/**
 * GET /api/v3/logs
 * Returns V3 call logs with optional filters for the visualization page.
 *
 * Query params:
 *   userId    — filter by user
 *   limit     — max rows (default 50, max 200)
 *   offset    — pagination offset
 *   requestId — fetch a single log by its request_id
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { fetchV3Logs, fetchV3LogById } from "@/lib/v3/logger";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;

    const requestId = sp.get("requestId");
    if (requestId) {
      const log = await fetchV3LogById(requestId);
      if (!log)
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(log);
    }

    const userId = sp.get("userId") ?? undefined;
    const limit = sp.get("limit") ? Number(sp.get("limit")) : undefined;
    const offset = sp.get("offset") ? Number(sp.get("offset")) : undefined;

    const result = await fetchV3Logs({
      userId,
      limit,
      offset,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/v3/logs] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

