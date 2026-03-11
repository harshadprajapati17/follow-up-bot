/**
 * High-level: This file records what the bot is doing, for later analysis.
 *
 * Non‑technical view:
 * - Every V2 request writes a compact "log line" to the database and console.
 * - Logs include: which endpoint, which tool (if any), tokens, latency, errors.
 * - The pipeline_trace field stores the step-by-step flow for visualization.
 * - This makes it easy to compare cached vs non‑cached paths and debug issues.
 * - Old logs are automatically deleted after 30 days to keep storage light.
 */
import { getMongoDb } from "@/lib/mongo";
import type { V2CallLog } from "./types";

const COLLECTION_NAME = "bot_v2_logs";

/**
 * Persist a V2 call log to MongoDB and emit a structured console log.
 * Non-blocking — errors are swallowed so logging never breaks the main flow.
 */
export async function logV2Call(entry: V2CallLog): Promise<void> {
  console.log(
    JSON.stringify({
      _tag: "v2_call",
      request_id: entry.request_id,
      layer_hit: entry.layer_hit,
      latency_ms: entry.latency_ms,
      tool_called: entry.tool_called,
      input_tokens: entry.input_tokens,
      output_tokens: entry.output_tokens,
    })
  );

  persistToMongo(entry).catch((err) =>
    console.error("[v2/logger] MongoDB persist failed:", err)
  );
}

async function persistToMongo(entry: V2CallLog): Promise<void> {
  const db = await getMongoDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.insertOne({
    ...entry,
    _created_at: new Date(entry.timestamp),
  });
}

/**
 * Ensure a TTL index exists on the logs collection.
 * Call once on app startup (idempotent).
 */
export async function ensureLogIndexes(): Promise<void> {
  try {
    const db = await getMongoDb();
    if (!db) return;

    const collection = db.collection(COLLECTION_NAME);
    await collection.createIndex(
      { _created_at: 1 },
      { expireAfterSeconds: 30 * 86400 }
    );
    await collection.createIndex({ user_id: 1, timestamp: -1 });
    await collection.createIndex({ endpoint: 1, timestamp: -1 });
    await collection.createIndex({ request_id: 1 }, { unique: true });
  } catch (err) {
    console.error("[v2/logger] Failed to ensure indexes:", err);
  }
}

// ---------------------------------------------------------------------------
// Fetch functions for the visualization page
// ---------------------------------------------------------------------------

export interface LogsQuery {
  userId?: string;
  endpoint?: "chat" | "chat-no-cache";
  layerHit?: "local" | "semantic_cache" | "gemini";
  limit?: number;
  offset?: number;
}

/**
 * Fetch V2 call logs from MongoDB with optional filters.
 * Returns newest-first.
 */
export async function fetchV2Logs(
  query: LogsQuery = {}
): Promise<{ logs: V2CallLog[]; total: number }> {
  const db = await getMongoDb();
  if (!db) return { logs: [], total: 0 };

  const collection = db.collection(COLLECTION_NAME);

  const filter: Record<string, unknown> = {};
  if (query.userId) filter.user_id = query.userId;
  if (query.endpoint) filter.endpoint = query.endpoint;
  if (query.layerHit) filter.layer_hit = query.layerHit;

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
    const { _id, _created_at, ...rest } = doc;
    void _id;
    void _created_at;
    return rest as unknown as V2CallLog;
  });

  return { logs, total };
}

/**
 * Fetch a single log by request_id.
 */
export async function fetchV2LogById(
  requestId: string
): Promise<V2CallLog | null> {
  const db = await getMongoDb();
  if (!db) return null;

  const collection = db.collection(COLLECTION_NAME);
  const doc = await collection.findOne({ request_id: requestId });
  if (!doc) return null;

  const { _id, _created_at, ...rest } = doc;
  void _id;
  void _created_at;
  return rest as unknown as V2CallLog;
}
