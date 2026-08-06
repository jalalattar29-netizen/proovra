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

import type { ReactNode } from "react";

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
