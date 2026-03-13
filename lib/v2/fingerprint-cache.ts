/**
 * FINGERPRINT CACHE — self-learning cache stored in MongoDB (zero extra cost).
 *
 * HOW IT WORKS:
 *   1. LEARNING: When Gemini answers a "first message" (user not mid-flow, no tool call),
 *      we extract keywords from the user's text, remove stop words, and save to MongoDB:
 *      { keywords: ["lead", "naya", "banana"], response: "Customer ka naam bata do..." }
 *
 *   2. MATCHING: Next time a similar message comes in, we find saved entries that share
 *      keywords. If 70%+ of a saved entry's keywords appear in the new message, we
 *      return the saved response — skipping Gemini entirely.
 *
 *   3. CLEANUP: Entries auto-delete after 90 days via MongoDB TTL index.
 *
 * EXAMPLE:
 *   Turn 1: User says "mujhe ek naya customer add karna hai"
 *           → keywords: ["add", "customer", "karna", "naya"]  → goes to Gemini → learns response
 *   Turn 2: User says "new customer add karo"
 *           → keywords: ["add", "customer", "karo", "new"]
 *           → Mongo finds saved entry, overlap = 2/4 = 50% (miss — below 70%)
 *   Turn 3: User says "customer add karna hai naya"
 *           → keywords: ["add", "customer", "karna", "naya"]
 *           → Mongo finds saved entry, overlap = 4/4 = 100% (HIT — return cached response)
 */
import { getMongoDb } from "@/lib/mongo";
import type { SessionV2 } from "./types";

// MongoDB collection name where fingerprints are stored.
const COLLECTION = "bot_v2_fingerprint_cache";

// A match needs 70%+ of the saved entry's keywords to appear in the user's message.
const SIMILARITY_THRESHOLD = 0.7;

// Messages with fewer than 2 meaningful keywords are too vague to cache/match.
const MIN_KEYWORDS = 2;

// Don't compare against more than 20 candidates per lookup (performance guard).
const MAX_CANDIDATES = 20;

// ---------------------------------------------------------------------------
// Types — what a fingerprint lookup returns
// ---------------------------------------------------------------------------

export interface FingerprintHit {
  matched: true;
  response: string;
  similarity: number;
  original_text: string;
  fingerprint: string;
}

export interface FingerprintMiss {
  matched: false;
}

export type FingerprintOutcome = FingerprintHit | FingerprintMiss;

// ---------------------------------------------------------------------------
// Stop words — Hinglish filler words that don't help identify intent.
// e.g. "mujhe ek naya lead banana hai" → after removing stop words → "naya lead banana"
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  // Hindi particles — no intent meaning
  "hai", "ho", "hoon", "tha", "thi", "the", "hain",
  "ka", "ki", "ke", "ko", "se", "mein", "par", "pe", "ne",
  "ek", "ye", "yeh", "woh", "wo", "jo", "jis",
  "bhi", "toh", "hi", "na", "nahi",
  "mujhe", "mera", "meri", "mere", "apna", "apni", "apne",
  "aur", "ya", "lekin", "agar", "jab", "tab",
  // English particles — same idea
  "the", "an", "is", "are", "was", "were",
  "me", "my", "we", "our", "you", "your",
  "it", "its", "this", "that", "for", "to", "of", "in", "on", "at",
  "and", "or", "but", "if", "so",
]);

// ---------------------------------------------------------------------------
// Keyword extraction — turn user text into a sorted list of meaningful words.
// "mujhe ek naya lead banana hai" → ["banana", "lead", "naya"]
// ---------------------------------------------------------------------------

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .sort();
}

// Join sorted unique keywords into one string for exact-match dedup in MongoDB.
function buildFingerprint(keywords: string[]): string {
  return [...new Set(keywords)].sort().join(" ");
}

// ---------------------------------------------------------------------------
// LOOKUP — search MongoDB for a cached response that matches the user's message.
// Returns FingerprintHit if a similar past message is found, FingerprintMiss otherwise.
// ---------------------------------------------------------------------------

const MISS: FingerprintMiss = { matched: false };

