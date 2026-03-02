import { getSession, setSession } from "@/lib/redis";
import { NextResponse } from "next/server";

const HEALTH_CHECK_KEY = "health-check";
const TTL_SECONDS = 10;

export async function GET() {
  try {
    await setSession(HEALTH_CHECK_KEY, { ping: true }, TTL_SECONDS);
    const value = await getSession<{ ping: boolean }>(HEALTH_CHECK_KEY);

    if (value?.ping !== true) {
      return NextResponse.json(
        { status: "error", message: "Health check read-back failed" },
        { status: 503 }
      );
    }

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { status: "error", message },
      { status: 503 }
    );
  }
}
