"use client";

/**
 * PHASE 12B — shared state primitives for the Security Center and the
 * sessions/devices console sections.
 *
 * Every section in these two surfaces renders FIVE DISTINCT states, because
 * conflating them is how a security console lies to an operator:
 *
 *   loading    — we have not heard from the server yet.
 *   denied     — the server refused (401 / 403 / 404). This must NEVER look
 *                like "there is nothing here": a concealed 404 from the
 *                anti-enumeration gate means "you cannot see this", not
 *                "this workspace has no MFA events".
 *   plan_gated — the server answered 402: the feature is real, the operator is
 *                allowed, and THIS WORKSPACE'S PLAN does not include it.
 *   error      — the request failed for another reason; retry is offered.
 *   ready      — real server data, including a genuinely EMPTY list, which is
 *                rendered with <EmptyState> by the section itself.
 *
 * Messages always come from `toSafeUserError` — raw `err.message`
 * passthrough is banned app-wide.
 *
 * ===========================================================================
 * WHY plan_gated EXISTS (GATE B, §B1)
 * ===========================================================================
 * `PATCH /v1/identity/mfa-admin/policy/:teamId` calls
 * `assertTeamAllowsEnterpriseFeature(teamId, "mfaEnforcement")` and answers
 *
 *     402 { code: "ENTERPRISE_FEATURE_REQUIRED", upgradeCta: "/contact-sales" }
 *
 * when the workspace is not on a plan that includes it. `classifyError`
 * recognised 401/403/404 as `denied` and swept EVERYTHING ELSE into `error`,
 * so that 402 reached the operator as an unexplained failure with a Try again
 * button — for a request that will fail identically every time, and whose
 * actual remedy is a plan change with a link the server already supplies.
 *
 * Retrying a refusal is not a recovery path. A plan gate is not an error, and
 * it is not a denial either: the operator has the authority, the workspace
 * does not have the entitlement. It gets its own state and its own words.
 */

import { useId, useState, type ReactNode } from "react";

import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

export type SectionState<T> =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | {
      kind: "plan_gated";
      message: string;
      /** The entitlement the server named, when it named one. */
      feature: string | null;
      /** Where the server said to go. Never invented here. */
      upgradeCta: string | null;
    }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

const MUTED = "var(--ink-muted)";

/**
 * Classify a thrown apiFetch error into `denied` vs `error`. A denial is a
 * deliberate server decision (including the concealed 404 the mfa-admin and
 * identity-security gates return for a cross-Organization scope).
 */
export function classifyError<T>(
  err: unknown,
  fallbackMessage: string,
): Extract<SectionState<T>, { kind: "denied" | "plan_gated" | "error" }> {
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
  if (denied) return { kind: "denied", message: safe.message };

  /*
    THE PLAN GATE, BEFORE THE CATCH-ALL.
    Ordered ahead of the `error` fallback deliberately: 402 used to reach it
    and become "we couldn't load this", with a Try again that cannot succeed.
    Both the status and the code are accepted because the mfa-admin route
    forwards whichever the entitlement helper threw.
  */
  if (status === 402 || code === "ENTERPRISE_FEATURE_REQUIRED") {
    const body = (err as { body?: { error?: Record<string, unknown> } }).body;
    const detail = (body?.error ?? {}) as {
      feature?: unknown;
      upgradeCta?: unknown;
    };
    return {
      kind: "plan_gated",
      message: safe.message,
      feature: typeof detail.feature === "string" ? detail.feature : null,
      upgradeCta:
        typeof detail.upgradeCta === "string" ? detail.upgradeCta : null,
    };
  }

  return { kind: "error", message: safe.message };
}

export function safeMessage(err: unknown, fallbackMessage: string): string {
  return toSafeUserError(err, { message: fallbackMessage }).message;
}

/**
 * IS THIS FAILURE A PLAN GATE? — for a MUTATION, where the state is a message
 * rather than a section.
 *
 * `classifyError` above answers this for a READ, whose result is a section
 * state. A refused SAVE has no section to replace: the data on screen is still
 * valid and the form is still the right thing to look at. What must change is
 * what the operator is told.
 *
 * `PATCH /v1/identity/mfa-admin/policy/:teamId` is the one plan-gated route in
 * the MFA admin surface — the reads are not gated — and its 402 reached the
 * operator as "We couldn't save the MFA policy", the same sentence a network
 * failure produces. One is worth retrying and the other never will be.
 *
 * Returns null when the failure is not a plan gate, so a caller can fall
 * through to its ordinary error path.
 */
export function planGateMessage(err: unknown): string | null {
  const status = (err as { statusCode?: number }).statusCode ?? 0;
  const code = ((err as { code?: string }).code ?? "").toUpperCase();
  if (status !== 402 && code !== "ENTERPRISE_FEATURE_REQUIRED") return null;

  // `ApiError.body` carries the server's normalised envelope, so the feature
  // and the upgrade destination are the SERVER's values and are never invented
  // here. This route sends `upgradeCta` and no `feature`; scim-admin sends a
  // `feature`. Both shapes are read, neither is required.
  const detail = ((err as { body?: { error?: Record<string, unknown> } }).body
    ?.error ?? {}) as { feature?: unknown; upgradeCta?: unknown };
  const feature =
    typeof detail.feature === "string" && detail.feature.trim()
      ? detail.feature.trim()
      : null;
  const cta =
    typeof detail.upgradeCta === "string" && detail.upgradeCta.trim()
      ? detail.upgradeCta.trim()
      : null;

  // What happened, why, that retrying is not the remedy, and where to go.
  return (
    `Not saved: this workspace's plan does not include ` +
    `${feature ? `"${feature}"` : "this feature"}. ` +
    `Nothing is wrong with your access, so retrying will not help — the ` +
    `workspace needs a plan that includes it.` +
    (cta ? ` Talk to sales: ${cta}` : "")
  );
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

/**
 * THE WORKSPACE'S PLAN DOES NOT INCLUDE THIS, AND THAT IS NOT A FAILURE.
 *
 * Three things are true at once and the operator needs all three: the feature
 * is real, they are allowed to use it, and this workspace is not entitled to
 * it. There is deliberately NO retry — the request will be refused
 * identically every time, and offering Try again on a settled refusal teaches
 * an operator to keep pressing it.
 *
 * `neutral`, not `risk`: nothing is wrong. The upgrade link is the server's
 * own `upgradeCta`; when it does not send one, none is invented here.
 */
export function SectionPlanGated({
  message,
  feature,
  upgradeCta,
}: {
  message: string;
  feature?: string | null;
  upgradeCta?: string | null;
}) {
  return (
    <Card variant="status" tone="neutral" data-section-state="plan-gated">
      <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
        Not included in this workspace&apos;s plan
      </p>
      <p style={{ margin: "6px 0 0", fontSize: 13, color: MUTED }}>{message}</p>
      {feature ? (
        <p style={{ margin: "6px 0 0", fontSize: 12.5, color: MUTED }}>
          The plan gate the server named is <code>{feature}</code>.
        </p>
      ) : null}
      <p style={{ margin: "6px 0 0", fontSize: 12.5, color: MUTED }}>
        Your access is not the limit here, so there is nothing to retry — the
        workspace needs a plan that includes it.
        {upgradeCta ? (
          <>
            {" "}
            <a href={upgradeCta}>Talk to sales</a>.
          </>
        ) : null}
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
          color: "var(--ink-primary)",
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
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--ink-primary)",
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
