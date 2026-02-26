import { generateGeminiJson } from '@/lib/gemini';

export type JobType = 'painting' | 'plumbing' | 'electrical' | 'civil' | 'unknown';

export type Urgency = 'today' | 'tomorrow' | 'this_week' | 'next_week' | 'flexible' | 'unknown';

export type PreferredLanguage = 'hi' | 'en' | 'mixed' | 'unknown';

export interface LeadAnalysis {
  contractor_id: string | null;
  raw_utterance: string;
  customer: {
    name: string | null;
    phone: string | null;
  };
  location_text: string | null;
  job_type: JobType;
  scope_hint: {
    interior: boolean | null;
    exterior: boolean | null;
  };
  urgency: Urgency;
  preferred_language: PreferredLanguage;
}

export interface LeadAnalysisInput {
  text: string;
  contractorId: string | null;
  detectedPhone: string | null;
  preferredLanguage: PreferredLanguage;
}

export async function analyzeLead(input: LeadAnalysisInput): Promise<LeadAnalysis> {
  const base: LeadAnalysis = {
    contractor_id: input.contractorId,
    raw_utterance: input.text,
    customer: {
      name: null,
      phone: input.detectedPhone,
    },
    location_text: null,
    job_type: 'unknown',
    scope_hint: {
      interior: null,
      exterior: null,
    },
    urgency: 'unknown',
    preferred_language: input.preferredLanguage,
  };

  const prompt = `
You are a construction lead intake assistant for a painting/contractor company in India.

Task:
- Read the user's utterance (Hinglish / Hindi / English / mixed).
- Use the base JSON object below.
- Fill in fields only when you are reasonably confident.
- If a field is not clear, leave it as null or "unknown" (do not guess).
- Infer job_type only from the text (e.g. painting, plumbing, electrical, civil, unknown).
- For urgency, use: "today", "tomorrow", "this_week", "next_week", "flexible", or "unknown".
- For preferred_language, if you are unsure, keep the base value.

Utterance:
"""${input.text}"""

Base JSON:
${JSON.stringify(base, null, 2)}

Return ONLY valid JSON matching this structure. No explanation, no markdown, no extra text.
`.trim();

  const analysis = await generateGeminiJson<LeadAnalysis>({ prompt });
  return analysis;
}

