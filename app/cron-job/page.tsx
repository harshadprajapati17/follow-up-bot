"use client";

import { useState } from "react";

export default function CronJobPage() {
  const [morningLoading, setMorningLoading] = useState(false);
  const [morningResult, setMorningResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [eveningLoading, setEveningLoading] = useState(false);
  const [eveningResult, setEveningResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleMorningSync() {
    setMorningResult(null);
    setMorningLoading(true);
    try {
      const res = await fetch("/api/cron-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "morning" }),
      });
      const data = await res.json();
      setMorningResult({
        ok: data.success === true,
        message: data.message ?? data.error ?? (res.ok ? "Done" : "Request failed"),
      });
    } catch (err) {
      setMorningResult({
        ok: false,
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setMorningLoading(false);
    }
  }

  async function handleEveningSync() {
    setEveningResult(null);
    setEveningLoading(true);
    try {
      const res = await fetch("/api/cron-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "evening" }),
      });
      const data = await res.json();
      setEveningResult({
        ok: data.success === true,
        message: data.message ?? data.error ?? (res.ok ? "Done" : "Request failed"),
      });
    } catch (err) {
      setEveningResult({
        ok: false,
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setEveningLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
          <a
            href="/"
            className="text-sm font-medium text-slate-500 transition hover:text-slate-800"
          >
            ← Back
          </a>
          <h1 className="text-lg font-semibold text-slate-800">Cron Job</h1>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <div className="grid gap-6 sm:grid-cols-1 lg:grid-cols-2">
          {/* Morning Status card */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-3 text-xl font-semibold text-slate-800">
              Morning Status
            </h2>
            <p className="mb-4 text-sm text-slate-600">
              This manual trigger later will be handled by cron job on schedule
              time
            </p>
            <button
              type="button"
              onClick={handleMorningSync}
              disabled={morningLoading}
              className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {morningLoading ? "Sending…" : "Trigger Morning Sync"}
            </button>
            {morningResult && (
              <p
                className={`mt-3 text-sm ${morningResult.ok ? "text-emerald-700" : "text-red-600"}`}
              >
                {morningResult.message}
              </p>
            )}
          </div>

          {/* Evening Status card */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-3 text-xl font-semibold text-slate-800">
              Evening Status
            </h2>
            <p className="mb-4 text-sm text-slate-600">
              This manual trigger later will be handled by cron job on schedule
              time
            </p>
            <button
              type="button"
              onClick={handleEveningSync}
              disabled={eveningLoading}
              className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {eveningLoading ? "Sending…" : "Trigger Evening Sync"}
            </button>
            {eveningResult && (
              <p
                className={`mt-3 text-sm ${eveningResult.ok ? "text-emerald-700" : "text-red-600"}`}
              >
                {eveningResult.message}
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
