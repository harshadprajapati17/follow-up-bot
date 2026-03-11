/**
 * High-level: This file defines what “actions” Gemini is allowed to take
 * and provides a helper to call Gemini with those actions enabled.
 *
 * Non‑technical view:
 * - Each FunctionDeclaration below is one business action (e.g. save lead, schedule visit).
 * - Gemini can decide when to call these actions, and with which data.
 * - We also convert our chat history + session info into the format Gemini expects.
 */
import { GoogleGenAI, Type } from "@google/genai";
import type { Content, FunctionDeclaration, Part } from "@google/genai";
import type { GeminiResponse, GeminiToolCall, SessionV2 } from "./types";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// Check that we have an API key to talk to Gemini; warn if missing.
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("[v2/gemini-tools] GEMINI_API_KEY is not set.");
}

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

export const MODEL_NAME =
  process.env.GEMINI_V2_MODEL || "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------

// Action: Save a new painting enquiry. Call with every field you know so far when user provides any lead detail.
const saveNewLead: FunctionDeclaration = {
  name: "save_new_lead",
  description:
    "Save a new painting enquiry / lead. When in this flow, call with EVERY field you know from the conversation and session context whenever the user provides or has already provided any detail (name, phone, location, scope, etc.). Use empty string for missing required fields; the system will store valid values and ask for the rest.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      customer_name: {
        type: Type.STRING,
        description: "Customer ka naam",
      },
      customer_phone: {
        type: Type.STRING,
        description: "10-digit Indian mobile number",
      },
      location_text: {
        type: Type.STRING,
        description: "Area / society / city (e.g. Hiranandani Powai, Mumbai)",
      },
      job_scope: {
        type: Type.STRING,
        description: "INTERIOR, EXTERIOR, or BOTH",
      },
      property_size_type: {
        type: Type.STRING,
        description: "1BHK, 2BHK, 3BHK, or OTHER",
      },
      is_repaint: {
        type: Type.BOOLEAN,
        description: "true if repaint (already painted walls), false if brand new",
      },
      start_timing: {
        type: Type.STRING,
        description: "When to start: THIS_WEEK, NEXT_WEEK, or a specific date",
      },
      finish_quality: {
        type: Type.STRING,
        description: "BASIC or PREMIUM",
      },
      property_area_sqft: {
        type: Type.NUMBER,
        description: "Approximate area in sqft (optional)",
      },
      start_date: {
        type: Type.STRING,
        description: "ISO date if user gave a specific date (optional)",
      },
      site_visit_preference: {
        type: Type.STRING,
        description: "Preferred visit time: morning, evening, anytime (optional)",
      },
    },
    required: [
      "customer_name",
      "customer_phone",
      "location_text",
      "job_scope",
      "property_size_type",
      "is_repaint",
      "start_timing",
      "finish_quality",
    ],
  },
};

// Action: Book a site visit for an existing lead (date, time, and lead ID needed).
const scheduleVisit: FunctionDeclaration = {
  name: "schedule_visit",
  description:
    "Schedule a site visit for an existing lead. Requires lead ID, date, and time.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lead_id: {
        type: Type.STRING,
        description: "MongoDB ObjectId of the lead",
      },
      date: {
        type: Type.STRING,
        description: "Visit date, e.g. '15 March', 'kal', ISO date",
      },
      time: {
        type: Type.STRING,
        description: "Visit time, e.g. 'morning', 'evening 5 baje', '3pm'",
      },
    },
    required: ["lead_id", "date", "time"],
  },
};

