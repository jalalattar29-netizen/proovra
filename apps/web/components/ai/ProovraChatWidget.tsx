"use client";

import { useMemo, useState } from "react";
import { Button, Card } from "../ui";
import { apiFetch, ApiError } from "../../lib/api";

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
      const pageContext = {
        path: typeof window !== "undefined" ? window.location.pathname : undefined,
        title: typeof document !== "undefined" ? document.title : undefined,
      };

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
      result.legalDisclaimer,
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

  const emptyState = useMemo(
    () => (
      <div className="p-4 text-sm text-slate-300">
        Start a short conversation about capture guidance, evidence intake quality, or metadata checks.
      </div>
    ),
    []
  );

  return (
    <div className="fixed right-4 bottom-[92px] z-50 flex flex-col items-end gap-3 sm:right-6 sm:bottom-6">
      {open ? (
<Card className="w-screen max-w-[420px] overflow-hidden rounded-[28px] border border-[rgba(36,55,59,0.12)] bg-[#fbfcfb] p-0 shadow-[0_28px_70px_rgba(15,23,42,0.18)] sm:w-[420px]">
<div className="flex items-center justify-between gap-3 border-b border-[rgba(36,55,59,0.10)] bg-[#f5f7f5] px-4 py-3">
                <div>
<div className="text-sm font-extrabold text-[#12252a]">PROOVRA AI chat</div>
<div className="text-xs leading-5 text-[#647174]">
                    Advisory support only. Not legal, admissibility, or authenticity verification.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
className="rounded-full border border-[rgba(58,93,97,0.18)] bg-white px-3 py-1 text-xs font-bold text-[#3a5d61] shadow-sm hover:bg-[#edf8f6]"
            >
              Close
            </button>
          </div>

<div className="max-h-[360px] overflow-y-auto bg-[#fbfcfb] px-4 py-3">
                {hasMessages ? (
              <div className="space-y-3">
                {messages.map((message, index) => (
                  <div
                    key={`${message.role}-${index}`}
                    className={`rounded-2xl border px-3 py-2 text-sm ${
message.role === "assistant"
  ? "border-[rgba(58,93,97,0.14)] bg-[#f1f6f4] text-[#24373b]"
  : "self-end border-[rgba(183,157,132,0.22)] bg-[linear-gradient(180deg,#3a5d61,#203a3f)] text-[#f4f7f6]"
                    }`}
                  >
                    <div className="text-[0.68rem] font-black uppercase tracking-[0.16em] text-[#8f745c]">
                      {message.role === "assistant" ? "Assistant" : "You"}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap leading-6">
                      {message.content}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              emptyState
            )}
          </div>

          <div className="border-t border-[rgba(36,55,59,0.10)] px-4 py-3">
            {error ? (
              <div className="mb-3 rounded-2xl bg-slate-900 px-3 py-2 text-sm text-rose-200">
                {error}
              </div>
            ) : null}

            {unavailable ? (
              <div className="mb-3 rounded-2xl bg-slate-900 px-3 py-2 text-sm text-slate-300">
                AI assistant unavailable. You can continue capture normally.
              </div>
            ) : null}

            <div className="grid gap-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                placeholder="Ask the AI about your capture session..."
className="w-full rounded-2xl border border-[rgba(36,55,59,0.12)] bg-white px-3 py-2 text-sm text-[#12252a] outline-none placeholder:text-[#8b989c] focus:border-[rgba(58,93,97,0.35)] focus:ring-4 focus:ring-[rgba(58,93,97,0.10)]"
                disabled={busy || unavailable}
              />
              <div className="flex items-center justify-between gap-3">
<div className="text-xs text-[#647174]">AI answers are advisory only.</div>
                <Button
                  variant="primary"
                  onClick={handleSend}
                  disabled={!canSend}
                  className="rounded-full px-4 py-2 text-sm"
                >
                  {busy ? "Sending…" : "Send"}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <Button
        variant="secondary"
        onClick={() => setOpen((prev) => !prev)}
className="rounded-full border border-[rgba(183,157,132,0.24)] bg-[linear-gradient(180deg,#3a5d61,#203a3f)] px-4 py-3 text-sm font-extrabold text-[#f4f7f6] shadow-[0_18px_42px_rgba(15,23,42,0.22)] hover:border-[rgba(214,184,157,0.36)]"
      >
        {open ? "Hide AI" : "Open AI Chat"}
      </Button>
    </div>
  );
}
