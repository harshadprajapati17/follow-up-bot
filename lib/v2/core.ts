/**
 * BRAIN OF V2 — Every user message flows through 4 layers in order:
 *   Layer 0: LOCAL RESOLVER  → catches "hi", phone numbers, lead IDs (free, <1ms)
 *   Layer 1A: KEYWORD RULES  → catches known intents like "naya lead banana hai" (free, <1ms)
 *   Layer 1B: FINGERPRINT DB → finds similar past messages in MongoDB (free, ~5ms)
 *   Layer 2: GEMINI LLM      → full AI call for everything else (paid, ~200ms)
 * The first layer that handles the message wins — all later layers are skipped.
 * Every step is recorded in pipeline_trace[] for the /v2-logs visualization page.
 */
import { randomUUID } from "crypto";
import type {
  ChatV2Response,
  ConversationMessage,
  GeminiResponse,
  PipelineStep,
  V2CallLog,
} from "./types";
import {
  loadConversation,
  saveConversation,
  appendMessage,
  updateSession,
} from "./conversation";
import { tryLocalResolve } from "./local-resolver";
import { trySemanticCache, getFlowStartUpdate } from "./semantic-cache";
import { findFingerprintMatch, saveFingerprint } from "./fingerprint-cache";
import { buildContentsFromHistory, callGemini } from "./gemini-tools";
import { getOrCreateCache } from "./gemini-cache";
import { validateToolCall, extractValidEntitiesFromFailedToolCall } from "./validation";
import { executeToolCall } from "./tool-handlers";
import { logV2Call } from "./logger";

// When local resolver captures one field mid-flow, ask for the next one so the flow continues.
const NEXT_FIELD_PROMPT: Record<string, string> = {
  customer_name: "कृपया ग्राहक का नाम बताइए।",
  customer_phone: "कृपया ग्राहक का फ़ोन नंबर बताइए।",
  location_text: "लोकेशन (एरिया / शहर) बताइए।",
  job_type: "किस तरह का काम है? (जैसे पेंटिंग, वाटरप्रूफिंग)",
  job_scope: "इंटीरियर, एक्सटीरियर या दोनों?",
  property_size_type: "प्रॉपर्टी साइज क्या है? (1BHK, 2BHK, 3BHK या OTHER)",
  is_repaint: "नया पेंट है या रीपेंट?",
  start_timing: "काम कब से शुरू करना है?",
  finish_quality: "फिनिश कैसा चाहिए — बेसिक या प्रीमियम?",
  lead_id: "कौन‑सा लीड है? Lead ID या नाम बताइए।",
  visit_date: "विज़िट की तारीख क्या रखें?",
  room_name: "रूम का नाम बताइए।",
  length_ft: "लंबाई कितनी है (फीट में)?",
  width_ft: "चौड़ाई कितनी है (फीट में)?",
  paint_type: "कौन‑सा पेंट टाइप चाहिए?",
};

/** When save_new_lead validation fails but we saved some fields (e.g. only phone), confirm and ask for next. */
function buildSaveNewLeadValidationFailureMessage(
  validEntities: Record<string, unknown>,
  pendingFields: string[]
): string {
  const parts: string[] = [];
  if (validEntities.customer_phone) {
    parts.push(`फ़ोन नंबर ${validEntities.customer_phone} नोट कर लिया है।`);
  }
  if (validEntities.customer_name) {
    parts.push(`नाम ${validEntities.customer_name} नोट कर लिया है।`);
  }
  if (validEntities.location_text) {
    parts.push("लोकेशन नोट कर ली है।");
  }
  if (pendingFields.length === 0) {
    parts.push(
      "जो details मिली हैं वो सेव हो गई हैं। अब आप अगला काम चुन सकते हैं — जैसे विज़िट शेड्यूल करना।"
    );
  } else {
    const nextField = pendingFields[0];
    const nextPrompt = nextField ? NEXT_FIELD_PROMPT[nextField] : null;
    if (nextPrompt) {
      parts.push(nextPrompt);
    }
  }
  return parts.join(" ");
}

