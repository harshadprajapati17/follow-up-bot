/**
 * GET  /api/pricing          — return current pricing (custom or default)
 * PUT  /api/pricing          — save custom pricing for a userId
 *
 * Body for PUT: { userId: string, pricing: Partial<PricingData> }
 */
import { NextRequest, NextResponse } from "next/server";
import { getMongoDb } from "@/lib/mongo";
import { DEFAULT_PRICING, type PricingData } from "@/lib/v2/pricing-data";

const COLLECTION = "pricing";

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json(DEFAULT_PRICING);
  }

  try {
    const db = await getMongoDb();
    const doc = db ? await db.collection(COLLECTION).findOne({ userId }) : null;
    const pricing: PricingData = doc
      ? { ...DEFAULT_PRICING, ...(doc.pricing as Partial<PricingData>) }
      : DEFAULT_PRICING;
    return NextResponse.json(pricing);
  } catch {
    return NextResponse.json(DEFAULT_PRICING);
  }
}

export async function PUT(req: NextRequest) {
  let body: { userId?: string; pricing?: Partial<PricingData> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userId, pricing } = body ?? {};
  if (!userId || !pricing) {
    return NextResponse.json(
      { error: "userId and pricing are required" },
      { status: 400 }
    );
  }

  try {
    const db = await getMongoDb();
    if (!db) throw new Error("DB unavailable");
    await db.collection(COLLECTION).updateOne(
      { userId },
      { $set: { userId, pricing, updated_at: new Date() } },
      { upsert: true }
    );
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/pricing] PUT error:", err);
    return NextResponse.json({ error: "Failed to save pricing" }, { status: 500 });
  }
}
