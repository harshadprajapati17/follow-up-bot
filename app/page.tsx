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
      message?: string;
    }
  | {
      status: "noop";
    };

type V2Response = {
  status: "success" | "error";
  message: string;
  layer_hit?: "local" | "semantic_cache" | "gemini";
  tool_executed?: string;
  tool_result?: {
    success: boolean;
    message: string;
    quote_pdf_url?: string;
    next_suggested_intents?: string[];
  };
};

type ApiVersion = "v1" | "v2" | "v2-no-cache";

type ChatRole = "user" | "bot";

type ChatMessage = {
  id: number;
  role: ChatRole;
  content: string;
  meta?: string;
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

const API_ENDPOINTS: Record<ApiVersion, string> = {
  v1: "/api/analyze-v1",
  v2: "/api/v2/chat",
  "v2-no-cache": "/api/v2/chat-no-cache",
};

const API_LABELS: Record<ApiVersion, string> = {
  v1: "V1 (Analyze)",
  v2: "V2 (Cached)",
  "v2-no-cache": "V2 (No Cache)",
};

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [apiVersion, setApiVersion] = useState<ApiVersion>("v2");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: "bot",
      content:
        "Namaste 👋 Main aapka paint project assistant hoon. Aap keh sakte ho – Lead add karo, Visit schedule karo, ya Measurement note karo.",
    },
  ]);
  const [isSending, setIsSending] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionChip[]>([]);
  const [counter, setCounter] = useState(2);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  /** Message id -> object URL for TTS audio (bot messages only). */
  const [botAudioUrls, setBotAudioUrls] = useState<Record<number, string>>({});

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const botAudioUrlsRef = useRef<Record<number, string>>({});
  botAudioUrlsRef.current = botAudioUrls;

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

  // Revoke TTS blob URLs on unmount to avoid leaks
  useEffect(() => {
    return () => {
      Object.values(botAudioUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  // On iOS Safari, temporarily allow the main container to scroll so the input
  // can move above the keyboard while typing.
  function handleInputFocus() {
    if (typeof window === "undefined") return;
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!isIOS) return;

    if (mainRef.current) {
      mainRef.current.style.overflowY = "auto";
      mainRef.current.style.height = "auto";
    }

    requestAnimationFrame(() => {
      setTimeout(() => {
        inputRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }, 300);
    });
  }

  function handleInputBlur() {
    if (typeof window === "undefined") return;
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!isIOS) return;

    if (mainRef.current) {
      mainRef.current.style.overflowY = "hidden";
      mainRef.current.style.height = "";
    }
  }

  /** Pushes a message and returns its id (for attaching TTS audio to bot messages). */
  function pushMessage(role: ChatRole, content: string, meta?: string): number {
    const id = counter;
    setMessages((prev) => [
      ...prev,
      {
        id,
        role,
        content: content.trim(),
        ...(meta ? { meta } : {}),
      },
    ]);
    setCounter((c) => c + 1);
    return id;
  }

  async function sendToApi(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    setIsSending(true);
    try {
      const endpoint = API_ENDPOINTS[apiVersion];
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, text: trimmed }),
      });

      if (!res.ok) {
        pushMessage(
          "bot",
          "Sorry, backend se response nahi aaya. Thodi der baad phir se try karein."
        );
        return;
      }

      if (apiVersion === "v1") {
        const json = (await res.json()) as AnalyzeV1Response;
        handleAnalyzeResponse(json);
      } else {
        const json = (await res.json()) as V2Response;
        handleV2Response(json);
      }
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

  function handleV2Response(resp: V2Response) {
    setSuggestions([]);

    if (resp.status === "error") {
      const id = pushMessage("bot", resp.message);
      void fetchAndSetBotAudio(id, resp.message);
      return;
    }

    const layerTag = resp.layer_hit ?? "gemini";
    const toolTag = resp.tool_executed ? ` · ${resp.tool_executed}` : "";
    const meta = `${layerTag}${toolTag}`;

    const botMsgId = pushMessage("bot", resp.message, meta);
    void fetchAndSetBotAudio(botMsgId, resp.message);

    const chips: SuggestionChip[] = [];

    if (resp.tool_result?.quote_pdf_url) {
      chips.push({
        id: "open-quote-pdf",
        label: "Quote PDF dekho",
        payload: resp.tool_result.quote_pdf_url,
      });
    }

    if (resp.tool_result?.next_suggested_intents) {
      for (const intent of resp.tool_result.next_suggested_intents) {
        const label = INTENT_LABELS[intent] ?? intent;
        const utterance = INTENT_UTTERANCES[intent] ?? label;
        chips.push({
          id: `next-${intent}-${Date.now()}`,
          label,
          payload: utterance,
        });
      }
    }

    if (chips.length > 0) {
      setSuggestions(chips);
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

      const shouldShowEntitiesSummary =
        resp.intent !== "DATA_RETRIEVAL" &&
        resp.entities &&
        Object.keys(resp.entities).length > 0;

      const entitiesSummary = shouldShowEntitiesSummary
        ? `\n\nCaptured details: ${Object.keys(resp.entities)
            .slice(0, 6)
            .join(", ")}${
            Object.keys(resp.entities).length > 6 ? " +" : ""
          }.`
        : "";

      let botMessage = "";
      if (
        (resp.intent === "GREETING" || resp.intent === "DATA_RETRIEVAL") &&
        resp.message
      ) {
        botMessage = `${resp.message}${
          resp.intent === "GREETING" ? entitiesSummary : ""
        }`;
      } else {
        botMessage = `Done ✅  – ${intentLabel} ready ho gaya.${entitiesSummary}`;

        if (resp.quote_pdf_url) {
          botMessage += `\n\nEk quote PDF bhi ready hai – niche button se open kar sakte hain.`;
        }
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

  /** Starts recording using an already-granted stream (call from getUserMedia.then to keep permission in user gesture). */
  function startRecordingWithStream(stream: MediaStream) {
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(stream);
    recordedChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    mediaStreamRef.current = stream;
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
    };
    recorder.start(200);
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
  }

  async function stopRecordingAndSend() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setIsRecording(false);
      return;
    }
    setIsRecording(false);
    setIsTranscribing(true);
    const stream = mediaStreamRef.current;
    const chunksPromise = new Promise<Blob[]>((resolve) => {
      recorder.onstop = () => {
        stream?.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        resolve(recordedChunksRef.current);
      };
    });
    recorder.stop();
    mediaRecorderRef.current = null;
    try {
      const chunks = await chunksPromise;
      if (chunks.length === 0) {
        pushMessage("bot", "Koi audio record nahi hua. Phir se try karein.");
        return;
      }
      const blob = new Blob(chunks, {
        type: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });
      const formData = new FormData();
      formData.append("file", blob, "voice.webm");
      const res = await fetch("/api/stt", { method: "POST", body: formData });
      const data = (await res.json()) as { success: boolean; transcript?: string; error?: string };
      if (!data.success || !data.transcript?.trim()) {
        pushMessage(
          "bot",
          data.error ?? "Voice samajh nahi aaya. Please type karke bhejein ya phir se bolein."
        );
        return;
      }
      pushMessage("user", data.transcript);
      await sendToApi(data.transcript);
    } catch (err) {
      console.error("STT or send failed:", err);
      pushMessage("bot", "Voice process karte waqt error. Phir se try karein ya type karein.");
    } finally {
      setIsTranscribing(false);
    }
  }

  function toggleRecording() {
    if (isRecording) {
      void stopRecordingAndSend();
      return;
    }
    if (isSending || isRecording) return;
    // Request mic in the same user gesture so the browser shows the permission prompt
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => startRecordingWithStream(stream))
      .catch((err) => {
        console.error("Microphone access failed:", err);
        const denied =
          err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError";
        pushMessage(
          "bot",
          denied
            ? "Mic allow nahi kiya. Address bar mein mic icon par click karke 'Allow' choose karein, ya site settings se mic on karein. Phir mic button dubara dabayein."
            : "Microphone access nahi mila. Please allow mic ya type karke bhejein."
        );
      });
  }

  async function fetchAndSetBotAudio(messageId: number, text: string) {
    if (!text.trim()) return;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.slice(0, 2500),
          target_language_code: "hi-IN",
          output_format: "mp3",
        }),
      });
      const data = (await res.json()) as { success?: boolean; audioBase64?: string };
      if (data.success && data.audioBase64) {
        const bytes = Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        setBotAudioUrls((prev) => ({ ...prev, [messageId]: url }));
      }
    } catch {
      // TTS is optional; text is still shown
    }
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
    <main
      ref={mainRef}
      className="flex h-[100dvh] items-stretch justify-center overflow-hidden bg-gradient-to-br from-slate-900 via-slate-950 to-sky-900 px-0 py-0 text-slate-50 md:px-6 md:py-6"
    >
      <div className="relative flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden border-0 border-slate-700/60 bg-slate-900/70 shadow-[0_18px_60px_rgba(15,23,42,0.85)] backdrop-blur-xl md:rounded-3xl md:border">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-800/80 px-4 py-3 md:px-6 md:py-4">
          <div className="flex items-center gap-3">
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
          </div>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setIsMenuOpen((open) => !open)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-300 transition hover:bg-slate-800/80 hover:text-sky-200 md:h-10 md:w-10"
              aria-label="More options"
            >
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden
              >
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
              </svg>
            </button>
          </div>
        </header>

        {isMenuOpen && (
          <div className="absolute right-3 top-[3.3rem] z-20 w-48 rounded-xl border border-slate-800/90 bg-slate-950/95 p-1.5 text-xs shadow-xl md:right-5 md:top-[3.6rem]">
            <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Options
            </div>
            <div className="space-y-1">
              {(Object.keys(API_LABELS) as ApiVersion[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setApiVersion(v);
                    setIsMenuOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-[11px] font-medium transition ${
                    apiVersion === v
                      ? "bg-sky-500/15 text-sky-100"
                      : "text-slate-200 hover:bg-slate-800/80"
                  }`}
                >
                  <span>{API_LABELS[v]}</span>
                  {apiVersion === v && (
                    <span className="text-[10px] text-emerald-300">●</span>
                  )}
                </button>
              ))}
              <a
                href="/v2-logs"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setIsMenuOpen(false)}
                className="flex w-full items-center rounded-lg px-3 py-1.5 text-[11px] font-medium text-slate-200 transition hover:bg-slate-800/80"
              >
                Logs
              </a>
            </div>
          </div>
        )}

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4 pb-24 md:space-y-4 md:px-5 md:py-5 md:pb-6"
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
                  className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-md md:text-base ${
                    msg.role === "user"
                      ? "rounded-br-sm bg-gradient-to-br from-sky-500 via-cyan-400 to-sky-500 text-slate-950 shadow-sky-500/40"
                      : "rounded-bl-sm bg-slate-800/90 text-slate-50 shadow-slate-900/60"
                  }`}
                >
                  {msg.role === "bot" && botAudioUrls[msg.id] && (
                    <div className="mb-2">
                      <audio
                        src={botAudioUrls[msg.id]}
                        controls
                        className="h-8 max-w-full rounded-lg bg-slate-700/80"
                        preload="metadata"
                      />
                    </div>
                  )}
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
          <div className="shrink-0 border-t border-slate-800/80 bg-slate-900/80 px-4 py-2.5 md:px-6">
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
          ref={formRef}
          onSubmit={handleSubmit}
          className="shrink-0 border-t border-slate-800/80 bg-slate-900/90 px-3 py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] md:px-5 md:py-3 md:pb-3"
        >
          <div className="flex items-center gap-2 md:gap-3">
            <button
              type="button"
              onClick={toggleRecording}
              disabled={isSending}
              title={isRecording ? "Stop & send voice" : "Record voice"}
              className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition md:h-10 md:w-10 ${
                isRecording
                  ? "border-red-400/80 bg-red-500/20 text-red-300"
                  : "border-slate-600/80 bg-slate-800/80 text-slate-300 hover:border-sky-400/60 hover:bg-slate-700/80 hover:text-sky-200"
              }`}
            >
              {isRecording ? (
                <span className="h-3 w-3 rounded-full bg-red-400 animate-pulse" />
              ) : isTranscribing ? (
                <span className="text-xs">…</span>
              ) : (
                <svg className="h-4 w-4 md:h-5 md:w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                  <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                </svg>
              )}
            </button>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={handleInputFocus}
              onBlur={handleInputBlur}
              placeholder="Type ya voice record karein…"
              className="flex-1 rounded-2xl border border-slate-700/80 bg-slate-900/70 px-3.5 py-2 text-base text-slate-50 placeholder:text-slate-500/80 shadow-inner shadow-slate-950/40 outline-none ring-0 transition focus:border-sky-400/80 focus:ring-2 focus:ring-sky-500/60 md:px-4 md:py-2.5 md:text-base"
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

        {isRecording && (
          <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center md:bottom-32">
            <button
              type="button"
              onClick={toggleRecording}
              className="pointer-events-auto relative flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-slate-50 shadow-xl shadow-red-500/40 md:h-20 md:w-20"
            >
              <span className="absolute inset-0 -z-10 animate-ping rounded-full bg-red-500/40" />
              <span className="absolute inset-1 rounded-full border border-red-300/70" />
              <span className="h-7 w-7 rounded-2xl bg-slate-950/90" />
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
