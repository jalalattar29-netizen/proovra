"use client";

/**
 * PHASE 12B — shared state primitives for the Security Center and the
 * sessions/devices console sections.
 *
 * Every section in these two surfaces renders FOUR DISTINCT states, because
 * conflating them is how a security console lies to an operator:
 *
 *   loading  — we have not heard from the server yet.
 *   denied   — the server refused (401 / 403 / 404). This must NEVER look
 *              like "there is nothing here": a concealed 404 from the
 *              anti-enumeration gate means "you cannot see this", not
 *              "this workspace has no MFA events".
 *   error    — the request failed for another reason; retry is offered.
 *   ready    — real server data, including a genuinely EMPTY list, which is
 *              rendered with <EmptyState> by the section itself.
 *
 * Messages always come from `toSafeUserError` — raw `err.message`
 * passthrough is banned app-wide.
 */

import { useId, useState, type ReactNode } from "react";

import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

export type SectionState<T> =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

const MUTED = "var(--ink-muted, #64748b)";

/**
 * Classify a thrown apiFetch error into `denied` vs `error`. A denial is a
 * deliberate server decision (including the concealed 404 the mfa-admin and
 * identity-security gates return for a cross-Organization scope).
 */
export function classifyError<T>(
  err: unknown,
  fallbackMessage: string,
): Extract<SectionState<T>, { kind: "denied" | "error" }> {
  const safe = toSafeUserError(err, { message: fallbackMessage });
  const status = (err as { statusCode?: number }).statusCode ?? 0;
  const code = ((err as { code?: string }).code ?? "").toUpperCase();
  const denied =
    status === 401 ||
    status === 403 ||
    status === 404 ||
    code === "FORBIDDEN" ||
    code === "UNAUTHORIZED" ||
    code === "NOT_FOUND";
  return denied
    ? { kind: "denied", message: safe.message }
    : { kind: "error", message: safe.message };
}

export function safeMessage(err: unknown, fallbackMessage: string): string {
  return toSafeUserError(err, { message: fallbackMessage }).message;
}

export function SectionLoading({ label }: { label: string }) {
  return (
    <Card padding="comfortable" data-section-state="loading">
      <p style={{ margin: 0, fontSize: 13, color: MUTED }}>{label}</p>
    </Card>
  );
}

export function SectionDenied({
  message,
  hint,
}: {
  message: string;
  hint?: ReactNode;
}) {
  return (
    <Card variant="status" tone="neutral" data-section-state="denied">
      <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
        You do not have access to this
      </p>
      <p style={{ margin: "6px 0 0", fontSize: 13, color: MUTED }}>{message}</p>
      <p style={{ margin: "6px 0 0", fontSize: 12.5, color: MUTED }}>
        {hint ??
          "This is a refusal, not an empty result. Ask a workspace owner or admin for security-operations access."}
      </p>
    </Card>
  );
}

export function SectionError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card variant="status" tone="risk" data-section-state="error">
      <p style={{ margin: 0, fontSize: 13, color: MUTED }}>{message}</p>
      <div style={{ marginTop: 10 }}>
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Card>
  );
}

export function NoWorkspaceSelected({ purpose }: { purpose: string }) {
  return (
    <Card padding="comfortable" data-section-state="no-workspace">
      <p style={{ margin: 0, fontSize: 13, color: MUTED }}>{purpose}</p>
    </Card>
  );
}

export const sectionMuted = { fontSize: 12.5, color: MUTED } as const;

/**
 * A section description that is one sentence long until asked.
 *
 * The Security Center carried seven paragraphs of methodology — what each
 * panel reads, what it never shows, which server decides — each printed in
 * full above its section. That is the right text and the wrong default: an
 * operator reads it once and scans past it every visit after, and on a phone
 * the seven of them were most of the first two screens.
 *
 * The first sentence stays visible, because it is the one that says what the
 * section IS. The rest opens in place. Inline elements only — this renders
 * inside the `<p>` that PageSection and PageHeader already provide, and a
 * `<details>` there would be invalid HTML.
 */
export function SectionDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const restId = useId();
  const match = /^(.*?[.!?])\s+(\S[\s\S]*)$/.exec(text.trim());
  if (!match) return <>{text}</>;
  const [, first, rest] = match;
  return (
    <>
      {first}{" "}
      {open ? (
        <span id={restId} data-section-description-rest>
          {rest}{" "}
        </span>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={restId}
        onClick={() => setOpen((o) => !o)}
        data-section-description-toggle
        style={{
          // Inherits the description's size and line-height so the toggle
          // sits in the sentence rather than beside it.
          font: "inherit",
          padding: 0,
          border: 0,
          background: "none",
          color: "var(--ink-primary, #0f172a)",
          textDecoration: "underline",
          textUnderlineOffset: 2,
          cursor: "pointer",
          minHeight: 0,
        }}
      >
        {open ? "Show less" : "Read more"}
      </button>
    </>
  );
}

export const sectionInputStyle = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  border: "1px solid var(--border, #cbd5e1)",
  borderRadius: 6,
  background: "var(--surface, #fff)",
  color: "var(--ink-primary, #0f172a)",
} as const;

export const sectionLabelStyle = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: MUTED,
  marginBottom: 4,
} as const;

/**
 * A radio or checkbox row, sized to be hit.
 *
 * A native radio is 13x13 and always will be — that is the platform widget —
 * so the <label> wrapping it is the target a person actually clicks. Three
 * choice rows in this console measured 43px, 39px and 39px tall: near-misses
 * that only a measurement finds, and that would otherwise have been patched
 * one at a time until somebody missed the fourth.
 *
 * `alignItems: "flex-start"` is the default because these rows usually carry a
 * bold label above a description, and centring floats the radio beside the
 * second line. Rows with a single line of text override it.
 */
export const choiceRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  minHeight: 44,
  paddingBlock: 2,
};
