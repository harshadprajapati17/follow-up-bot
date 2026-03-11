/**
 * High-level: Central place for all V2 TypeScript types.
 *
 * Non‑technical view:
 * - This file just defines “shapes” of data: what a message looks like,
 *   what we store in session, how tool results and logs are structured, etc.
 * - Changing logic happens in other files; this one is about shared contracts.
 */

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant" | "tool_call" | "tool_result";

// A single message in the chat: who said it, what they said, and when.
export interface ConversationMessage {
  role: MessageRole;
  content: string;
  /** Tool name when role is tool_call or tool_result */
  tool_name?: string;
  /** Structured tool arguments when role is tool_call */
  tool_args?: Record<string, unknown>;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Session state (stored in Redis alongside conversation history)
// ---------------------------------------------------------------------------

// What we remember about the current conversation: active lead, flow, collected info.
export interface SessionV2 {
  active_lead_id: string | null;
  /** High-level label of what flow the user is currently in, if any. */
  current_flow: string | null;
  /** Entities collected so far across the conversation. */
  collected_entities: Record<string, unknown>;
  /** Fields that still need to be collected for the current flow. */
  pending_fields: string[];
}

export const DEFAULT_SESSION_V2: SessionV2 = {
  active_lead_id: null,
  current_flow: null,
  collected_entities: {},
  pending_fields: [],
};

// Full conversation: message list plus session state.
export interface ConversationV2 {
  messages: ConversationMessage[];
  session: SessionV2;
}

export const DEFAULT_CONVERSATION_V2: ConversationV2 = {
  messages: [],
  session: { ...DEFAULT_SESSION_V2 },
};

// ---------------------------------------------------------------------------
// Layer results — what each layer can return to short-circuit or pass through
// ---------------------------------------------------------------------------

// We handled the message locally (e.g. greeting, phone) — here's the reply and any updates.
export interface LocalResolverResult {
  handled: true;
  response: string;
  session_update?: Partial<SessionV2>;
  /** Entity extracted locally (e.g. phone number, "dono" → job_scope) */
  entity_update?: Record<string, unknown>;
}

// We didn't handle it — pass through to the next layer (cache or AI).
export interface LocalResolverSkip {
  handled: false;
}

export type LocalResolverOutcome = LocalResolverResult | LocalResolverSkip;

// ---------------------------------------------------------------------------
// Gemini tool call result
// ---------------------------------------------------------------------------

// One action the AI wants to perform: tool name and its arguments.
export interface GeminiToolCall {
  name: string;
  args: Record<string, unknown>;
}

// Full AI response: text reply, any tool calls, and token counts.
export interface GeminiResponse {
  text: string | null;
  tool_calls: GeminiToolCall[];
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

// ---------------------------------------------------------------------------
// Tool handler result (after executing a tool call against MongoDB)
// ---------------------------------------------------------------------------

// Result of running a tool: success/fail, message, and optional data or next steps.
export interface ToolHandlerResult {
  success: boolean;
  /** Human-readable message describing what happened. */
  message: string;
  /** Newly created lead ID, if applicable. */
  created_lead_id?: string;
  /** Data retrieved (for read tools like get_lead_details). */
  data?: Record<string, unknown>;
  /** Suggested next intents after this tool completes. */
  next_suggested_intents?: string[];
  /** Quote PDF URL, if generated. */
  quote_pdf_url?: string;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

// Whether the tool arguments are valid and cleaned-up values to use.
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** For partial/failed calls: which required fields are missing (if computed). */
  missing_fields?: string[];
  /** Sanitized args after validation (trimmed strings, etc.) */
  sanitized_args?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// API response shape
// ---------------------------------------------------------------------------

// What we send back to the client: success with message and optional tool result, or error.
export type ChatV2Response =
  | {
      status: "success";
      message: string;
      tool_executed?: string;
      tool_result?: ToolHandlerResult;
      layer_hit: "local" | "semantic_cache" | "gemini";
    }
  | {
      status: "error";
      message: string;
    };

// ---------------------------------------------------------------------------
// Pipeline trace — step-by-step record of what happened during one request
// ---------------------------------------------------------------------------

export type PipelineStepName =
  | "input"
  | "local_resolver"
  | "semantic_cache"
  | "gemini_call"
  | "validation"
  | "tool_execution"
  | "response";

export type PipelineStepStatus = "proceed" | "skip" | "handled" | "error";

export interface PipelineStep {
  step: PipelineStepName;
  status: PipelineStepStatus;
  detail: string;
  duration_ms: number;
  tokens_saved?: number;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Log entry (persisted to MongoDB + structured console)
// ---------------------------------------------------------------------------

// One log row: who, when, what was said, which layer responded, tokens, latency.
export interface V2CallLog {
  request_id: string;
  user_id: string;
  timestamp: number;
  endpoint: "chat" | "chat-no-cache";
  layer_hit: "local" | "semantic_cache" | "gemini";
  user_text: string;
  conversation_length: number;
  cache_used: boolean;
  cache_name: string | null;
  tool_called: string | null;
  tool_params: Record<string, unknown> | null;
  response_text: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  latency_ms: number;
  gemini_latency_ms: number;
  validation_passed: boolean;
  validation_errors: string[];
  pipeline_trace: PipelineStep[];
}
