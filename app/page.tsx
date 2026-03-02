/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type AnalyzeV1Response =
  | {
      status: "incomplete";
      question: string;
      question_examples?: string[];
    }
  | {
      status: "ready";
      intent: string | null;
      entities: Record<string, unknown>;
      quote_pdf_url?: string;
      next_suggested_intents?: string[];
    }
  | {
      status: "noop";
    };

type ChatRole = "user" | "bot";

type ChatMessage = {
  id: number;
  role: ChatRole;
  content: string;
};

type SuggestionChip = {
  id: string;
  label: string;
  payload: string;
};

const INTENT_LABELS: Record<string, string> = {
  NEW_LEAD: "Naya lead add karo",
  SCHEDULE_VISIT: "Visit schedule karo",
  LOG_MEASUREMENT: "Measurement log karo",
  GENERATE_QUOTE_OPTIONS: "Quote options banao",
};

const INTENT_UTTERANCES: Record<string, string> = {
  NEW_LEAD: "Naya lead add karo",
  SCHEDULE_VISIT: "Visit schedule karo",
  LOG_MEASUREMENT: "Measurement log karo",
  GENERATE_QUOTE_OPTIONS: "Quote options banao",
};

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: "bot",
      content:
        "Namaste 👋 Main aapka paint project assistant hoon. Simple Hindi / Hinglish mein bataiye – kis type ka kaam karwana hai?",
    },
  ]);
  const [isSending, setIsSending] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionChip[]>([]);
  const [counter, setCounter] = useState(2);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const userId = useMemo(() => {
    // Simple stable ID for browser; can be replaced with real auth later.
    if (typeof window === "undefined") return "web-demo-user";
    const key = "ai-followup-web-user-id";
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const generated = `web-user-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(key, generated);
    return generated;
  }, []);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, suggestions, isSending]);

  function pushMessage(role: ChatRole, content: string) {
    setMessages((prev) => [
      ...prev,
      {
        id: counter,
        role,
        content: content.trim(),
      },
    ]);
    setCounter((c) => c + 1);
  }

  async function sendToApi(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    setIsSending(true);
    try {
      const res = await fetch("/api/analyze-v1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId,
          text: trimmed,
        }),
      });

      if (!res.ok) {
        pushMessage(
          "bot",
          "Sorry, backend se response nahi aaya. Thodi der baad phir se try karein."
        );
        return;
      }

      const json = (await res.json()) as AnalyzeV1Response;
      handleAnalyzeResponse(json);
    } catch (err) {
      console.error(err);
      pushMessage(
        "bot",
        "Kuch technical issue aa gaya. Thodi der baad dubara try kar sakte hain."
      );
    } finally {
      setIsSending(false);
    }
  }

  function handleAnalyzeResponse(resp: AnalyzeV1Response) {
    // Clear old suggestions; rebuild fresh from this turn.
    setSuggestions([]);

    if (resp.status === "incomplete") {
      pushMessage("bot", resp.question);

      if (resp.question_examples && resp.question_examples.length > 0) {
        const chips: SuggestionChip[] = resp.question_examples.map((ex, idx) => ({
          id: `example-${Date.now()}-${idx}`,
          label: ex,
          payload: ex,
        }));
        setSuggestions(chips);
      }
      return;
    }

    if (resp.status === "ready") {
      const intentLabel =
        (resp.intent && INTENT_LABELS[resp.intent]) ||
        (resp.intent ? resp.intent : "Flow complete");

      const entitiesSummary =
        resp.entities && Object.keys(resp.entities).length > 0
          ? `\n\nCaptured details: ${Object.keys(resp.entities)
              .slice(0, 6)
              .join(", ")}${Object.keys(resp.entities).length > 6 ? " +" : ""}.`
          : "";

      let botMessage = `Done ✅  – ${intentLabel} ready ho gaya.${entitiesSummary}`;

      if (resp.quote_pdf_url) {
        botMessage += `\n\nEk quote PDF bhi ready hai – niche button se open kar sakte hain.`;
      }

      pushMessage("bot", botMessage);

      const next = resp.next_suggested_intents ?? [];
      const chips: SuggestionChip[] = [];

      for (const intent of next) {
        const label = INTENT_LABELS[intent] ?? intent;
        const utterance = INTENT_UTTERANCES[intent] ?? label;
        chips.push({
          id: `next-${intent}-${Date.now()}`,
          label,
          payload: utterance,
        });
      }

      if (resp.quote_pdf_url) {
        chips.push({
          id: "open-quote-pdf",
          label: "Quote PDF dekho",
          payload: resp.quote_pdf_url,
        });
      }

      if (chips.length > 0) {
        setSuggestions(chips);
      }

      return;
    }

    // status === "noop"
    pushMessage(
      "bot",
      "Is message ke basis par koi naya step nahi chalu hua. Agar paint kaam se related kuch specific puchna ho toh likhiye."
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isSending) return;

    pushMessage("user", trimmed);
    setInput("");
    await sendToApi(trimmed);
  }

  async function handleChipClick(chip: SuggestionChip) {
    // If chip payload is a URL (quote PDF), open in new tab instead of sending as text.
    const isUrl =
      chip.payload.startsWith("http://") || chip.payload.startsWith("https://");

    if (isUrl) {
      if (typeof window !== "undefined") {
        window.open(chip.payload, "_blank", "noopener,noreferrer");
      }
      return;
    }

    pushMessage("user", chip.payload);
    setInput("");
    await sendToApi(chip.payload);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 via-slate-950 to-sky-900 px-4 py-6 text-slate-50 md:px-6 md:py-10">
      <div className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-700/60 bg-slate-900/70 shadow-[0_18px_60px_rgba(15,23,42,0.85)] backdrop-blur-xl">
        <header className="flex items-center gap-3 border-b border-slate-800/80 px-4 py-3 md:px-6 md:py-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 via-cyan-300 to-emerald-300 shadow-lg shadow-sky-500/40">
            <span className="text-base font-semibold text-slate-950">AI</span>
          </div>
          <div className="flex flex-col">
            <h1 className="text-sm font-semibold tracking-wide text-slate-50 md:text-base">
              Paint Project Copilot
            </h1>
            <p className="text-xs text-slate-400 md:text-[13px]">
              Chat-first flow for leads, measurements & quotes
            </p>
          </div>
        </header>

        <div
          ref={scrollRef}
          className="h-[64vh] max-h-[600px] space-y-3 overflow-y-auto px-3 py-4 md:space-y-4 md:px-5 md:py-5"
        >
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex w-full ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div className="flex max-w-[78%] items-end gap-2 md:max-w-[75%]">
                {msg.role === "bot" && (
                  <div className="hidden h-7 w-7 flex-none items-center justify-center rounded-full bg-slate-800 text-[10px] font-semibold text-slate-200 shadow-sm sm:flex">
                    AI
                  </div>
                )}
                <div
                  className={`rounded-2xl px-4 py-2.5 text-xs leading-relaxed shadow-md md:text-sm ${
                    msg.role === "user"
                      ? "rounded-br-sm bg-gradient-to-br from-sky-500 via-cyan-400 to-sky-500 text-slate-950 shadow-sky-500/40"
                      : "rounded-bl-sm bg-slate-800/90 text-slate-50 shadow-slate-900/60"
                  }`}
                >
                  {msg.content.split("\n").map((line, idx) => (
                    <p key={idx} className={idx > 0 ? "mt-1" : undefined}>
                      {line}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          ))}

          {isSending && (
            <div className="flex justify-start">
              <div className="flex max-w-[75%] items-center gap-2">
                <div className="hidden h-7 w-7 flex-none items-center justify-center rounded-full bg-slate-800 text-[10px] font-semibold text-slate-200 sm:flex">
                  AI
                </div>
                <div className="flex items-center gap-1 rounded-2xl bg-slate-800/80 px-3 py-2 text-xs text-slate-300 shadow-md">
                  <span className="inline-flex h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
                  <span className="inline-flex h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:120ms]" />
                  <span className="inline-flex h-1.5 w-1.5 animate-bounce rounded-full bg-slate-600 [animation-delay:240ms]" />
                </div>
              </div>
            </div>
          )}
        </div>

        {suggestions.length > 0 && (
          <div className="border-t border-slate-800/80 bg-slate-900/80 px-4 py-2.5 md:px-6">
            <div className="flex flex-wrap gap-2">
              {suggestions.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => void handleChipClick(chip)}
                  className="group inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/5 px-3 py-1 text-[11px] font-medium text-sky-200 shadow-sm transition hover:border-sky-300 hover:bg-sky-500/15 hover:text-sky-50 md:text-xs"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 group-hover:bg-sky-300" />
                  <span>{chip.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="border-t border-slate-800/80 bg-slate-900/90 px-3 py-2.5 md:px-5 md:py-3"
        >
          <div className="flex items-center gap-2 md:gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type in simple Hindi / Hinglish…"
              className="flex-1 rounded-2xl border border-slate-700/80 bg-slate-900/70 px-3.5 py-2 text-xs text-slate-50 placeholder:text-slate-500/80 shadow-inner shadow-slate-950/40 outline-none ring-0 transition focus:border-sky-400/80 focus:ring-2 focus:ring-sky-500/60 md:px-4 md:py-2.5 md:text-sm"
              disabled={isSending}
            />
            <button
              type="submit"
              disabled={isSending || !input.trim()}
              className="inline-flex h-9 items-center justify-center rounded-full bg-gradient-to-r from-sky-400 via-cyan-300 to-emerald-300 px-3.5 text-xs font-semibold text-slate-950 shadow-lg shadow-sky-500/40 transition hover:from-sky-300 hover:via-cyan-200 hover:to-emerald-200 disabled:cursor-not-allowed disabled:opacity-60 md:h-10 md:px-4 md:text-sm"
            >
              <span className="hidden md:inline">
                {isSending ? "Sending…" : "Send"}
              </span>
              <span className="md:hidden">
                {isSending ? "…" : "➤"}
              </span>
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
