/**
 * V3 conversation store — MongoDB only, no Redis.
 * Keeps last MAX_MESSAGES turns. When history grows beyond SUMMARIZE_THRESHOLD,
 * older messages are compacted into a summary via Gemini.
 */
import { getMongoDb } from "../mongo";
import type { ConversationV3, Message } from "./types";

interface ConversationDoc {
  _id: string;
  active_lead_id: string | null;
  summary: string;
  messages: Message[];
  updatedAt: Date;
}

const COLLECTION = "v3_conversations";
const MAX_MESSAGES = 15;
const SUMMARIZE_THRESHOLD = 20;

export async function loadConversation(userId: string): Promise<ConversationV3> {
  const db = await getMongoDb();
  if (!db) {
    return { active_lead_id: null, summary: "", messages: [], updatedAt: new Date() };
  }

  const doc = await db.collection<ConversationDoc>(COLLECTION).findOne({ _id: userId });
  if (!doc) {
    return { active_lead_id: null, summary: "", messages: [], updatedAt: new Date() };
  }

  return {
    active_lead_id: doc.active_lead_id ?? null,
    summary: doc.summary ?? "",
    messages: doc.messages ?? [],
    updatedAt: doc.updatedAt ?? new Date(),
  };
}

export async function saveConversation(userId: string, conv: ConversationV3): Promise<void> {
  const db = await getMongoDb();
  if (!db) return;

  // Trim to MAX_MESSAGES before saving
  const trimmed = conv.messages.slice(-MAX_MESSAGES);

  await db.collection<ConversationDoc>(COLLECTION).updateOne(
    { _id: userId },
    {
      $set: {
        active_lead_id: conv.active_lead_id,
        summary: conv.summary,
        messages: trimmed,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

export function appendMessage(conv: ConversationV3, msg: Message): ConversationV3 {
  return { ...conv, messages: [...conv.messages, msg] };
}

/**
 * Returns true if we should summarize before the next Gemini call.
 * Triggers when message count exceeds threshold.
 */
export function shouldSummarize(conv: ConversationV3): boolean {
  return conv.messages.length >= SUMMARIZE_THRESHOLD;
}

/**
 * Compact oldest messages into summary using Gemini, keep newest 10.
 * Called before building Gemini contents when history is long.
 */
export async function compactConversation(conv: ConversationV3): Promise<ConversationV3> {
  const keepCount = 10;
  const toSummarize = conv.messages.slice(0, -keepCount);
  const toKeep = conv.messages.slice(-keepCount);

  if (toSummarize.length === 0) return conv;

  // Build a text block of the older messages for Gemini to summarize
  const historyText = toSummarize
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "User" : "Bot"}: ${m.content}`)
    .join("\n");

  const prevSummary = conv.summary
    ? `Previous summary: ${conv.summary}\n\n`
    : "";

  const prompt = `${prevSummary}Conversation to summarize:\n${historyText}\n\nSummarize in 2-4 bullet points: leads created (name, phone), visits scheduled, measurements logged, quotes generated. Be concise.`;

  try {
    const { callGeminiRaw } = await import("./gemini");
    const summary = await callGeminiRaw(prompt);
    return { ...conv, summary: summary ?? conv.summary, messages: toKeep };
  } catch {
    // If summarization fails, just trim — better than crashing
    return { ...conv, messages: toKeep };
  }
}

/**
 * Ensure the conversations collection has a TTL index (7 days inactivity).
 * Call once at app startup or first request.
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getMongoDb();
  if (!db) return;
  await db.collection(COLLECTION).createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 7 * 24 * 60 * 60, name: "ttl_7d" }
  );
}
