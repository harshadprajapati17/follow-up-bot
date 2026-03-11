import * as Sanscript from "@indic-transliteration/sanscript";

/**
 * Best-effort transliteration of a Hinglish sentence into Hindi (Devanagari).
 *
 * Note: Sanscript is designed for formal romanization schemes (like ITRANS).
 * Our inputs are casual Hinglish, but in practice Sarvam TTS still benefits
 * from getting Devanagari text, and Sanscript handles punctuation safely.
 */
export function toHindiDevanagari(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;

  try {
    // Treat input as approximate ITRANS and convert to Devanagari.
    // If the scheme doesn't fully match, Sanscript will leave
    // unmatched pieces alone, so this is safe to call on any string.
    const converted = (Sanscript as any).t(trimmed, "itrans", "devanagari");
    const sampleIn = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    const sampleOut =
      converted && converted.length > 120 ? `${converted.slice(0, 120)}…` : converted;
    // eslint-disable-next-line no-console
    console.log("[toHindiDevanagari] sample:", { in: sampleIn, out: sampleOut });
    return converted;
  } catch {
    // On any failure, just fall back to the original text so TTS still works.
    return text;
  }
}


