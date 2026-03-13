import { NextRequest, NextResponse } from "next/server";
import { handleChatV3 } from "@/lib/v3/core";
import { ensureIndexes } from "@/lib/v3/conversation";
import { ensureV3LogIndexes } from "@/lib/v3/logger";
import type { ChatV3Response } from "@/lib/v3/types";

// Run once on first request
let indexesReady = false;

export const runtime = "nodejs";

/**
 * POST /api/v3/chat
 * V3 endpoint — no caching layers, Gemini owns the conversation.
 * Body: { userId: string, text: string }
 */
export async function POST(req: NextRequest) {
  let body: { userId?: string; text?: string };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json<ChatV3Response>(
      { status: "error", message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const { userId, text } = body ?? {};

  if (!userId || typeof userId !== "string") {
    return NextResponse.json<ChatV3Response>(
      { status: "error", message: "userId is required." },
      { status: 400 }
    );
  }

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return NextResponse.json<ChatV3Response>(
      { status: "error", message: "text is required." },
      { status: 400 }
    );
  }

  // Guard against excessively long messages (potential prompt injection / abuse)
  if (text.length > 1000) {
    return NextResponse.json<ChatV3Response>(
      { status: "error", message: "Message too long. Keep it under 1000 characters." },
      { status: 400 }
    );
  }

  if (!indexesReady) {
    await Promise.all([ensureIndexes(), ensureV3LogIndexes()]);
    indexesReady = true;
  }

  const result = await handleChatV3({ userId, text });
  const statusCode = result.status === "error" ? 502 : 200;
  return NextResponse.json<ChatV3Response>(result, { status: statusCode });
}
