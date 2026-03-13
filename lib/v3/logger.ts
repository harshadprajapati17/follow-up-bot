import { getMongoDb } from "@/lib/mongo";
import type { GeminiToolCall } from "./types";

const COLLECTION_NAME = "bot_v3_logs";

export interface V3ToolExecutionLog {
  name: string;
  args: Record<string, unknown>;
  result_message: string;
  success: boolean;
  quote_pdf_url?: string;
}

export interface V3CallLog {
  request_id: string;
  user_id: string;
  timestamp: number;
  user_text: string;

  // Raw Gemini response (before we decide how to reply)
  gemini_text: string | null;
  gemini_tool_calls: GeminiToolCall[];
  gemini_input_tokens: number;
  gemini_output_tokens: number;

  /**
   * Full content array we sent to Gemini (context + history), as used in
   * the generateContent call. Helpful to understand why Gemini behaved
   * a certain way for this turn.
   */
  gemini_contents?: unknown;

  // Tools we actually executed (in order)
  tools: V3ToolExecutionLog[];

  // What the user finally saw
  final_message: string;

  // High-level outcome flags
  error?: boolean;
  greeting_shortcut?: boolean;
}

/**
 * Persist a V3 call log to MongoDB and emit a compact console log.
 * Non-blocking for the main flow — if Mongo is unavailable, we just skip.
 */
export async function logV3Call(entry: V3CallLog): Promise<void> {
  // Compact console line for quick grepping
  console.log(
    JSON.stringify({
      _tag: "v3_call",
      request_id: entry.request_id,
      user_id: entry.user_id,
      tools: entry.tools.map((t) => t.name),
      error: entry.error ?? false,
    })
  );

  const db = await getMongoDb();
  if (!db) return;

  try {
    const collection = db.collection(COLLECTION_NAME);
    await collection.insertOne({
      ...entry,
      _created_at: new Date(entry.timestamp),
    });
  } catch (err) {
    console.error("[v3/logger] MongoDB persist failed:", err);
  }
}

export interface V3LogsQuery {
  userId?: string;
  limit?: number;
  offset?: number;
}

export async function fetchV3Logs(
  query: V3LogsQuery = {}
): Promise<{ logs: V3CallLog[]; total: number }> {
  const db = await getMongoDb();
  if (!db) return { logs: [], total: 0 };

  const collection = db.collection(COLLECTION_NAME);

  const filter: Record<string, unknown> = {};
  if (query.userId) filter.user_id = query.userId;

  const total = await collection.countDocuments(filter);
  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;

  const docs = await collection
    .find(filter)
    .sort({ timestamp: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();

  const logs = docs.map((doc) => {
    const { _id, _created_at, ...rest } = doc as any;
    void _id;
    void _created_at;
    return rest as V3CallLog;
  });

  return { logs, total };
}

export async function fetchV3LogById(
  requestId: string
): Promise<V3CallLog | null> {
  const db = await getMongoDb();
  if (!db) return null;

  const collection = db.collection(COLLECTION_NAME);
  const doc = await collection.findOne({ request_id: requestId });
  if (!doc) return null;

  const { _id, _created_at, ...rest } = doc as any;
  void _id;
  void _created_at;
  return rest as V3CallLog;
}

/**
 * Ensure TTL and basic indexes exist on the V3 logs collection.
 * Call once on app startup (idempotent).
 */
export async function ensureV3LogIndexes(): Promise<void> {
  try {
    const db = await getMongoDb();
    if (!db) return;

    const collection = db.collection(COLLECTION_NAME);
    await collection.createIndex(
      { _created_at: 1 },
      { expireAfterSeconds: 30 * 86400 }
    );
    await collection.createIndex({ user_id: 1, timestamp: -1 });
    await collection.createIndex({ request_id: 1 }, { unique: true });
  } catch (err) {
    console.error("[v3/logger] Failed to ensure indexes:", err);
  }
}

