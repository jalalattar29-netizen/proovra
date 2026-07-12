"use client";

import { useEffect, useState } from "react";
import { Card } from "../ui";
import { apiFetch, ApiError } from "../../lib/api";
import { hasPreferencesConsent } from "../../lib/consent";
import {
  classifyRouteClass,
  getSafePageContext,
  isSensitiveRoute,
} from "../../lib/privacy/redact";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type AiFlag = {
  severity: "info" | "warning" | "danger";
  title: string;
  detail: string;
  affectedItemId?: string;
  affectedStepId?: string;
};

type AiResult = {
  status: "ok" | "blocked" | "disabled" | "error";
  summary: string;
  warnings: string[];
  suggestions: string[];
  flags: AiFlag[];
  legalDisclaimer: string;
};

type ChatResponsePayload = {
  data?: AiResult;
};

export function ProovraChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [showHint, setShowHint] = useState(false);

useEffect(() => {
  if (typeof window === "undefined") return;

  const canPersist = hasPreferencesConsent();
  const seen = canPersist
    ? window.localStorage.getItem("proovra-chat-hint-seen")
    : null;

  if (seen) return;

  setShowHint(true);

  const timer = window.setTimeout(() => {
    setShowHint(false);
    if (canPersist) {
      try {
        window.localStorage.setItem("proovra-chat-hint-seen", "1");
      } catch {
        // ignore quota / private mode
      }
    }
  }, 3000);

  return () => window.clearTimeout(timer);
}, []);

  const hasMessages = messages.length > 0;
  const canSend = Boolean(draft.trim()) && !busy && !unavailable;

  const handleSend = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;

    const newMessages: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(newMessages);
    setDraft("");
    setBusy(true);
    setError(null);

    try {
      const rawPath =
        typeof window !== "undefined" ? window.location.pathname : null;
      const safe = getSafePageContext(rawPath);
      // Never send page titles — they routinely contain evidence names,
      // case numbers, recipient names, or report subjects.
      const pageContext = {
        path: safe.safePath,
        routeClass: safe.routeClass,
      };

      // Defense-in-depth: refuse to send any AI request from a sensitive
      // route even if the host page somehow rendered the widget.
      if (isSensitiveRoute(rawPath) || classifyRouteClass(rawPath) === "auth") {
        setUnavailable(true);
        setError("AI assistant disabled on this page.");
        setBusy(false);
        return;
      }

      const response = (await apiFetch(
        "/v1/ai/chat",
        {
          method: "POST",
          body: JSON.stringify({
            messages: newMessages,
            pageContext,
          }),
        },
        { auth: true }
      )) as ChatResponsePayload;

const result = response?.data;

const assistantMessage = result
  ? [
      result.summary,
      result.warnings?.length
        ? `Warnings:\n${result.warnings.map((item) => `• ${item}`).join("\n")}`
        : "",
      result.suggestions?.length
        ? `Suggested next actions:\n${result.suggestions.map((item) => `• ${item}`).join("\n")}`
        : "",
      result.flags?.length
        ? `Flags:\n${result.flags
            .map((flag) => `• [${flag.severity}] ${flag.title}: ${flag.detail}`)
            .join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
  : "The assistant returned an advisory response.";

setMessages((prev) => [
  ...prev,
  {
    role: "assistant",
    content: assistantMessage,
  },
]);
    } catch (err: unknown) {
      const apiError = err as ApiError;
      const unavailableReason =
        apiError?.code === "AI_DISABLED" ||
        apiError?.statusCode === 404 ||
        apiError?.statusCode === 503 ||
        apiError?.statusCode === 502 ||
        apiError?.statusCode === 504;

      if (unavailableReason) {
        setUnavailable(true);
        setError("AI assistant unavailable.");
      } else {
        setError("AI assistant currently unavailable. Continue without AI.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
<div className="fixed inset-x-3 bottom-4 z-50 flex flex-col items-end gap-3 sm:inset-x-auto sm:right-6 sm:bottom-6">
        {open ? (
<Card className="w-full max-w-[420px] overflow-hidden rounded-[24px] border border-[rgba(58,93,97,0.18)] bg-[#fbfcfb] p-0 shadow-[0_24px_70px_rgba(15,23,42,0.20)] sm:w-[420px] sm:rounded-[28px]">
            <div className="border-b border-[rgba(36,55,59,0.10)] bg-[linear-gradient(180deg,#f9fbfa,#eef4f2)] px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[0.95rem] font-extrabold tracking-[-0.02em] text-[#12252a]">
PROOVRA Assistant
                </div>
                <div className="mt-1 text-[0.72rem] leading-5 text-[#6a777a]">
                  Advisory support only. Not legal or factual determination.
                </div>
              </div>

              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full border border-[rgba(58,93,97,0.14)] bg-white px-3 py-1 text-xs font-bold text-[#3a5d61] shadow-sm"
              >
                Close
              </button>
            </div>
          </div>

<div className="max-h-[42dvh] overflow-y-auto bg-[#f7faf8] px-4 py-3 sm:max-h-[360px]" role="log" aria-live="polite" aria-label="Support chat conversation">
              {hasMessages ? (
              <div className="space-y-3">
                {messages.map((message, index) => (
                  <div
                    key={`${message.role}-${index}`}
                    className={`rounded-2xl border px-3 py-3 text-sm shadow-sm ${
                      message.role === "assistant"
                        ? "border-[rgba(58,93,97,0.14)] bg-white text-[#24373b]"
                        : "border-[rgba(58,93,97,0.22)] bg-[linear-gradient(180deg,#3a5d61,#243f44)] text-[#f4f7f6]"
                    }`}
                  >
                    <div
                      className={`text-[0.68rem] font-black uppercase tracking-[0.16em] ${
                        message.role === "assistant"
                          ? "text-[#8f745c]"
                          : "text-[#e6c9ae]"
                      }`}
                    >
                      {message.role === "assistant" ? "Assistant" : "You"}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap leading-6">
                      {message.content}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-[rgba(58,93,97,0.12)] bg-white p-4 text-sm leading-6 text-[#526164] shadow-sm">
Ask about PROOVRA, upload steps, reports, verification, billing, or account support.
              </div>
            )}
          </div>

          <div className="border-t border-[rgba(36,55,59,0.10)] bg-white px-4 py-3">
            {error ? (
              <div className="mb-3 rounded-2xl border border-rose-500/20 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                {error}
              </div>
            ) : null}

            {unavailable ? (
              <div className="mb-3 rounded-2xl border border-[rgba(183,157,132,0.24)] bg-[#faf6f1] px-3 py-2 text-sm text-[#705f50]">
                AI assistant unavailable. You can continue capture normally.
              </div>
            ) : null}

            <div className="grid gap-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                placeholder="Ask a question..."
                className="w-full rounded-2xl border border-[rgba(58,93,97,0.16)] bg-[#fbfcfb] px-3 py-3 text-sm text-[#12252a] outline-none placeholder:text-[#8b989c] focus:border-[rgba(58,93,97,0.34)] focus:ring-4 focus:ring-[rgba(58,93,97,0.08)]"
                disabled={busy || unavailable}
              />

              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-[#7a878a]">
                  Advisory only.
                </div>

                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSend}
                  className="rounded-full border border-[rgba(183,157,132,0.28)] bg-[linear-gradient(180deg,#3a5d61,#203a3f)] px-5 py-2.5 text-sm font-extrabold text-[#f4f7f6] shadow-[0_12px_26px_rgba(15,23,42,0.16)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

<div className="relative">
  {showHint && !open ? (
    <div className="proovra-chat-hint" role="status">
      Need help?
    </div>
  ) : null}

  <button
    type="button"
    onClick={() => setOpen((prev) => !prev)}
    aria-label={open ? "Close support chat" : "Open support chat"}
    className={[
      "flex h-12 w-12 items-center justify-center rounded-full",
      "border border-[rgba(36,55,59,0.14)] bg-white/95",
      "shadow-[0_18px_46px_rgba(15,23,42,0.18)] backdrop-blur",
      "transition hover:-translate-y-0.5 hover:shadow-[0_22px_58px_rgba(15,23,42,0.22)]",
      "focus:outline-none focus:ring-4 focus:ring-[rgba(58,93,97,0.12)]",
    ].join(" ")}
  >
    <span
      aria-hidden="true"
      className="relative h-6 w-7 rounded-[9px] border-2 border-[#3a5d61]"
    >
      <span className="absolute -bottom-[5px] left-2 h-2 w-2 rotate-45 border-b-2 border-r-2 border-[#3a5d61] bg-white" />
      <span className="absolute left-[6px] top-[8px] h-1 w-1 rounded-full bg-[#3a5d61]" />
      <span className="absolute left-[12px] top-[8px] h-1 w-1 rounded-full bg-[#3a5d61]" />
      <span className="absolute left-[18px] top-[8px] h-1 w-1 rounded-full bg-[#3a5d61]" />
    </span>
  </button>
</div>
    </div>
  );
}