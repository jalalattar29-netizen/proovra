"use client";

/**
 * THE AUTHENTICATED ASSISTANT.
 *
 * =============================================================================
 * WHAT CHANGED AND WHY
 * =============================================================================
 * This panel used to report every failure it did not recognise with one line:
 *
 *     "AI assistant currently unavailable. Continue without AI."
 *
 * The sentence was reached for a workspace that had deliberately switched AI
 * off, for a plan that never included it, for a rate limit, for a spent
 * budget, and for an expired session — none of which are unavailability. The
 * reasoning behind that mapping now lives in `lib/ai/assistant-state.ts`,
 * where it is a pure function and every branch can be asserted; see that file
 * for the full account of what the old branch got wrong.
 *
 * Three further changes follow from it:
 *
 * ONE STATE, NOT TWO. There were two independent pieces of state, `error` and
 * `unavailable`, rendered as two separate blocks that could appear together —
 * two contradictory explanations of one failure, stacked. There is now a
 * single `AssistantState`.
 *
 * THE PANEL ASKS BEFORE IT GUESSES. Opening the panel reads
 * `GET /v1/ai/availability`, so a workspace that turned the assistant off is
 * told so immediately instead of after typing a question and having it fail.
 *
 * A 200 IS NOT AN ANSWER. The provider layer catches its own failures and
 * reports them in the body as `status: "error"`, so a panel that inspected
 * only HTTP status rendered an apology in the shape of advice. The result
 * status is now classified too.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import {
  classifyAssistantError,
  classifyAssistantResult,
  READY_STATE,
  SENSITIVE_ROUTE_STATE,
  type AssistantState,
} from "../../lib/ai/assistant-state";
import { hasPreferencesConsent } from "../../lib/consent";
import {
  classifyRouteClass,
  getSafePageContext,
  isSensitiveRoute,
} from "../../lib/privacy/redact";
import "./assistant.css";

type AiFlag = {
  severity: "info" | "warning" | "danger";
  title: string;
  detail: string;
};

type AiResult = {
  status: "ok" | "blocked" | "disabled" | "error";
  summary: string;
  warnings: string[];
  suggestions: string[];
  flags: AiFlag[];
  legalDisclaimer: string;
};

/**
 * A turn as the panel renders it.
 *
 * `suggestions` and `warnings` are kept as fields rather than folded into the
 * text. The old panel joined them into `content` behind "Suggested next
 * actions:" and bullet characters, which made a list that could not be styled,
 * could not be a list for a screen reader, and could not be told apart from a
 * summary that happened to contain a newline.
 */
type Turn = {
  role: "user" | "assistant";
  content: string;
  suggestions?: string[];
  warnings?: string[];
};

/** What the panel sends to the API — the transcript only, without decoration. */
type WireMessage = { role: "user" | "assistant"; content: string };

type ChatResponsePayload = { data?: AiResult };

type AvailabilityPayload = {
  data?: {
    available: boolean;
    decision: string;
    groundedAnswersAvailable: boolean;
  };
};

/*
 * The opening prompts are REAL QUESTIONS the assistant can answer without a
 * provider — each maps to a grounded topic in the server's product-knowledge
 * bundle. That matters: an opening prompt that fails when AI is switched off
 * would be the panel advertising something it cannot do.
 */
const OPENING_QUESTIONS = [
  "How do I capture evidence?",
  "What is a verification package?",
  "What does TSA failed mean?",
  "What can AI do in PROOVRA?",
];

