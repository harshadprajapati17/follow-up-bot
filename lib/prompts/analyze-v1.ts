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

const ALLOWED_CAPABILITIES = [
  "FLOW_START",
  "DATA_RETRIEVAL",
  "DATA_UPDATE",
  "CHAT",
] as const;

export type Capability = (typeof ALLOWED_CAPABILITIES)[number];

/** Intents for which we run a separate entity-extraction LLM call. */
export const INTENTS_WITH_ENTITY_EXTRACTION = new Set([
  "NEW_LEAD",
  "SCHEDULE_VISIT",
  "UPDATE_EXISTING_LEAD",
  "LOG_MEASUREMENT",
  "GENERATE_QUOTE_OPTIONS",
]);

/**
 * Step 0: High‑level capability routing. Very small prompt that decides whether
 * the message is starting/continuing a workflow, asking for existing data,
 * updating existing data, or just chatting.
 */
export function buildCapabilityRouterPrompt(params: {
  session: AnalyzeSessionV1;
  text: string;
}): string {
  const { session, text } = params;
  const userText = typeof text === "string" ? text : "";

  return dedent(`
    You are a high-level router for a painting contractor's assistant. Your job is to decide what kind of action the user message is asking for.

    CAPABILITIES (pick exactly ONE):
    - FLOW_START
      - User wants to start or continue a structured workflow like:
        - New painting enquiry / lead (naya kaam, new enquiry)
        - Schedule / reschedule a site visit
        - Log site measurement
        - Generate quote options
      - Examples:
        - "naya kaam hai"
        - "new lead add karo"
        - "kal visit schedule karni hai"
        - "measurement log karo"
        - "quote banao"

    - DATA_RETRIEVAL
      - User is asking to view or hear information about something that already exists in the system.
      - No new work is being created; they just want status / summary / schedule / details.
      - Common patterns:
        - Visit timing questions: user mentions "visit" or "site" together with WHEN/ timing words like "kab", "kaunsi date", "date", "time", "slot", "timing", "kitne baje", "schedule kya hai".
        - Lead summary / details: "iss lead ka details/summary batao", "client ka naam/number/location kya tha", "lead ka status kya hai".
        - Quote / measurement status: "quote bheja kya?", "quote ka link bhejo", "measurement kya log hua hai?".
      - Example messages:
        - "visit kab hai?"
        - "kab schedule wali visit hai?"
        - "kal wali visit ka time kya hai?"
        - "iss lead ka summary share karo"
        - "quote bheja kya?"

    - DATA_UPDATE
      - User wants to change/update existing saved information (not just hear it).
      - Common patterns:
        - Lead field changes: "number badal do", "client ka naam update karo", "location change karna hai".
        - Visit changes: "visit ka time change kar do", "kal wali visit cancel karni hai", "visit ko next week shift karo".
        - Scope changes: "color update karna hai", "job scope change karna hai".

    - CHAT
      - Greetings, chitchat, or general questions not clearly tied to a workflow or a specific saved item.
      - Examples:
        - "hi", "hello", "namaste"
        - "kaise ho?"
        - General painting questions like "interior ke liye kaunsa paint best hai?"

    Current session context (for your understanding only):
    ${JSON.stringify(
      {
        current_intent: session.current_intent,
        active_lead_id: session.active_lead_id,
      },
      null,
      2
    )}

    User message:
    """${userText}"""

    Rules:
    - Choose exactly ONE capability from: ${ALLOWED_CAPABILITIES.join(", ")}.
    - If the user is clearly asking "kab visit hai", "visit kab hai", "kab schedule visit hai" or similar, choose DATA_RETRIEVAL (they are asking WHEN, not booking a new visit).
    - If the message is only greeting / small talk and no clear work, choose CHAT.
    - If the message clearly starts/continues a NEW_LEAD / SCHEDULE_VISIT / LOG_MEASUREMENT / GENERATE_QUOTE_OPTIONS style flow, choose FLOW_START.
    - If the message clearly asks to change/update stored data, choose DATA_UPDATE.

    Return strictly valid JSON only:
    { "capability": string }
  `);
}

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
    - UPDATE_EXISTING_LEAD: when user clearly talks about an old/existing lead and wants to change any already-captured lead details, including core fields (name, phone, location, job scope, BHK/area, repaint vs new, timing, finish, visit preference) **and** quote-related parameters (advance amount, rate band, quote type, timeline). Examples: "purana lead update karo", "existing lead ka number change karo", "advance amount change karna hai", "timeline 7 din kar do", "basic ki jagah premium quote chahiye". Do NOT use this just because the user sent a number or asked only to hear details.
    - LOG_MEASUREMENT: user wants to log measurement(s) for a lead.
    - GENERATE_QUOTE_OPTIONS: user wants to freshly generate quote options for a lead (e.g. "quote banao", "3 options bana do", "quote ready karo") when the focus is on creating/refreshing options, not just updating a single saved field.
    - GREETING: generic hello / chitchat or general questions when no workflow intent matches (including questions like "lead ka details batao / share kar" where user is only asking to hear details, not change anything).

    Special rule when session.current_intent = "NEW_LEAD":
    - If the message looks like a short property / location description (e.g. "2BHK", "3BHK", "3Bed room, hall kitchen", "2 bedroom hall kitchen") and does NOT clearly talk about technical measurement details (sqft, paintable area, coats, putty, dampness, scraping, "measurement log karo", etc.), keep the primary intent as NEW_LEAD and treat it as part of the same lead description, NOT LOG_MEASUREMENT.

    Special rule for number-only messages:
    - If the user message is only numbers (e.g. a 10-digit phone number) AND the session already has current_intent = "NEW_LEAD" (e.g. we are collecting phone), return NEW_LEAD. Do NOT return UPDATE_EXISTING_LEAD.

    Special rule for "details" questions:
    - If the user says things like "lead ka details batao", "lead ka details share kar", "iss lead ka summary batao", "client ka naam/number/location kya tha" and they are NOT clearly asking to change/update something, classify as GREETING (general question), NOT UPDATE_EXISTING_LEAD.

    Special rule for quote-parameter change requests:
    - If the user clearly talks about changing quote-related values like advance amount, rate band (basic/standard/premium), quote type (labour-only vs labour + material), or timeline (kitne din), and they use words like "change", "update", "badal", "badha", "ghata", prefer UPDATE_EXISTING_LEAD even if they don't yet give the new value.

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
    - "advance amount change karna hai" -> UPDATE_EXISTING_LEAD
    - "timeline 7 din kar do" -> UPDATE_EXISTING_LEAD
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
  /**
   * Optional visit schedule JSON (date/time) for the active lead, when available.
   * This lets the LLM answer questions like "visit kab hai" or "schedule ka details batao"
   * using structured data instead of guessing.
   */
  visit?: unknown;
  /**
   * Optional measurement / scope JSON for the active lead, when available.
   * This includes paintable areas, rooms, issues, and recommended_addons so the LLM
   * can answer questions like "measurement kya log hua hai", "issues kya aaye the",
   * or "addons kya suggest kiye the".
   */
  measurement?: unknown;
}): string {
  const { userText, lead, visit, measurement } = params;

  return dedent(`
    You are a friendly assistant for a painting contractor.

    The contractor asked (in Hindi/Hinglish):
    "${typeof userText === "string" ? userText : ""}"

    ${
      lead
        ? `Below is JSON for a related lead from their system (lead details):\n${JSON.stringify(
            lead,
            null,
            2
          )}\n`
        : "There is no extra lead JSON context for this question.\n"
    }${
      visit
        ? `\nAdditionally, below is JSON for the scheduled visit for this lead (if any):\n${JSON.stringify(
            visit,
            null,
            2
          )}\n`
        : ""
    }${
      measurement
        ? `\nAdditionally, below is JSON for the logged measurement / scope for this lead (if any):\n${JSON.stringify(
            measurement,
            null,
            2
          )}\n`
        : ""
    }

    Task:
    - Give a short, natural Hindi/Hinglish answer to the contractor's question.
    - If the question is about lead details and lead JSON is provided, summarise key facts (naam, phone, location, BHK, repaint/naya, timing, finish quality) but only when present in JSON.
    - If the question is about visit schedule / timing and visit JSON is provided (with date/time), clearly answer using those fields (e.g. "Is lead ka visit 15 March ko shaam 7 baje scheduled hai").
    - If the question is about site measurement, scope, issues, ya recommended add-ons (damp treatment, crack repair, etc.) and measurement JSON is provided, answer directly from that JSON (for example, total area, issues list, or recommended_addons labels).
    - Do NOT invent any data that is not present in the JSON.
    - If the question is more general (not about a specific lead), just answer from your general knowledge about painting work and sales workflow.

    Style:
    - 1–3 sentences max.
    - Use Hinglish like you are talking to a fellow contractor, not the client.
    - Avoid informal filler exclamations like "arre", "arey", "yaar", or anything that can sound disrespectful or too casual.
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

    Entities represent fields on the existing lead document in MongoDB.
    You should allow updating any field that is stored on the lead, but NEVER change the lead's id.

    Core identifier (only for selecting which lead to update, not for changing the id):
    - active_lead_id: string (which lead to update – this maps to the Mongo _id; do NOT invent or modify it, only copy what user/flow provides)

    Lead fields that can be updated when the user asks for a change (examples of natural language hints in brackets):
    - customer_name: string                      (e.g. "naam change karna hai", "customer ka naam update karo")
    - customer_phone: string                     (e.g. "number change karna hai", "phone update karo")
    - location_text: string                      (e.g. "location change karni hai", "address ab Andheri hai")
    - job_scope: string                          (e.g. "sirf interior karna hai", "ab dono interior + exterior")
    - property_size_type: string                 (e.g. "2BHK se 3BHK ho gaya", "size type update karo")
    - property_area_sqft: number | string        (e.g. "area 900 nahi 1100 sqft hai")
    - is_repaint: boolean                        (e.g. "ab repaint hai", "naya ghar hai, repaint nahi")
    - start_timing: string                       (e.g. "start timing next week kar do")
    - start_date: string                         (e.g. "start date 15 March se 20 March kar do")
    - finish_quality: string                     (e.g. "basic nahi premium finish chahiye")
    - site_visit_preference: string              (e.g. "visit preference evening kar do")
    - quote_type: string                         (e.g. "sirf labour-only chahiye", "labour + material kar do")
    - rate_band: string                          (e.g. "basic se premium pe shift karo", "standard nahi basic chahiye")
    - timeline_days: string | number             (e.g. "timeline 7 din kar do", "10-12 din ka time rakhna")
    - advance: { type: "PERCENTAGE" | "FIXED_AMOUNT"; value: number | string }
        - type = "PERCENTAGE" when user says 30%, 40 percent, aadha payment, etc.
        - type = "FIXED_AMOUNT" when user gives a rupee amount (e.g. 20000, 50k)

    If the user talks about "number", "naam", "location", "area", "date", "timing", "finish", "advance", "timeline", "basic/standard/premium", "labour-only", etc.,
    map them to the closest matching stored field from the list above.
    Do NOT invent new fields and do NOT attempt to change the lead id.

    User messages can be in Hindi / Hinglish and may reference fields indirectly.

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
