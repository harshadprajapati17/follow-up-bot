/**
 * High-level: This file handles very simple messages without calling Gemini.
 *
 * Non‑technical view:
 * - It catches patterns like "hi", a 10‑digit phone, or a lead ID.
 * - Handles fuzzy/STT-style inputs (e.g. "helo", "namste", spaces in phone numbers).
 * - When it recognizes something, it updates the session and replies instantly.
 * - This keeps the bot fast and cheap for common, predictable messages.
 */
import type { SessionV2, LocalResolverOutcome } from "./types";

const SKIP: LocalResolverOutcome = { handled: false };

const SKIP_PHRASES = new Set([
  "skip", "skip karo", "skip karna", "baad mein", "baad me", "chhodiye",
  "chhodo", "chodo", "rehne do", "rehne doh", "no", "nahi", "nope", "next",
]);


/**
 * Layer 0: Cheap local resolution for predictable patterns.
 * Handles ~20‑30% of messages with zero LLM cost and <5ms latency.
 */
export function tryLocalResolve(
  text: string,
  session: SessionV2
): LocalResolverOutcome {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Don't intercept greetings mid-flow — user may be saying "hi Harshad" (a name)
  // or "hi 9876543210" (a phone). Let Gemini handle it with full context.
  if (!session.current_flow && isGreeting(lower)) {
    return {
      handled: true,
      response:
        "नमस्ते! मैं आपका पेंटिंग असिस्टेंट हूँ — नया लीड जोड़ना हो, विज़िट शेड्यूल करनी हो, मेज़रमेंट लॉग करना हो या कोट बनवाना हो तो बताइए।",
    };
  }

  // Skip chip during enrichment — advance to next question without updating the field.
  if (session.current_flow === "update_lead" && SKIP_PHRASES.has(lower.trim())) {
    return {
      handled: true,
      response: "",        // core.ts will replace this with the next enrichment question
      advance_enrichment: true,
    };
  }

  // Phone number: strip all non-digits (STT may add spaces, dashes, "91", "+91", etc.).
  const digitsOnly = trimmed.replace(/\D/g, "");
  const tenDigit =
    digitsOnly.length === 10
      ? digitsOnly
      : digitsOnly.length === 12 && digitsOnly.startsWith("91")
        ? digitsOnly.slice(-10)
        : null;
  if (tenDigit !== null) {
    // During save_new_lead flow, let Gemini handle the phone so it can call
    // save_new_lead with all collected fields (name + phone) at once.
    if (session.current_flow === "save_new_lead") {
      return SKIP;
    }

    // In all other cases let Gemini handle the phone number — it has full conversation
    // history and session context (collected_entities) to call save_new_lead properly
    // with all known fields at once, rather than just acknowledging and stalling.
  }

  // Lead ID: 24-character hex string.
  if (
    (session.pending_fields.includes("lead_id") ||
      session.pending_fields.includes("active_lead_id") ||
      !session.active_lead_id) &&
    /^[0-9a-fA-F]{24}$/.test(trimmed)
  ) {
    return {
      handled: true,
      response: `Lead ID ${trimmed} set kar diya.`,
      session_update: { active_lead_id: trimmed },
      entity_update: { lead_id: trimmed, active_lead_id: trimmed },
    };
  }

  // job_scope "dono"/"both" is not handled locally — let Gemini handle it so context
  // and multi-part messages stay consistent (e.g. "Katargam, Dono, Repaint, Kal tak, premiume").

  return SKIP;
}

// ---------------------------------------------------------------------------
// Pattern helpers — STT-friendly with fuzzy matching
// ---------------------------------------------------------------------------

const GREETING_EXACT = new Set([
  "hi",
  "hello",
  "helo",
  "hlo",
  "hey",
  "hii",
  "namaste",
  "namste",
  "namaskar",
  "namasте",
  "good morning",
  "good afternoon",
  "good evening",
  "gm",
  "morning",
]);

const GREETING_FIRST_WORDS = new Set([
  "hi",
  "hello",
  "helo",
  "hlo",
  "hey",
  "hii",
  "namaste",
  "namste",
  "namaskar",
  "good",
  "gm",
  "morning",
]);

const HONORIFIC_WORDS = new Set([
  "bhaiya",
  "bhai",
  "sir",
  "jee",
  "ji",
  "boss",
  "bro",
  "dost",
  "friend",
]);

function stripHonorificWords(input: string): string {
  return input
    .split(/\s+/)
    .filter((word) => !HONORIFIC_WORDS.has(word))
    .join(" ")
    .trim();
}

function isGreeting(lower: string): boolean {
  const withoutHonorifics = stripHonorificWords(lower);
  const cleaned = withoutHonorifics.replace(/[!?.]+$/g, "").trim();
  if (!cleaned) return false;

  // Exact match for known greeting phrases (single or multi-word).
  if (GREETING_EXACT.has(cleaned)) return true;

  const words = cleaned.split(/\s+/);
  const first = words[0];

  // If the first word itself is a greeting, treat whole sentence as greeting,
  // e.g. "hello kaise ho", "namaste kaam batata hoon".
  if (GREETING_FIRST_WORDS.has(first)) return true;

  // Fuzzy match very short single-word greetings from STT.
  if (words.length === 1 && cleaned.length <= 12 && /^(na+m[as]+te+|hel+o+|he+y+|hi+)$/.test(cleaned)) {
    return true;
  }

  return false;
}

