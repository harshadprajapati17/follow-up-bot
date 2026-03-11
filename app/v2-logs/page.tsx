"use client";

import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types mirrored from lib/v2/types.ts (kept client-side to avoid server imports)
// ---------------------------------------------------------------------------

type PipelineStepStatus = "proceed" | "skip" | "handled" | "error";

interface PipelineStep {
  step: string;
  status: PipelineStepStatus;
  detail: string;
  duration_ms: number;
  tokens_saved?: number;
  data?: Record<string, unknown>;
}

interface V2CallLog {
  request_id: string;
  user_id: string;
  timestamp: number;
  endpoint: "chat" | "chat-no-cache";
  layer_hit: "local" | "semantic_cache" | "gemini";
  user_text: string;
  conversation_length: number;
  cache_used: boolean;
  cache_name: string | null;
  tool_called: string | null;
  tool_params: Record<string, unknown> | null;
  response_text: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  latency_ms: number;
  gemini_latency_ms: number;
  validation_passed: boolean;
  validation_errors: string[];
  pipeline_trace: PipelineStep[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEP_LABELS: Record<string, string> = {
  input: "User Input",
  local_resolver: "Local Resolver",
  semantic_cache: "Semantic Cache",
  gemini_call: "Gemini LLM",
  validation: "Validation",
  tool_execution: "Tool Execution",
  response: "Final Response",
};

const STATUS_STYLES: Record<
  PipelineStepStatus,
  { bg: string; border: string; text: string; badge: string; label: string }
> = {
  proceed: {
    bg: "bg-emerald-950/40",
    border: "border-emerald-600",
    text: "text-emerald-300",
    badge: "bg-emerald-700 text-emerald-100",
    label: "ACTIVE",
  },
  handled: {
    bg: "bg-sky-950/40",
    border: "border-sky-500",
    text: "text-sky-300",
    badge: "bg-sky-700 text-sky-100",
    label: "HANDLED",
  },
  skip: {
    bg: "bg-zinc-800/50",
    border: "border-zinc-600",
    text: "text-zinc-400",
    badge: "bg-zinc-700 text-zinc-300",
    label: "SKIP",
  },
  error: {
    bg: "bg-red-950/40",
    border: "border-red-600",
    text: "text-red-300",
    badge: "bg-red-700 text-red-100",
    label: "ERROR",
  },
};

const LAYER_COLORS: Record<string, string> = {
  local: "bg-sky-600",
  semantic_cache: "bg-violet-600",
  gemini: "bg-emerald-600",
};

// ---------------------------------------------------------------------------
// Helper: format timestamp
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function StepNode({ step, isLast }: { step: PipelineStep; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const style = STATUS_STYLES[step.status];

  return (
    <div className="flex items-start gap-0 shrink-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`
          relative rounded-lg border px-3 py-2 min-w-[140px] max-w-[180px]
          transition-all cursor-pointer text-left
          ${style.bg} ${style.border} ${style.text}
          hover:brightness-125
        `}
      >
        <div className="flex items-center justify-between gap-1 mb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
            {STEP_LABELS[step.step] ?? step.step}
          </span>
          <div className="flex items-center gap-1">
            {typeof step.data?.method === "string" && (
              <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-violet-700/60 text-violet-200">
                {step.data.method}
              </span>
            )}
            <span
              className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${style.badge}`}
            >
              {style.label}
            </span>
          </div>
        </div>

        <p className="text-[11px] leading-tight opacity-70 line-clamp-2">
          {step.detail}
        </p>

        <div className="flex items-center gap-2 mt-1.5 text-[10px] opacity-60">
          <span>{formatMs(step.duration_ms)}</span>
          {step.tokens_saved ? (
            <span className="text-amber-400">
              ~{step.tokens_saved} tok saved
            </span>
          ) : null}
        </div>

        {expanded && step.data && (
          <pre className="mt-2 text-[10px] bg-black/30 rounded p-1.5 overflow-auto max-h-32 whitespace-pre-wrap break-all">
            {JSON.stringify(step.data, null, 2)}
          </pre>
        )}
      </button>

      {!isLast && (
        <div className="flex items-center self-center px-1">
          <svg
            width="24"
            height="12"
            viewBox="0 0 24 12"
            className="text-zinc-500"
          >
            <line
              x1="0"
              y1="6"
              x2="18"
              y2="6"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <polygon points="18,2 24,6 18,10" fill="currentColor" />
          </svg>
        </div>
      )}
    </div>
  );
}

function PipelineTrace({ trace }: { trace: PipelineStep[] }) {
  if (!trace || trace.length === 0) {
    return (
      <p className="text-zinc-500 text-sm italic">
        No pipeline trace available (older log format)
      </p>
    );
  }

  return (
    <div className="flex items-start overflow-x-auto pb-2 gap-0 scrollbar-thin">
      {trace.map((step, i) => (
        <StepNode key={step.step} step={step} isLast={i === trace.length - 1} />
      ))}
    </div>
  );
}

function LogCard({ log }: { log: V2CallLog }) {
  const [open, setOpen] = useState(false);
  const layerColor = LAYER_COLORS[log.layer_hit] ?? "bg-zinc-600";

  const totalTokensSaved =
    log.pipeline_trace?.reduce((s, t) => s + (t.tokens_saved ?? 0), 0) ?? 0;

  // Extract cache method (keyword / fingerprint) from the semantic_cache step.
  const cacheStep = log.pipeline_trace?.find((s) => s.step === "semantic_cache");
  const cacheMethod = cacheStep?.data?.method as string | undefined;

  return (
    <div className="bg-zinc-900 border border-zinc-700/60 rounded-xl overflow-hidden transition-all">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 hover:bg-zinc-800/60 transition-colors cursor-pointer"
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`shrink-0 w-2 h-2 rounded-full ${layerColor}`}
            />
            <span className="text-zinc-100 text-sm font-medium truncate max-w-[320px]">
              &ldquo;{log.user_text}&rdquo;
            </span>
          </div>

          <div className="flex items-center gap-3 text-[11px] text-zinc-400 shrink-0">
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${layerColor} text-white`}
            >
              {log.layer_hit}
            </span>
            {cacheMethod && (
              <span className="px-1.5 py-0.5 rounded bg-violet-800/60 text-violet-200 text-[10px]">
                {cacheMethod}
              </span>
            )}
            {log.tool_called && (
              <span className="px-1.5 py-0.5 rounded bg-amber-800/60 text-amber-200 text-[10px]">
                {log.tool_called}
              </span>
            )}
            <span>{formatMs(log.latency_ms)}</span>
            {log.input_tokens > 0 && (
              <span>
                {log.input_tokens}/{log.output_tokens} tok
              </span>
            )}
            {totalTokensSaved > 0 && (
              <span className="text-amber-400">
                ~{totalTokensSaved} saved
              </span>
            )}
            <span className="text-zinc-500">{formatTime(log.timestamp)}</span>
            <span className="text-zinc-600">{open ? "▲" : "▼"}</span>
          </div>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-zinc-800">
          <div className="pt-3">
            <h4 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">
              Pipeline Flow
            </h4>
            <PipelineTrace trace={log.pipeline_trace} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
            <DetailBox label="User Input" value={log.user_text} />
            <DetailBox label="User Sees" value={log.response_text} />
            {log.tool_called && (
              <DetailBox
                label={`Tool: ${log.tool_called}`}
                value={
                  log.tool_params
                    ? JSON.stringify(log.tool_params, null, 2)
                    : "—"
                }
                mono
              />
            )}
            <DetailBox
              label="Metadata"
              value={[
                `Request: ${log.request_id}`,
                `User: ${log.user_id}`,
                `Endpoint: ${log.endpoint}`,
                `Cache: ${log.cache_used ? "yes" : "no"}${log.cache_name ? ` (${log.cache_name.slice(-8)})` : ""}`,
                `Conversation length: ${log.conversation_length}`,
                `Gemini latency: ${formatMs(log.gemini_latency_ms)}`,
                `Total latency: ${formatMs(log.latency_ms)}`,
                log.cached_tokens
                  ? `Cached tokens: ${log.cached_tokens}`
                  : null,
                !log.validation_passed
                  ? `Validation errors: ${log.validation_errors.join(", ")}`
                  : null,
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

function SummaryStats({ logs }: { logs: V2CallLog[] }) {
  if (logs.length === 0) return null;

  const localCount = logs.filter((l) => l.layer_hit === "local").length;
  const cacheCount = logs.filter((l) => l.layer_hit === "semantic_cache").length;
  const keywordCount = logs.filter((l) => {
    const cs = l.pipeline_trace?.find((s) => s.step === "semantic_cache");
    return cs?.data?.method === "keyword";
  }).length;
  const fingerprintCount = logs.filter((l) => {
    const cs = l.pipeline_trace?.find((s) => s.step === "semantic_cache");
    return cs?.data?.method === "fingerprint";
  }).length;
  const geminiCount = logs.filter((l) => l.layer_hit === "gemini").length;
  const avgLatency = Math.round(
    logs.reduce((s, l) => s + l.latency_ms, 0) / logs.length
  );
  const totalIn = logs.reduce((s, l) => s + l.input_tokens, 0);
  const totalOut = logs.reduce((s, l) => s + l.output_tokens, 0);
  const totalSaved = logs.reduce(
    (s, l) =>
      s + (l.pipeline_trace?.reduce((a, t) => a + (t.tokens_saved ?? 0), 0) ?? 0),
    0
  );

  const pct = (n: number) => `${n} (${Math.round((n / logs.length) * 100)}%)`;

  const stats = [
    { label: "Requests", value: String(logs.length) },
    { label: "Local", value: pct(localCount) },
    { label: "Cache", value: `${pct(cacheCount)}`, sub: keywordCount || fingerprintCount ? `kw:${keywordCount} fp:${fingerprintCount}` : undefined },
    { label: "Gemini", value: pct(geminiCount) },
    { label: "Avg Latency", value: formatMs(avgLatency) },
    { label: "Tokens In/Out", value: `${totalIn} / ${totalOut}` },
    { label: "Est. Saved", value: `~${totalSaved} tok` },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-7 gap-2 mb-4">
      {stats.map((s) => (
        <div
          key={s.label}
          className="bg-zinc-800/50 rounded-lg px-3 py-2 text-center"
        >
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">
            {s.label}
          </div>
          <div className="text-zinc-100 text-sm font-semibold mt-0.5">
            {s.value}
          </div>
          {s.sub && (
            <div className="text-[9px] text-violet-400 mt-0.5">{s.sub}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function V2LogsPage() {
  const [logs, setLogs] = useState<V2CallLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [userId, setUserId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [layerHit, setLayerHit] = useState("");
  const [limit] = useState(50);
  const [page, setPage] = useState(0);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (userId) params.set("userId", userId);
    if (endpoint) params.set("endpoint", endpoint);
    if (layerHit) params.set("layerHit", layerHit);
    params.set("limit", String(limit));
    params.set("offset", String(page * limit));

    try {
      const res = await fetch(`/api/v2/logs?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLogs(data.logs ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch logs");
    } finally {
      setLoading(false);
    }
  }, [userId, endpoint, layerHit, limit, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">
            V2 Pipeline Logs
          </h1>
          <p className="text-zinc-400 text-sm mt-1">
            Visualize every request: input → local resolver → cache → Gemini → validation → tool → response
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
          <div>
            <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
              Endpoint
            </label>
            <select
              value={endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value);
                setPage(0);
              }}
              className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-200 w-40 focus:outline-none focus:border-zinc-500"
            >
              <option value="">All</option>
              <option value="chat">chat (cached)</option>
              <option value="chat-no-cache">chat-no-cache</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
              Layer
            </label>
            <select
              value={layerHit}
              onChange={(e) => {
                setLayerHit(e.target.value);
                setPage(0);
              }}
              className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-200 w-36 focus:outline-none focus:border-zinc-500"
            >
              <option value="">All</option>
              <option value="local">Local</option>
              <option value="semantic_cache">Semantic Cache</option>
              <option value="gemini">Gemini</option>
            </select>
          </div>
          <button
            onClick={() => fetchLogs()}
            className="bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm px-4 py-1.5 rounded-md transition-colors"
          >
            Refresh
          </button>
        </div>

        {/* Summary */}
        <SummaryStats logs={logs} />

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
            No logs found. Send some messages to /api/v2/chat first.
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
