import { NextRequest, NextResponse } from 'next/server';
import { detectLeadIntent, type LeadIntentResult } from '@/lib/leadIntent';

type LeadIntentRequestBody = {
  text: string;
};

type LeadIntentResponse =
  | {
      success: true;
      intent: LeadIntentResult;
    }
  | {
      success: false;
      error: string;
    };

// Cheap, local heuristics so we can avoid an LLM
// call for obvious cases (e.g. pure greetings).
function detectLocalIntent(text: string): LeadIntentResult | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  const greetings = [
    'hi',
    'hello',
    'hey',
    'namaste',
    'namaskar',
    'good morning',
    'good evening',
    'good afternoon',
    'gm',
    'gn',
    'good night',
    'ram ram',
    'jai shree krishna',
  ];

  if (
    greetings.some(
      (g) => normalized === g || normalized.startsWith(g + ' ')
    )
  ) {
    return {
      intent: 'GREETING',
      lead_hint: null,
      topic: null,
    };
  }

  // Short acknowledgements / closings that clearly don't
  // describe a job; treat as OTHER without LLM.
  const shortNonLead = ['ok', 'okay', 'thanks', 'thank you', 'bye', 'tc'];
  if (
    normalized.length <= 20 &&
    shortNonLead.some((w) => normalized === w || normalized.startsWith(w + ' '))
  ) {
    return {
      intent: 'OTHER',
      lead_hint: null,
      topic: null,
    };
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<LeadIntentRequestBody>;
    const text = body.text?.trim();

    if (!text) {
      const res: LeadIntentResponse = {
        success: false,
        error: 'Send JSON with non-empty "text" field.',
      };
      return NextResponse.json(res, { status: 400 });
    }

    // First try cheap local detection to avoid LLM when possible.
    const localIntent = detectLocalIntent(text);
    if (localIntent) {
      const res: LeadIntentResponse = { success: true, intent: localIntent };
      return NextResponse.json(res, { status: 200 });
    }

    // Fallback to LLM-based intent detection for richer cases.
    const intent = await detectLeadIntent({ text });
    const res: LeadIntentResponse = { success: true, intent };
    return NextResponse.json(res, { status: 200 });
  } catch (err) {
    console.error('[api/lead/intent] Error:', err);
    const res: LeadIntentResponse = {
      success: false,
      error: 'Could not detect intent for this message.',
    };
    return NextResponse.json(res, { status: 500 });
  }
}

