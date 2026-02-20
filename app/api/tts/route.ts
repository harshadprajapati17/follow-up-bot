/**
 * Text-to-Speech API Route (Sarvam AI)
 * ------------------------------------
 * Server-only proxy to Sarvam's TTS API. Clients send a POST with the text
 * to speak; we call Sarvam with the API key from env and return base64 audio.
 * The API key never leaves the server.
 *
 * Ref: https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/rest-api
 */

import { NextRequest, NextResponse } from 'next/server';

/** Max length Sarvam TTS accepts for a single request (Bulbul v3). */
const MAX_TEXT_LENGTH = 2500;

/** Shape of the request body. */
interface TTSRequestBody {
  /** Text to convert to speech. */
  text: string;
  /** Optional: BCP-47 language code (e.g. en-IN, hi-IN). Defaults to en-IN. */
  target_language_code?: string;
  /** Optional: Speaker/voice (e.g. shubh, aditya). Defaults to shubh. */
  speaker?: string;
  /** Optional: Model. Bulbul v3 is recommended. */
  model?: string;
  /** Optional: Speech pace 0.5–2.0. */
  pace?: number;
  /** Optional: Sample rate in Hz (e.g. 24000). */
  sample_rate?: number;
  /** Optional: Output format (e.g. mp3, wav). */
  output_format?: string;
}

/**
 * Validates the TTS request body. Returns true if valid.
 */
function validateBody(body: unknown): body is TTSRequestBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (typeof b.text !== 'string' || !b.text.trim()) return false;
  if (b.text.length > MAX_TEXT_LENGTH) return false;
  if (b.target_language_code != null && typeof b.target_language_code !== 'string') return false;
  if (b.speaker != null && typeof b.speaker !== 'string') return false;
  if (b.model != null && typeof b.model !== 'string') return false;
  if (b.pace != null && (typeof b.pace !== 'number' || b.pace < 0.5 || b.pace > 2)) return false;
  if (b.sample_rate != null && (typeof b.sample_rate !== 'number' || b.sample_rate < 8000 || b.sample_rate > 48000)) return false;
  if (b.output_format != null && typeof b.output_format !== 'string') return false;
  return true;
}

/**
 * POST /api/tts
 * -------------
 * Converts the given text to speech using Sarvam Bulbul v3. Returns JSON
 * with base64-encoded audio (and content type) or an error.
 *
 * Params: none (all input via request body).
 *
 * Payload (JSON body):
 *   - text: string              (required) — Up to 2500 characters
 *   - target_language_code?: string  (optional) — e.g. "en-IN", "hi-IN"
 *   - speaker?: string          (optional) — e.g. "shubh", "aditya"
 *   - model?: string            (optional) — default "bulbul:v3"
 *   - pace?: number             (optional) — 0.5 to 2.0
 *   - sample_rate?: number      (optional) — 8000 to 48000
 *   - output_format?: string    (optional) — e.g. "mp3", "wav"
 *
 * Success response: { success: true, audioBase64: string, contentType: string }
 * Error response:    { success: false, error: string }
 *
 * Sample cURL — Basic (text only):
 *   curl -X POST http://localhost:3000/api/tts \
 *     -H "Content-Type: application/json" \
 *     -d '{"text":"Hello, this is a test."}'
 *
 * Sample cURL — With options (language, speaker):
 *   curl -X POST http://localhost:3000/api/tts \
 *     -H "Content-Type: application/json" \
 *     -d '{"text":"नमस्ते","target_language_code":"hi-IN","speaker":"shubh","output_format":"mp3"}'
 *
 * Flow:
 * 1. Validate JSON body and text length.
 * 2. Call Sarvam TTS API with API key from SARVAM_API_KEY env.
 * 3. Return base64 audio (or forward error).
 */
export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.SARVAM_API_KEY;
    if (!apiKey?.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: 'TTS not configured. Set SARVAM_API_KEY in the environment.',
        },
        { status: 503 }
      );
    }

    const body = await request.json();
    if (!validateBody(body)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid request. Send JSON with "text" (string, max ${MAX_TEXT_LENGTH} characters). Optional: target_language_code, speaker, model, pace, sample_rate, output_format.`,
        },
        { status: 400 }
      );
    }

    const {
      text,
      target_language_code = 'en-IN',
      speaker = 'hitesh',
      model = 'bulbul:v2',
      pace = 1,
      sample_rate = 24000,
      output_format = 'mp3',
    } = body;

    const payload = {
      text: text.trim(),
      target_language_code,
      speaker,
      model,
      pace,
      sample_rate,
      output_format,
    };

    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[api/tts] Sarvam API error:', res.status, errText);
      return NextResponse.json(
        {
          success: false,
          error: `TTS request failed (${res.status}). ${errText.slice(0, 200)}`,
        },
        { status: res.status >= 500 ? 502 : res.status }
      );
    }

    const data = await res.json();
    // Sarvam returns { request_id, audios } — audios is an array of base64 strings or objects.
    const audios = data?.audios;
    const first = Array.isArray(audios) && audios.length > 0 ? audios[0] : undefined;
    const audioBase64 =
      typeof first === 'string'
        ? first
        : first && typeof first === 'object'
          ? (first as { audio_content?: string; audio?: string }).audio_content ??
            (first as { audio?: string }).audio
          : undefined;
    const resolved =
      audioBase64 ?? data?.audio_content ?? data?.audioBase64 ?? data?.audio;
    if (!resolved || typeof resolved !== 'string') {
      console.error('[api/tts] Unexpected Sarvam response shape:', Object.keys(data ?? {}));
      return NextResponse.json(
        { success: false, error: 'TTS returned invalid response (no audio).' },
        { status: 502 }
      );
    }

    const contentType = output_format === 'wav' ? 'audio/wav' : output_format === 'mp3' ? 'audio/mpeg' : `audio/${output_format}`;
    return NextResponse.json({
      success: true,
      audioBase64: resolved,
      contentType,
    });
  } catch (err) {
    console.error('[api/tts] Error:', err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'TTS request could not be processed.',
      },
      { status: 400 }
    );
  }
}
