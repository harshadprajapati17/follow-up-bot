/**
 * V3 Gemini integration — tool declarations + chat call.
 * Uses generateContent (same API as v2) with full conversation history each call.
 * No caching complexity, no fake session context messages.
 */
import { GoogleGenAI, Type, FunctionCallingConfigMode } from "@google/genai";
import type { Content, FunctionDeclaration, Part } from "@google/genai";
import type { Message, GeminiResponse, GeminiToolCall } from "./types";
import { SYSTEM_PROMPT } from "./system-prompt";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.warn("[v3/gemini] GEMINI_API_KEY is not set.");

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

export const MODEL_NAME = process.env.GEMINI_V3_MODEL || "gemini-2.5-flash";

/** Toggle voice (STT + TTS) for V3. Set V3_VOICE_ENABLED=false to disable both. */
export const VOICE_ENABLED =
  (process.env.V3_VOICE_ENABLED ?? "true").toLowerCase() !== "false";

// ---------------------------------------------------------------------------
// Tool declarations (same business actions as v2)
// ---------------------------------------------------------------------------

const saveNewLead: FunctionDeclaration = {
  name: "save_new_lead",
  description:
    "Save a new painting enquiry. Call as soon as you have customer_name and any phone digits. Pass all known fields. Use empty string for unknown optional fields.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      customer_name: { type: Type.STRING, description: "Customer's name" },
      customer_phone: { type: Type.STRING, description: "10-digit Indian mobile number" },
      location_text: { type: Type.STRING, description: "Area / society / city" },
      start_timing: { type: Type.STRING, description: "THIS_WEEK, NEXT_WEEK, or a specific date" },
    },
    required: ["customer_name", "customer_phone", "location_text"],
  },
};

const scheduleVisit: FunctionDeclaration = {
  name: "schedule_visit",
  description: "Schedule a site visit for an existing lead.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lead_id: { type: Type.STRING, description: "MongoDB ObjectId of the lead" },
      date: { type: Type.STRING, description: "Visit date e.g. '15 March', 'kal', ISO date" },
      time: { type: Type.STRING, description: "Visit time e.g. 'morning', 'shaam 5 baje', '3pm'" },
    },
    required: ["lead_id", "date", "time"],
  },
};

const logMeasurement: FunctionDeclaration = {
  name: "log_measurement",
  description: "Log or update site measurements for a lead. Call once with area, then call again as each optional detail is collected. Only pass fields the user has explicitly provided.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lead_id: { type: Type.STRING, description: "MongoDB ObjectId of the lead" },
      paintable_area_sqft: { type: Type.NUMBER, description: "Total paintable area in sqft" },
      ceiling_included: { type: Type.BOOLEAN, description: "Whether ceiling painting is included" },
      putty_coats: { type: Type.NUMBER, description: "Number of putty coats: 0, 1, or 2" },
      primer_included: { type: Type.BOOLEAN, description: "Whether primer is needed" },
      scrape_required: { type: Type.BOOLEAN, description: "Whether old paint scraping is needed" },
      damp_issue: { type: Type.STRING, description: "Damp/seepage description, or 'none' if no issue" },
      brand_preference: { type: Type.STRING, description: "Paint brand e.g. Asian Paints, Berger, Nerolac — only pass if user explicitly mentioned" },
      finish_quality: { type: Type.STRING, description: "BASIC (Economy), STANDARD (Mid Range), or PREMIUM — only pass if user explicitly mentioned" },
    },
    required: ["lead_id"],
  },
};

const generateQuote: FunctionDeclaration = {
  name: "generate_quote",
  description: "Generate a PDF quote for a lead. Requires measurement to be logged first.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lead_id: { type: Type.STRING, description: "MongoDB ObjectId of the lead" },
      quote_type: { type: Type.STRING, description: "LABOUR_ONLY or LABOUR_PLUS_MATERIAL" },
      timeline_days: { type: Type.NUMBER, description: "Estimated days to complete the job" },
      advance: { type: Type.NUMBER, description: "Advance amount in rupees" },
      rate_band: { type: Type.STRING, description: "BASIC, STANDARD, or PREMIUM (optional)" },
    },
    required: ["lead_id", "quote_type", "timeline_days", "advance"],
  },
};

