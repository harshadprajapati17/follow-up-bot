/**
 * High-level: Same as /api/v2/chat but without Gemini caching.
 *
 * Non‑technical view:
 * - This is mainly for debugging and comparison.
 * - It uses the exact same brain (`handleChatV2`) but asks Gemini to recompute
 *   the full prompt every time, so we can compare speed and token usage.
 */
import { NextRequest, NextResponse } from "next/server";
import { handleChatV2 } from "@/lib/v2/core";
import type { ChatV2Response } from "@/lib/v2/types";

export const runtime = "nodejs";

/**
 * POST /api/v2/chat-no-cache
 * Debug endpoint — sends system prompt + tools inline (no explicit cache).
 * Use for A/B comparison with the cached endpoint.
 */
export async function POST(req: NextRequest) {
  let body: { userId?: string; text?: string };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json<ChatV2Response>(
      { status: "error", message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const { userId, text } = body ?? {};

  if (!userId || typeof userId !== "string") {
    return NextResponse.json<ChatV2Response>(
      { status: "error", message: "userId is required." },
      { status: 400 }
    );
  }

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return NextResponse.json<ChatV2Response>(
      { status: "error", message: "text is required." },
      { status: 400 }
    );
  }

  const result = await handleChatV2({
    userId,
    text,
    useCache: false,
    endpoint: "chat-no-cache",
  });

  const statusCode = result.status === "error" ? 502 : 200;
  return NextResponse.json<ChatV2Response>(result, { status: statusCode });
}
