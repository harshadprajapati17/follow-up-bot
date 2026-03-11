/**
 * GET /api/v2/logs
 * Returns V2 call logs with optional filters for the visualization page.
 *
 * Query params:
 *   userId    — filter by user
 *   endpoint  — "chat" | "chat-no-cache"
 *   layerHit  — "local" | "semantic_cache" | "gemini"
 *   limit     — max rows (default 50, max 200)
 *   offset    — pagination offset
 *   requestId — fetch a single log by its request_id
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { fetchV2Logs, fetchV2LogById } from "@/lib/v2/logger";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;

    const requestId = sp.get("requestId");
    if (requestId) {
      const log = await fetchV2LogById(requestId);
      if (!log)
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(log);
    }

    const userId = sp.get("userId") ?? undefined;
    const endpoint = sp.get("endpoint") as
      | "chat"
      | "chat-no-cache"
      | undefined;
    const layerHit = sp.get("layerHit") as
      | "local"
      | "semantic_cache"
      | "gemini"
      | undefined;
    const limit = sp.get("limit") ? Number(sp.get("limit")) : undefined;
    const offset = sp.get("offset") ? Number(sp.get("offset")) : undefined;

    const result = await fetchV2Logs({
      userId,
      endpoint,
      layerHit,
      limit,
      offset,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/v2/logs] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
