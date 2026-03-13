/**
 * High-level: This file is the “safety gate” in front of our tools.
 *
 * Non‑technical view:
 * - Even if Gemini wants to run an action, we double‑check the inputs here.
 * - We make sure things like phone numbers, enums and required fields look sane.
 * - If something is off, we block or adjust the call instead of touching the database.
 */
import type { ConversationMessage, ValidationResult } from "./types";
import { getToolByName } from "./gemini-tools";

/** Normalize Indian mobile: 10 digits as-is; 12 digits starting with 91 → last 10. */
function normalizeIndianPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(-10);
  return phone;
}

/**
 * Validate tool call arguments against our business rules.
 * Gemini's schema enforces required fields, but we add domain‑specific checks.
 */
export function validateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  conversation?: ConversationMessage[]
): ValidationResult {
  const tool = getToolByName(toolName);
  if (!tool) {
    return { valid: false, errors: [`Unknown tool: ${toolName}`] };
  }

  const errors: string[] = [];
  const sanitized: Record<string, unknown> = { ...args };
  let missingFields: string[] | undefined;

  // Remove extra spaces from all text inputs (e.g. "  John  " → "John")
  for (const [k, v] of Object.entries(sanitized)) {
    if (typeof v === "string") {
      sanitized[k] = v.trim();
    }
  }

  // Route each tool to its own validator; some tools have no extra checks
  switch (toolName) {
    case "save_new_lead":
      missingFields = validateSaveNewLead(sanitized, errors, conversation);
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
    case "get_lead_details":
    case "list_recent_leads":
      // Minimal validation — lead_id checked below if present
      break;
  }

  // Reject invalid lead IDs: must be exactly 24 hex characters (e.g. "507f1f77bcf86cd799439011")
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

/**
 * When validation fails, extract entity fields that ARE valid so we can preserve them.
 * e.g. save_new_lead with { customer_name: "Harshad", customer_phone: "8866" } fails on phone,
 * but we should keep customer_name in collected_entities so we don't ask for it again.
 */
export function extractValidEntitiesFromFailedToolCall(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const a = { ...args };
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "string") (a as Record<string, unknown>)[k] = v.trim();
  }

  if (toolName === "save_new_lead") {
    const name = String(a.customer_name ?? "").trim();
    if (name) out.customer_name = name;

    const loc = String(a.location_text ?? a.customer_location ?? "").trim();
    if (loc) out.location_text = loc;

    const scope = String(a.job_scope ?? "").toUpperCase();
    if (["INTERIOR", "EXTERIOR", "BOTH"].includes(scope)) out.job_scope = scope;

    const size = String(a.property_size_type ?? "").toUpperCase();
    if (["1BHK", "2BHK", "3BHK", "OTHER"].includes(size)) out.property_size_type = size;

    const quality = String(a.finish_quality ?? "").toUpperCase();
    if (["BASIC", "PREMIUM"].includes(quality)) out.finish_quality = quality;

    if (typeof a.is_repaint === "boolean") out.is_repaint = a.is_repaint;
    if (a.start_timing && String(a.start_timing).trim()) out.start_timing = String(a.start_timing).trim();
    if (a.job_type && String(a.job_type).trim()) out.job_type = String(a.job_type).trim();
  }

  return out;
}

// ---------------------------------------------------------------------------
// Per-tool validators
// ---------------------------------------------------------------------------