// Action: Record measurement and scope details after a site visit (area, ceiling, prep, brand, etc.).
const logMeasurement: FunctionDeclaration = {
  name: "log_measurement",
  description:
    "Log site measurement and scope details for a lead after the visit.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lead_id: {
        type: Type.STRING,
        description: "MongoDB ObjectId of the lead",
      },
      paintable_area_sqft: {
        type: Type.STRING,
        description: "Total paintable area in sqft or room-wise description",
      },
      ceiling_included: {
        type: Type.BOOLEAN,
        description: "Whether ceiling is included in painting scope",
      },
      prep_level: {
        type: Type.STRING,
        description: "Putty/primer detail, e.g. '1 coat putty, 1 coat primer'",
      },
      brand_preference: {
        type: Type.STRING,
        description: "Paint brand preference, e.g. 'Asian Paints', 'no preference'",
      },
      finish: {
        type: Type.STRING,
        description: "Finish type: matt, satin, gloss, or texture",
      },
      damp_issue: {
        type: Type.STRING,
        description: "Dampness/cracks info if any, or 'none'",
      },
      scrape_required: {
        type: Type.BOOLEAN,
        description: "Whether full old-paint scraping is required",
      },
      rooms: {
        type: Type.STRING,
        description: "Room-wise area breakdown if given (optional)",
      },
      issues: {
        type: Type.STRING,
        description: "Any wall issues described by contractor (optional)",
      },
    },
    required: [
      "lead_id",
      "paintable_area_sqft",
      "ceiling_included",
      "prep_level",
      "brand_preference",
      "finish",
    ],
  },
};

// Action: Create a quote PDF for a lead (labour-only or labour+material, rate band, timeline).
const generateQuote: FunctionDeclaration = {
  name: "generate_quote",
  description: "Generate quote options PDF for a lead.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lead_id: {
        type: Type.STRING,
        description: "MongoDB ObjectId of the lead",
      },
      quote_type: {
        type: Type.STRING,
        description: "LABOUR_ONLY or LABOUR_PLUS_MATERIAL",
      },
      rate_band: {
        type: Type.STRING,
        description: "BASIC, STANDARD, or PREMIUM",
      },
      timeline_days: {
        type: Type.STRING,
        description: "Estimated days to complete, e.g. '7 din', '10-12 din'",
      },
      advance: {
        type: Type.STRING,
        description: "Advance amount or percentage, e.g. '30%', '20000'",
      },
    },
    required: ["lead_id", "quote_type", "rate_band", "timeline_days", "advance"],
  },
};

// Action: Change one or more details on an existing lead (only what the contractor asked to change).
const updateLead: FunctionDeclaration = {
  name: "update_lead",
  description:
    "Update one or more fields on an existing lead. Only include fields the contractor explicitly asked to change.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lead_id: {
        type: Type.STRING,
        description: "MongoDB ObjectId of the lead to update",
      },
      customer_name: { type: Type.STRING, description: "New customer name" },
      customer_phone: { type: Type.STRING, description: "New phone number" },
      location_text: { type: Type.STRING, description: "New location" },
      job_scope: { type: Type.STRING, description: "New job scope" },
      property_size_type: { type: Type.STRING, description: "New size type" },
      is_repaint: { type: Type.BOOLEAN, description: "New repaint status" },
      start_timing: { type: Type.STRING, description: "New start timing" },
      finish_quality: { type: Type.STRING, description: "New finish quality" },
      quote_type: { type: Type.STRING, description: "New quote type" },
      rate_band: { type: Type.STRING, description: "New rate band" },
      timeline_days: { type: Type.STRING, description: "New timeline" },
      advance: { type: Type.STRING, description: "New advance amount" },
    },
    required: ["lead_id"],
  },
};

// Action: Fetch full details for a single lead (name, phone, location, scope, visit, measurement).
const getLeadDetails: FunctionDeclaration = {
  name: "get_lead_details",
  description:
    "Retrieve full details (name, phone, location, scope, visit, measurement) for a lead.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      lead_id: {
        type: Type.STRING,
        description: "MongoDB ObjectId of the lead",
      },
    },
    required: ["lead_id"],
  },
};

// Action: Show the contractor’s recent leads (up to 5) with name, phone, location, and ID.
const listRecentLeads: FunctionDeclaration = {
  name: "list_recent_leads",
  description:
    "List the contractor's recent leads (up to 5) with name, phone, location, and ID.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

// ---------------------------------------------------------------------------
// Exported tool list and helpers
// ---------------------------------------------------------------------------

// All actions the AI can take; passed to Gemini so it knows what it’s allowed to do.
export const ALL_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  saveNewLead,
  scheduleVisit,
  logMeasurement,
  generateQuote,
  updateLead,
  getLeadDetails,
  listRecentLeads,
];