const updateLead: FunctionDeclaration = {
  name: "update_lead",
  description: "Update details of an existing lead (location, scope, size, timing, etc.).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lead_id: { type: Type.STRING, description: "MongoDB ObjectId of the lead" },
      location_text: { type: Type.STRING },
      job_scope: { type: Type.STRING },
      property_size_type: { type: Type.STRING },
      is_repaint: { type: Type.BOOLEAN },
      start_timing: { type: Type.STRING },
      brand_preference: { type: Type.STRING, description: "Paint brand e.g. Asian Paints, Berger, Nerolac" },
      finish_quality: { type: Type.STRING, description: "Economy, Mid Range, or Premium" },
      property_area_sqft: { type: Type.NUMBER },
    },
    required: ["lead_id"],
  },
};

const getLeadDetails: FunctionDeclaration = {
  name: "get_lead_details",
  description: "Fetch full details of a lead including visit and measurement.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lead_id: { type: Type.STRING, description: "MongoDB ObjectId of the lead" },
    },
    required: ["lead_id"],
  },
};

const listRecentLeads: FunctionDeclaration = {
  name: "list_recent_leads",
  description: "List the 5 most recent leads for this contractor.",
  parameters: { type: Type.OBJECT, properties: {} },
};

export const ALL_TOOLS: FunctionDeclaration[] = [
  saveNewLead,
  scheduleVisit,
  logMeasurement,
  generateQuote,
  updateLead,
  getLeadDetails,
  listRecentLeads,
];

export function getToolByName(name: string): FunctionDeclaration | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

// ---------------------------------------------------------------------------
// Build Gemini content array from conversation history
// ---------------------------------------------------------------------------

export function buildContents(params: {
  messages: Message[];
  summary: string;
  active_lead_id: string | null;
}): Content[] {
  const { messages, summary, active_lead_id } = params;
  const contents: Content[] = [];

  // Inject context as a single leading user+model pair so Gemini knows DB state
  const contextLines: string[] = [];
  if (active_lead_id) {
    contextLines.push(
      `Active lead ID: ${active_lead_id} — use for schedule_visit, log_measurement, update_lead without asking the user which lead.`
    );
  }
  if (summary) {
    contextLines.push(`Conversation summary so far:\n${summary}`);
  }

  if (contextLines.length > 0) {
    contents.push({
      role: "user",
      parts: [{ text: `[Context]\n${contextLines.join("\n")}` }],
    });
    contents.push({
      role: "model",
      parts: [{ text: "समझ गया।" }],
    });
  }

  // Map each message to Gemini format
  for (const msg of messages) {
    if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
    } else if (msg.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: msg.content }] });
    } else if (msg.role === "tool_call" && msg.tool_name && msg.tool_args) {
      contents.push({
        role: "model",
        parts: [{ functionCall: { name: msg.tool_name, args: msg.tool_args } } as Part],
      });
    } else if (msg.role === "tool_result" && msg.tool_name) {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: msg.tool_name, response: { result: msg.content } } } as Part],
      });
    }
  }

  return contents;
}

// ---------------------------------------------------------------------------
// Call Gemini
// ---------------------------------------------------------------------------

export async function callGemini(contents: Content[]): Promise<GeminiResponse> {
  if (!ai) throw new Error("GEMINI_API_KEY is not configured");

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: ALL_TOOLS }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
      temperature: 0.3,
    },
  });

  const text = response.text ?? null;

  const tool_calls: GeminiToolCall[] = [];
  if (response.functionCalls?.length) {
    for (const fc of response.functionCalls) {
      tool_calls.push({ name: fc.name ?? "", args: (fc.args as Record<string, unknown>) ?? {} });
    }
  }

  const usage = response.usageMetadata;
  return {
    text,
    tool_calls,
    input_tokens: usage?.promptTokenCount ?? 0,
    output_tokens: usage?.candidatesTokenCount ?? 0,
  };
}

/**
 * Simple single-turn Gemini call for summarization — no tools, no system prompt.
 */
export async function callGeminiRaw(prompt: string): Promise<string | null> {
  if (!ai) return null;
  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      temperature: 0.1,
    },
  });
  return response.text ?? null;
}
