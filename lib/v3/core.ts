/**
 * V3 core — simple 2-step pipeline.
 *
 * Step 1: Instant reply for greetings (zero cost).
 * Step 2: Everything else → Gemini with full conversation history.
 *
 * No keyword layers. No fingerprint cache. No session flow tracking.
 * Gemini owns the conversation and decides when to call tools.
 */
import type { ChatV3Response } from "./types";
import {
  loadConversation,
  saveConversation,
  appendMessage,
  shouldSummarize,
  compactConversation,
} from "./conversation";
import { buildContents, callGemini } from "./gemini";
import { validateToolCall, sanitizeGeminiText } from "./validation";
import { executeToolCall } from "./tool-handlers";
import { logV3Call, type V3ToolExecutionLog } from "./logger";

// ---------------------------------------------------------------------------
// Greeting detection (the only cheap intercept we keep)
// ---------------------------------------------------------------------------

const GREETINGS = new Set([
  "hi", "hello", "helo", "hlo", "hey", "hii", "hii!",
  "namaste", "namste", "namaskar", "gm", "good morning", "good evening",
]);

function isGreeting(text: string): boolean {
  return GREETINGS.has(text.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleChatV3(params: {
  userId: string;
  text: string;
}): Promise<ChatV3Response> {
  const { userId, text } = params;
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const startedAt = Date.now();
  const trimmed = text.trim();

  // Load conversation from MongoDB
  let conv = await loadConversation(userId);

  // ─── Step 1: Instant greeting reply ───────────────────────────────────────
  if (isGreeting(trimmed) && !conv.active_lead_id) {
    const reply =
      "नमस्ते! मैं आपका पेंटिंग असिस्टेंट हूँ — नया लीड जोड़ना हो, विज़िट शेड्यूल करनी हो, मेज़रमेंट लॉग करना हो या कोट बनवाना हो तो बताइए।";
    conv = appendMessage(conv, { role: "user", content: trimmed, ts: Date.now() });
    const ts = Date.now();
    conv = appendMessage(conv, { role: "assistant", content: reply, ts });
    await saveConversation(userId, conv);
    await logV3Call({
      request_id: requestId,
      user_id: userId,
      timestamp: startedAt,
      user_text: trimmed,
      gemini_text: null,
      gemini_tool_calls: [],
      gemini_input_tokens: 0,
      gemini_output_tokens: 0,
      tools: [],
      final_message: reply,
      greeting_shortcut: true,
    });
    return { status: "success", message: reply };
  }

  // ─── Step 2: Gemini ───────────────────────────────────────────────────────

  // Append user message
  conv = appendMessage(conv, { role: "user", content: trimmed, ts: Date.now() });

  // Summarize if history is long
  if (shouldSummarize(conv)) {
    conv = await compactConversation(conv);
  }

  // Build contents and call Gemini
  const contents = buildContents({
    messages: conv.messages,
    summary: conv.summary,
    active_lead_id: conv.active_lead_id,
  });

  let geminiResponse;
  try {
    geminiResponse = await callGemini(contents);
  } catch (err) {
    console.error("[v3/core] Gemini call failed:", err);
    const fallback = "माफ़ करें, कुछ गड़बड़ी हो गई। थोड़ी देर बाद फिर से कोशिश करें।";
    conv = appendMessage(conv, { role: "assistant", content: fallback, ts: Date.now() });
    await saveConversation(userId, conv);
    await logV3Call({
      request_id: requestId,
      user_id: userId,
      timestamp: startedAt,
      user_text: trimmed,
      gemini_text: null,
      gemini_contents: contents,
      gemini_tool_calls: [],
      gemini_input_tokens: 0,
      gemini_output_tokens: 0,
      tools: [],
      final_message: fallback,
      error: true,
    });
    return { status: "error", message: fallback };
  }

  // ─── Tool call path ───────────────────────────────────────────────────────
  if (geminiResponse.tool_calls.length > 0) {
    let lastToolName: string | undefined;
    let lastToolResult:
      | Awaited<ReturnType<typeof executeToolCall>>
      | undefined;
    const executedTools: V3ToolExecutionLog[] = [];

    for (const toolCall of geminiResponse.tool_calls) {
      // Validate args
      const validation = validateToolCall(
        toolCall.name,
        toolCall.args,
        conv.messages
      );

      if (!validation.valid) {
        const missingFields = validation.missing_fields ?? [];
        let errorMsg = "कुछ जानकारी अधूरी रह गई।";
        if (missingFields.includes("customer_phone")) {
          errorMsg = "ग्राहक का 10-digit फ़ोन नंबर बताइए।";
        } else if (missingFields.includes("customer_name")) {
          errorMsg = "ग्राहक का नाम बताइए।";
        }

        conv = appendMessage(conv, {
          role: "assistant",
          content: errorMsg,
          ts: Date.now(),
        });
        await saveConversation(userId, conv);
        return { status: "success", message: errorMsg };
      }

      const sanitizedArgs = validation.sanitized_args ?? toolCall.args;

      // Store tool call in history
      conv = appendMessage(conv, {
        role: "tool_call",
        content: "",
        tool_name: toolCall.name,
        tool_args: sanitizedArgs,
        ts: Date.now(),
      });

      // Execute tool
      let toolResult;
      try {
        toolResult = await executeToolCall(
          toolCall.name,
          sanitizedArgs,
          userId
        );
      } catch (err) {
        console.error("[v3/core] Tool execution failed:", err);
        const errorMsg = "टूल चलाने में समस्या आई। दोबारा कोशिश करें।";

        // IMPORTANT: store a synthetic tool_result before the assistant error
        // message. Gemini's protocol requires every functionCall (model) to be
        // followed by a functionResponse (user) before another model turn.
        // Skipping this causes two consecutive model-role messages which breaks
        // Gemini's history understanding and causes it to re-ask all questions.
        conv = appendMessage(conv, {
          role: "tool_result",
          content: `[server_error] ${toolCall.name} threw an unexpected exception. Parameters were valid — retry with the same arguments.`,
          tool_name: toolCall.name,
          ts: Date.now(),
        });
        conv = appendMessage(conv, {
          role: "assistant",
          content: errorMsg,
          ts: Date.now(),
        });
        await saveConversation(userId, conv);
        await logV3Call({
          request_id: requestId,
          user_id: userId,
          timestamp: startedAt,
          user_text: trimmed,
          gemini_contents: contents,
          gemini_text: geminiResponse.text,
          gemini_tool_calls: geminiResponse.tool_calls,
          gemini_input_tokens: geminiResponse.input_tokens,
          gemini_output_tokens: geminiResponse.output_tokens,
          tools: executedTools,
          final_message: errorMsg,
          error: true,
        });
        return { status: "error", message: errorMsg };
      }

      // Store tool result in history
      conv = appendMessage(conv, {
        role: "tool_result",
        content: toolResult.message,
        tool_name: toolCall.name,
        ts: Date.now(),
      });

      // Update active_lead_id if a new lead was created
      if (toolResult.created_lead_id) {
        conv = { ...conv, active_lead_id: toolResult.created_lead_id };
      }

      lastToolName = toolCall.name;
      lastToolResult = toolResult;
      executedTools.push({
        name: toolCall.name,
        args: sanitizedArgs,
        result_message: toolResult.message,
        success: toolResult.success,
        quote_pdf_url: toolResult.quote_pdf_url,
      });
    }

    // ── Server-error short-circuit ──────────────────────────────────────────
    // When a tool returns a [server_error] (e.g. S3/PDF crash), skip the
    // followup Gemini call entirely. Gemini would paraphrase the raw internal
    // tag and send it to the user. Instead, return a hardcoded friendly message
    // with a retry chip so the user can tap once to retry without a loop.
    if (
      lastToolResult &&
      !lastToolResult.success &&
      lastToolResult.message.startsWith("[server_error]")
    ) {
      const retryMsg =
        "Technical issue आई — quote generate नहीं हो पाया। एक बार फिर try करें?";
      conv = appendMessage(conv, {
        role: "assistant",
        content: retryMsg,
        ts: Date.now(),
      });
      await saveConversation(userId, conv);
      await logV3Call({
        request_id: requestId,
        user_id: userId,
        timestamp: startedAt,
        user_text: trimmed,
        gemini_text: geminiResponse.text,
        gemini_contents: contents,
        gemini_tool_calls: geminiResponse.tool_calls,
        gemini_input_tokens: geminiResponse.input_tokens,
        gemini_output_tokens: geminiResponse.output_tokens,
        tools: executedTools,
        final_message: retryMsg,
        error: true,
      });
      return {
        status: "success",
        message: retryMsg,
        tool_executed: lastToolName,
        selection_chips: [
          { label: "फिर से Try करें 🔄", payload: "quote dobara banao" },
          { label: "बाद में", payload: "baad mein" },
        ],
        chips_type: "suggestion",
      };
    }

    // Ask Gemini to generate final reply with next-step suggestion
    const contentsAfterTool = buildContents({
      messages: conv.messages,
      summary: conv.summary,
      active_lead_id: conv.active_lead_id,
    });

    let followupResponse;
    try {
      followupResponse = await callGemini(contentsAfterTool);
    } catch {
      followupResponse = {
        text: lastToolResult?.message ?? null,
        tool_calls: [],
        input_tokens: 0,
        output_tokens: 0,
      };
    }

    // Sanitize text output to strip hallucinated URLs/code and internal tags
    const rawMsg = followupResponse.text?.trim() || lastToolResult?.message || "";
    const responseMsg = sanitizeGeminiText(rawMsg);

    conv = appendMessage(conv, {
      role: "assistant",
      content: responseMsg,
      ts: Date.now(),
    });
    await saveConversation(userId, conv);

    // Prefer chips from tools; if none, infer from response text
    const inferredChips =
      !lastToolResult?.selection_chips && responseMsg
        ? inferChips(responseMsg, lastToolName)
        : null;

    const apiResponse: ChatV3Response = {
      status: "success",
      message: responseMsg,
      tool_executed: lastToolName,
      quote_pdf_url: lastToolResult?.quote_pdf_url,
      ...(lastToolResult?.selection_chips
        ? {
            selection_chips: lastToolResult.selection_chips,
            chips_type: lastToolResult.chips_type,
          }
        : inferredChips
        ? {
            selection_chips: inferredChips.selection_chips,
            chips_type: inferredChips.chips_type,
          }
        : {}),
    };

    await logV3Call({
      request_id: requestId,
      user_id: userId,
      timestamp: startedAt,
      user_text: trimmed,
      gemini_text: geminiResponse.text,
      gemini_contents: contents,
      gemini_tool_calls: geminiResponse.tool_calls,
      gemini_input_tokens: geminiResponse.input_tokens,
      gemini_output_tokens: geminiResponse.output_tokens,
      tools: executedTools,
      final_message: apiResponse.message,
    });

    return apiResponse;
  }

  // ─── Text reply path ──────────────────────────────────────────────────────
  const rawText = geminiResponse.text?.trim() || "समझ नहीं आया, थोड़ा और बताइए?";
  const responseText = sanitizeGeminiText(rawText);

  conv = appendMessage(conv, {
    role: "assistant",
    content: responseText,
    ts: Date.now(),
  });
  await saveConversation(userId, conv);

  const inferredChips = inferChips(responseText);

  const apiResponse: ChatV3Response = inferredChips
    ? {
        status: "success",
        message: responseText,
        selection_chips: inferredChips.selection_chips,
        chips_type: inferredChips.chips_type,
      }
    : { status: "success", message: responseText };

  await logV3Call({
    request_id: requestId,
    user_id: userId,
    timestamp: startedAt,
    user_text: trimmed,
    gemini_contents: contents,
    gemini_text: geminiResponse.text,
    gemini_tool_calls: geminiResponse.tool_calls,
    gemini_input_tokens: geminiResponse.input_tokens,
    gemini_output_tokens: geminiResponse.output_tokens,
    tools: [],
    final_message: apiResponse.message,
  });

  return apiResponse;
}

// ---------------------------------------------------------------------------
// Robust chip inference — keyword-based, not exact string match
// ---------------------------------------------------------------------------

type ChipResult = {
  selection_chips: Array<{ label: string; payload: string }>;
  chips_type: "selection" | "suggestion";
};

const YES_NO_SKIP: ChipResult = {
  selection_chips: [
    { label: "हाँ", payload: "haan" },
    { label: "नहीं", payload: "nahi" },
    { label: "Skip ⏭", payload: "skip" },
  ],
  chips_type: "selection",
};

const PUTTY_CHIPS: ChipResult = {
  selection_chips: [
    { label: "0", payload: "0" },
    { label: "1", payload: "1" },
    { label: "2", payload: "2" },
    { label: "Skip ⏭", payload: "skip" },
  ],
  chips_type: "selection",
};

const BRAND_CHIPS: ChipResult = {
  selection_chips: [
    { label: "Asian Paints", payload: "Asian Paints" },
    { label: "Berger", payload: "Berger" },
    { label: "Nerolac", payload: "Nerolac" },
    { label: "कोई भी", payload: "koi bhi chalega" },
    { label: "Skip ⏭", payload: "skip" },
  ],
  chips_type: "selection",
};

const PRODUCT_CHIPS: ChipResult = {
  selection_chips: [
    { label: "Economy", payload: "Economy" },
    { label: "Mid Range", payload: "Mid Range" },
    { label: "Premium", payload: "Premium" },
    { label: "Skip ⏭", payload: "skip" },
  ],
  chips_type: "selection",
};

const QUOTE_CHIPS: ChipResult = {
  selection_chips: [
    { label: "कोटेशन बनाएं", payload: "haan quote banao" },
    { label: "बाद में", payload: "baad mein" },
  ],
  chips_type: "suggestion",
};

/** Check if text contains ANY of the given keywords (case-insensitive). */
function hasAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Extract the question/last sentence from a bot message.
 * Bot messages often start with an acknowledgment ("X हो गया।") followed by
 * the actual new question. Splitting on the Devanagari danda (।) lets us
 * match chips against only what is being asked *right now*, avoiding false
 * positives from acknowledgment keywords.
 */
function getQuestionPart(text: string): string {
  // Split on danda (।), newline, or end-of-sentence markers and take the last
  // non-trivially-short fragment.
  const parts = text
    .split(/[।\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
  return parts[parts.length - 1] ?? text;
}

/**
 * Infer selection chips from the Gemini response text.
 * Matches against only the *question* part of the message (last sentence after
 * acknowledgment) so that acknowledgment keywords don't bleed into chip logic.
 */
function inferChips(text: string, lastTool?: string): ChipResult | null {
  // Use the question/last-sentence part for keyword matching to avoid false
  // positives from acknowledgment text (e.g. "सीलिंग शामिल कर ली गई है।
  // पुट्टी के कितने कोट चाहिए?" should yield PUTTY_CHIPS, not YES_NO_SKIP).
  const q = getQuestionPart(text).toLowerCase();
  const full = text.toLowerCase();

  // Putty question — check before ceiling so "पुट्टी … कोट?" wins
  if (hasAny(q, ["putty", "पुट्टी", "पट्टी"]) && hasAny(q, ["coat", "कोट", "कितन"])) {
    return PUTTY_CHIPS;
  }

  // Primer question
  if (hasAny(q, ["primer", "प्राइमर", "प्राईमर"])) {
    return YES_NO_SKIP;
  }

  // Ceiling question
  if (hasAny(q, ["ceiling", "सीलिंग", "सिलिंग", "छत"])) {
    return YES_NO_SKIP;
  }

  // Scraping question
  if (hasAny(q, ["scrap", "स्क्रैप", "स्क्रेप", "खुरच"])) {
    return YES_NO_SKIP;
  }

  // Damp/seepage question
  if (hasAny(q, ["damp", "seepage", "सीपेज", "डैम्प", "नमी", "सीलन"])) {
    return YES_NO_SKIP;
  }

  // Brand question
  if (hasAny(q, ["brand", "ब्रांड", "ब्रैंड"]) || hasAny(q, ["asian paints", "berger", "nerolac"])) {
    return BRAND_CHIPS;
  }

  // Product/grade question
  if (
    hasAny(q, ["product", "प्रोडक्ट", "grade", "ग्रेड"]) ||
    (hasAny(q, ["economy", "mid range", "premium"]) && hasAny(q, ["?", "?"]))
  ) {
    return PRODUCT_CHIPS;
  }

  // Quote suggestion — use full text so "कोटेशन" anywhere triggers it
  if (hasAny(full, ["quote", "कोटेशन", "quotation"]) && !hasAny(q, ["putty", "पुट्टी", "primer", "प्राइमर", "ceiling", "सीलिंग"])) {
    return QUOTE_CHIPS;
  }

  // Visit suggestion after lead saved
  if (lastTool === "save_new_lead" && hasAny(full, ["visit", "विज़िट", "विजिट"])) {
    return {
      selection_chips: [
        { label: "विज़िट शेड्यूल करें", payload: "visit schedule karo" },
        { label: "बाद में", payload: "baad mein" },
      ],
      chips_type: "suggestion",
    };
  }

  // Measurement suggestion after visit scheduled
  if (lastTool === "schedule_visit" && hasAny(full, ["measurement", "मेज़रमेंट", "मेजरमेंट", "नाप"])) {
    return {
      selection_chips: [
        { label: "मेज़रमेंट लॉग करें", payload: "measurement log karo" },
        { label: "बाद में", payload: "baad mein" },
      ],
      chips_type: "suggestion",
    };
  }

  return null;
}