// Rough token estimates for calculating how much we save when we skip Gemini.
const SYSTEM_PROMPT_TOKENS_ESTIMATE = 300;
const AVG_TOKENS_PER_MESSAGE = 30;
const AVG_OUTPUT_TOKENS = 50;

function estimateTokensSaved(conversationLength: number): number {
  return (
    SYSTEM_PROMPT_TOKENS_ESTIMATE +
    conversationLength * AVG_TOKENS_PER_MESSAGE +
    AVG_OUTPUT_TOKENS
  );
}

function sanitizeGeminiText(raw: string | null): string {
  if (!raw) return "";
  const text = raw;
  const metaHints = [
    "सोच रहा हूँ कि टूल",
    "soch raha hoon ki tool",
    "tool `save_new_lead`",
    "tool `schedule_visit`",
    "tool `log_measurement`",
    "tool `generate_quote`",
    "tool `update_lead`",
    "tool `get_lead_details`",
    "tool `list_recent_leads`",
    "functionCall",
    "function call",
  ];

  if (!metaHints.some((p) => text.includes(p))) {
    return text;
  }

  const cleaned = text
    .split("\n")
    .filter(
      (line) =>
        !line.includes("tool `") &&
        !line.includes("टूल") &&
        !line.includes("functionCall") &&
        !line.includes("function call")
    )
    .join("\n")
    .trim();

  return cleaned;
}

/**
 * Main entry point — called by /api/v2/chat and /api/v2/chat-no-cache.
 * Returns the bot's reply + which layer handled it + optional tool result.
 */
