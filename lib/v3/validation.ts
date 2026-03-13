/**
 * V3 validation — safety gate for tool call arguments + text output sanitization.
 * Checks required fields, normalizes phone numbers, validates enums,
 * and strips hallucinated content from Gemini text output.
 */
import type { Message } from "./types";
import { getToolByName } from "./gemini";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  missing_fields?: string[];
  sanitized_args?: Record<string, unknown>;
}

/** Normalize Indian mobile: 10 digits as-is; 12 digits starting with 91 → last 10. */
function normalizeIndianPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(-10);
  return phone;
}

export function validateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  messages?: Message[]
): ValidationResult {
  const tool = getToolByName(toolName);
  if (!tool) {
    return { valid: false, errors: [`Unknown tool: ${toolName}`] };
  }

  const errors: string[] = [];
  const sanitized: Record<string, unknown> = { ...args };
  let missingFields: string[] | undefined;

  // Trim all string inputs
  for (const [k, v] of Object.entries(sanitized)) {
    if (typeof v === "string") {
      sanitized[k] = v.trim();
    }
  }

  switch (toolName) {
    case "save_new_lead":
      missingFields = validateSaveNewLead(sanitized, errors, messages);
      break;
    case "schedule_visit":
      validateScheduleVisit(sanitized, errors);
      break;
    case "log_measurement":
      validateLogMeasurement(sanitized, errors);
      break;
    case "generate_quote":
      validateGenerateQuote(sanitized, errors);
      break;
    case "update_lead":
      validateUpdateLead(sanitized, errors);
      break;
  }

  // Validate lead_id format
  const leadId = sanitized.lead_id;
  if (typeof leadId === "string" && leadId && !/^[0-9a-fA-F]{24}$/.test(leadId)) {
    errors.push(`Invalid lead_id format: ${leadId}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    ...(missingFields ? { missing_fields: missingFields } : {}),
    sanitized_args: sanitized,
  };
}

// ---------------------------------------------------------------------------
// Text output sanitization — strips hallucinated URLs, code, raw JSON
// ---------------------------------------------------------------------------

/** Remove hallucinated URLs, raw JSON, code blocks, and internal system tags from Gemini output. */
export function sanitizeGeminiText(text: string): string {
  let cleaned = text;

  // Strip internal error tags that must never reach the user
  // These tags are for Gemini's tool-error reasoning only.
  cleaned = cleaned.replace(/\[server_error\][^\n]*/gi, "");
  cleaned = cleaned.replace(/\[data_error\][^\n]*/gi, "");

  // Strip any URLs (http/https/ftp/www)
  cleaned = cleaned.replace(/https?:\/\/[^\s)]+/gi, "");
  cleaned = cleaned.replace(/www\.[^\s)]+/gi, "");

  // Strip raw JSON objects that leaked through
  cleaned = cleaned.replace(/\{[^}]{20,}\}/g, "");

  // Strip markdown code blocks
  cleaned = cleaned.replace(/```[\s\S]*?```/g, "");

  // Strip backtick-wrapped code
  cleaned = cleaned.replace(/`[^`]+`/g, "");

  // Collapse multiple spaces/newlines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").replace(/ {2,}/g, " ").trim();

  return cleaned;
}

// ---------------------------------------------------------------------------
// Per-tool validators
// ---------------------------------------------------------------------------

function validateSaveNewLead(
  args: Record<string, unknown>,
  errors: string[],
  messages?: Message[]
): string[] {
  const missing: string[] = [];

  const name = String(args.customer_name ?? "").trim();
  if (!name) {
    errors.push("customer_name is required");
    missing.push("customer_name");
  }

  const phoneRaw = String(args.customer_phone ?? "").trim();
  if (!phoneRaw) {
    errors.push("customer_phone is required");
    missing.push("customer_phone");
  } else {
    const phone = normalizeIndianPhone(phoneRaw);
    if (!/^\d{10}$/.test(phone)) {
      errors.push(`customer_phone must be 10 digits, got: ${phoneRaw}`);
      missing.push("customer_phone");
    } else {
      // Anti-hallucination: phone must appear in user messages
      if (messages && messages.length > 0) {
        const userDigits = messages
          .filter((m) => m.role === "user")
          .map((m) => m.content.replace(/\D/g, ""))
          .join(" ");
        if (userDigits && !userDigits.includes(phone)) {
          errors.push(`customer_phone not found in user messages: ${phone}`);
          missing.push("customer_phone");
        } else {
          args.customer_phone = phone;
        }
      } else {
        args.customer_phone = phone;
      }
    }
  }

  // Location is required
  const location = String(args.location_text ?? "").trim();
  if (!location) {
    errors.push("location_text is required");
    missing.push("location_text");
  }

  return missing;
}

function validateScheduleVisit(
  args: Record<string, unknown>,
  errors: string[]
): void {
  if (!args.lead_id || String(args.lead_id).trim() === "") {
    errors.push("lead_id is required for schedule_visit");
  }
  if (!args.date || String(args.date).trim() === "") {
    errors.push("date is required for schedule_visit");
  }
  if (!args.time || String(args.time).trim() === "") {
    errors.push("time is required for schedule_visit");
  }
}

function validateLogMeasurement(
  args: Record<string, unknown>,
  errors: string[]
): void {
  if (!args.lead_id || String(args.lead_id).trim() === "") {
    errors.push("lead_id is required for log_measurement");
  }

  // At least one measurement field must be provided
  const hasField =
    args.paintable_area_sqft != null ||
    args.ceiling_included != null ||
    args.putty_coats != null ||
    args.primer_included != null ||
    args.scrape_required != null ||
    args.damp_issue != null;

  if (!hasField) {
    errors.push("log_measurement requires at least one measurement field");
  }

  // Sanitize putty_coats range
  if (args.putty_coats != null) {
    const coats = Number(args.putty_coats);
    if (coats < 0 || coats > 3) {
      args.putty_coats = Math.max(0, Math.min(3, coats));
    }
  }

  // Sanitize area — must be positive and reasonable
  if (args.paintable_area_sqft != null) {
    const area = Number(args.paintable_area_sqft);
    if (area <= 0 || area > 100000) {
      errors.push(`paintable_area_sqft out of range: ${area}`);
    }
  }
}

function validateGenerateQuote(
  args: Record<string, unknown>,
  errors: string[]
): void {
  if (!args.lead_id || String(args.lead_id).trim() === "") {
    errors.push("lead_id is required for generate_quote");
  }

  const quoteType = String(args.quote_type ?? "").toUpperCase();
  if (quoteType && !["LABOUR_ONLY", "LABOUR_PLUS_MATERIAL"].includes(quoteType)) {
    errors.push(`Invalid quote_type: ${quoteType}`);
  } else if (quoteType) {
    args.quote_type = quoteType;
  }

  // Sanitize timeline_days — must be positive integer
  if (args.timeline_days != null) {
    const days = Number(args.timeline_days);
    if (days < 1 || days > 365) {
      args.timeline_days = Math.max(1, Math.min(365, Math.round(days)));
    }
  }

  // Sanitize advance — if it looks like a fraction (0-1), it's probably a percentage
  if (args.advance != null) {
    const adv = Number(args.advance);
    if (adv > 0 && adv <= 1) {
      // Gemini sent a fraction like 0.6 — we can't convert to rupees without knowing total,
      // so store as-is but flag it for the PDF handler
      args.advance_is_percentage = true;
    }
  }
}

function validateUpdateLead(
  args: Record<string, unknown>,
  errors: string[]
): void {
  const fieldCount = Object.keys(args).filter(
    (k) => k !== "lead_id" && args[k] !== undefined && args[k] !== null
  ).length;
  if (fieldCount === 0) {
    errors.push("update_lead requires at least one field to update");
  }

  // Normalize finish_quality values
  if (args.finish_quality) {
    const raw = String(args.finish_quality).toUpperCase().trim();
    if (raw.includes("ECONOMY") || raw.includes("BASIC")) {
      args.finish_quality = "BASIC";
    } else if (raw.includes("MID") || raw.includes("STANDARD")) {
      args.finish_quality = "STANDARD";
    } else if (raw.includes("PREMIUM")) {
      args.finish_quality = "PREMIUM";
    }
  }
}
