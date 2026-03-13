/**
 * Pure calculation engine — no DB, no AI.
 * Takes measurement data + pricing rates → returns itemized quote.
 */
import { DEFAULT_PRICING, type PricingData } from "./pricing-data";

export interface MeasurementInput {
  paintable_area_sqft: number;
  ceiling_included?: boolean;
  putty_coats?: number;          // 0, 1, or 2
  primer_included?: boolean;
  scrape_required?: boolean;
  damp_issue?: string;           // 'none' or description
  brand_preference?: string;     // 'Asian Paints', 'Berger', 'Nerolac', 'no preference'
  finish_quality?: string;       // 'BASIC', 'STANDARD', 'PREMIUM'
  quote_type?: string;           // 'LABOUR_ONLY' or 'LABOUR_PLUS_MATERIAL'
}

export interface QuoteLineItem {
  label: string;
  area_sqft: number;
  rate_per_sqft: number;
  amount: number;
}

export interface QuoteResult {
  line_items: QuoteLineItem[];
  subtotal: number;
  gst_amount: number;
  total: number;
  gst_percent: number;
  brand_name: string;
  product_name: string;
  quote_type: "LABOUR_ONLY" | "LABOUR_PLUS_MATERIAL";
}

function normalizeBrand(brand?: string): string {
  if (!brand || brand.toLowerCase().includes("no preference")) return "no preference";
  for (const key of ["Asian Paints", "Berger", "Nerolac"]) {
    if (brand.toLowerCase().includes(key.toLowerCase())) return key;
  }
  return "no preference";
}

function normalizeQuality(quality?: string): "basic" | "standard" | "premium" {
  const q = (quality ?? "").toUpperCase();
  if (q === "PREMIUM") return "premium";
  if (q === "STANDARD") return "standard";
  return "basic";
}

export function calculateQuote(
  input: MeasurementInput,
  pricing: PricingData = DEFAULT_PRICING
): QuoteResult {
  const area = input.paintable_area_sqft;
  const labour = pricing.labour;
  const quoteType: "LABOUR_ONLY" | "LABOUR_PLUS_MATERIAL" =
    input.quote_type === "LABOUR_PLUS_MATERIAL" ? "LABOUR_PLUS_MATERIAL" : "LABOUR_ONLY";

  const items: QuoteLineItem[] = [];

  // Scraping old paint
  if (input.scrape_required) {
    items.push({
      label: "Scraping (old paint removal)",
      area_sqft: area,
      rate_per_sqft: labour.scraping_per_sqft,
      amount: area * labour.scraping_per_sqft,
    });
  }

  // Putty coats
  const puttyCoats = input.putty_coats ?? 0;
  if (puttyCoats > 0) {
    const puttyRate = labour.putty_per_coat_per_sqft * puttyCoats;
    items.push({
      label: `Putty (${puttyCoats} coat${puttyCoats > 1 ? "s" : ""})`,
      area_sqft: area,
      rate_per_sqft: puttyRate,
      amount: area * puttyRate,
    });
  }

  // Primer
  if (input.primer_included) {
    items.push({
      label: "Primer (1 coat)",
      area_sqft: area,
      rate_per_sqft: labour.primer_per_sqft,
      amount: area * labour.primer_per_sqft,
    });
  }

  // Damp treatment
  const hasDamp = input.damp_issue && input.damp_issue.toLowerCase() !== "none" && input.damp_issue.trim() !== "";
  if (hasDamp) {
    items.push({
      label: "Damp / seepage treatment",
      area_sqft: area,
      rate_per_sqft: labour.damp_treatment_per_sqft,
      amount: area * labour.damp_treatment_per_sqft,
    });
  }

  // Paint labour — apply ceiling multiplier if ceiling included
  const effectiveArea = input.ceiling_included
    ? area * labour.ceiling_multiplier
    : area;
  items.push({
    label: `Paint labour (2 coats)${input.ceiling_included ? " incl. ceiling" : ""}`,
    area_sqft: effectiveArea,
    rate_per_sqft: labour.paint_labour_per_sqft,
    amount: effectiveArea * labour.paint_labour_per_sqft,
  });

  // Material cost (only for LABOUR_PLUS_MATERIAL)
  const brand = normalizeBrand(input.brand_preference);
  const quality = normalizeQuality(input.finish_quality);
  const brandRates = pricing.brands[brand] ?? pricing.brands["no preference"];
  const product = brandRates[quality];

  if (quoteType === "LABOUR_PLUS_MATERIAL") {
    items.push({
      label: `Material — ${brand} ${product.name}`,
      area_sqft: area,
      rate_per_sqft: product.material_per_sqft,
      amount: area * product.material_per_sqft,
    });
  }

  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const gst_amount = Math.round((subtotal * pricing.gst_percent) / 100);
  const total = subtotal + gst_amount;

  return {
    line_items: items,
    subtotal: Math.round(subtotal),
    gst_amount,
    total: Math.round(total),
    gst_percent: pricing.gst_percent,
    brand_name: brand,
    product_name: product.name,
    quote_type: quoteType,
  };
}
