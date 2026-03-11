/**
 * High-level: Main V2 API endpoint used by the app/frontend.
 *
 * Non‑technical view:
 * - The UI sends `userId` + `text` here.
 * - This endpoint calls the new V2 brain (`handleChatV2`) with caching turned ON.
 * - The response is a simple JSON with the bot’s message (and some metadata).
 */
import { NextRequest, NextResponse } from "next/server";
import { handleChatV2 } from "@/lib/v2/core";
import type { ChatV2Response } from "@/lib/v2/types";

export const runtime = "nodejs";

/**
 * POST /api/v2/chat
 * Production endpoint — uses explicit Gemini cache for system prompt + tools.
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
    useCache: true,
    endpoint: "chat",
  });

  const statusCode = result.status === "error" ? 502 : 200;
  return NextResponse.json<ChatV2Response>(result, { status: statusCode });
}
