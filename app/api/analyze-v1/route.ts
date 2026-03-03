import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { generateGeminiJson } from "@/lib/gemini";
import {
  AnalyzeSessionV1,
  DEFAULT_SESSION,
  orchestrateV1,
} from "@/lib/orchestrator-v1";
import {
  buildAnalyzeV1IntentPrompt,
  buildAnalyzeV1EntitiesPromptForIntent,
  buildGeneralKnowledgeAnswerPrompt,
  buildCapabilityRouterPrompt,
  INTENTS_WITH_ENTITY_EXTRACTION,
} from "@/lib/prompts/analyze-v1";
import {
  createLeadFromEntities,
  updateLeadFromEntities,
  upsertMeasurementFromEntities,
  upsertVisitFromEntities,
  getLeadByIdForUser,
  getRecentLeadsForUser,
  getLeadDetailsForUser,
  getVisitForLead,
  getMeasurementForLead,
} from "@/lib/mongo";
import { buildQuotePdfBuffer } from "@/lib/quotePdf";
import { uploadQuotePdfToS3 } from "@/lib/s3";

// Use the Node.js runtime so the Gemini SDK can access required Node APIs.
export const runtime = "nodejs";

const BOT_SESSION_KEY = (userId: string) => `bot:session:${userId}`;

function isDontKnow(text: string): boolean {
  const lower = text.toLowerCase();
  const patterns = [
    "pata nahi",
    "pata nhi",
    "pata nai",
    "mujhe nahi pata",
    "mujhe nhi pata",
    "nahi pata",
    "nhi pata",
    "malum nahi",
    "maloom nahi",
  ];
  return patterns.some((p) => lower.includes(p));
}

function isBothJobScopeAnswer(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;

  // Common Hinglish/Hindi ways to say "both" when asked interior vs exterior
  const patterns = [
    "dono",
    "dono hi",
    "both",
    "interior aur exterior",
    "interior or exterior dono",
    "interior and exterior",
  ];

  return patterns.some((p) => lower === p || lower.includes(p));
}

/**
 * POST /api/analyze-v1
 * --------------------
 * Lightweight v1 intent + entity detection + orchestration endpoint.
 *
 * Flow:
 *   1. Read JSON body containing userId + text.
 *   2. Retrieve Redis session at bot:session:{userId}; if none, use default.
 *   3. Call Gemini for intent-only classification (small prompt).
 *   4. If top intent needs entities (NEW_LEAD, SCHEDULE_VISIT, etc.), call Gemini again with intent-specific entity prompt; skip for GREETING.
 *   5. Call orchestrateV1({ session, intents, entities, text }).
 *   6. Save orchestrator result.session back to Redis with 30min expiry.
 *   7. Return a structured status response based on orchestrator result.
 */

type AnalyzeRequestBody = {
  userId: string;
  text: string;
};

type AnalyzeResult = {
  intents: string[];
  entities: Record<string, unknown>;
};

const DEFAULT_RESULT: AnalyzeResult = {
  intents: [],
  entities: {},
};

type AnalyzeV1Response =
  | {
      status: "incomplete";
      question: string;
      question_examples?: string[];
    }
  | {
      status: "ready";
      intent: string | null;
      entities: Record<string, unknown>;
      quote_pdf_url?: string;
      /**
       * Optional natural-language message (e.g. lead details summary)
       * that the frontend can speak/show directly.
       */
      message?: string;
      /**
       * Optional raw lead details when user asks to view a lead.
       */
      lead_details?: Record<string, unknown>;
      /**
       * Optional hint for what the next high-level step could be.
       * Example: after NEW_LEAD is ready, suggest SCHEDULE_VISIT.
       */
      next_suggested_intents?: string[];
    }
  | {
      status: "noop";
    };

