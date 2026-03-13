import { NextResponse } from "next/server";
import { VOICE_ENABLED } from "@/lib/v3/gemini";

export const runtime = "nodejs";

/** GET /api/v3/config — returns feature flags for the V3 frontend. */
export async function GET() {
  return NextResponse.json({ voiceEnabled: VOICE_ENABLED });
}
