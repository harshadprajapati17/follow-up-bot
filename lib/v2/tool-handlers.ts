/**
 * High-level: This file actually “does the work” once a tool call is approved.
 *
 * Non‑technical view:
 * - After Gemini and validation agree on an action, we land here.
 * - Each handler talks to MongoDB or S3 using our existing helper functions.
 * - For example, saving a lead, scheduling a visit, logging measurement,
 *   or generating and uploading a quote PDF.
 * - It always returns a simple message and structured data back to the bot.
 */
import type { ToolHandlerResult } from "./types";
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

/**
 * Execute a validated tool call against MongoDB / S3 and return a structured result.
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  userId: string
): Promise<ToolHandlerResult> {
  // Route to the right handler based on which action the AI requested.
  switch (toolName) {
    case "save_new_lead":
      return handleSaveNewLead(args, userId);
    case "schedule_visit":
      return handleScheduleVisit(args);
    case "log_measurement":
      return handleLogMeasurement(args);
    case "generate_quote":
      return handleGenerateQuote(args);
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
// Individual handlers
// ---------------------------------------------------------------------------

// Create a new lead in the database from the collected customer info.
async function handleSaveNewLead(
  args: Record<string, unknown>,
  userId: string
): Promise<ToolHandlerResult> {
  try {
    const leadId = await createLeadFromEntities({ userId, entities: args });
    if (!leadId) {
      return { success: false, message: "Lead create karte waqt error aaya." };
    }
    return {
      success: true,
      message: `Naya lead save ho gaya (ID: ${leadId}).`,
      created_lead_id: leadId,
      next_suggested_intents: ["schedule_visit"],
    };
  } catch (err) {
    console.error("[v2/tool-handlers] save_new_lead error:", err);
    return { success: false, message: "Lead save karte waqt error aaya." };
  }
}

// Schedule a site visit for a lead (date, time, notes).
async function handleScheduleVisit(
  args: Record<string, unknown>
): Promise<ToolHandlerResult> {
  const leadId = String(args.lead_id ?? "");
  try {
    await upsertVisitFromEntities({ leadId, entities: args });
    return {
      success: true,
      message: `Visit schedule ho gaya — ${args.date}, ${args.time}.`,
      next_suggested_intents: ["log_measurement"],
    };
  } catch (err) {
    console.error("[v2/tool-handlers] schedule_visit error:", err);
    return { success: false, message: "Visit schedule karte waqt error aaya." };
  }
}

// Log room measurements and paintable area for a lead.
async function handleLogMeasurement(
  args: Record<string, unknown>
): Promise<ToolHandlerResult> {
  const leadId = String(args.lead_id ?? "");
  const entities: Record<string, unknown> = {
    ...args,
    measurement_area: args.paintable_area_sqft,
    measurements: args.rooms ?? undefined,
  };

  try {
    await upsertMeasurementFromEntities({ leadId, entities });
    return {
      success: true,
      message: "Measurement log ho gaya.",
      next_suggested_intents: ["generate_quote"],
    };
  } catch (err) {
    console.error("[v2/tool-handlers] log_measurement error:", err);
    return {
      success: false,
      message: "Measurement log karte waqt error aaya.",
    };
  }
}

// Build a quote PDF and upload it to S3; return the download URL.
async function handleGenerateQuote(
  args: Record<string, unknown>
): Promise<ToolHandlerResult> {
  const leadId = String(args.lead_id ?? "");
  try {
    const pdfBuffer = await buildQuotePdfBuffer(args);
    const url = await uploadQuotePdfToS3(pdfBuffer, leadId);
    return {
      success: true,
      message: "Quote PDF ready hai.",
      quote_pdf_url: url ?? undefined,
    };
  } catch (err) {
    console.error("[v2/tool-handlers] generate_quote error:", err);
    return { success: false, message: "Quote generate karte waqt error aaya." };
  }
}

// Update an existing lead's fields (name, phone, address, etc.).
async function handleUpdateLead(
  args: Record<string, unknown>
): Promise<ToolHandlerResult> {
  const leadId = String(args.lead_id ?? "");
  const { lead_id: _, ...fieldsToUpdate } = args;

  try {
    await updateLeadFromEntities({ leadId, entities: fieldsToUpdate });
    const updatedFields = Object.keys(fieldsToUpdate).join(", ");
    return {
      success: true,
      message: `Lead update ho gaya (fields: ${updatedFields}).`,
    };
  } catch (err) {
    console.error("[v2/tool-handlers] update_lead error:", err);
    return { success: false, message: "Lead update karte waqt error aaya." };
  }
}

// Fetch lead, visit, and measurement in parallel; return combined details.
async function handleGetLeadDetails(
  args: Record<string, unknown>,
  userId: string
): Promise<ToolHandlerResult> {
  const leadId = String(args.lead_id ?? "");

  try {
    // Fetch lead, visit, and measurement at the same time for speed.
    const [lead, visit, measurement] = await Promise.all([
      getLeadDetailsForUser({ userId, leadId }),
      getVisitForLead({ leadId }),
      getMeasurementForLead({ leadId }),
    ]);

    if (!lead) {
      return { success: false, message: "Yeh lead nahi mila system mein." };
    }

    const data: Record<string, unknown> = {
      lead,
      ...(visit ? { visit } : {}),
      ...(measurement ? { measurement } : {}),
    };

    return {
      success: true,
      message: "Lead details mil gaye.",
      data,
    };
  } catch (err) {
    console.error("[v2/tool-handlers] get_lead_details error:", err);
    return { success: false, message: "Lead details nikalte waqt error aaya." };
  }
}

// Get the last 5 leads for this user and build a readable summary.
async function handleListRecentLeads(
  userId: string
): Promise<ToolHandlerResult> {
  try {
    const leads = await getRecentLeadsForUser({ userId, limit: 5 });

    if (leads.length === 0) {
      return {
        success: true,
        message: "Aapke naam se koi lead nahi mila abhi.",
        data: { leads: [] },
      };
    }

    // Build a short line for each lead: name, location, phone, ID.
    const summary = leads
      .map((l, i) => {
        const parts: string[] = [];
        if (l.customer_name) parts.push(l.customer_name);
        if (l.location_text) parts.push(l.location_text);
        const main = parts.join(" - ") || "Unnamed lead";
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
    console.error("[v2/tool-handlers] list_recent_leads error:", err);
    return {
      success: false,
      message: "Recent leads nikalte waqt error aaya.",
    };
  }
}