export async function handleChatV2(params: {
  userId: string;
  text: string;
  useCache: boolean;
  endpoint: "chat" | "chat-no-cache";
}): Promise<ChatV2Response> {
  const { userId, text, useCache, endpoint } = params;
  const requestId = randomUUID();
  const startTime = Date.now();
  const trace: PipelineStep[] = [];

  const textStr = typeof text === "string" ? text.trim() : "";
  if (!textStr) {
    return { status: "error", message: "Empty message." };
  }

  // =====================================================================
  // STEP 1: INPUT — Log what the user sent. No processing yet.
  // =====================================================================
  trace.push({
    step: "input",
    status: "proceed",
    detail: textStr.length > 80 ? `${textStr.substring(0, 80)}…` : textStr,
    duration_ms: 0,
    data: { char_count: textStr.length },
  });

  // Load this user's conversation history from Redis (or create a fresh one).
  let conv = await loadConversation(userId);

  // Append the new message so all layers can see the full conversation.
  const userMsg: ConversationMessage = {
    role: "user",
    content: textStr,
    timestamp: Date.now(),
  };
  conv = appendMessage(conv, userMsg);

  // How many tokens we'd spend if this goes all the way to Gemini.
  const tokensIfGemini = estimateTokensSaved(conv.messages.length);

  // =====================================================================
  // LAYER 0: LOCAL RESOLVER — regex/pattern matching, no AI, no DB.
  // Catches: greetings ("hi"), 10-digit phones, 24-char lead IDs, "dono".
  // If it matches → reply instantly, skip everything else.
  // =====================================================================
  const localStart = Date.now();
  const localResult = tryLocalResolve(textStr, conv.session);
  const localDuration = Date.now() - localStart;

  if (localResult.handled) {
    // LOCAL HIT — message was a simple pattern. Reply now, skip all AI layers.
    trace.push({
      step: "local_resolver",
      status: "handled",
      detail: localResult.response,
      duration_ms: localDuration,
      data: {
        method: "pattern",
        entity_update: localResult.entity_update ?? null,
        session_update: localResult.session_update ?? null,
      },
    });

    // Mark all downstream layers as skipped (with token savings estimate).
    trace.push({ step: "semantic_cache", status: "skip", detail: "Skipped — local resolver already replied", duration_ms: 0, tokens_saved: tokensIfGemini });
    trace.push({ step: "gemini_call", status: "skip", detail: "Skipped — local resolver already replied", duration_ms: 0, tokens_saved: tokensIfGemini });
    trace.push({ step: "validation", status: "skip", detail: "No tool call needed", duration_ms: 0 });
    trace.push({ step: "tool_execution", status: "skip", detail: "No tool call needed", duration_ms: 0 });

    // Save any entity the local resolver extracted (e.g. phone number).
    if (localResult.entity_update) {
      conv = updateSession(conv, { collected_entities: localResult.entity_update });
      const resolvedKeys = Object.keys(localResult.entity_update);
      const newPending = conv.session.pending_fields.filter((f) => !resolvedKeys.includes(f));
      conv = updateSession(conv, { pending_fields: newPending });
    }
    if (localResult.session_update) {
      conv = updateSession(conv, localResult.session_update);
    }

    // If user is mid-flow and there are still fields to collect, ask for the next one.
    // This prevents the flow from "stopping" after just noting one piece of info.
    let responseText = localResult.response;
    if (conv.session.current_flow && conv.session.pending_fields.length > 0) {
      const nextField = conv.session.pending_fields[0];
      const followUp = NEXT_FIELD_PROMPT[nextField];
      if (followUp) {
        responseText = `${responseText} ${followUp}`;
      }
    }

    // Store the bot's reply in conversation history and save to Redis.
    const assistantMsg: ConversationMessage = { role: "assistant", content: responseText, timestamp: Date.now() };
    conv = appendMessage(conv, assistantMsg);
    await saveConversation(userId, conv);

    trace.push({ step: "response", status: "proceed", detail: responseText, duration_ms: Date.now() - startTime });

    // Log to MongoDB for the /v2-logs visualization page.
    await logV2Call(buildLog({ requestId, userId, endpoint, layerHit: "local", userText: textStr, conversationLength: conv.messages.length, cacheUsed: false, cacheName: null, responseText, startTime, trace }));

    return { status: "success", message: responseText, layer_hit: "local" };
  }

  // LOCAL MISS — no pattern matched. Move to next layer.
  trace.push({ step: "local_resolver", status: "skip", detail: "No pattern matched — passing to keyword rules", duration_ms: localDuration });

  // =====================================================================
  // LAYER 0B: KEYWORD RULES — hardcoded intent-trigger phrases.
  // Still local (in-memory, no DB, no API), but smarter: matches intents
  // like "naya lead", "visit schedule", "quote banao" using keyword groups.
  // Skipped if user is mid-flow (answering questions) — Gemini handles that.
  // Logged as layer_hit: "local" with method: "keyword" (not "semantic_cache").
  // =====================================================================
  const cacheStart = Date.now();
  const keywordResult = trySemanticCache(textStr, conv.session);

  if (keywordResult.matched) {
    // KEYWORD HIT — we recognized the intent from hardcoded rules. Reply now.
    const cacheDuration = Date.now() - cacheStart;
    trace.push({
      step: "local_resolver",
      status: "handled",
      detail: `Keyword rules matched intent: "${keywordResult.intent}"`,
      duration_ms: localDuration + cacheDuration,
      tokens_saved: tokensIfGemini,
      data: { method: "keyword", intent: keywordResult.intent, flow_update: keywordResult.flow_update ?? null },
    });

    // Mark semantic cache + Gemini + tool layers as skipped.
    trace.push({ step: "semantic_cache", status: "skip", detail: "Skipped — keyword rules already replied", duration_ms: 0, tokens_saved: tokensIfGemini });
    trace.push({ step: "gemini_call", status: "skip", detail: "Skipped — keyword rules already replied", duration_ms: 0, tokens_saved: tokensIfGemini });
    trace.push({ step: "validation", status: "skip", detail: "No tool call needed", duration_ms: 0 });
    trace.push({ step: "tool_execution", status: "skip", detail: "No tool call needed", duration_ms: 0 });

    // Set the conversation flow and CLEAR old collected data — user is starting fresh.
    // Without this, a previous lead's phone number would carry over and we'd skip asking for it.
    if (keywordResult.flow_update) {
      conv = updateSession(conv, {
        current_flow: keywordResult.flow_update.current_flow,
        pending_fields: keywordResult.flow_update.pending_fields,
        collected_entities: {},
      });
    }

    const assistantMsg: ConversationMessage = { role: "assistant", content: keywordResult.response, timestamp: Date.now() };
    conv = appendMessage(conv, assistantMsg);
    await saveConversation(userId, conv);

    trace.push({ step: "response", status: "proceed", detail: keywordResult.response, duration_ms: Date.now() - startTime });
    await logV2Call(buildLog({ requestId, userId, endpoint, layerHit: "local", userText: textStr, conversationLength: conv.messages.length, cacheUsed: false, cacheName: null, responseText: keywordResult.response, startTime, trace }));

    return { status: "success", message: keywordResult.response, layer_hit: "local" };
  }

  // =====================================================================
  // LAYER 1B: FINGERPRINT CACHE — learned phrases stored in MongoDB.
  // Compares user's keywords against previously saved Gemini responses.
  // If 70%+ of a cached entry's keywords match → return that saved response.
  // Skipped if user is mid-flow (same reason as keyword rules).
  // =====================================================================
  const fpResult = await findFingerprintMatch(textStr, conv.session);

  if (fpResult.matched) {
    // FINGERPRINT HIT — a past Gemini response matches this message. Reuse it.
    const cacheDuration = Date.now() - cacheStart;
    trace.push({
      step: "semantic_cache",
      status: "handled",
      detail: `Fingerprint match: ${(fpResult.similarity * 100).toFixed(0)}% overlap with "${fpResult.original_text}"`,
      duration_ms: cacheDuration,
      tokens_saved: tokensIfGemini,
      data: { method: "fingerprint", similarity: fpResult.similarity, original_text: fpResult.original_text, fingerprint: fpResult.fingerprint },
    });

    // Mark Gemini + tool layers as skipped.
    trace.push({ step: "gemini_call", status: "skip", detail: "Skipped — fingerprint cache already replied", duration_ms: 0, tokens_saved: tokensIfGemini });
    trace.push({ step: "validation", status: "skip", detail: "No tool call needed", duration_ms: 0 });
    trace.push({ step: "tool_execution", status: "skip", detail: "No tool call needed", duration_ms: 0 });

    const assistantMsg: ConversationMessage = { role: "assistant", content: fpResult.response, timestamp: Date.now() };
    conv = appendMessage(conv, assistantMsg);
    await saveConversation(userId, conv);

    trace.push({ step: "response", status: "proceed", detail: fpResult.response, duration_ms: Date.now() - startTime });
    await logV2Call(buildLog({ requestId, userId, endpoint, layerHit: "semantic_cache", userText: textStr, conversationLength: conv.messages.length, cacheUsed: false, cacheName: null, responseText: fpResult.response, startTime, trace }));

    return { status: "success", message: fpResult.response, layer_hit: "semantic_cache" };
  }

  // SEMANTIC CACHE MISS — neither keyword rules nor fingerprint DB matched.
  const cacheDuration = Date.now() - cacheStart;
  trace.push({ step: "semantic_cache", status: "skip", detail: "No keyword or fingerprint match — passing to Gemini LLM", duration_ms: cacheDuration });

  // Save whether user was mid-flow BEFORE Gemini (used after Gemini to decide if we learn).
  const wasInFlow = !!(conv.session.current_flow && conv.session.pending_fields.length > 0);

  // If user is starting a new flow (e.g. "new lead" as a different project), fully
  // reset session: current_flow, pending_fields, and collected_entities. Keyword
  // rules already do this when they fire; this is the Gemini path equivalent so we
  // don't reuse the previous lead's name/phone when the user says "Jay 8866574684".
  const flowStartUpdate = getFlowStartUpdate(textStr);
  if (flowStartUpdate) {
    conv = updateSession(conv, {
      current_flow: flowStartUpdate.current_flow,
      pending_fields: flowStartUpdate.pending_fields,
      collected_entities: {},
    });
  }

  // =====================================================================
  // LAYER 2: GEMINI LLM — full AI call with conversation history.
  // This is the expensive/slow path. We only reach here if no earlier layer handled it.
  // Gemini may respond with text only, or request a tool call (save lead, schedule visit, etc).
  // =====================================================================
  let cacheName: string | null = null;
  let geminiResponse: GeminiResponse;
  const geminiStart = Date.now();

  try {
    // If caching is enabled, reuse the cached system prompt + tool definitions.
    if (useCache) {
      cacheName = await getOrCreateCache();
    }

    // Build the Gemini request from full conversation history + session context.
    const contents = buildContentsFromHistory(conv.messages, conv.session);
    geminiResponse = await callGemini({ contents, cachedContentName: cacheName ?? undefined });
  } catch (err) {
    // GEMINI FAILED — send a friendly fallback, log the error, return.
    console.error("[v2/core] Gemini call failed:", err);

    trace.push({ step: "gemini_call", status: "error", detail: err instanceof Error ? err.message : "Unknown error", duration_ms: Date.now() - geminiStart });
    trace.push({ step: "validation", status: "skip", detail: "Skipped — Gemini failed", duration_ms: 0 });
    trace.push({ step: "tool_execution", status: "skip", detail: "Skipped — Gemini failed", duration_ms: 0 });

    const fallback = "Samajh nahi aaya, thodi der baad phir se try kariye.";
    trace.push({ step: "response", status: "error", detail: fallback, duration_ms: Date.now() - startTime });

    const assistantMsg: ConversationMessage = { role: "assistant", content: fallback, timestamp: Date.now() };
    conv = appendMessage(conv, assistantMsg);
    await saveConversation(userId, conv);

    await logV2Call(buildLog({ requestId, userId, endpoint, layerHit: "gemini", userText: textStr, conversationLength: conv.messages.length, cacheUsed: useCache && !!cacheName, cacheName, responseText: fallback, startTime, trace }));

    return { status: "error", message: fallback };
  }

  const geminiLatency = Date.now() - geminiStart;

  // GEMINI RESPONDED — log what it returned (text, tool calls, token counts).
  trace.push({
    step: "gemini_call",
    status: "proceed",
    detail: geminiResponse.tool_calls.length > 0
      ? `Gemini wants to call tool: "${geminiResponse.tool_calls[0].name}"`
      : "Gemini replied with text only (no tool call)",
    duration_ms: geminiLatency,
    data: {
      input_tokens: geminiResponse.input_tokens,
      output_tokens: geminiResponse.output_tokens,
      cached_tokens: geminiResponse.cached_tokens,
      gemini_text: geminiResponse.text?.substring(0, 200) ?? null,
      tool_calls: geminiResponse.tool_calls.map((tc) => tc.name),
      cache_used: useCache && !!cacheName,
    },
  });

  // =====================================================================
  // STEP: VALIDATION + TOOL EXECUTION — only if Gemini requested a tool call.
  // We validate the args (e.g. phone must be 10 digits), then execute against DB.
  // If Gemini sent text only → both steps are skipped.
  // =====================================================================
  let responseText = sanitizeGeminiText(geminiResponse.text ?? "");
  let toolExecuted: string | undefined;
  let toolResult: ReturnType<typeof executeToolCall> extends Promise<infer R> ? R : never;
  let validationPassed = true;
  let validationErrors: string[] = [];

  if (geminiResponse.tool_calls.length > 0) {
    // GEMINI REQUESTED A TOOL — e.g. save_new_lead, schedule_visit, etc.
    const tc = geminiResponse.tool_calls[0];
    toolExecuted = tc.name;

    // Auto-inject lead_id from session if Gemini didn't provide one.
    if (conv.session.active_lead_id && !tc.args.lead_id && tc.name !== "save_new_lead" && tc.name !== "list_recent_leads") {
      tc.args.lead_id = conv.session.active_lead_id;
    }

    // Validate: are the tool arguments correct? (e.g. phone format, required fields)
    const validationStart = Date.now();
    const validation = validateToolCall(tc.name, tc.args);
    const validationDuration = Date.now() - validationStart;
    validationPassed = validation.valid;
    validationErrors = validation.errors;

    trace.push({
      step: "validation",
      status: validation.valid ? "proceed" : "error",
      detail: validation.valid
        ? `Tool "${tc.name}" passed all validation checks`
        : `Tool "${tc.name}" failed: ${validation.errors.join(", ")}`,
      duration_ms: validationDuration,
      data: { tool: tc.name, args: tc.args, errors: validation.errors },
    });

    if (validation.valid) {
      // VALIDATION PASSED — execute the tool against MongoDB/S3.
      const sanitizedArgs = validation.sanitized_args ?? tc.args;

      // Record the tool call in conversation history (so Gemini sees it next turn).
      const toolCallMsg: ConversationMessage = { role: "tool_call", content: JSON.stringify(sanitizedArgs), tool_name: tc.name, tool_args: sanitizedArgs, timestamp: Date.now() };
      conv = appendMessage(conv, toolCallMsg);

      // Execute: e.g. insert lead into MongoDB, upload PDF to S3, etc.
      const toolStart = Date.now();
      toolResult = await executeToolCall(tc.name, sanitizedArgs, userId);
      const toolDuration = Date.now() - toolStart;

      trace.push({
        step: "tool_execution",
        status: toolResult.success ? "proceed" : "error",
        detail: toolResult.success
          ? `Tool "${tc.name}" executed successfully`
          : `Tool "${tc.name}" failed: ${toolResult.message.substring(0, 100)}`,
        duration_ms: toolDuration,
        data: { tool: tc.name, success: toolResult.success, created_lead_id: toolResult.created_lead_id ?? null, next_intents: toolResult.next_suggested_intents ?? [] },
      });

      // Record the tool result in conversation history.
      const toolResultMsg: ConversationMessage = { role: "tool_result", content: toolResult.message, tool_name: tc.name, timestamp: Date.now() };
      conv = appendMessage(conv, toolResultMsg);

      // If a new lead was created, store its ID in session for future turns.
      if (toolResult.created_lead_id) {
        conv = updateSession(conv, { active_lead_id: toolResult.created_lead_id, current_flow: null, pending_fields: [] });
      }

      // Reset collection state after saving a lead (flow is done).
      if (tc.name === "save_new_lead" && toolResult.success) {
        conv = updateSession(conv, { current_flow: null, collected_entities: {}, pending_fields: [] });
      }

      // Combine Gemini's text with the tool result into one reply.
      if (responseText) {
        responseText = `${responseText}\n\n${toolResult.message}`;
      } else {
        responseText = toolResult.message;
      }

      // Suggest the natural next step (e.g. "Ab visit schedule karein?").
      if (toolResult.next_suggested_intents?.length) {
        const next = toolResult.next_suggested_intents[0];
        const suggestions: Record<string, string> = {
          schedule_visit: "Ab visit schedule karein?",
          log_measurement: "Ab measurement log karna hai?",
          generate_quote: "Ab quote generate karein?",
        };
        if (suggestions[next]) {
          responseText += ` ${suggestions[next]}`;
        }
      }
    } else {
      // VALIDATION FAILED — don't execute the tool. But preserve valid fields so we don't ask again.
      // e.g. user said "Harshad, 8866" — name is valid, phone isn't. Keep "Harshad" in session.
      trace.push({ step: "tool_execution", status: "skip", detail: `Skipped — validation failed for "${tc.name}"`, duration_ms: 0 });

      const validEntities = extractValidEntitiesFromFailedToolCall(tc.name, tc.args);
      if (Object.keys(validEntities).length > 0) {
        conv = updateSession(conv, { collected_entities: validEntities });
        const resolvedKeys = Object.keys(validEntities);
        let newPending = conv.session.pending_fields.filter((f) => !resolvedKeys.includes(f));

        // Tool-calling driven: if save_new_lead failed, drive flow from validation.missing_fields.
        if (tc.name === "save_new_lead") {
          const missing = validation.missing_fields ?? [];
          const missingMinusResolved = missing.filter((f) => !resolvedKeys.includes(f));
          if (missingMinusResolved.length > 0) {
            newPending = missingMinusResolved;
            conv = updateSession(conv, { current_flow: "save_new_lead" });
          }
        }

        conv = updateSession(conv, { pending_fields: newPending });
        // When user gave only partial details (e.g. just phone 8866574684), confirm what we saved and ask for the next.
        if (tc.name === "save_new_lead" && !responseText) {
          responseText = buildSaveNewLeadValidationFailureMessage(validEntities, newPending);
        }
      }

      if (!responseText) {
        console.warn(`[v2/core] Validation failed for ${tc.name}:`, validationErrors);
        const errorDetail =
          validationErrors.length > 0
            ? ` Ye issue hai: ${validationErrors.join(". ")}`
            : "";
        responseText = `Kuch details galat lag rahi hain, phir se check karke batao.${errorDetail}`;
      }
    }
  } else {
    // GEMINI RETURNED TEXT ONLY — no tool was requested. Skip validation + execution.
    trace.push({ step: "validation", status: "skip", detail: "Skipped — Gemini didn't request any tool", duration_ms: 0 });
    trace.push({ step: "tool_execution", status: "skip", detail: "Skipped — Gemini didn't request any tool", duration_ms: 0 });
  }

  // Fallback if Gemini returned nothing useful.
  if (!responseText && geminiResponse.tool_calls.length === 0) {
    responseText = "Samajh nahi aaya, thoda detail mein bata sakte hain?";
  }

  // =====================================================================
  // FINGERPRINT LEARNING — save this Gemini response for future cache hits.
  // Only when: Gemini replied with text only (no tool), user was NOT mid-flow,
  // and the response is meaningful (>10 chars). This grows the fingerprint DB.
  // =====================================================================
  if (geminiResponse.tool_calls.length === 0 && !wasInFlow && responseText.length > 10) {
    saveFingerprint(textStr, responseText).catch(() => {});
  }

  // =====================================================================
  // FINAL: Build the response, save conversation, log everything.
  // =====================================================================
  trace.push({
    step: "response",
    status: "proceed",
    detail: responseText.length > 200 ? `${responseText.substring(0, 200)}…` : responseText,
    duration_ms: Date.now() - startTime,
  });

  const assistantMsg: ConversationMessage = { role: "assistant", content: responseText, timestamp: Date.now() };
  conv = appendMessage(conv, assistantMsg);
  await saveConversation(userId, conv);

  await logV2Call(buildLog({
    requestId, userId, endpoint,
    layerHit: "gemini",
    userText: textStr,
    conversationLength: conv.messages.length,
    cacheUsed: useCache && !!cacheName,
    cacheName,
    toolCalled: toolExecuted ?? null,
    toolParams: geminiResponse.tool_calls[0]?.args ?? null,
    responseText,
    inputTokens: geminiResponse.input_tokens,
    outputTokens: geminiResponse.output_tokens,
    cachedTokens: geminiResponse.cached_tokens,
    geminiLatencyMs: geminiLatency,
    validationPassed,
    validationErrors,
    startTime, trace,
  }));

  return {
    status: "success",
    message: responseText,
    layer_hit: "gemini",
    ...(toolExecuted ? { tool_executed: toolExecuted } : {}),
    ...(toolResult! ? { tool_result: toolResult } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helper: builds the log object for MongoDB + /v2-logs page.
// ---------------------------------------------------------------------------

function buildLog(p: {
  requestId: string;
  userId: string;
  endpoint: "chat" | "chat-no-cache";
  layerHit: "local" | "semantic_cache" | "gemini";
  userText: string;
  conversationLength: number;
  cacheUsed: boolean;
  cacheName: string | null;
  toolCalled?: string | null;
  toolParams?: Record<string, unknown> | null;
  responseText: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  geminiLatencyMs?: number;
  validationPassed?: boolean;
  validationErrors?: string[];
  startTime: number;
  trace: PipelineStep[];
}): V2CallLog {
  return {
    request_id: p.requestId,
    user_id: p.userId,
    timestamp: Date.now(),
    endpoint: p.endpoint,
    layer_hit: p.layerHit,
    user_text: p.userText,
    conversation_length: p.conversationLength,
    cache_used: p.cacheUsed,
    cache_name: p.cacheName,
    tool_called: p.toolCalled ?? null,
    tool_params: p.toolParams ?? null,
    response_text: p.responseText,
    input_tokens: p.inputTokens ?? 0,
    output_tokens: p.outputTokens ?? 0,
    cached_tokens: p.cachedTokens ?? 0,
    latency_ms: Date.now() - p.startTime,
    gemini_latency_ms: p.geminiLatencyMs ?? 0,
    validation_passed: p.validationPassed ?? true,
    validation_errors: p.validationErrors ?? [],
    pipeline_trace: p.trace,
  };
}
