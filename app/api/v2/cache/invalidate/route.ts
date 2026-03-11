/**
 * High-level: Ops endpoint to manage the Gemini context cache.
 *
 * Non‑technical view:
 * - GET  /api/v2/cache/invalidate     → shows which cache version is active.
 * - POST /api/v2/cache/invalidate     → (with secret) clears all caches so that
 *   the next request creates a fresh one, useful after big rule/tool changes.
 */
import { NextRequest, NextResponse } from "next/server";
import { invalidateAllCaches, getCacheInfo } from "@/lib/v2/gemini-cache";

export const runtime = "nodejs";

/**
 * POST /api/v2/cache/invalidate
 * Force-clear all paint-bot-v2 Gemini caches.
 * Protected by ADMIN_SECRET env variable.
 *
 * GET  /api/v2/cache/invalidate — returns current cache info (no auth required).
 */
export async function POST(req: NextRequest) {
  let body: { secret?: string };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || body.secret !== adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const deleted = await invalidateAllCaches();
    return NextResponse.json({
      success: true,
      deleted,
      message: `Invalidated ${deleted} cache(s). Next request will create a fresh cache.`,
    });
  } catch (err) {
    console.error("[v2/cache/invalidate] Error:", err);
    return NextResponse.json(
      { error: "Failed to invalidate caches." },
      { status: 500 }
    );
  }
}

export async function GET() {
  const info = getCacheInfo();
  return NextResponse.json(info);
}
