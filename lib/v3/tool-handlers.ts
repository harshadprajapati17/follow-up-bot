/**
 * V3 tool handlers — pure DB operations.
 * No chips, no flow logic, no "what to ask next".
 * Gemini owns the conversation; handlers just read/write data.
 */
import {
  createLeadFromEntities,
  updateLeadFromEntities,
  upsertVisitFromEntities,
  upsertMeasurementFromEntities,
  getLeadDetailsForUser,
  getRecentLeadsForUser,
  getVisitForLead,
  getMeasurementForLead,
} from "@/lib/mongo";
import { buildQuotePdfBuffer } from "@/lib/quotePdf";
import { uploadQuotePdfToS3 } from "@/lib/s3";
import { calculateQuote, type MeasurementInput } from "./quote-calculator";

// ---------------------------------------------------------------------------
// Result type — intentionally simple
// ---------------------------------------------------------------------------

export interface ToolResult {
  success: boolean;
  /** Factual summary of what happened — Gemini uses this to compose its reply */
  message: string;
  /** Newly created lead ID */
  created_lead_id?: string;
  /** Data payload (for read tools) */
  data?: Record<string, unknown>;
  /** Quote PDF URL */
  quote_pdf_url?: string;
  /** Suggestion chips for next actions */
  selection_chips?: Array<{ label: string; payload: string }>;
  chips_type?: "selection" | "suggestion";
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  userId: string
): Promise<ToolResult> {
  switch (toolName) {
    case "save_new_lead":
      return handleSaveNewLead(args, userId);
    case "schedule_visit":
      return handleScheduleVisit(args);
    case "log_measurement":
      return handleLogMeasurement(args);
    case "generate_quote":
      return handleGenerateQuote(args, userId);
    case "update_lead":
      return handleUpdateLead(args);
    case "get_lead_details":
      return handleGetLeadDetails(args, userId);
    case "list_recent_leads":
      return handleListRecentLeads(userId);
    default:
      return { success: false, message: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// Handlers — each one: save to DB, return what happened
// ---------------------------------------------------------------------------

async function handleSaveNewLead(
  args: Record<string, unknown>,
  userId: string
): Promise<ToolResult> {
  try {
    const leadId = await createLeadFromEntities({ userId, entities: args });
    if (!leadId) {
      return { success: false, message: "Lead save failed." };
    }
    return {
      success: true,
      message: `Lead saved: ${args.customer_name} (${args.customer_phone}). Lead ID: ${leadId}`,
      created_lead_id: leadId,
      selection_chips: [
        { label: "विज़िट शेड्यूल करें", payload: "Visit schedule karo" },
        { label: "बाद में", payload: "Baad mein karte hain" },
      ],
      chips_type: "suggestion",
    };
  } catch (err) {
    console.error("[v3/tool-handlers] save_new_lead error:", err);
    return { success: false, message: "Lead save failed." };
  }
}

async function handleScheduleVisit(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const leadId = String(args.lead_id ?? "");
  try {
    await upsertVisitFromEntities({ leadId, entities: args });
    return {
      success: true,
      message: `Visit scheduled: ${args.date}, ${args.time}.`,
      selection_chips: [
        { label: "मेज़रमेंट लॉग करें", payload: "Measurement log karo" },
        { label: "बाद में", payload: "Baad mein karte hain" },
      ],
      chips_type: "suggestion",
    };
  } catch (err) {
    console.error("[v3/tool-handlers] schedule_visit error:", err);
    return { success: false, message: "Visit scheduling failed." };
  }
}

async function handleLogMeasurement(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const leadId = String(args.lead_id ?? "");

  // Map tool args to DB field names
  const entities: Record<string, unknown> = {
    ...(args.paintable_area_sqft != null
      ? { measurement_area: String(args.paintable_area_sqft) }
      : {}),
    ...(args.ceiling_included != null
      ? { ceiling_included: Boolean(args.ceiling_included) }
      : {}),
    ...(args.putty_coats != null
      ? { putty_coats: Number(args.putty_coats) }
      : {}),
    ...(args.primer_included != null
      ? { primer_included: Boolean(args.primer_included) }
      : {}),
    ...(args.scrape_required != null
      ? { scrape_required: Boolean(args.scrape_required) }
      : {}),
    ...(args.damp_issue != null
      ? { damp_issue: String(args.damp_issue) }
      : {}),
  };

  try {
    await upsertMeasurementFromEntities({ leadId, entities });

    // Build a clean confirmation listing only what was saved
    const parts: string[] = [];
    if (args.paintable_area_sqft) parts.push(`area: ${args.paintable_area_sqft} sqft`);
    if (args.ceiling_included != null) parts.push(`ceiling: ${args.ceiling_included ? "yes" : "no"}`);
    if (args.putty_coats != null) parts.push(`putty: ${args.putty_coats} coat`);
    if (args.primer_included != null) parts.push(`primer: ${args.primer_included ? "yes" : "no"}`);
    if (args.scrape_required != null) parts.push(`scraping: ${args.scrape_required ? "yes" : "no"}`);
    if (args.damp_issue != null) parts.push(`damp: ${args.damp_issue}`);

    return {
      success: true,
      message: `Measurement updated: ${parts.join(", ")}.`,
    };
  } catch (err) {
    console.error("[v3/tool-handlers] log_measurement error:", err);
    return { success: false, message: "Measurement logging failed." };
  }
}

async function handleGenerateQuote(
  args: Record<string, unknown>,
  userId: string
): Promise<ToolResult> {
  const leadId = String(args.lead_id ?? "");
  try {
    const [lead, measurement] = await Promise.all([
      getLeadDetailsForUser({ userId, leadId }),
      getMeasurementForLead({ leadId }),
    ]);

    // Missing lead is a data problem — tell Gemini so it doesn't retry blindly
    if (!lead) {
      return {
        success: false,
        message: `[data_error] Lead not found for id: ${leadId}. Cannot generate quote.`,
      };
    }

    const leadRecord = lead as Record<string, unknown>;

    // Missing measurement means area is unknown — Gemini should ask for it
    if (!measurement || !measurement.measurement_area) {
      return {
        success: false,
        message:
          "[data_error] No measurement found for this lead. Ask the contractor to log measurements (area, ceiling, putty, primer) before generating a quote.",
      };
    }

    const measurementInput: MeasurementInput = {
      paintable_area_sqft: Number(measurement.measurement_area),
      ceiling_included: measurement.ceiling_included ?? false,
      putty_coats: measurement.putty_coats ?? 0,
      primer_included: measurement.primer_included ?? false,
      scrape_required: measurement.scrape_required ?? false,
      damp_issue: measurement.damp_issue ?? "none",
      brand_preference: String(
        measurement.brand_preference ??
          leadRecord.brand_preference ??
          "no preference"
      ),
      finish_quality: String(
        measurement.finish ??
          leadRecord.finish_quality ??
          "BASIC"
      ),
      quote_type: String(args.quote_type ?? "LABOUR_PLUS_MATERIAL"),
    };

    const quoteResult = calculateQuote(measurementInput);

    // Build PDF entities with proper field names
    const pdfEntities: Record<string, unknown> = {
      customer_name: leadRecord.customer_name ?? "",
      customer_phone: leadRecord.customer_phone ?? "",
      location_text: leadRecord.location_text ?? "",
      paintable_area_sqft: measurementInput.paintable_area_sqft,
      measurement_area: measurementInput.paintable_area_sqft,
      ceiling_included: measurementInput.ceiling_included,
      putty_coats: measurementInput.putty_coats,
      primer_included: measurementInput.primer_included,
      scrape_required: measurementInput.scrape_required,
      damp_issue: measurementInput.damp_issue,
      brand_preference: measurementInput.brand_preference,
      finish_quality: measurementInput.finish_quality,
      quote_type: args.quote_type,
      timeline_days: args.timeline_days,
      advance: args.advance,
    };

    const pdfBuffer = await buildQuotePdfBuffer(pdfEntities, quoteResult);
    const url = await uploadQuotePdfToS3(pdfBuffer, leadId);

    const totalText = `Total: ₹${quoteResult.total.toLocaleString("en-IN")} (incl. GST)`;

    return {
      success: true,
      message: `Quote PDF generated. ${totalText}`,
      quote_pdf_url: url ?? undefined,
    };
  } catch (err) {
    console.error("[v3/tool-handlers] generate_quote error:", err);
    // Tag as server_error so Gemini knows NOT to re-ask quote parameters —
    // the args were valid and should be retried as-is.
    return {
      success: false,
      message:
        "[server_error] Quote PDF generation failed due to a technical error (PDF/S3). All quote parameters (lead_id, quote_type, timeline_days, advance) were valid. Retry generate_quote immediately with the exact same arguments — do NOT ask the user again.",
    };
  }
}

async function handleUpdateLead(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const leadId = String(args.lead_id ?? "");
  const { lead_id: _, ...fieldsToUpdate } = args;

  try {
    await updateLeadFromEntities({ leadId, entities: fieldsToUpdate });
    const fields = Object.keys(fieldsToUpdate).join(", ");

    // Brand just set → show quality chips as UI hints
    if (fieldsToUpdate.brand_preference && !fieldsToUpdate.finish_quality) {
      return {
        success: true,
        message: `Lead updated: ${fields}.`,
        selection_chips: [
          { label: "Economy", payload: "Economy product chahiye" },
          { label: "Mid Range", payload: "Mid range product chahiye" },
          { label: "Premium", payload: "Premium product chahiye" },
          { label: "Skip ⏭", payload: "skip karo" },
        ],
        chips_type: "selection",
      };
    }

    // Quality just set → show quote chip
    if (fieldsToUpdate.finish_quality) {
      return {
        success: true,
        message: `Lead updated: ${fields}.`,
        selection_chips: [
          { label: "कोटेशन बनाएं", payload: "Quote banao" },
          { label: "बाद में", payload: "Baad mein karte hain" },
        ],
        chips_type: "suggestion",
      };
    }

    return {
      success: true,
      message: `Lead updated: ${fields}.`,
    };
  } catch (err) {
    console.error("[v3/tool-handlers] update_lead error:", err);
    return { success: false, message: "Lead update failed." };
  }
}

async function handleGetLeadDetails(
  args: Record<string, unknown>,
  userId: string
): Promise<ToolResult> {
  const leadId = String(args.lead_id ?? "");

  try {
    const [lead, visit, measurement] = await Promise.all([
      getLeadDetailsForUser({ userId, leadId }),
      getVisitForLead({ leadId }),
      getMeasurementForLead({ leadId }),
    ]);

    if (!lead) {
      return { success: false, message: "Lead not found." };
    }

    return {
      success: true,
      message: "Lead details retrieved.",
      data: {
        lead,
        ...(visit ? { visit } : {}),
        ...(measurement ? { measurement } : {}),
      },
    };
  } catch (err) {
    console.error("[v3/tool-handlers] get_lead_details error:", err);
    return { success: false, message: "Failed to fetch lead details." };
  }
}

async function handleListRecentLeads(
  userId: string
): Promise<ToolResult> {
  try {
    const leads = await getRecentLeadsForUser({ userId, limit: 5 });

    if (leads.length === 0) {
      return {
        success: true,
        message: "No leads found.",
        data: { leads: [] },
      };
    }

    const summary = leads
      .map((l, i) => {
        const parts: string[] = [];
        if (l.customer_name) parts.push(l.customer_name);
        if (l.location_text) parts.push(l.location_text);
        const main = parts.join(" - ") || "Unknown";
        const phone = l.customer_phone ? `, Ph: ${l.customer_phone}` : "";
        return `${i + 1}) ${main}${phone} (ID: ${l.id})`;
      })
      .join("\n");

    return {
      success: true,
      message: `Recent leads:\n${summary}`,
      data: { leads },
    };
  } catch (err) {
    console.error("[v3/tool-handlers] list_recent_leads error:", err);
    return { success: false, message: "Failed to fetch leads." };
  }
}
