"use client";

import { useState } from "react";

type SheetState = "idle" | "loading" | "loaded" | "error";

/** Triggers TTS for the given text; returns true on success. */
async function playTTS(text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: t }),
  });
  const json = await res.json();
  if (!json?.success || !json.audioBase64) return false;
  const audio = new Audio(`data:${json.contentType ?? "audio/mpeg"};base64,${json.audioBase64}`);
  await audio.play();
  return true;
}

function colLetter(index: number): string {
  let letter = "";
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

export default function SheetViewPage() {
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [range, setRange] = useState("A1:Z10");
  const [state, setState] = useState<SheetState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<string[][]>([]);
  const [ttsRowIndex, setTtsRowIndex] = useState<number | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    loadSheet();
  }

  async function loadSheet() {
    console.log("loadSheet", spreadsheetId, range);
    if (!spreadsheetId.trim() || !range.trim()) return;
    setState("loading");
    setError(null);
    try {
      const res = await fetch("/api/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "read",
          spreadsheetId: spreadsheetId.trim(),
          range: range.trim(),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error ?? "Request failed");
        setState("error");
        return;
      }
      setData(json.data ?? []);
      setState("loaded");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setState("error");
    }
  }

  const maxCols = data.length ? Math.max(...data.map((row) => row.length)) : 0;
  const colHeaders = Array.from({ length: maxCols }, (_, i) => colLetter(i));

  async function handlePlayRow(row: string[], rowIndex: number) {
    const text = (row[1] ?? "").trim();
    if (!text) return;
    setTtsRowIndex(rowIndex);
    try {
      await playTTS(text);
    } finally {
      setTtsRowIndex(null);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top bar — Google Sheets–style */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
          <a
            href="/"
            className="text-sm font-medium text-slate-500 transition hover:text-slate-800"
          >
            ← Back
          </a>
          <h1 className="text-lg font-semibold text-slate-800">Sheet View</h1>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {/* Fetch form */}
        <form
          onSubmit={handleSubmit}
          className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
            <div>
              <label
                htmlFor="spreadsheetId"
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Spreadsheet ID
              </label>
              <input
                id="spreadsheetId"
                type="text"
                value={spreadsheetId}
                onChange={(e) => setSpreadsheetId(e.target.value)}
                placeholder="From URL: .../d/SPREADSHEET_ID/edit"
                className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label
                htmlFor="range"
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Range (A1 notation)
              </label>
              <input
                id="range"
                type="text"
                value={range}
                onChange={(e) => setRange(e.target.value)}
                placeholder="Sheet1!A1:Z100"
                className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => {
                  loadSheet();
                  console.log("loadSheet", spreadsheetId, range);
                }}
                disabled={state === "loading"}
                className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
              >
                {state === "loading" ? "Loading…" : "Load sheet"}
              </button>
            </div>
          </div>
        </form>

        {state === "error" && error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        {/* Table container — premium sheet feel */}
        {state === "loaded" && (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="overflow-x-auto overflow-y-auto max-h-[70vh]">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-slate-100">
                  <tr>
                    <th className="sticky left-0 z-20 min-w-[3rem] border-b border-r border-slate-200 bg-slate-100 px-2 py-2 text-center font-semibold text-slate-500">
                      {/* Corner cell */}
                    </th>
                    <th className="sticky left-[3rem] z-20 min-w-[2.5rem] border-b border-r border-slate-200 bg-slate-100 px-1 py-2 text-center font-semibold text-slate-500" title="Play row as speech (TTS)">
                      ▶
                    </th>
                    {colHeaders.map((letter, i) => (
                      <th
                        key={i}
                        className="min-w-[8rem] border-b border-r border-slate-200 px-3 py-2 text-left font-semibold text-slate-600 last:border-r-0"
                      >
                        {letter}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((row, rowIndex) => (
                    <tr
                      key={rowIndex}
                      className="bg-white transition hover:bg-slate-50/80"
                    >
                      <td className="sticky left-0 z-10 border-b border-r border-slate-200 bg-slate-50 px-2 py-1.5 text-center font-mono text-xs text-slate-500">
                        {rowIndex + 1}
                      </td>
                      <td className="sticky left-[3rem] z-10 border-b border-r border-slate-200 bg-slate-50 px-1 py-1.5 text-center">
                        <button
                          type="button"
                          onClick={() => handlePlayRow(row, rowIndex)}
                          disabled={ttsRowIndex !== null || !(row[0] ?? "").trim()}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-emerald-100 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                          title="Play row as speech"
                          aria-label="Play row as speech"
                        >
                          {ttsRowIndex === rowIndex ? (
                            <span className="text-xs">…</span>
                          ) : (
                            <span className="text-xs">▶</span>
                          )}
                        </button>
                      </td>
                      {colHeaders.map((_, colIndex) => (
                        <td
                          key={colIndex}
                          className="min-w-[8rem] border-b border-r border-slate-200 px-3 py-1.5 text-slate-800 last:border-r-0"
                        >
                          {row[colIndex] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
              {data.length} row{data.length !== 1 ? "s" : ""}, {maxCols} column
              {maxCols !== 1 ? "s" : ""}
            </div>
          </div>
        )}

        {state === "idle" && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/50 py-16 text-center text-slate-500">
            Enter a Spreadsheet ID and range above, then click &quot;Load sheet&quot; to view data.
          </div>
        )}
      </main>
    </div>
  );
}
