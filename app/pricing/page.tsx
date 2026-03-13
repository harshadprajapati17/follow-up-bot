"use client";

import { useEffect, useState } from "react";
import { DEFAULT_PRICING, type PricingData } from "@/lib/v2/pricing-data";

const BRANDS = ["Asian Paints", "Berger", "Nerolac", "no preference"] as const;
const TIERS = ["basic", "standard", "premium"] as const;
const TIER_LABELS = { basic: "Economy", standard: "Mid Range", premium: "Premium" };

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function deepMerge(base: PricingData, override: DeepPartial<PricingData>): PricingData {
  return {
    labour: { ...base.labour, ...(override.labour ?? {}) },
    brands: Object.fromEntries(
      BRANDS.map((b) => [
        b,
        {
          basic: { ...base.brands[b].basic, ...(override.brands?.[b]?.basic ?? {}) },
          standard: { ...base.brands[b].standard, ...(override.brands?.[b]?.standard ?? {}) },
          premium: { ...base.brands[b].premium, ...(override.brands?.[b]?.premium ?? {}) },
        },
      ])
    ),
    gst_percent: override.gst_percent ?? base.gst_percent,
  };
}

export default function PricingPage() {
  const [pricing, setPricing] = useState<PricingData>(DEFAULT_PRICING);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string>("");

  useEffect(() => {
    const key = "ai-followup-web-user-id";
    const id = localStorage.getItem(key) ?? `web-user-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(key, id);
    setUserId(id);

    fetch(`/api/pricing?userId=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((data: PricingData) => {
        setPricing(deepMerge(DEFAULT_PRICING, data));
      })
      .catch(() => setPricing(DEFAULT_PRICING))
      .finally(() => setLoading(false));
  }, []);

  function setLabour(field: keyof PricingData["labour"], value: string) {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setPricing((prev) => ({ ...prev, labour: { ...prev.labour, [field]: num } }));
  }

  function setBrandRate(brand: string, tier: "basic" | "standard" | "premium", field: "material_per_sqft" | "name", value: string) {
    setPricing((prev) => ({
      ...prev,
      brands: {
        ...prev.brands,
        [brand]: {
          ...prev.brands[brand],
          [tier]: {
            ...prev.brands[brand][tier],
            [field]: field === "material_per_sqft" ? (parseFloat(value) || 0) : value,
          },
        },
      },
    }));
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/pricing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, pricing }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setPricing(DEFAULT_PRICING);
    setSaved(false);
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">
        <span className="text-sm">Loading rates…</span>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-950 to-sky-900 px-4 py-8 text-slate-50 md:px-8">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <a href="/" className="mb-2 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-sky-300">
              ← Back to chat
            </a>
            <h1 className="text-xl font-bold text-slate-50 md:text-2xl">Pricing Configuration</h1>
            <p className="mt-0.5 text-sm text-slate-400">
              Customize rates — these are used for every new quote you generate.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleReset}
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-slate-700"
            >
              Reset to defaults
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-gradient-to-r from-sky-500 to-emerald-400 px-4 py-1.5 text-xs font-semibold text-slate-950 shadow transition hover:from-sky-400 hover:to-emerald-300 disabled:opacity-60"
            >
              {saving ? "Saving…" : saved ? "✓ Saved!" : "Save rates"}
            </button>
          </div>
        </div>

        {/* Labour Rates */}
        <Section title="Labour Rates" subtitle="Cost per sqft for each type of work">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <LabourField
              label="Paint labour (2 coats)"
              value={pricing.labour.paint_labour_per_sqft}
              onChange={(v) => setLabour("paint_labour_per_sqft", v)}
            />
            <LabourField
              label="Putty per coat"
              value={pricing.labour.putty_per_coat_per_sqft}
              onChange={(v) => setLabour("putty_per_coat_per_sqft", v)}
            />
            <LabourField
              label="Primer (1 coat)"
              value={pricing.labour.primer_per_sqft}
              onChange={(v) => setLabour("primer_per_sqft", v)}
            />
            <LabourField
              label="Scraping old paint"
              value={pricing.labour.scraping_per_sqft}
              onChange={(v) => setLabour("scraping_per_sqft", v)}
            />
            <LabourField
              label="Damp treatment"
              value={pricing.labour.damp_treatment_per_sqft}
              onChange={(v) => setLabour("damp_treatment_per_sqft", v)}
            />
            <div>
              <label className="mb-1 block text-[11px] font-medium text-slate-400">
                Ceiling multiplier
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step="0.05"
                  min="1"
                  max="2"
                  value={pricing.labour.ceiling_multiplier}
                  onChange={(e) => setLabour("ceiling_multiplier", e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-50 outline-none focus:border-sky-400/80"
                />
                <span className="text-xs text-slate-500">×</span>
              </div>
              <p className="mt-0.5 text-[10px] text-slate-500">e.g. 1.2 = 20% extra for ceiling</p>
            </div>
          </div>
        </Section>

        {/* GST */}
        <Section title="GST" subtitle="Applied on total before sharing with customer">
          <div className="flex items-center gap-3">
            <input
              type="number"
              min="0"
              max="28"
              step="1"
              value={pricing.gst_percent}
              onChange={(e) => {
                const n = parseFloat(e.target.value);
                if (!isNaN(n)) setPricing((prev) => ({ ...prev, gst_percent: n }));
              }}
              className="w-28 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-50 outline-none focus:border-sky-400/80"
            />
            <span className="text-sm text-slate-400">%</span>
          </div>
        </Section>

        {/* Brand Material Rates */}
        {BRANDS.map((brand) => (
          <Section
            key={brand}
            title={brand === "no preference" ? "No Preference / Generic" : brand}
            subtitle="Material cost per sqft (for 2 coats) — per quality tier"
          >
            <div className="grid gap-4 md:grid-cols-3">
              {TIERS.map((tier) => (
                <div key={tier} className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4">
                  <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {TIER_LABELS[tier]}
                  </p>
                  <div className="space-y-2">
                    <div>
                      <label className="mb-1 block text-[10px] text-slate-500">Product name</label>
                      <input
                        type="text"
                        value={pricing.brands[brand][tier].name}
                        onChange={(e) => setBrandRate(brand, tier, "name", e.target.value)}
                        className="w-full rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-1.5 text-xs text-slate-50 outline-none focus:border-sky-400/80"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] text-slate-500">₹ per sqft (material)</label>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={pricing.brands[brand][tier].material_per_sqft}
                        onChange={(e) => setBrandRate(brand, tier, "material_per_sqft", e.target.value)}
                        className="w-full rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-1.5 text-xs text-slate-50 outline-none focus:border-sky-400/80"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        ))}

        {/* Save button at bottom too */}
        <div className="mt-8 flex justify-end gap-3">
          <button
            type="button"
            onClick={handleReset}
            className="rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-700"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-gradient-to-r from-sky-500 to-emerald-400 px-6 py-2 text-sm font-semibold text-slate-950 shadow transition hover:from-sky-400 hover:to-emerald-300 disabled:opacity-60"
          >
            {saving ? "Saving…" : saved ? "✓ Saved!" : "Save rates"}
          </button>
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-2xl border border-slate-800/60 bg-slate-900/60 p-5 md:p-6">
      <h2 className="text-sm font-semibold text-slate-100 md:text-base">{title}</h2>
      <p className="mb-4 mt-0.5 text-xs text-slate-500">{subtitle}</p>
      {children}
    </div>
  );
}

function LabourField({ label, value, onChange }: { label: string; value: number; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-slate-400">{label}</label>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs text-slate-500">₹</span>
        <input
          type="number"
          min="0"
          step="0.5"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-slate-700 bg-slate-800/60 py-2 pl-7 pr-3 text-sm text-slate-50 outline-none focus:border-sky-400/80"
        />
      </div>
      <p className="mt-0.5 text-[10px] text-slate-500">per sqft</p>
    </div>
  );
}
