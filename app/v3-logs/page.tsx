"use client";

import { useState, useEffect, useCallback } from "react";

interface V3ToolExecutionLog {
  name: string;
  args: Record<string, unknown>;
  result_message: string;
  success: boolean;
  quote_pdf_url?: string;
}

interface V3CallLog {
  request_id: string;
  user_id: string;
  timestamp: number;
  user_text: string;
  gemini_text: string | null;
  gemini_tool_calls: Array<{ name: string; args: Record<string, unknown> }>;
  gemini_input_tokens: number;
  gemini_output_tokens: number;
  gemini_contents?: unknown;
  tools: V3ToolExecutionLog[];
  final_message: string;
  error?: boolean;
  greeting_shortcut?: boolean;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function DetailBox({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="bg-zinc-800/60 rounded-lg p-2.5">
      <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
        {label}
      </span>
      <p
        className={`mt-1 text-zinc-200 whitespace-pre-wrap break-all leading-relaxed ${
          mono ? "font-mono text-[11px]" : "text-[12px]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function LogCard({ log }: { log: V3CallLog }) {
  const [open, setOpen] = useState(false);

  const hasTools = log.tools && log.tools.length > 0;
  const badgeColor = log.error
    ? "bg-red-600"
    : log.greeting_shortcut
    ? "bg-sky-600"
    : hasTools
    ? "bg-emerald-600"
    : "bg-zinc-600";

  return (
    <div className="bg-zinc-900 border border-zinc-700/60 rounded-xl overflow-hidden transition-all">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 hover:bg-zinc-800/60 transition-colors cursor-pointer"
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`shrink-0 w-2 h-2 rounded-full ${badgeColor}`} />
            <span className="text-zinc-100 text-sm font-medium truncate max-w-[320px]">
              &ldquo;{log.user_text}&rdquo;
            </span>
          </div>

          <div className="flex items-center gap-3 text-[11px] text-zinc-400 shrink-0">
            {log.greeting_shortcut && (
              <span className="px-1.5 py-0.5 rounded bg-sky-800/60 text-sky-100 text-[10px]">
                greeting
              </span>
            )}
            {hasTools && (
              <span className="px-1.5 py-0.5 rounded bg-emerald-800/60 text-emerald-100 text-[10px]">
                tools: {log.tools.map((t) => t.name).join(", ")}
              </span>
            )}
            {log.gemini_input_tokens > 0 && (
              <span>
                {log.gemini_input_tokens}/{log.gemini_output_tokens} tok
              </span>
            )}
            <span className="text-zinc-500">{formatTime(log.timestamp)}</span>
            <span className="text-zinc-600">{open ? "▲" : "▼"}</span>
          </div>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-zinc-800">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px] pt-3">
            <DetailBox label="User Input" value={log.user_text} />
            <DetailBox label="User Sees" value={log.final_message} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
            <DetailBox
              label="Gemini (text)"
              value={log.gemini_text ?? "—"}
            />
            <DetailBox
              label="Gemini (tool calls)"
              value={
                log.gemini_tool_calls.length
                  ? JSON.stringify(log.gemini_tool_calls, null, 2)
                  : "—"
              }
              mono
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-1 gap-3 text-[12px]">
            <DetailBox
              label="Gemini (input contents)"
              value={
                log.gemini_contents
                  ? JSON.stringify(log.gemini_contents, null, 2)
                  : "—"
              }
              mono
            />
          </div>

          <div className="space-y-2 text-[12px]">
            <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
              Tools Executed
            </span>
            {hasTools ? (
              log.tools.map((tool) => (
                <div
                  key={tool.name + JSON.stringify(tool.args)}
                  className="bg-zinc-800/60 rounded-lg p-2.5 space-y-1"
                >
                  <div className="flex items-center justify-between text-[11px] text-zinc-300">
                    <span className="font-semibold">{tool.name}</span>
                    {tool.quote_pdf_url && (
                      <span className="text-emerald-300 text-[10px]">
                        PDF: {tool.quote_pdf_url}
                      </span>
                    )}
                  </div>
                  <DetailBox
                    label="Args"
                    value={JSON.stringify(tool.args, null, 2)}
                    mono
                  />
                  <DetailBox
                    label="Result"
                    value={tool.result_message}
                  />
                </div>
              ))
            ) : (
              <p className="text-zinc-500 text-sm italic">
                No tools executed in this turn.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
            <DetailBox
              label="Metadata"
              value={[
                `Request: ${log.request_id}`,
                `User: ${log.user_id}`,
                `Gemini tokens: ${log.gemini_input_tokens}/${log.gemini_output_tokens}`,
              ]
                .filter(Boolean)
                .join("\n")}
              mono
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default function V3LogsPage() {
  const [logs, setLogs] = useState<V3CallLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [userId, setUserId] = useState("");
  const [limit] = useState(50);
  const [page, setPage] = useState(0);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (userId) params.set("userId", userId);
    params.set("limit", String(limit));
    params.set("offset", String(page * limit));

    try {
      const res = await fetch(`/api/v3/logs?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLogs(data.logs ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch logs");
    } finally {
      setLoading(false);
    }
  }, [userId, limit, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="mb-6">
          <h2 className="text-2xl font-bold tracking-tight">
            V3 Conversation Logs
          </h2>
          <p className="text-zinc-400 text-sm mt-1">
            See each request: user input → Gemini text/tool calls → tools →
            final reply.
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div>
            <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
              User ID
            </label>
            <input
              type="text"
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value);
                setPage(0);
              }}
              placeholder="Filter by user…"
              className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 w-48 focus:outline-none focus:border-zinc-500"
            />
          </div>
          <button
            onClick={() => fetchLogs()}
            className="bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm px-4 py-1.5 rounded-md transition-colors"
          >
            Refresh
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded-lg px-4 py-2 mb-4 text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Log List */}
        {loading ? (
          <div className="text-center py-12 text-zinc-500">Loading…</div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            No logs found. Send some messages to /api/v3/chat first.
          </div>
        ) : (
          <div className="space-y-2">
            {logs.map((log) => (
              <LogCard key={log.request_id} log={log} />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 mt-6 text-sm">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Prev
            </button>
            <span className="text-zinc-400">
              Page {page + 1} of {totalPages} ({total} total)
            </span>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