export function ProovraChatWidget() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<AssistantState>(READY_STATE);
  const [showHint, setShowHint] = useState(false);

  const logRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  /** Availability is read once per open, not once per keystroke. */
  const probedRef = useRef(false);

  // ---- the one-time nudge -------------------------------------------------
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

  /*
   * ASK WHAT IS POSSIBLE BEFORE OFFERING IT.
   *
   * Without this the only way to discover a workspace opt-out was to type a
   * question and have it refused, which is how a deliberate configuration came
   * to be presented as a malfunction. A failure to probe is not itself an
   * error worth showing — the send path will classify whatever is really
   * wrong, with a real request behind it.
   */
  const probeAvailability = useCallback(async () => {
    if (probedRef.current) return;
    probedRef.current = true;
    try {
      const res = (await apiFetch(
        "/v1/ai/availability",
        { method: "GET" },
        { auth: true },
      )) as AvailabilityPayload;

      const info = res?.data;
      if (!info || info.available) return;

      setState(
        classifyAssistantError({
          code: "AI_WORKSPACE_POLICY_DENIED",
          statusCode: 403,
          details: { decision: info.decision },
        }),
      );
    } catch {
      // Stay ready; a real send will produce a real classification.
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void probeAvailability();
    fieldRef.current?.focus();
  }, [open, probeAvailability]);

  // Keep the newest turn in view without yanking the whole page.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      const rawPath =
        typeof window !== "undefined" ? window.location.pathname : null;

      // Defence in depth: never send from a screen that can show sensitive
      // material, even if the host page somehow rendered the widget there.
      if (isSensitiveRoute(rawPath) || classifyRouteClass(rawPath) === "auth") {
        setState(SENSITIVE_ROUTE_STATE);
        return;
      }

      const nextTurns: Turn[] = [...turns, { role: "user", content: trimmed }];
      setTurns(nextTurns);
      setDraft("");
      setBusy(true);
      setState(READY_STATE);

      // The wire carries the transcript only. Suggestions and warnings are
      // this panel's rendering of an answer, not part of the conversation.
      const wire: WireMessage[] = nextTurns.map((t) => ({
        role: t.role,
        content: t.content,
      }));

      try {
        const safe = getSafePageContext(rawPath);
        // Never send page titles — they routinely contain evidence names,
        // case numbers, recipient names, or report subjects.
        const response = (await apiFetch(
          "/v1/ai/chat",
          {
            method: "POST",
            body: JSON.stringify({
              messages: wire,
              pageContext: { path: safe.safePath, routeClass: safe.routeClass },
            }),
          },
          { auth: true },
        )) as ChatResponsePayload;

        const result = response?.data;
        if (!result) {
          setState(classifyAssistantResult("error"));
          return;
        }

        const resultState = classifyAssistantResult(result.status);
        setState(resultState);

        // A refusal or a failure is shown in the banner, which explains it
        // once and in the panel's own words. Adding it to the transcript as
        // well would say the same thing twice and leave an apology sitting in
        // the history as though it were an answer.
        if (result.status !== "ok") return;

        setTurns((prev) => [
          ...prev,
          {
            role: "assistant",
            content: result.summary,
            suggestions: result.suggestions?.length ? result.suggestions : undefined,
            warnings: result.warnings?.length ? result.warnings : undefined,
          },
        ]);
      } catch (err: unknown) {
        setState(
          classifyAssistantError(
            (err ?? {}) as {
              code?: string;
              statusCode?: number;
              details?: Record<string, unknown>;
            },
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, turns],
  );

  const canSend = Boolean(draft.trim()) && !busy && state.canSend;

  return (
    <div className="assistant-dock">
      {open ? (
        <div
          className="assistant-panel"
          role="dialog"
          aria-label="PROOVRA assistant"
          data-assistant-panel
        >
          <div className="assistant-panel__header">
            <div>
              <div className="assistant-panel__title">PROOVRA Assistant</div>
              {/*
                The disclosure says the same thing the old one did — "Advisory
                support only. Not legal or factual determination." — in words
                that mean something to the person reading it. The boundary is
                not weakened: "advisory" and "does not determine" both remain,
                and what it does not determine is now named rather than left as
                an abstraction.
              */}
              <p className="assistant-panel__disclosure">
                Advisory only. It answers questions about using PROOVRA and does
                not determine whether evidence is authentic, or give legal advice.
              </p>
            </div>
            <button
              type="button"
              className="assistant-panel__close"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
            >
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path
                  d="M5 5l10 10M15 5L5 15"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <div
            className="assistant-log"
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-label="Assistant conversation"
          >
            {turns.length === 0 ? (
              <div>
                <p className="assistant-empty__lead">
                  Ask anything about capturing, organising or verifying evidence.
                </p>
                <div className="assistant-empty__list">
                  {OPENING_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="assistant-suggestion"
                      onClick={() => void send(q)}
                      disabled={busy || !state.canSend}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((turn, index) => (
                <div
                  key={`${turn.role}-${index}`}
                  className="assistant-msg"
                  data-role={turn.role}
                >
                  {turn.content}
                  {turn.warnings?.length ? (
                    <ul className="assistant-msg__warnings">
                      {turn.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  ) : null}
                  {turn.suggestions?.length ? (
                    <ul className="assistant-msg__actions">
                      {turn.suggestions.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))
            )}

            {busy ? (
              <div className="assistant-typing" aria-label="Assistant is answering">
                <span />
                <span />
                <span />
              </div>
            ) : null}
          </div>

          {state.kind !== "READY" ? (
            <div
              className="assistant-state"
              data-tone={state.tone}
              data-assistant-state={state.kind}
              role={state.tone === "problem" ? "alert" : "status"}
            >
              <div className="assistant-state__title">{state.title}</div>
              <div className="assistant-state__body">{state.body}</div>
            </div>
          ) : null}

          <div className="assistant-composer">
            <textarea
              ref={fieldRef}
              className="assistant-composer__field"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line — the convention
                // every chat surface the reader already uses shares.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) void send(draft);
                }
              }}
              rows={2}
              placeholder="Ask a question…"
              disabled={busy || !state.canSend}
              aria-label="Ask the assistant"
            />
            <div className="assistant-composer__row">
              <span className="assistant-composer__hint">
                Enter to send · Shift + Enter for a new line
              </span>
              <button
                type="button"
                className="app-primary-action"
                onClick={() => void send(draft)}
                disabled={!canSend}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ position: "relative" }}>
        {showHint && !open ? (
          <div className="assistant-hint" role="status">
            Need help?
          </div>
        ) : null}
        <button
          type="button"
          className="assistant-launcher"
          onClick={() => setOpen((prev) => !prev)}
          aria-label={open ? "Close assistant" : "Open assistant"}
          aria-expanded={open}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M21 12a8 8 0 0 1-8 8H7l-4 3v-4.6A8 8 0 0 1 13 4a8 8 0 0 1 8 8Z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
