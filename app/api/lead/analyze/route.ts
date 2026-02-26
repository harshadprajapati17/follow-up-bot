import { NextRequest, NextResponse } from 'next/server';
import { analyzeLead, LeadAnalysis, PreferredLanguage } from '@/lib/leadAnalysis';

const MAX_TEXT_LENGTH = 2000;

interface LeadAnalyzeRequestBody {
  contractor_id?: string;
  text: string;
  language_hint?: string;
}

interface LeadAnalyzeResponse {
  success: boolean;
  data?: LeadAnalysis;
  error?: string;
}

/**
 * POST /api/lead/analyze
 * ----------------------
 * Takes a free-form text (usually a voice transcript) and returns structured
 * lead information extracted by LLM.
 *
 * Request body (JSON):
 *   - text: string                 (required)  — User utterance, max 2000 chars
 *   - contractor_id?: string       (optional)  — Your internal contractor id
 *   - language_hint?: string       (optional)  — "hi" | "en" | "mixed" | "unknown"
 *
 * Successful response (200):
 *   {
 *     "success": true,
 *     "data": {
 *       "contractor_id": "c_123",
 *       "raw_utterance": "2BHK interior repaint HSR, site visit Saturday 11am, customer Rahil",
 *       "customer": { "name": "Rahil", "phone": "+91xxxxxxxxxx" },
 *       "location_text": "HSR Layout, 27th Main",
 *       "job_type": "painting",
 *       "scope_hint": { "interior": true, "exterior": false },
 *       "urgency": "next_week",
 *       "preferred_language": "hi"
 *     }
 *   }
 *
 * Error response (400 / 500):
 *   { "success": false, "error": "message" }
 *
 * Note: Question generation is handled by the orchestrator based on intent and dependencies.
 *
 * Sample cURL:
 *   curl -X POST http://localhost:3000/api/lead/analyze \\
 *     -H "Content-Type: application/json" \\
 *     -d '{
 *       "contractor_id": "c_123",
 *       "text": "New lead add karo. 2BHK interior repaint. Location: HSR, 27th Main. Customer: Rahil. Site visit Saturday 11am."
 *     }'
 */

// Check that the incoming JSON body has the fields we expect.
function validateBody(body: unknown): body is LeadAnalyzeRequestBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (typeof b.text !== 'string' || !b.text.trim()) return false;
  if (b.text.length > MAX_TEXT_LENGTH) return false;
  if (b.contractor_id != null && typeof b.contractor_id !== 'string') return false;
  if (b.language_hint != null && typeof b.language_hint !== 'string') return false;
  return true;
}

// Pull out an Indian mobile number like +91XXXXXXXXXX or 9XXXXXXXXX from the text.
function detectPhone(text: string): string | null {
  const match = text.match(/(\+91[-\s]?)?[6-9]\d{9}/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return null;
}

// Guess if the text is mainly Hindi, English, or mixed using script + optional hint.
function detectPreferredLanguage(text: string, hint?: string): PreferredLanguage {
  if (hint === 'hi' || hint === 'en' || hint === 'mixed' || hint === 'unknown') {
    return hint;
  }
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  const hasAscii = /[A-Za-z]/.test(text);
  if (hasDevanagari && hasAscii) return 'mixed';
  if (hasDevanagari) return 'hi';
  if (hasAscii) return 'en';
  return 'unknown';
}

export async function POST(request: NextRequest) {
  try {
    // Read JSON body from the incoming HTTP request.
    const body = await request.json();

    // Validate that the body has a usable "text" field and optional fields are correct.
    if (!validateBody(body)) {
      const res: LeadAnalyzeResponse = {
        success: false,
        error: `Invalid request. Send JSON with "text" (string, max ${MAX_TEXT_LENGTH} characters). Optional: contractor_id, language_hint.`,
      };
      return NextResponse.json(res, { status: 400 });
    }

    // Clean up the text and pull out simple fields from the raw request.
    const text = body.text.trim();
    const contractorId = body.contractor_id ?? null;
    const languageHint = body.language_hint;

    // Use regex to find a possible mobile number in the text.
    const detectedPhone = detectPhone(text);

    // Use script detection and optional hint to guess preferred language.
    const preferredLanguage = detectPreferredLanguage(text, languageHint);

    // Ask Gemini (via our leadAnalysis helper) to turn text into structured data.
    const analysis = await analyzeLead({
      text,
      contractorId,
      detectedPhone,
      preferredLanguage,
    });

    // Build the final API response - just return the analyzed data.
    // Question generation is handled by the orchestrator based on intent and dependencies.
    const res: LeadAnalyzeResponse = {
      success: true,
      data: analysis,
    };

    return NextResponse.json(res, { status: 200 });
  } catch (err) {
    // Log and surface unexpected errors in a user-friendly way.
    console.error('[api/lead/analyze] Error:', err);
    const res: LeadAnalyzeResponse = {
      success: false,
      error:
        err instanceof Error
          ? err.message
          : 'Lead analysis request could not be processed.',
    };
    return NextResponse.json(res, { status: 500 });
  }
}