// Only name + phone are required to create a lead; everything else is optional and collected later.
function validateSaveNewLead(
  args: Record<string, unknown>,
  errors: string[],
  conversation?: ConversationMessage[]
): string[] {
  const missing: string[] = [];

  // Name is required
  const name = String(args.customer_name ?? "").trim();
  if (!name) {
    errors.push("customer_name is required");
    missing.push("customer_name");
  }

  // Phone: 10 digits or 12 starting with 91; normalize to 10 for storage
  const phoneRaw = String(args.customer_phone ?? "").trim();
  if (!phoneRaw) {
    errors.push("customer_phone is required");
    missing.push("customer_phone");
  } else {
    const phone = normalizeIndianPhone(phoneRaw);
    if (!/^\d{10}$/.test(phone)) {
      errors.push(
        `customer_phone must be 10 digits (or 91 followed by 10), got: ${phoneRaw}`
      );
      missing.push("customer_phone");
    } else {
      // Extra safety: only accept phones that actually appeared in user messages
      if (conversation && conversation.length > 0) {
        const userDigits = conversation
          .filter((m) => m.role === "user")
          .map((m) => m.content.replace(/\D/g, ""))
          .join(" ");
        if (userDigits && !userDigits.includes(phone)) {
          errors.push(
            `customer_phone did not match any 10-digit sequence spoken by the user, got: ${phone}`
          );
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

  // Optional field normalization (no error if missing)
  const scope = String(args.job_scope ?? "").toUpperCase();
  if (scope && !["INTERIOR", "EXTERIOR", "BOTH"].includes(scope)) {
    errors.push(`Invalid job_scope: ${scope}`);
  } else if (scope) {
    args.job_scope = scope;
  }

  const size = String(args.property_size_type ?? "").toUpperCase();
  if (size && !["1BHK", "2BHK", "3BHK", "OTHER"].includes(size)) {
    errors.push(`Invalid property_size_type: ${size}`);
  } else if (size) {
    args.property_size_type = size;
  }

  const quality = String(args.finish_quality ?? "").toUpperCase();
  if (quality && !["BASIC", "PREMIUM"].includes(quality)) {
    errors.push(`Invalid finish_quality: ${quality}`);
  } else if (quality) {
    args.finish_quality = quality;
  }

  return missing;
}

// Ensures date and time are both provided for scheduling a visit
function validateScheduleVisit(
  args: Record<string, unknown>,
  errors: string[]
): void {
  // Date is required (e.g. "2025-03-15")
  if (!args.date || String(args.date).trim() === "") {
    errors.push("date is required for schedule_visit");
  }
  // Time is required (e.g. "10:00" or "2:30 PM")
  if (!args.time || String(args.time).trim() === "") {
    errors.push("time is required for schedule_visit");
  }
}

// Ensures paintable area (in sq ft) is provided for the measurement
function validateLogMeasurement(
  args: Record<string, unknown>,
  errors: string[]
): void {
  // Paintable area in square feet is required (e.g. "1200")
  if (
    !args.paintable_area_sqft ||
    String(args.paintable_area_sqft).trim() === ""
  ) {
    errors.push("paintable_area_sqft is required for log_measurement");
  }
}

// Ensures quote type and rate band use allowed values
function validateGenerateQuote(
  args: Record<string, unknown>,
  errors: string[]
): void {
  // Quote type must be LABOUR_ONLY or LABOUR_PLUS_MATERIAL
  const quoteType = String(args.quote_type ?? "").toUpperCase();
  if (
    quoteType &&
    !["LABOUR_ONLY", "LABOUR_PLUS_MATERIAL"].includes(quoteType)
  ) {
    errors.push(`Invalid quote_type: ${quoteType}`);
  } else if (quoteType) {
    args.quote_type = quoteType;
  }

  // Rate band must be BASIC, STANDARD, or PREMIUM
  const rateBand = String(args.rate_band ?? "").toUpperCase();
  if (rateBand && !["BASIC", "STANDARD", "PREMIUM"].includes(rateBand)) {
    errors.push(`Invalid rate_band: ${rateBand}`);
  } else if (rateBand) {
    args.rate_band = rateBand;
  }
}

// Ensures at least one field (besides lead_id) is being updated
function validateUpdateLead(
  args: Record<string, unknown>,
  errors: string[]
): void {
  // Must update something: reject empty updates (e.g. only lead_id with no changes)
  const fieldCount = Object.keys(args).filter(
    (k) => k !== "lead_id" && args[k] !== undefined && args[k] !== null
  ).length;

  if (fieldCount === 0) {
    errors.push("update_lead requires at least one field to update besides lead_id");
  }
}
