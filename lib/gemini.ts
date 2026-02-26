import { GoogleGenerativeAI } from '@google/generative-ai';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn('[gemini] GEMINI_API_KEY is not set. Gemini calls will fail until it is configured.');
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// You can override this via env if needed (e.g. GEMINI_MODEL=gemini-1.5-flash-001).
const DEFAULT_MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

export async function generateGeminiJson<T = unknown>(params: {
  prompt: string;
  modelName?: string;
}): Promise<T> {
  if (!genAI) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const model = genAI.getGenerativeModel({ model: params.modelName ?? DEFAULT_MODEL_NAME });

  const result = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [{ text: params.prompt }],
      },
    ],
  });

  const rawText = result.response.text().trim();

  // Some models wrap JSON in ``` or ```json fences. Strip them if present.
  let cleaned = rawText;
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  }

  // Try direct parse first.
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // As a fallback, try to extract the first {...} block from the text.
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(jsonSlice) as T;
      } catch (innerErr) {
        console.error('[gemini] Failed to parse JSON slice from model:', innerErr, 'Raw:', cleaned);
      }
    } else {
      console.error('[gemini] No JSON braces found in model response:', cleaned);
    }
    throw new Error('Model returned invalid JSON');
  }
}

