/**
 * Sarvam AI Speech-to-Text (STT)
 * ------------------------------
 * Transcribes audio using Sarvam's REST API. Used by the Telegram webhook
 * to convert voice messages to text.
 *
 * Ref: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
 */

const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';

export interface SarvamSttOptions {
  /** BCP-47 language code (e.g. hi-IN, en-IN). Use "unknown" for auto-detect. */
  language_code?: string;
  /** Model: saarika:v2.5 (default) or saaras:v3 */
  model?: string;
  /** Mode for saaras:v3: transcribe | translate | verbatim | translit | codemix */
  mode?: string;
}

export interface SarvamSttResponse {
  request_id: string | null;
  transcript: string;
  language_code: string | null;
  language_probability?: number | null;
}

/**
 * Transcribes audio buffer using Sarvam AI Speech-to-Text REST API.
 *
 * @param audioBuffer - Raw audio bytes (e.g. OGG from Telegram)
 * @param mimeType - MIME type (e.g. audio/ogg)
 * @param filename - Filename for the form field (e.g. voice.ogg)
 * @param options - Optional language_code, model, mode
 * @returns Transcript text or null on failure
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/ogg',
  filename: string = 'voice.ogg',
  options: SarvamSttOptions = {}
): Promise<string | null> {
  const apiKey = process.env.SARVAM_API_KEY?.trim();
  if (!apiKey) {
    console.error('[sarvamStt] SARVAM_API_KEY is not set');
    return null;
  }

  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  formData.append('file', blob, filename);

  if (options.language_code) {
    formData.append('language_code', options.language_code);
  }
  if (options.model) {
    formData.append('model', options.model);
  }
  if (options.mode) {
    formData.append('mode', options.mode);
  }

  try {
    const res = await fetch(SARVAM_STT_URL, {
      method: 'POST',
      headers: {
        'api-subscription-key': apiKey,
      },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[sarvamStt] API error', res.status, text);
      return null;
    }

    const data = (await res.json()) as SarvamSttResponse;
    const transcript = data?.transcript?.trim() ?? null;
    if (transcript) {
      console.log('[sarvamStt] Transcribed:', transcript.slice(0, 80) + (transcript.length > 80 ? '...' : ''));
    }
    return transcript;
  } catch (err) {
    console.error('[sarvamStt] Request failed:', err);
    return null;
  }
}
