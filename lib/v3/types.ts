/**
 * V3 types — minimal. Gemini owns flow state via conversation history.
 * We only persist what Gemini cannot know (DB-generated IDs, summaries).
 */

export type MessageRole = "user" | "assistant" | "tool_call" | "tool_result";

export interface Message {
  role: MessageRole;
  content: string;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  ts: number;
}

// What we store in MongoDB per user. Gemini infers everything else from messages.
export interface ConversationV3 {
  _id?: string; // userId
  active_lead_id: string | null;
  summary: string; // Gemini-generated summary of older messages
  messages: Message[]; // Last 15 turns
  updatedAt: Date;
}

export const DEFAULT_CONVERSATION: ConversationV3 = {
  active_lead_id: null,
  summary: "",
  messages: [],
  updatedAt: new Date(),
};

// Gemini tool call
export interface GeminiToolCall {
  name: string;
  args: Record<string, unknown>;
}

// Raw Gemini response
export interface GeminiResponse {
  text: string | null;
  tool_calls: GeminiToolCall[];
  input_tokens: number;
  output_tokens: number;
}

// Validation result (reused from v2 shape)
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  missing_fields?: string[];
  sanitized_args?: Record<string, unknown>;
}

// API response to frontend
export type ChatV3Response =
  | {
      status: "success";
      message: string;
      tool_executed?: string;
      quote_pdf_url?: string;
      selection_chips?: Array<{ label: string; payload: string }>;
      chips_type?: "selection" | "suggestion";
    }
  | {
      status: "error";
      message: string;
    };
