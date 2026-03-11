/**
 * High-level: This file is the “short‑term memory” for each user.
 *
 * Non‑technical view:
 * - We store the last ~20 messages and key session info in Redis for every user.
 * - This lets Gemini see the full conversation history, not just the latest line.
 * - We also remember which lead is active and what information is still missing.
 * - Data is automatically cleaned up after a couple of hours of inactivity.
 */
import { redis } from "@/lib/redis";
import type { ConversationMessage, ConversationV2, SessionV2 } from "./types";
import { DEFAULT_CONVERSATION_V2, DEFAULT_SESSION_V2 } from "./types";

// Storage key prefix, max messages to keep, and how long data lives before auto-cleanup.
const KEY_PREFIX = "bot:v2:";
const MAX_MESSAGES = 20;
const TTL_SECONDS = 2 * 60 * 60; // 2 hours

function key(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

/**
 * Load conversation + session from Redis. Returns defaults if nothing stored.
 */
export async function loadConversation(
  userId: string
): Promise<ConversationV2> {
  try {
    // Fetch from Redis and normalize so we always have valid shapes.
    const raw = await redis.get<ConversationV2>(key(userId));
    if (!raw) return { ...DEFAULT_CONVERSATION_V2, messages: [] };

    return {
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      session: raw.session
        ? {
            active_lead_id: raw.session.active_lead_id ?? null,
            current_flow: raw.session.current_flow ?? null,
            collected_entities:
              raw.session.collected_entities &&
              typeof raw.session.collected_entities === "object"
                ? raw.session.collected_entities
                : {},
            pending_fields: Array.isArray(raw.session.pending_fields)
              ? raw.session.pending_fields
              : [],
          }
        : { ...DEFAULT_SESSION_V2 },
    };
  } catch (err) {
    console.error("[v2/conversation] Failed to load from Redis:", err);
    return { ...DEFAULT_CONVERSATION_V2, messages: [] };
  }
}

/**
 * Save conversation + session back to Redis.
 * Trims history to MAX_MESSAGES to bound token usage.
 */
export async function saveConversation(
  userId: string,
  conv: ConversationV2
): Promise<void> {
  try {
    // Keep only the last N messages to limit size, then store with expiry.
    const trimmed: ConversationV2 = {
      messages: conv.messages.slice(-MAX_MESSAGES),
      session: conv.session,
    };

    await redis.set(key(userId), trimmed, { ex: TTL_SECONDS });
  } catch (err) {
    console.error("[v2/conversation] Failed to save to Redis:", err);
  }
}

/**
 * Append a message and return the updated conversation.
 * Does NOT persist — call saveConversation separately after all messages are appended.
 */
export function appendMessage(
  conv: ConversationV2,
  msg: ConversationMessage
): ConversationV2 {
  // Add a message to the list; caller must call saveConversation to persist.
  return {
    ...conv,
    messages: [...conv.messages, msg],
  };
}

/**
 * Update session fields (partial merge).
 * When collected_entities is passed as {} (empty), it CLEARS all collected data.
 * When collected_entities has keys, it MERGES with existing.
 */
export function updateSession(
  conv: ConversationV2,
  update: Partial<SessionV2>
): ConversationV2 {
  const collectedEntities =
    update.collected_entities === undefined
      ? conv.session.collected_entities
      : Object.keys(update.collected_entities).length === 0
        ? {}
        : { ...conv.session.collected_entities, ...update.collected_entities };

  return {
    ...conv,
    session: {
      ...conv.session,
      ...update,
      collected_entities: collectedEntities,
    },
  };
}

/**
 * Reset conversation to defaults (useful after cache invalidation or manual reset).
 */
export async function resetConversation(userId: string): Promise<void> {
  try {
    // Delete all stored conversation data for this user.
    await redis.del(key(userId));
  } catch (err) {
    console.error("[v2/conversation] Failed to reset:", err);
  }
}
