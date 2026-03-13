/**
 * Default pricing rate cards for painting jobs in India.
 * All rates are in ₹ per sqft unless noted.
 * Contractors can override these via the /api/pricing endpoint.
 */

export interface LabourRates {
  /** Base paint labour (2 coats) per sqft */
  paint_labour_per_sqft: number;
  /** Putty per coat per sqft */
  putty_per_coat_per_sqft: number;
  /** Primer (1 coat) per sqft */
  primer_per_sqft: number;
  /** Scraping old paint per sqft */
  scraping_per_sqft: number;
  /** Damp treatment per sqft */
  damp_treatment_per_sqft: number;
  /** Ceiling premium multiplier (e.g. 1.2 = 20% more) */
  ceiling_multiplier: number;
}

export interface BrandProduct {
  name: string;
  /** Material cost per sqft for 2 coats */
  material_per_sqft: number;
}

export interface BrandRates {
  basic: BrandProduct;
  standard: BrandProduct;
  premium: BrandProduct;
}

export interface PricingData {
  labour: LabourRates;
  brands: Record<string, BrandRates>;
  /** GST percentage to apply on total (default 18) */
  gst_percent: number;
}

export const DEFAULT_PRICING: PricingData = {
  labour: {
    paint_labour_per_sqft: 10,      // Basic labour for 2 coats
    putty_per_coat_per_sqft: 5,     // Per putty coat
    primer_per_sqft: 3,             // 1 coat primer
    scraping_per_sqft: 2.5,         // Scraping old paint
    damp_treatment_per_sqft: 10,    // Damp/seepage treatment
    ceiling_multiplier: 1.2,        // 20% extra for ceiling work
  },
  brands: {
    "Asian Paints": {
      basic:    { name: "Tractor Emulsion",  material_per_sqft: 5 },
      standard: { name: "Apcolite Premium",  material_per_sqft: 9 },
      premium:  { name: "Royale",            material_per_sqft: 15 },
    },
    "Berger": {
      basic:    { name: "Ranger",            material_per_sqft: 5 },
      standard: { name: "Easy Clean",        material_per_sqft: 8 },
      premium:  { name: "Silk Glamour",      material_per_sqft: 13 },
    },
    "Nerolac": {
      basic:    { name: "Beauty Smooth",     material_per_sqft: 5 },
      standard: { name: "Impressions",       material_per_sqft: 9 },
      premium:  { name: "Excel Total",       material_per_sqft: 14 },
    },
    "no preference": {
      basic:    { name: "Economy Brand",     material_per_sqft: 4 },
      standard: { name: "Mid-range Brand",   material_per_sqft: 7 },
      premium:  { name: "Premium Brand",     material_per_sqft: 13 },
    },
  },
  gst_percent: 18,
};
