import dedent from "ts-dedent";
import type { AnalyzeSessionV1 } from "@/lib/orchestrator-v1";

const ALLOWED_INTENTS = [
  "GREETING",
  "NEW_LEAD",
  "SCHEDULE_VISIT",
  "UPDATE_EXISTING_LEAD",
  "LOG_MEASUREMENT",
  "GENERATE_QUOTE_OPTIONS",
] as const;

/** Intents for which we run a separate entity-extraction LLM call. */
export const INTENTS_WITH_ENTITY_EXTRACTION = new Set([
  "NEW_LEAD",
  "SCHEDULE_VISIT",
  "UPDATE_EXISTING_LEAD",
  "LOG_MEASUREMENT",
  "GENERATE_QUOTE_OPTIONS",
]);

/**
 * Step 1: Intent-only classification. Small prompt, returns only intents.
 * Use this first; then call buildAnalyzeV1EntitiesPromptForIntent only when top intent needs entities.
 */
export function buildAnalyzeV1IntentPrompt(params: {
  session: AnalyzeSessionV1;
  text: string;
}): string {
  const { session, text } = params;
  const userText = typeof text === "string" ? text : "";

  return dedent(`
    You are a strict intent classifier. Choose exactly one primary intent from the allowed list.

    Allowed intents (use only these exact labels):
    ${ALLOWED_INTENTS.map((i) => `- ${i}`).join("\n")}

    When to use each intent:
    - NEW_LEAD: user wants to create a new painting enquiry / lead (naya kaam, new enquiry).
    - SCHEDULE_VISIT: user clearly wants to fix/book a visit or time slot.
    - UPDATE_EXISTING_LEAD: ONLY when user clearly talks about an old/existing lead and wants to change something (e.g. "purana lead update karo", "existing lead ka number change karo"). Do NOT use this just because the user sent a number or asked for details.
    - LOG_MEASUREMENT: user wants to log measurement(s) for a lead.
    - GENERATE_QUOTE_OPTIONS: user wants quote options for a lead.
    - GREETING: generic hello / chitchat or general questions when no workflow intent matches (including questions like "lead ka details batao / share kar" where user is only asking to hear details, not change anything).

    Special rule for number-only messages:
    - If the user message is only numbers (e.g. a 10-digit phone number) AND the session already has current_intent = "NEW_LEAD" (e.g. we are collecting phone), return NEW_LEAD. Do NOT return UPDATE_EXISTING_LEAD.

    Special rule for "details" questions:
    - If the user says things like "lead ka details batao", "lead ka details share kar", "iss lead ka summary batao", "client ka naam/number/location kya tha" and they are NOT clearly asking to change/update something, classify as GREETING (general question), NOT UPDATE_EXISTING_LEAD.

    Rules:
    - Return exactly one primary intent as the first element. You may include secondary intents if relevant, but the first is the main one.
    - If no workflow intent matches, return GREETING.
    - Do not invent new intent names.

    Return strictly valid JSON only:
    { "intents": string[] }

    Session:
    ${JSON.stringify({ current_intent: session.current_intent })}

    User input:
    ${userText}

    Classification examples (for your understanding):
    - "purana lead ka number change karo" -> UPDATE_EXISTING_LEAD
    - "lead ka details batao" -> GREETING
    - "lead ka details share kar" -> GREETING
    - "iss lead ka summary batao" -> GREETING
  `);
}

/**
 * Step 2: Entity extraction for a specific intent. Call only after intent is known and intent is in INTENTS_WITH_ENTITY_EXTRACTION.
 * Returns prompt string, or null for GREETING (no entity extraction).
 */
export function buildAnalyzeV1EntitiesPromptForIntent(
  intent: string,
  params: { session: AnalyzeSessionV1; text: string }
): string | null {
  const { session, text } = params;

  switch (intent) {
    case "NEW_LEAD":
      return buildNewLeadEntitiesPrompt({ session, text });
    case "SCHEDULE_VISIT":
      return buildScheduleVisitEntitiesPrompt({ session, text });
    case "UPDATE_EXISTING_LEAD":
      return buildUpdateExistingLeadEntitiesPrompt({ session, text });
    case "LOG_MEASUREMENT":
      return buildLogMeasurementEntitiesPrompt({ session, text });
    case "GENERATE_QUOTE_OPTIONS":
      return buildGenerateQuoteOptionsEntitiesPrompt({ session, text });
    default:
      return null;
  }
}

/**
 * Prompt to let the LLM answer a general Hindi/Hinglish question, optionally
 * using lead details as context when available.
 */
