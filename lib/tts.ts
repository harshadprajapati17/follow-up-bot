/**
 * Text-to-Speech (Sarvam AI) — server-side only.
 * Used to generate voice replies for the Telegram bot (e.g. /project conversation).
 */

const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';

// Only speaker and model from env. Language and format use code defaults.
const TTS_SPEAKER = process.env.SARVAM_TTS_SPEAKER || 'hitesh';
const TTS_MODEL = process.env.SARVAM_TTS_MODEL || 'bulbul:v2';

export interface TTSOptions {
  target_language_code?: string;
  speaker?: string;
  model?: string;
  output_format?: string;
}

/**
 * Converts text to speech using Sarvam TTS. Returns audio as Buffer (e.g. mp3) or null.
 */
export async function textToSpeech(
  text: string,
  options: TTSOptions = {}
): Promise<Buffer | null> {
  const apiKey = process.env.SARVAM_API_KEY?.trim();
  if (!apiKey) {
    console.error('[tts] SARVAM_API_KEY is not set');
    return null;
  }

  const {
    target_language_code = 'hi-IN',
    speaker = TTS_SPEAKER,
    model = TTS_MODEL,
    output_format = 'mp3',
  } = options;

  const payload = {
    text: text.trim(),
    target_language_code,
    speaker,
    model,
    pace: 1,
    sample_rate: 24000,
    output_format,
  };

  try {
    const res = await fetch(SARVAM_TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[tts] Sarvam API error', res.status, errText);
      return null;
    }

    const data = await res.json();
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
      console.error('[tts] Unexpected Sarvam response');
      return null;
    }

    return Buffer.from(resolved, 'base64');
  } catch (err) {
    console.error('[tts] Request failed:', err);
    return null;
  }
}