// Main entry point for this API: takes chat text + userId and returns next step.
export async function POST(req: NextRequest) {
  let body: AnalyzeRequestBody;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ...DEFAULT_RESULT }, { status: 400 });
  }

  // Read userId and user message from the incoming request.
  const { userId, text } = body ?? {};

  if (!userId || typeof userId !== "string") {
    return NextResponse.json({ ...DEFAULT_RESULT }, { status: 400 });
  }

  // Build Redis key and fetch the latest conversation state for this user.
  const key = BOT_SESSION_KEY(userId);
  const raw = await redis.get<AnalyzeSessionV1>(key);
  console.log("======== [api/analyze-v1] REDIS SESSION: RAW ========");
  console.dir({ key, raw }, { depth: null });
  // Normalise the stored session into a safe default shape.
  const session: AnalyzeSessionV1 = raw
    ? {
        current_intent: raw.current_intent ?? null,
        entities: raw.entities && typeof raw.entities === "object" ? raw.entities : {},
        missing_fields: Array.isArray(raw.missing_fields) ? raw.missing_fields : [],
        active_lead_id: raw.active_lead_id ?? null,
        pending_intent_switch_to: raw.pending_intent_switch_to ?? null,
        pending_phone_candidate: raw.pending_phone_candidate ?? null,
      }
    : { ...DEFAULT_SESSION };

  const textStr = typeof text === "string" ? text.trim() : "";

  try {
    // If we are mid-flow and only waiting for an active_lead_id, and the user
    // sends something that looks like a Mongo ObjectId, treat it as a lead
    // selection: fetch that lead from MongoDB and hydrate the session so that
    // downstream steps (like LOG_MEASUREMENT) can continue without asking again.
    let sessionForFlow: AnalyzeSessionV1 = session;

    const looksLikeObjectId =
      typeof textStr === "string" && /^[0-9a-fA-F]{24}$/.test(textStr);

    if (
      looksLikeObjectId &&
      Array.isArray(sessionForFlow.missing_fields) &&
      sessionForFlow.missing_fields.includes("active_lead_id")
    ) {
      try {
        console.log(
          "======== [api/analyze-v1] MONGO LOOKUP: LEAD BY ID FOR USER ========"
        );
        console.dir(
          {
            userId,
            currentIntent: sessionForFlow.current_intent,
            missing_fields: sessionForFlow.missing_fields,
            text: textStr,
          },
          { depth: null }
        );

        const selectedLead = await getLeadByIdForUser({
          userId,
          leadId: textStr,
        });

        if (selectedLead) {
          const updatedMissingFields = sessionForFlow.missing_fields.filter(
            (field) => field !== "active_lead_id"
          );

          sessionForFlow = {
            ...sessionForFlow,
            active_lead_id: selectedLead.id,
            entities: {
              ...(sessionForFlow.entities ?? {}),
              active_lead_id: selectedLead.id,
              customer_name: selectedLead.customer_name ?? undefined,
              customer_phone: selectedLead.customer_phone ?? undefined,
              location_text: selectedLead.location_text ?? undefined,
            },
            missing_fields: updatedMissingFields,
          };
        }
      } catch (lookupErr) {
        console.error(
          "[api/analyze-v1] Error while fetching lead by id for user:",
          lookupErr
        );
      }
    }

    // Step 0: High-level capability routing (FLOW_START vs DATA_RETRIEVAL, etc.).
    const capabilityPrompt = buildCapabilityRouterPrompt({
      session: sessionForFlow,
      text: textStr,
    });
    console.log(
      "======== [api/analyze-v1] LLM CALL (CAPABILITY): REQUEST ========"
    );
    console.log(capabilityPrompt);

    const capabilityParsed = await generateGeminiJson<{ capability?: string }>({
      prompt: capabilityPrompt,
    });
    console.log(
      "======== [api/analyze-v1] LLM CALL (CAPABILITY): RESPONSE ========"
    );
    console.dir(capabilityParsed, { depth: null });

    const capability =
      typeof capabilityParsed.capability === "string"
        ? capabilityParsed.capability
        : null;

    // Fast path: handle pure data-retrieval questions separately so things like
    // "kab schedule visit hai?" don't get treated as a fresh SCHEDULE_VISIT flow.
    if (capability === "DATA_RETRIEVAL") {
      const activeLeadId =
        sessionForFlow.active_lead_id &&
        typeof sessionForFlow.active_lead_id === "string"
          ? sessionForFlow.active_lead_id
          : null;

      // If we don't know which lead they are talking about, fall back to the
      // normal flow for now (which might ask them to pick a lead).
      if (activeLeadId) {
        let message: string | null = null;
        let knowledgeLeadDetails: Record<string, unknown> | null = null;
        let knowledgeVisitDetails: Record<string, unknown> | null = null;
        let knowledgeMeasurementDetails: Record<string, unknown> | null = null;

        try {
          const [lead, visit, measurement] = await Promise.all([
            getLeadDetailsForUser({
              userId,
              leadId: activeLeadId,
            }),
            getVisitForLead({ leadId: activeLeadId }),
            getMeasurementForLead({ leadId: activeLeadId }),
          ]);

          if (lead) {
            knowledgeLeadDetails = lead as unknown as Record<string, unknown>;
          }

          if (visit && (visit.date || visit.time)) {
            knowledgeVisitDetails =
              visit as unknown as Record<string, unknown>;
          }

          if (measurement) {
            knowledgeMeasurementDetails =
              measurement as unknown as Record<string, unknown>;
          }

          const knowledgePrompt = buildGeneralKnowledgeAnswerPrompt({
            userText: textStr,
            ...(knowledgeLeadDetails ? { lead: knowledgeLeadDetails } : {}),
            ...(knowledgeVisitDetails ? { visit: knowledgeVisitDetails } : {}),
            ...(knowledgeMeasurementDetails
              ? { measurement: knowledgeMeasurementDetails }
              : {}),
          });

          const knowledgeParsed = await generateGeminiJson<{
            message?: string;
          }>({
            prompt: knowledgePrompt,
          });

          if (
            knowledgeParsed &&
            typeof knowledgeParsed.message === "string" &&
            knowledgeParsed.message.trim().length > 0
          ) {
            message = knowledgeParsed.message.trim();
          }

          if (!message) {
            if (knowledgeMeasurementDetails) {
              message =
                "Measurement / scope details nikalte waqt koi clear summary nahi mili, lekin data system mein saved hai.";
            } else if (knowledgeVisitDetails) {
              message =
                "Visit/ schedule details nikalte waqt koi clear summary nahi mili, lekin data system mein saved hai.";
            } else if (knowledgeLeadDetails) {
              message =
                "Lead details nikalte waqt koi clear summary nahi mili, lekin data system mein saved hai.";
            } else {
              message =
                "Is lead ke liye koi additional details nahi mile, lekin agar kuch hoga toh system mein save rahega.";
            }
          }
        } catch (err) {
          console.error(
            "[api/analyze-v1] Error while fetching data for DATA_RETRIEVAL:",
            err
          );
          message =
            "Details nikalte waqt error aaya, thodi der baad phir se try kariye.";
        }

        console.log("======== [api/analyze-v1] SESSION: WRITE TO REDIS ========");
        console.dir(
          {
            key,
            session: sessionForFlow,
          },
          { depth: null }
        );

        await redis.set(key, sessionForFlow);

        return NextResponse.json<AnalyzeV1Response>({
          status: "ready",
          intent: "DATA_RETRIEVAL",
          entities: sessionForFlow.entities ?? {},
          ...(message ? { message } : {}),
          ...(knowledgeLeadDetails ? { lead_details: knowledgeLeadDetails } : {}),
        });
      }
    }

    // Step 1: Intent-only classification (small prompt) for FLOW_START-like flows.
    const intentPrompt = buildAnalyzeV1IntentPrompt({
      session: sessionForFlow,
      text: textStr,
    });
    console.log("======== [api/analyze-v1] LLM CALL (INTENT): REQUEST ========");
    console.log(intentPrompt);

    const intentParsed = await generateGeminiJson<{ intents?: string[] }>({
      prompt: intentPrompt,
    });
    console.log("======== [api/analyze-v1] LLM CALL (INTENT): RESPONSE ========");
    console.dir(intentParsed, { depth: null });

    const intents = Array.isArray(intentParsed.intents)
      ? intentParsed.intents.filter((i): i is string => typeof i === "string")
      : [];

    let entities: Record<string, unknown> = {};

    // Step 2: Entity extraction.
    // If we are mid-flow with a current_intent and still have missing_fields,
    // prefer that intent for entities instead of a generic GREETING
    // classification. This lets short answers like "Sirf sanding chalega"
    // correctly fill LOG_MEASUREMENT fields instead of being treated as chit‑chat.
    const topIntent = intents[0] ?? null;
    const effectiveIntentForEntities =
      sessionForFlow.current_intent &&
      Array.isArray(sessionForFlow.missing_fields) &&
      sessionForFlow.missing_fields.length > 0
        ? sessionForFlow.current_intent
        : topIntent;

    // Lightweight heuristic: if we are in NEW_LEAD flow, currently asking for
    // job_scope, and the contractor replies with a short "both" style answer
    // like "dono", fill job_scope directly without an LLM round-trip.
    const isAwaitingJobScope =
      effectiveIntentForEntities === "NEW_LEAD" &&
      Array.isArray(sessionForFlow.missing_fields) &&
      sessionForFlow.missing_fields.includes("job_scope");

    if (isAwaitingJobScope && isBothJobScopeAnswer(textStr)) {
      entities.job_scope = "BOTH";
    }

    if (
      effectiveIntentForEntities &&
      INTENTS_WITH_ENTITY_EXTRACTION.has(effectiveIntentForEntities) &&
      Object.keys(entities).length === 0
    ) {
      const entityPrompt = buildAnalyzeV1EntitiesPromptForIntent(
        effectiveIntentForEntities,
        {
          session: sessionForFlow,
          text: textStr,
        }
      );
      if (entityPrompt) {
        console.log("======== [api/analyze-v1] LLM CALL (ENTITIES): REQUEST ========");
        console.log(entityPrompt);

        const entityParsed = await generateGeminiJson<{
          entities?: Record<string, unknown>;
        }>({
          prompt: entityPrompt,
        });
        console.log("======== [api/analyze-v1] LLM CALL (ENTITIES): RESPONSE ========");
        console.dir(entityParsed, { depth: null });

        entities =
          entityParsed.entities && typeof entityParsed.entities === "object"
            ? (entityParsed.entities as Record<string, unknown>)
            : {};
      }
    }

    // Hand over everything to the orchestrator, which decides the next step.
    console.log("======== [api/analyze-v1] ORCHESTRATOR CALL: INPUT ========");
    console.dir(
      {
        session: sessionForFlow,
        intents,
        entities,
        text: textStr,
      },
      { depth: null }
    );

    const orchestratorResult = orchestrateV1({
      session: sessionForFlow,
      intents,
      entities,
      text: textStr,
    });

    // Orchestrator decides if we should ask a question, are ready, or do nothing.
    console.log("======== [api/analyze-v1] ORCHESTRATOR CALL: RESULT ========");
    console.dir(orchestratorResult, { depth: null });

    // Persist lead-related data in MongoDB when a flow step is fully ready.
    let sessionToPersist: AnalyzeSessionV1 = orchestratorResult.session;
    const currentIntent =
      sessionToPersist.current_intent ?? (intents[0] ?? null);

    let overriddenIncompleteQuestion: string | null = null;

    // If user says "pata nahi" when we are asking for active_lead_id,
    // look up their recent leads in MongoDB and suggest options instead
    // of blindly repeating the same question.
    if (
      orchestratorResult.status === "incomplete" &&
      currentIntent &&
      Array.isArray(sessionToPersist.missing_fields) &&
      sessionToPersist.missing_fields.includes("active_lead_id") &&
      isDontKnow(textStr)
    ) {
      try {
        console.log(
          "======== [api/analyze-v1] MONGO LOOKUP: RECENT LEADS FOR USER ========"
        );
        console.dir(
          {
            userId,
            currentIntent,
            missing_fields: sessionToPersist.missing_fields,
            text: textStr,
          },
          { depth: null }
        );

        const recentLeads = await getRecentLeadsForUser({ userId, limit: 5 });

        console.log(
          "[api/analyze-v1] Mongo recent leads fetched:",
          recentLeads.length
        );

        if (recentLeads.length > 0) {
          const lines = recentLeads.map((lead, idx) => {
            const parts: string[] = [];
            if (lead.customer_name) parts.push(lead.customer_name);
            if (lead.location_text) parts.push(lead.location_text);
            const main = parts.join(" - ") || "Unnamed lead";
            const phone = lead.customer_phone ? `, Phone: ${lead.customer_phone}` : "";
            return `${idx + 1}) ${main}${phone} (ID: ${lead.id})`;
          });

          const header = "Koi baat nahi. Aapke naam pe kuch leads mile:";

          let actionLine = "kaam karna hai";
          if (currentIntent === "LOG_MEASUREMENT") {
            actionLine = "measurement log karna hai";
          } else if (currentIntent === "SCHEDULE_VISIT") {
            actionLine = "visit schedule karni hai";
          } else if (currentIntent === "GENERATE_QUOTE_OPTIONS") {
            actionLine = "quote options chahiye";
          } else if (currentIntent === "UPDATE_EXISTING_LEAD") {
            actionLine = "update karna hai";
          }

          const footer = `Inmein se kaunse lead ke liye ${actionLine}? Lead ID ya naam/number bata dijiye.`;

          overriddenIncompleteQuestion = [header, ...lines, footer].join("\n");
        } else {
          let actionLine = "kaam ke liye";
          if (currentIntent === "LOG_MEASUREMENT") {
            actionLine = "measurement ke liye";
          } else if (currentIntent === "SCHEDULE_VISIT") {
            actionLine = "visit ke liye";
          } else if (currentIntent === "GENERATE_QUOTE_OPTIONS") {
            actionLine = "quote options ke liye";
          } else if (currentIntent === "UPDATE_EXISTING_LEAD") {
            actionLine = "update ke liye";
          }

          overriddenIncompleteQuestion =
            `Mujhe aapke naam se koi existing lead nahi mila ${actionLine}. ` +
            `Pehle ek naya lead add kar lijiye, phir uske liye ${actionLine} wapas bol sakte hain.`;
        }
      } catch (lookupErr) {
        console.error(
          "[api/analyze-v1] Error while fetching recent leads for user:",
          lookupErr
        );
      }
    }

    let quotePdfUrl: string | null = null;
    let knowledgeMessage: string | null = null;
    let knowledgeLeadDetails: Record<string, unknown> | null = null;

    if (orchestratorResult.status === "ready" && currentIntent) {
      const entitiesForDb =
        (sessionToPersist.entities &&
          typeof sessionToPersist.entities === "object"
          ? (sessionToPersist.entities as Record<string, unknown>)
          : {}) ?? {};

      try {
        if (currentIntent === "NEW_LEAD") {
          // If this is the first time we are completing NEW_LEAD, create a fresh lead.
          if (!sessionToPersist.active_lead_id) {
            const newLeadId = await createLeadFromEntities({
              userId,
              entities: entitiesForDb,
            });
            if (newLeadId) {
              sessionToPersist = {
                ...sessionToPersist,
                active_lead_id: newLeadId,
                entities: {
                  ...entitiesForDb,
                  active_lead_id: newLeadId,
                },
              };
            }
          } else {
            // NEW_LEAD completed again for an existing lead → treat as lead update.
            await updateLeadFromEntities({
              leadId: sessionToPersist.active_lead_id,
              entities: entitiesForDb,
            });
          }
        } else if (
          currentIntent === "UPDATE_EXISTING_LEAD" &&
          sessionToPersist.active_lead_id
        ) {
          await updateLeadFromEntities({
            leadId: sessionToPersist.active_lead_id,
            entities: entitiesForDb,
          });
        } else if (
          currentIntent === "SCHEDULE_VISIT" &&
          sessionToPersist.active_lead_id
        ) {
          await upsertVisitFromEntities({
            leadId: sessionToPersist.active_lead_id,
            entities: entitiesForDb,
          });
        } else if (
          currentIntent === "LOG_MEASUREMENT" &&
          sessionToPersist.active_lead_id
        ) {
          await upsertMeasurementFromEntities({
            leadId: sessionToPersist.active_lead_id,
            entities: entitiesForDb,
          });
        } else if (
          currentIntent === "GENERATE_QUOTE_OPTIONS" &&
          sessionToPersist.active_lead_id
        ) {
          try {
            const pdfBuffer = await buildQuotePdfBuffer(
              (sessionToPersist.entities ??
                {}) as Record<string, unknown>
            );
            quotePdfUrl = await uploadQuotePdfToS3(
              pdfBuffer,
              sessionToPersist.active_lead_id
            );
          } catch (pdfErr) {
            console.error(
              "[api/analyze-v1] Error while generating/uploading quote PDF:",
              pdfErr
            );
          }
        }
      } catch (persistErr) {
        console.error(
          "[api/analyze-v1] Error while persisting lead data to MongoDB:",
          persistErr
        );
      }
    }

    // Save the updated conversation state so the next message continues smoothly.
    console.log("======== [api/analyze-v1] SESSION: WRITE TO REDIS ========");
    console.dir(
      {
        key,
        session: sessionToPersist,
      },
      { depth: null }
    );

    await redis.set(key, sessionToPersist);

    // If more information is needed, send back a friendly follow‑up question.
    if (orchestratorResult.status === "incomplete") {
      return NextResponse.json<AnalyzeV1Response>({
        status: "incomplete",
        question: overriddenIncompleteQuestion ?? orchestratorResult.question,
        ...(overriddenIncompleteQuestion
          ? {}
          : orchestratorResult.question_examples
          ? { question_examples: orchestratorResult.question_examples }
          : {}),
      });
    }

    // If we have all details, tell the app which intent is ready and the data we captured.
    if (orchestratorResult.status === "ready") {
      const intent = sessionToPersist.current_intent ?? null;

      let next_suggested_intents: string[] | undefined;
      if (intent === "NEW_LEAD") {
        const entitiesForResponse =
          sessionToPersist.entities &&
          typeof sessionToPersist.entities === "object"
            ? (sessionToPersist.entities as Record<string, unknown>)
            : {};

        const dateValue = entitiesForResponse.date as unknown;
        const hasDate =
          (typeof dateValue === "string" && dateValue.trim().length > 0) ||
          (dateValue !== null && dateValue !== undefined);

        next_suggested_intents = hasDate ? ["LOG_MEASUREMENT"] : ["SCHEDULE_VISIT"];
      } else if (intent === "LOG_MEASUREMENT") {
        // After logging measurement, the natural next step is to generate quote options.
        next_suggested_intents = ["GENERATE_QUOTE_OPTIONS"];
      }

      // For GREETING / general questions, optionally answer using
      // general knowledge and the active lead as context when present.
      if (intent === "GREETING") {
        let leadForKnowledge: Record<string, unknown> | undefined;
        let visitForKnowledge: Record<string, unknown> | undefined;
        let measurementForKnowledge: Record<string, unknown> | undefined;

        const activeLeadId =
          sessionToPersist.active_lead_id &&
          typeof sessionToPersist.active_lead_id === "string"
            ? sessionToPersist.active_lead_id
            : undefined;

        if (activeLeadId) {
          try {
            const [lead, visit, measurement] = await Promise.all([
              getLeadDetailsForUser({
                userId,
                leadId: activeLeadId,
              }),
              getVisitForLead({ leadId: activeLeadId }),
              getMeasurementForLead({ leadId: activeLeadId }),
            ]);
            if (lead) {
              knowledgeLeadDetails =
                lead as unknown as Record<string, unknown>;
              leadForKnowledge = knowledgeLeadDetails;
            }
            if (visit && (visit.date || visit.time)) {
              visitForKnowledge = visit as unknown as Record<string, unknown>;
            }
            if (measurement) {
              measurementForKnowledge =
                measurement as unknown as Record<string, unknown>;
            }
          } catch (err) {
            console.error(
              "[api/analyze-v1] Error while fetching lead/visit/measurement for general knowledge answer:",
              err
            );
          }
        }

        try {
          const knowledgePrompt = buildGeneralKnowledgeAnswerPrompt({
            userText: textStr,
            lead: leadForKnowledge,
            visit: visitForKnowledge,
            measurement: measurementForKnowledge,
          });

          const knowledgeParsed = await generateGeminiJson<{ message?: string }>(
            {
              prompt: knowledgePrompt,
            }
          );

          if (
            knowledgeParsed &&
            typeof knowledgeParsed.message === "string" &&
            knowledgeParsed.message.trim().length > 0
          ) {
            knowledgeMessage = knowledgeParsed.message.trim();
          }
        } catch (err) {
          console.error(
            "[api/analyze-v1] Error while generating general knowledge answer:",
            err
          );
        }
      }

      return NextResponse.json<AnalyzeV1Response>({
        status: "ready",
        intent,
        entities: sessionToPersist.entities ?? {},
        ...(quotePdfUrl ? { quote_pdf_url: quotePdfUrl } : {}),
        ...(knowledgeMessage ? { message: knowledgeMessage } : {}),
        ...(knowledgeLeadDetails ? { lead_details: knowledgeLeadDetails } : {}),
        ...(next_suggested_intents
          ? { next_suggested_intents }
          : {}),
      });
    }

    // Fallback: nothing to do for this message.
    return NextResponse.json<AnalyzeV1Response>({
      status: "noop",
    });
  } catch (err) {
    console.error("[api/analyze-v1] Error calling Gemini:", err);
    return NextResponse.json({ ...DEFAULT_RESULT }, { status: 502 });
  }
}