export function buildGeneralKnowledgeAnswerPrompt(params: {
  userText: string;
  lead?: unknown;
}): string {
  const { userText, lead } = params;

  return dedent(`
    You are a friendly assistant for a painting contractor.

    The contractor asked (in Hindi/Hinglish):
    "${typeof userText === "string" ? userText : ""}"

    ${
      lead
        ? `Below is JSON for a related lead from their system:\n${JSON.stringify(
            lead,
            null,
            2
          )}\n\nUse it only if it helps answer the question (for example, if they are asking for that lead's details).`
        : "There is no extra lead JSON context for this question."
    }

    Task:
    - Give a short, natural Hindi/Hinglish answer to the contractor's question.
    - If the question is about lead details and lead JSON is provided, summarise key facts (naam, phone, location, BHK, repaint/naya, timing, finish quality) but only when present in JSON.
    - Do NOT invent any data that is not present in the JSON.
    - If the question is more general (not about a specific lead), just answer from your general knowledge about painting work and sales workflow.

    Style:
    - 1–3 sentences max.
    - Use Hinglish like you are talking to a fellow contractor, not the client.
    - Avoid bullet points; make it sound like one spoken answer.

    Return strictly valid JSON only:
    { "message": string }
  `);
}

function buildNewLeadEntitiesPrompt(params: {
  session: AnalyzeSessionV1;
  text: string;
}): string {
  const { session, text } = params;

  return dedent(`
    You are an entity extraction engine for a NEW_LEAD (painting enquiry) flow. Extract only what the user clearly mentioned.

    Entities to extract when relevant:
    - customer_name: string
    - customer_phone: string (e.g. 10-digit Indian number)
    - location_text: string (area / society / city, e.g. "Hiranandani Powai, Mumbai")
    - job_scope: "INTERIOR" | "EXTERIOR" | "BOTH"
    - property_size_type: "1BHK" | "2BHK" | "3BHK" | "OTHER"
    - property_area_sqft: number or string (approx area if user says 1200 sqft etc.)
    - is_repaint: boolean (true if repaint / already painted, false if brand new / naya ghar)
    - start_timing: "THIS_WEEK" | "NEXT_WEEK" | "DATE_FIXED" when user talks about timing
    - start_date: ISO date string when user gives a clear date
    - finish_quality: "BASIC" | "PREMIUM"
    - site_visit_preference: string summary like "morning", "evening", "anytime"

    User messages can be in Hindi / Hinglish. Infer entities accordingly.

    If the user message is only numbers (e.g. 10-digit phone) and the session has current_intent = "NEW_LEAD" with missing_fields including "customer_phone", extract that number as customer_phone.

    If missing_fields includes "customer_name" and the user message is text (not only digits) and not a greeting (e.g. not "hi", "hello", "haan"), treat the message as the customer name and return customer_name with that text (trimmed).

    Return strictly valid JSON only:
    { "entities": { [key: string]: any } }

    Session:
    ${JSON.stringify({
      current_intent: session.current_intent,
      missing_fields: session.missing_fields,
    })}

    User input:
    ${typeof text === "string" ? text : ""}
  `);
}

function buildScheduleVisitEntitiesPrompt(params: {
  session: AnalyzeSessionV1;
  text: string;
}): string {
  const { session, text } = params;

  return dedent(`
    You are an entity extraction engine for a SCHEDULE_VISIT flow. Extract only what the user clearly mentioned.

    Entities to extract when relevant:
    - active_lead_id: string (lead id or reference if user mentions which lead)
    - date: string (visit date, e.g. "15 March", or ISO date if clear)
    - time: string (e.g. "morning", "afternoon", "evening", or specific time)

    User messages can be in Hindi / Hinglish.

    Return strictly valid JSON only:
    { "entities": { [key: string]: any } }

    Session:
    ${JSON.stringify({
      current_intent: session.current_intent,
      missing_fields: session.missing_fields,
    })}

    User input:
    ${typeof text === "string" ? text : ""}
  `);
}

function buildUpdateExistingLeadEntitiesPrompt(params: {
  session: AnalyzeSessionV1;
  text: string;
}): string {
  const { session, text } = params;

  return dedent(`
    You are an entity extraction engine for an UPDATE_EXISTING_LEAD flow. Extract only what the user clearly mentioned.

    Entities to extract when relevant:
    - active_lead_id: string (which lead to update)
    - old_phone: string (current phone if user says "change from X to Y")
    - new_phone: string (new phone number)
    - customer_name: string (if user wants to update name)

    User messages can be in Hindi / Hinglish.

    Return strictly valid JSON only:
    { "entities": { [key: string]: any } }

    Session:
    ${JSON.stringify({
      current_intent: session.current_intent,
      missing_fields: session.missing_fields,
    })}

    User input:
    ${typeof text === "string" ? text : ""}
  `);
}

function buildLogMeasurementEntitiesPrompt(params: {
  session: AnalyzeSessionV1;
  text: string;
}): string {
  const { session, text } = params;

  return dedent(`
    You are an entity extraction engine for a LOG_MEASUREMENT (site measurement + scope clarification) flow. Extract only what the user clearly mentioned.

    Entities to extract when relevant:
    - active_lead_id: string (which lead this measurement is for)
    - paintable_area_sqft: number or string (rough total paintable area if user gives approx sqft)
    - rooms: array of { name?: string; area_sqft?: number | string } when user lists rooms/areas separately
    - ceiling_included: boolean (true if ceiling included in painting scope, false if not)
    - prep_level: string (short summary like "1 coat putty, 2 coat primer")
    - damp_issue: { has_issue: boolean; locations?: string } ("cracks/dampness" info, with where if mentioned)
    - scrape_required: boolean (true if old paint scraping required, false if only light sanding)
    - brand_preference: string (e.g. "Asian Paints", "Berger", "Nerolac", "Dulux", or "no preference")
    - finish: string (e.g. "matt", "satin", "shine", "texture", or any finish words user mentions)

    Additionally, capture any paint-surface issues the user clearly mentions:
    - issues: array of {
        description: string;      // short natural language summary in the user's words
        locations?: string;       // where the issue is (e.g. "bedroom ki ek wall", "ceiling near window")
      }

    Do NOT guess problems or upgrades that the user did not mention.
    If the user does NOT mention any such problem, keep issues as an empty array (or omit it).

    User messages can be in Hindi / Hinglish.

    Return strictly valid JSON only:
    { "entities": { [key: string]: any } }

    Session:
    ${JSON.stringify({
      current_intent: session.current_intent,
      missing_fields: session.missing_fields,
    })}

    User input:
    ${typeof text === "string" ? text : ""}
  `);
}

function buildGenerateQuoteOptionsEntitiesPrompt(params: {
  session: AnalyzeSessionV1;
  text: string;
}): string {
  const { session, text } = params;

  return dedent(`
    You are an entity extraction engine for a GENERATE_QUOTE_OPTIONS flow. Extract only what the user clearly mentioned.

    Entities to extract when relevant:
    - active_lead_id: string (which lead to generate quote for)
    - quote_type: "LABOUR_ONLY" | "LABOUR_PLUS_MATERIAL"
      - LABOUR_ONLY: when user says only labour, labour-only, sirf labour
      - LABOUR_PLUS_MATERIAL: when user says labour + material, material bhi aap hi de do, turnkey, etc.
    - rate_band: "BASIC" | "STANDARD" | "PREMIUM"
      - BASIC: entry-level/budget range
      - STANDARD: normal/standard range
      - PREMIUM: high-end/premium range
    - timeline_days: number or string (approx total days to complete work, e.g. "7 din", "10-12 din", "2 week")
    - advance: { type: "PERCENTAGE" | "FIXED_AMOUNT"; value: number | string }
      - type = "PERCENTAGE" when user says 30%, 40 percent, aadha payment, etc.
      - type = "FIXED_AMOUNT" when user gives a rupee amount (e.g. 20000, 50k)

    Mapping from common Hindi/Hinglish phrases:
    - If user says "labour-only", "sirf labour", "material client dega" → quote_type = "LABOUR_ONLY".
    - If user says "labour + material", "material bhi aap de do", "turnkey" → quote_type = "LABOUR_PLUS_MATERIAL".
    - If user says "basic", "standard", "premium" (in any case/spelling) → map directly to rate_band.
    - If user gives duration like "7 din", "10–12 din", "2 week" → put full text in timeline_days (do NOT try to over-normalise).
    - If user says "30 percent", "30%", "aadha payment", etc. → advance.type = "PERCENTAGE" and advance.value = that percent text/number.
    - If user gives a rupee value for advance (e.g. "20000", "50k") → advance.type = "FIXED_AMOUNT" and advance.value = that amount.

    User messages can be in Hindi / Hinglish.

    Return strictly valid JSON only:
    { "entities": { [key: string]: any } }

    Session:
    ${JSON.stringify({
      current_intent: session.current_intent,
      missing_fields: session.missing_fields,
    })}

    User input:
    ${typeof text === "string" ? text : ""}
  `);
}
