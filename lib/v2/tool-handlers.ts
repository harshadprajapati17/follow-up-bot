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
import { calculateQuote, type MeasurementInput } from "./quote-calculator";

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

// Chips shown after lead is saved — collect remaining enrichment fields one by one.
export const LEAD_ENRICHMENT_CHIPS: Array<{
  field: string;
  question: string;
  chips: Array<{ label: string; payload: string }>;
}> = [
  {
    field: "job_scope",
    question: "🏠 क्या काम करना है?",
    chips: [
      { label: "Interior", payload: "Interior painting karna hai" },
      { label: "Exterior", payload: "Exterior painting karna hai" },
      { label: "दोनों", payload: "Interior aur exterior dono karna hai" },
    ],
  },
  {
    field: "property_size_type",
    question: "🏢 प्रॉपर्टी साइज़?",
    chips: [
      { label: "1 BHK", payload: "Property 1 BHK hai" },
      { label: "2 BHK", payload: "Property 2 BHK hai" },
      { label: "3 BHK", payload: "Property 3 BHK hai" },
      { label: "Other / Villa", payload: "Property villa ya badi hai" },
    ],
  },
];

// Create a new lead in the database from the collected customer info.
async function handleSaveNewLead(
  args: Record<string, unknown>,
  userId: string
): Promise<ToolHandlerResult> {
  try {
    const leadId = await createLeadFromEntities({ userId, entities: args });
    if (!leadId) {
      return { success: false, message: "लीड बनाते समय कोई समस्या आई।" };
    }

    const name = String(args.customer_name ?? "");
    const phone = String(args.customer_phone ?? "");

    // Find first missing enrichment field to ask about
    const missingStep = LEAD_ENRICHMENT_CHIPS.find(
      ({ field }) => !args[field] || String(args[field]).trim() === ""
    );

    if (missingStep && missingStep.chips.length > 0) {
      return {
        success: true,
        message: `✓ ${name} (${phone}) — लीड सेव हो गया!\n\n${missingStep.question}\nनीचे दिए विकल्पों में से चुनें`,
        created_lead_id: leadId,
        selection_chips: missingStep.chips,
        chips_type: "selection",
      };
    }

    // Location is missing (free text step) — just ask
    if (missingStep) {
      return {
        success: true,
        message: `✓ ${name} (${phone}) — लीड सेव हो गया!\n\n${missingStep.question}`,
        created_lead_id: leadId,
      };
    }

    // All enrichment done
    return {
      success: true,
      message: `✓ ${name} (${phone}) — लीड सेव हो गया!`,
      created_lead_id: leadId,
      next_suggested_intents: ["schedule_visit"],
      selection_chips: [
        { label: "विज़िट शेड्यूल करें", payload: "Visit schedule karo" },
        { label: "बाद में", payload: "Baad mein karte hain" },
      ],
      chips_type: "suggestion",
    };
  } catch (err) {
    console.error("[v2/tool-handlers] save_new_lead error:", err);
    return { success: false, message: "लीड सेव करते समय कोई समस्या आई।" };
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
      message: `विज़िट शेड्यूल हो गया — ${args.date}, ${args.time}.`,
      next_suggested_intents: ["log_measurement"],
      selection_chips: [
        { label: "मेज़रमेंट लॉग करें", payload: "Measurement log karo" },
        { label: "बाद में", payload: "Baad mein karte hain" },
      ],
      chips_type: "suggestion",
    };
  } catch (err) {
    console.error("[v2/tool-handlers] schedule_visit error:", err);
    return { success: false, message: "विज़िट शेड्यूल करते समय कोई समस्या आई।" };
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

    const area = args.paintable_area_sqft ? `${args.paintable_area_sqft} sqft` : "";

    // If brand not yet collected, ask via selection chips
    if (!args.brand_preference) {
      return {
        success: true,
        message: `✓ मेज़रमेंट नोट हो गया${area ? ` (${area})` : ""}!\n\n🎨 कौन-सा पेंट ब्रांड चाहिए?\nनीचे दिए विकल्पों में से चुनें`,
        selection_chips: [
          { label: "Asian Paints", payload: "Asian Paints brand chahiye" },
          { label: "Berger", payload: "Berger brand chahiye" },
          { label: "Nerolac", payload: "Nerolac brand chahiye" },
          { label: "कोई भी चलेगा", payload: "Koi bhi brand chalega, no preference" },
        ],
        chips_type: "selection",
      };
    }

    // Brand known — ask product/quality tier
    if (!args.finish_quality) {
      const brand = String(args.brand_preference);
      return {
        success: true,
        message: `✓ मेज़रमेंट नोट हो गया${area ? ` (${area})` : ""}!\n\n${brand} — कौन-सा प्रोडक्ट?\nनीचे दिए विकल्पों में से चुनें`,
        selection_chips: [
          { label: "Economy", payload: `${brand} ka economy / basic product chahiye` },
          { label: "Mid Range", payload: `${brand} ka mid range product chahiye` },
          { label: "Premium", payload: `${brand} ka premium product chahiye` },
        ],
        chips_type: "selection",
      };
    }

    return {
      success: true,
      message: `✓ मेज़रमेंट नोट हो गया${area ? ` (${area})` : ""}!`,
      next_suggested_intents: ["generate_quote"],
      selection_chips: [
        { label: "कोटेशन बनाएं", payload: "Quote banao" },
        { label: "बाद में", payload: "Baad mein karte hain" },
      ],
      chips_type: "suggestion",
    };
  } catch (err) {
    console.error("[v2/tool-handlers] log_measurement error:", err);
    return {
      success: false,
      message: "मेज़रमेंट नोट करते समय कोई समस्या आई।",
    };
  }
}