export async function findFingerprintMatch(
  text: string,
  session: SessionV2
): Promise<FingerprintOutcome> {
  // Skip lookup if user is mid-flow — their message is an answer, not a new intent.
  // Also covers "update_lead" enrichment flow (asking location/scope/size after lead is saved).
  if (session.current_flow) {
    return MISS;
  }

  // Extract keywords and check minimum count.
  const queryKeywords = [...new Set(extractKeywords(text))];
  if (queryKeywords.length < MIN_KEYWORDS) return MISS;

  try {
    const db = await getMongoDb();
    if (!db) return MISS;

    const collection = db.collection(COLLECTION);

    // Step 1: Pre-filter — find entries that share at least one keyword and have similar length.
    // This avoids scanning the entire collection.
    const candidates = await collection
      .find({
        keywords: { $in: queryKeywords },
        keyword_count: { $gte: queryKeywords.length - 2, $lte: queryKeywords.length + 2 },
      })
      .limit(MAX_CANDIDATES)
      .toArray();

    if (candidates.length === 0) return MISS;

    // Step 2: Score each candidate — what % of its keywords appear in the user's message?
    let bestSimilarity = 0;
    let bestCandidate: (typeof candidates)[0] | null = null;

    for (const candidate of candidates) {
      const cachedKws = candidate.keywords as string[];
      const cachedSet = new Set(cachedKws);
      const intersection = queryKeywords.filter((w) => cachedSet.has(w)).length;
      const similarity = cachedSet.size > 0 ? intersection / cachedSet.size : 0;

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestCandidate = candidate;
      }
    }

    // Step 3: Only return if similarity meets threshold (70%+).
    if (!bestCandidate || bestSimilarity < SIMILARITY_THRESHOLD) return MISS;

    // Increment hit count in background — don't slow down the response.
    collection
      .updateOne({ _id: bestCandidate._id }, { $inc: { hit_count: 1 }, $set: { last_hit_at: new Date() } })
      .catch(() => {});

    return {
      matched: true,
      response: bestCandidate.response as string,
      similarity: bestSimilarity,
      original_text: bestCandidate.original_text as string,
      fingerprint: bestCandidate.fingerprint as string,
    };
  } catch (err) {
    console.error("[v2/fingerprint-cache] Lookup failed:", err);
    return MISS;
  }
}

// ---------------------------------------------------------------------------
// SAVE — store a new fingerprint entry after Gemini responds.
// Called from core.ts when: no tool call, user was not mid-flow, response > 10 chars.
// Uses upsert so the same keyword set is never stored twice.
// ---------------------------------------------------------------------------

export async function saveFingerprint(
  userText: string,
  response: string
): Promise<void> {
  const keywords = [...new Set(extractKeywords(userText))];
  if (keywords.length < MIN_KEYWORDS) return;

  const fingerprint = buildFingerprint(keywords);

  try {
    const db = await getMongoDb();
    if (!db) return;

    const collection = db.collection(COLLECTION);

    // Upsert by fingerprint — if same keywords exist, don't overwrite.
    await collection.updateOne(
      { fingerprint },
      {
        $setOnInsert: {
          fingerprint,
          keywords,
          keyword_count: keywords.length,
          original_text: userText,
          response,
          hit_count: 0,
          created_at: new Date(),
          last_hit_at: null,
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("[v2/fingerprint-cache] Save failed:", err);
  }
}

// ---------------------------------------------------------------------------
// INDEXES — call once on app startup. Creates:
//   - Unique index on fingerprint (dedup)
//   - Index on keywords (for $in queries during lookup)
//   - TTL index on created_at (auto-delete after 90 days)
// ---------------------------------------------------------------------------

export async function ensureFingerprintIndexes(): Promise<void> {
  try {
    const db = await getMongoDb();
    if (!db) return;

    const collection = db.collection(COLLECTION);

    await collection.createIndex({ fingerprint: 1 }, { unique: true });
    await collection.createIndex({ keywords: 1 });
    await collection.createIndex({ created_at: 1 }, { expireAfterSeconds: 90 * 86400 });
  } catch (err) {
    console.error("[v2/fingerprint-cache] Index creation failed:", err);
  }
}
