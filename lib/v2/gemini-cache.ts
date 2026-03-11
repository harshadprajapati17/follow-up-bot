/**
 * High-level: This file manages a long‑lived “cache” on Gemini’s side.
 *
 * Why we need it (non‑technical explanation):
 * - Our bot always sends the same “rules” and “tools” to Gemini (how the bot should behave).
 * - Gemini can remember this static part so we don’t pay for it fully on every message.
 * - This file creates that shared memory once and then reuses it for all conversations.
 * - When we change the bot’s rules/tools in code, we automatically create a fresh cache.
 */
import { GoogleGenAI } from "@google/genai";
import { createHash } from "crypto";
import { SYSTEM_PROMPT } from "./system-prompt";
import { ALL_TOOL_DECLARATIONS, MODEL_NAME } from "./gemini-tools";

// ---------------------------------------------------------------------------
// Client (reused from gemini-tools, but we need our own ref for cache ops)
// ---------------------------------------------------------------------------

const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// ---------------------------------------------------------------------------
// Version hash — changes whenever system prompt or tool definitions change
// ---------------------------------------------------------------------------

// Create a fingerprint from our rules and tools so we know when to refresh the cache.
const CONTENT_HASH = createHash("md5")
  .update(SYSTEM_PROMPT + JSON.stringify(ALL_TOOL_DECLARATIONS))
  .digest("hex")
  .slice(0, 8);

// Human-readable label for the cache so we can find or clean up old versions.
const CACHE_DISPLAY_NAME = `paint-bot-v2-${CONTENT_HASH}`;

const CACHE_TTL_SECONDS = 365 * 86400; // 1 year — effectively permanent

// ---------------------------------------------------------------------------
// Module-level state — survives across requests in the same process
// ---------------------------------------------------------------------------

// Keep the cache name in memory so we don't look it up again on every request.
let cachedContentName: string | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get or create the explicit Gemini cache containing our system prompt + tools.
 * - On first call (or cold start): looks for an existing cache by displayName.
 * - If not found: creates a new one and cleans up old versions.
 * - Subsequent calls in the same process: returns the cached name instantly.
 */
export async function getOrCreateCache(): Promise<string> {
  // If we already have it in memory, return immediately.
  if (cachedContentName) return cachedContentName;

  if (!ai) throw new Error("GEMINI_API_KEY is not configured");

  // Look for an existing cache on Gemini's side that matches our rules and tools.
  const existing = await findExistingCache();
  if (existing) {
    cachedContentName = existing;
    console.log(`[v2/cache] Reusing existing cache: ${existing}`);
    return cachedContentName;
  }

  // No existing cache found — create a new one with our rules and tools.
  console.log(
    `[v2/cache] Creating new cache: ${CACHE_DISPLAY_NAME} (TTL ${CACHE_TTL_SECONDS}s)`
  );

  const cache = await ai.caches.create({
    model: MODEL_NAME,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: ALL_TOOL_DECLARATIONS }],
      ttl: `${CACHE_TTL_SECONDS}s`,
      displayName: CACHE_DISPLAY_NAME,
    },
  });

  cachedContentName = cache.name!;
  console.log(`[v2/cache] Created cache: ${cachedContentName}`);

  // Remove old cache versions in the background so we don't clutter Gemini.
  cleanupOldCaches().catch((err) =>
    console.error("[v2/cache] Cleanup failed:", err)
  );

  return cachedContentName;
}

/**
 * Force-invalidate all paint-bot-v2 caches. Useful on manual deploy triggers.
 * Returns the number of caches deleted.
 */
export async function invalidateAllCaches(): Promise<number> {
  if (!ai) throw new Error("GEMINI_API_KEY is not configured");

  // Loop through all caches, delete ours, and reset memory so next request creates fresh.
  const pager = await ai.caches.list({ config: { pageSize: 100 } });
  let deleted = 0;

  for await (const cache of pager) {
    if (cache.displayName?.startsWith("paint-bot-v2-")) {
      try {
        await ai.caches.delete({ name: cache.name! });
        deleted++;
      } catch (err) {
        console.error(`[v2/cache] Failed to delete ${cache.name}:`, err);
      }
    }
  }

  cachedContentName = null;
  console.log(`[v2/cache] Invalidated ${deleted} cache(s)`);
  return deleted;
}

/**
 * Get the current content hash (useful for debugging / health checks).
 */
// Return debug info: our fingerprint, cache name, and model.
export function getCacheInfo() {
  return {
    content_hash: CONTENT_HASH,
    display_name: CACHE_DISPLAY_NAME,
    cached_name: cachedContentName,
    model: MODEL_NAME,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Search Gemini's caches for one that matches our rules and tools.
async function findExistingCache(): Promise<string | null> {
  if (!ai) return null;

  try {
    const pager = await ai.caches.list({ config: { pageSize: 100 } });

    for await (const cache of pager) {
      if (cache.displayName === CACHE_DISPLAY_NAME) {
        return cache.name ?? null;
      }
    }
  } catch (err) {
    console.error("[v2/cache] Error listing caches:", err);
  }

  return null;
}

// Remove old cache versions (from previous code deployments) to avoid clutter.
async function cleanupOldCaches(): Promise<void> {
  if (!ai) return;

  try {
    const pager = await ai.caches.list({ config: { pageSize: 100 } });

    for await (const cache of pager) {
      const isOurs = cache.displayName?.startsWith("paint-bot-v2-");
      const isOldVersion = cache.displayName !== CACHE_DISPLAY_NAME;

      if (isOurs && isOldVersion) {
        try {
          await ai.caches.delete({ name: cache.name! });
          console.log(`[v2/cache] Deleted old cache: ${cache.displayName}`);
        } catch (delErr) {
          console.error(
            `[v2/cache] Failed to delete old cache ${cache.displayName}:`,
            delErr
          );
        }
      }
    }
  } catch (err) {
    console.error("[v2/cache] Error during cleanup:", err);
  }
}