// Build a quote PDF and upload it to S3; return the download URL.
async function handleGenerateQuote(
  args: Record<string, unknown>
): Promise<ToolHandlerResult> {
  const leadId = String(args.lead_id ?? "");
  try {
    // Fetch measurement data to run pricing calculation
    const measurement = (await getMeasurementForLead({ leadId })) as unknown as Record<string, unknown> | null;

    const measurementInput: MeasurementInput = {
      paintable_area_sqft: Number(
        measurement?.measurement_area ??
        measurement?.paintable_area_sqft ??
        args.paintable_area_sqft ?? 0
      ),
      ceiling_included: Boolean(measurement?.ceiling_included),
      putty_coats: Number(measurement?.putty_coats ?? 0),
      primer_included: Boolean(measurement?.primer_included),
      scrape_required: Boolean(measurement?.scrape_required),
      damp_issue: String(measurement?.damp_issue ?? "none"),
      brand_preference: String(measurement?.brand_preference ?? args.brand_preference ?? "no preference"),
      finish_quality: String(measurement?.finish_quality ?? args.finish_quality ?? "BASIC"),
      quote_type: String(args.quote_type ?? "LABOUR_PLUS_MATERIAL"),
    };

    // Run calculation only if we have area data
    const quoteResult = measurementInput.paintable_area_sqft > 0
      ? calculateQuote(measurementInput)
      : undefined;

    const pdfEntities: Record<string, unknown> = {
      ...args,
      ...(measurement ?? {}),
    };

    const pdfBuffer = await buildQuotePdfBuffer(pdfEntities, quoteResult);
    const url = await uploadQuotePdfToS3(pdfBuffer, leadId);

    const totalText = quoteResult
      ? ` कुल: ₹${quoteResult.total.toLocaleString("en-IN")} (incl. GST)`
      : "";

    return {
      success: true,
      message: `✓ कोटेशन PDF तैयार है!${totalText}`,
      quote_pdf_url: url ?? undefined,
    };
  } catch (err) {
    console.error("[v2/tool-handlers] generate_quote error:", err);
    return { success: false, message: "कोटेशन बनाते समय कोई समस्या आई।" };
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
    return {
      success: true,
      message: `लीड अपडेट हो गया।`,
    };
  } catch (err) {
    console.error("[v2/tool-handlers] update_lead error:", err);
    return { success: false, message: "लीड अपडेट करते समय कोई समस्या आई।" };
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
      return { success: false, message: "यह लीड सिस्टम में नहीं मिला।" };
    }

    const data: Record<string, unknown> = {
      lead,
      ...(visit ? { visit } : {}),
      ...(measurement ? { measurement } : {}),
    };

    return {
      success: true,
      message: "लीड की जानकारी मिल गई।",
      data,
    };
  } catch (err) {
    console.error("[v2/tool-handlers] get_lead_details error:", err);
    return { success: false, message: "लीड की जानकारी लेते समय कोई समस्या आई।" };
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
        message: "अभी कोई लीड नहीं मिला।",
        data: { leads: [] },
      };
    }

    // Build a short line for each lead: name, location, phone, ID.
    const summary = leads
      .map((l, i) => {
        const parts: string[] = [];
        if (l.customer_name) parts.push(l.customer_name);
        if (l.location_text) parts.push(l.location_text);
        const main = parts.join(" - ") || "अज्ञात लीड";
        const phone = l.customer_phone ? `, Ph: ${l.customer_phone}` : "";
        return `${i + 1}) ${main}${phone} (ID: ${l.id})`;
      })
      .join("\n");

    return {
      success: true,
      message: `हाल के लीड:\n${summary}`,
      data: { leads },
    };
  } catch (err) {
    console.error("[v2/tool-handlers] list_recent_leads error:", err);
    return {
      success: false,
      message: "लीड सूची लेते समय कोई समस्या आई।",
    };
  }
}