// Look up an action by its name (e.g. "save_new_lead") when we need its definition.
export function getToolByName(name: string): FunctionDeclaration | undefined {
  return ALL_TOOL_DECLARATIONS.find((t) => t.name === name);
}

// ---------------------------------------------------------------------------
// Build Gemini-compatible content array from our conversation messages
// ---------------------------------------------------------------------------

export function buildContentsFromHistory(
  messages: Array<{ role: string; content: string; tool_name?: string; tool_args?: Record<string, unknown> }>,
  sessionContext: SessionV2
): Content[] {
  const contents: Content[] = [];

  // Build a short summary of the session: active lead, current flow, what’s collected, what’s still needed.
  const contextBlock: string[] = [];
  if (sessionContext.active_lead_id) {
    contextBlock.push(`Active lead ID: ${sessionContext.active_lead_id}`);
  }
  if (sessionContext.current_flow) {
    contextBlock.push(`Current flow: ${sessionContext.current_flow}`);
  }
  if (Object.keys(sessionContext.collected_entities).length > 0) {
    contextBlock.push(
      `Collected so far: ${JSON.stringify(sessionContext.collected_entities)}`
    );
  }
  if (sessionContext.pending_fields.length > 0) {
    contextBlock.push(
      `Still needed: ${sessionContext.pending_fields.join(", ")}`
    );
  }

  // Add that context as a fake user message so the AI knows the current state.
  if (contextBlock.length > 0) {
    contents.push({
      role: "user",
      parts: [{ text: `[Session context]\n${contextBlock.join("\n")}` }],
    });
    contents.push({
      role: "model",
      parts: [{ text: "Samajh gaya, context note kar liya." }],
    });
  }

  // Turn each chat message into the format Gemini expects: user text, AI reply, tool call, or tool result.
  for (const msg of messages) {
    if (msg.role === "user") {
      contents.push({
        role: "user",
        parts: [{ text: msg.content }],
      });
    } else if (msg.role === "assistant") {
      contents.push({
        role: "model",
        parts: [{ text: msg.content }],
      });
    } else if (msg.role === "tool_call" && msg.tool_name && msg.tool_args) {
      contents.push({
        role: "model",
        parts: [
          {
            functionCall: {
              name: msg.tool_name,
              args: msg.tool_args,
            },
          } as Part,
        ],
      });
    } else if (msg.role === "tool_result" && msg.tool_name) {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: msg.tool_name,
              response: { result: msg.content },
            },
          } as Part,
        ],
      });
    }
  }

  return contents;
}

// ---------------------------------------------------------------------------
// Call Gemini with tool calling (cached or uncached)
// ---------------------------------------------------------------------------

export async function callGemini(params: {
  contents: Content[];
  cachedContentName?: string;
}): Promise<GeminiResponse> {
  if (!ai) throw new Error("GEMINI_API_KEY is not configured");

  const { contents, cachedContentName } = params;

  const config: Record<string, unknown> = {};

  // If we have a cache, use it; otherwise send the system prompt and tool list fresh.
  if (cachedContentName) {
    config.cachedContent = cachedContentName;
  } else {
    config.systemInstruction = (await import("./system-prompt")).SYSTEM_PROMPT;
    config.tools = [{ functionDeclarations: ALL_TOOL_DECLARATIONS }];
  }

  // Send the conversation to Gemini and wait for its reply.
  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents,
    config,
  });

  // Pull out the AI’s written reply (if any).
  const text = response.text ?? null;

  // Pull out any actions the AI decided to run (e.g. save lead, schedule visit).
  const toolCalls: GeminiToolCall[] = [];
  if (response.functionCalls && response.functionCalls.length > 0) {
    for (const fc of response.functionCalls) {
      toolCalls.push({
        name: fc.name ?? "",
        args: (fc.args as Record<string, unknown>) ?? {},
      });
    }
  }

  // Pull out token counts (how much text was sent and received) for logging or billing.
  const usage = response.usageMetadata;

  return {
    text,
    tool_calls: toolCalls,
    input_tokens: usage?.promptTokenCount ?? 0,
    output_tokens: usage?.candidatesTokenCount ?? 0,
    cached_tokens: usage?.cachedContentTokenCount ?? 0,
  };
}
