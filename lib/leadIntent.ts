import { generateGeminiJson } from '@/lib/gemini';

export type HighLevelIntent =
  | 'GREETING'
  | 'NEW_LEAD'
  | 'ESTIMATION_FOR_EXISTING_LEAD'
  | 'UPDATE_EXISTING_LEAD'
  | 'LOG_MEASUREMENT'
  | 'GENERAL_QUESTION'
  | 'OTHER';

export interface LeadIntentResult {
  intent: HighLevelIntent;
  /**
   * Optional short hint that might help you match to a project/lead later,
   * e.g. "HSR 2BHK", "Rahil ka HSR kaam", "Whitefield villa".
   */
  lead_hint?: string | null;
  /**
   * For GENERAL_QUESTION, a 1‑line summary of what they are asking.
   */
  topic?: string | null;
}

interface LeadIntentInput {
  text: string;
}

/**
 * Uses Gemini to classify a user message into a small set of
 * high-level intents relevant for the painting lead workflow.
 */
export async function detectLeadIntent(input: LeadIntentInput): Promise<LeadIntentResult> {
  const base: LeadIntentResult = {
    intent: 'OTHER',
    lead_hint: null,
    topic: null,
  };

  const prompt = `
You are an intent detection assistant for a painting contractor bot in India.

User message:
"""${input.text}"""

Classify the message into one of these intents:
- "GREETING"  → pure greetings / pleasantries, like "hi", "hello", "namaste", "good morning", etc.
- "NEW_LEAD" → user is giving details of a new painting job (location, rooms, repainting, etc.).
- "ESTIMATION_FOR_EXISTING_LEAD" → user is asking for an estimate / quotation for a job that was already discussed or visited earlier.
- "UPDATE_EXISTING_LEAD" → user wants to change details of an already captured job (change colour, area, date, etc.).
- "LOG_MEASUREMENT" → user is dictating site measurement / technical details (BHK, sqft, paintable area, ceilings, coats, putty level, dampness, brand preference) that should be attached to an existing job/lead.
- "GENERAL_QUESTION" → user is asking a generic question (e.g. about rates, paint types, process) not tied clearly to a new or existing lead.
- "OTHER" → anything else.

Guidance:
- Prefer "LOG_MEASUREMENT" instead of "NEW_LEAD" when the text looks like measurement / area / putty / dampness / coats / paint brand details and there is no clear statement that this is a completely new job.

Also, when possible:
- Put a short "lead_hint" like "HSR 2BHK Rahil", "Whitefield villa", "yesterday's site" if the message clearly refers to a specific project.
- For GENERAL_QUESTION, summarize the question in 1 short English line in "topic".

Return ONLY valid JSON matching this TypeScript type:
${JSON.stringify(base, null, 2)}
`.trim();

  const result = await generateGeminiJson<LeadIntentResult>({ prompt });
  return result;
}

