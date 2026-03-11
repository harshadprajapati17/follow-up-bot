/**
 * High-level: Layer 1 — Semantic cache for common intent-trigger phrases.
 *
 * Non‑technical view:
 * - When the user starts a new flow (e.g. "naya lead banana hai"), we don't
 *   need Gemini to understand that — we can recognize the intent locally
 *   and reply with the right "what info do I need?" question.
 * - This uses keyword groups: the message must contain at least one word from
 *   each required group. E.g. "new lead" needs a word from the "new" group
 *   AND a word from the "lead" group.
 * - Hinglish and STT spelling variants are included in each group.
 * - Only fires when the user isn't already mid-flow — if they're answering
 *   questions, Gemini handles it with full conversation context.
 * - Saves the entire Gemini API call (~300–500 tokens + latency).
 */
import type { SessionV2 } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SemanticCacheHit {
  matched: true;
  intent: string;
  response: string;
  flow_update?: {
    current_flow: string;
    pending_fields: string[];
  };
}

export interface SemanticCacheMiss {
  matched: false;
}

export type SemanticCacheOutcome = SemanticCacheHit | SemanticCacheMiss;

// ---------------------------------------------------------------------------
// Phrase bank — keyword groups per intent
// ---------------------------------------------------------------------------

interface CacheEntry {
  intent: string;
  groups: string[][];
  response: string;
  flow_update?: {
    current_flow: string;
    pending_fields: string[];
  };
}

const CACHE_ENTRIES: CacheEntry[] = [
  {
    intent: "save_new_lead",
    groups: [
      ["naya", "nayi", "nai", "naye", "nay", "new"],
      ["lead", "customer", "client", "party", "banda", "aadmi"],
    ],
    response:
      "नया लीड बनाते हैं। ग्राहक का नाम और फ़ोन नंबर बता दीजिए।",
    flow_update: {
      current_flow: "save_new_lead",
      pending_fields: [
        "customer_name",
        "customer_phone",
        "job_type",
        "job_scope",
      ],
    },
  },
  {
    intent: "schedule_visit",
    groups: [
      ["visit", "milne", "dekhne", "site", "inspection"],
      [
        "schedule", "book", "fix", "plan", "set", "rakh", "karo",
        "karna", "jana", "jao", "lagao",
      ],
    ],
    response:
      "विज़िट शेड्यूल करते हैं। किस लीड के लिए है? और तिथि क्या रखनी है?",
    flow_update: {
      current_flow: "schedule_visit",
      pending_fields: ["lead_id", "visit_date"],
    },
  },
  {
    intent: "log_measurement",
    groups: [
      ["measurement", "naap", "mapai", "size", "dimension", "area", "sqft"],
      ["log", "save", "add", "daal", "dal", "note", "record", "likh", "karo", "karna", "lo"],
    ],
    response:
      "मेज़रमेंट लॉग करते हैं। किस लीड का है? रूम का नाम और क्षेत्र (लंबाई x चौड़ाई फीट) बता दीजिए।",
    flow_update: {
      current_flow: "log_measurement",
      pending_fields: ["lead_id", "room_name", "length_ft", "width_ft"],
    },
  },
  {
    intent: "generate_quote",
    groups: [
      ["quote", "quotation", "estimate", "rate", "price", "cost"],
      ["banao", "generate", "create", "bhejo", "send", "nikalo", "do", "chahiye", "karo"],
    ],
    response:
      "कोट बनाते हैं। किस लीड के लिए? पेंट का टाइप और कलर प्रेफरेंस बता दीजिए।",
    flow_update: {
      current_flow: "generate_quote",
      pending_fields: ["lead_id", "paint_type"],
    },
  },

  // Conversational intents — no flow, just a quick reply.
  {
    intent: "help",
    groups: [
      ["help", "madad", "kya", "bata", "batao"],
      ["kar", "karo", "sakta", "sakti", "sakte", "hai", "ho", "options"],
    ],
    response:
      "मैं ये सब कर सकता हूँ:\n• नया लीड बनाना\n• विज़िट शेड्यूल करना\n• मेज़रमेंट लॉग करना\n• कोट जनरेट करना\n• लीड डीटेल्स देखना\nबस बोलिए क्या करना है!",
  },
  {
    intent: "thanks",
    groups: [["thanks", "thank", "shukriya", "dhanyavaad", "dhanyawad", "thnx", "ty"]],
    response: "कोई बात नहीं! और कुछ करना हो तो बता दीजिए।",
  },
];

// ---------------------------------------------------------------------------
// Matching logic
// ---------------------------------------------------------------------------

const MISS: SemanticCacheMiss = { matched: false };

/**
 * Try to match the user's message against the semantic cache.
 * Returns a cached response if matched, otherwise passes through.
 */
export function trySemanticCache(
  text: string,
  session: SessionV2
): SemanticCacheOutcome {
  // When the user is already mid-flow (answering questions), let Gemini
  // handle it — it has the full conversation context to interpret short answers.
  if (session.current_flow && session.pending_fields.length > 0) {
    return MISS;
  }

  const words = extractWords(text);
  if (words.size === 0) return MISS;

  let bestMatch: CacheEntry | null = null;
  let bestGroupsMatched = 0;

  for (const entry of CACHE_ENTRIES) {
    const groupsMatched = entry.groups.filter((group) =>
      group.some((keyword) => words.has(keyword))
    ).length;

    // Must match ALL groups for this entry to count.
    if (groupsMatched === entry.groups.length && groupsMatched > bestGroupsMatched) {
      bestGroupsMatched = groupsMatched;
      bestMatch = entry;
    }
  }

  if (!bestMatch) return MISS;

  return {
    matched: true,
    intent: bestMatch.intent,
    response: bestMatch.response,
    flow_update: bestMatch.flow_update,
  };
}

/**
 * Extract meaningful words from STT-style Hinglish input.
 * Strips punctuation, lowercases, removes very short filler words.
 */
function extractWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

/**
 * Check if the user message indicates starting a new flow (new lead, schedule visit, etc).
 * Used by core.ts to clear stale collected_entities before calling Gemini —
 * so we don't carry over a previous lead's phone number when the user says "ek aur lead add karo".
 */
export function matchesFlowStartIntent(text: string): boolean {
  return getFlowStartUpdate(text) !== null;
}

/**
 * Return the flow_update for the matching flow-start intent, or null if none.
 * Used by core.ts on the Gemini path to fully reset session (current_flow, pending_fields,
 * collected_entities) when the user starts a new flow — e.g. "new lead" as a different project.
 */
export function getFlowStartUpdate(
  text: string
): { current_flow: string; pending_fields: string[] } | null {
  const words = extractWords(text);
  if (words.size === 0) return null;

  for (const entry of CACHE_ENTRIES) {
    if (!entry.flow_update) continue;
    const groupsMatched = entry.groups.filter((group) =>
      group.some((keyword) => words.has(keyword))
    ).length;
    if (groupsMatched === entry.groups.length) return entry.flow_update;
  }
  return null;
}
