/**
 * Shared StatusBadge module — canonical enterprise status palette.
 *
 * Final-closure consistency normalization. Mirrors the considered palette
 * from `apps/web/app/(app)/admin/identity/ui-tokens.ts:statusBadgeStyle`,
 * extended to cover the wider operator status vocabulary (workflow
 * instance status, retention policy status, notification delivery
 * status, intelligence job status).
 *
 * Tone families (semantic, not literal hex):
 *   - success  → green (approvals, completed, active-good)
 *   - warning  → amber (pending, needs review, retrying)
 *   - danger   → red   (failed, revoked, denied)
 *   - neutral  → slate (archived, disabled, skipped — terminal-passive)
 *   - info     → blue  (in-flight, default unknown)
 *
 * Callers that previously held local palettes should migrate here so the
 * visual language stays consistent. Use `statusBadgeStyle(status)` for a
 * drop-in style object, or `<StatusBadge status="..." />` for the full
 * rendered chip with humanized text.
 */
import type { CSSProperties } from "react";

type Tone = "success" | "warning" | "danger" | "neutral" | "info";

/**
 * The same six pairs `Badge` uses, named rather than repeated.
 *
 * These were bare hex — a fourth copy of the product's status palette, beside
 * the one in `Badge.tsx` (as undeclared `var()` fallbacks), the one in
 * `admin/identity/ui-tokens.ts` and the one in `tokens.css`. Four copies of
 * six colours agree only for as long as nobody edits one of them.
 *
 * `warning`'s foreground moves with that consolidation: it was #78350F here
 * and #EA580C in `Badge`, for the same amber ground. Neither survives; both
 * are now `--status-pending-fg`, which is `--orange-ink` and measures 4.65:1
 * on that ground.
 */
const TONE_TOKEN: Record<Tone, "verified" | "pending" | "risk" | "neutral" | "info"> = {
  success: "verified",
  warning: "pending",
  danger: "risk",
  neutral: "neutral",
  info: "info",
};

/**
 * Canonical status → tone mapping.
 *
 * Unknown statuses fall through to `info` (safe blue), matching the
 * behaviour the legacy local helpers used as their default branch.
 *
 * Notable terminal-passive states (ARCHIVED, DISABLED, SKIPPED,
 * CANCELLED) intentionally render `neutral` slate — they are NOT
 * dangers, they are simply out-of-flow. ARCHIVED here refers to the
 * generic operator-vocabulary archival state used by retention
 * policies / governance / etc. — NOT a workflow instance status (the
 * Phase 22 ARCHIVED workflow status was retired in Phase R).
 *
 * Phase E canonicalization: the dead Phase 22 workflow export-ladder
 * statuses (REPORT_READY, PACKAGE_READY, SHARED_EXTERNALLY) plus the
 * dead workflow-hold / workflow-retention statuses (LEGAL_HOLD,
 * RETAINED) had ZERO producer routes and ZERO UI controls in any
 * workspace. They were the only consumers of those literal strings
 * inside the shared status palette and have been removed from this
 * map. Any legacy row that still carries one of those literal
 * values now falls through to the default `info` tone. Re-adding
 * them here is a regression and is forbidden by
 * `phase-r-workflow-canonicalization.test.ts` (the source-text
 * grep guard scans this file too).
 *
 * The generic ACTIVE / ARCHIVED entries remain because they serve
 * non-workflow domains (retention policy status, etc.). The legal-hold
 * lifecycle indicator for evidence lives in the dedicated
 * `LifecycleIndicators` palette, not here.
 */
const STATUS_TO_TONE: Record<string, Tone> = {
  // success family
  ACTIVE: "success",
  ALLOW: "success",
  APPROVED: "success",
  APPROVED_INTERNAL: "success",
  COMPLETED: "success",
  DELIVERED: "success",
  SENT: "success",

  // warning family
  CHANGES_REQUESTED: "warning",
  IN_REVIEW: "warning",
  NEEDS_REVIEW: "warning",
  PAUSED: "warning",
  PENDING: "warning",
  RETRY_SCHEDULED: "warning",
  STEP_UP_REQUIRED: "warning",
  SUBMITTED: "warning",
  UNDER_REVIEW: "warning",

  // danger family
  DENY: "danger",
  ESCALATED: "danger",
  FAILED: "danger",
  REVOKED: "danger",

  /* PHASE 7 — the upload-reliability lifecycle, which /admin/platform/
     reliability had been colouring from a page-local copy of this map. Its
     three terminal-bad states were not here, so routing that page through the
     canonical map without adding them would have quietly repainted two
     failures and one abandonment as informational blue.

     STALLED and REVIEW_REQUIRED are DANGER because an operator has to act on
     them: a stalled upload is not progressing and a review-required one is
     holding evidence. ABANDONED is NEUTRAL — it is a finished, deliberate
     outcome, not a fault. The in-flight steps stay on the default `info`,
     which is what "this is moving through the pipeline" means. */
  STALLED: "danger",
  REVIEW_REQUIRED: "danger",

  // neutral / terminal-passive family
  ABANDONED: "neutral",
  ARCHIVED: "neutral",
  CANCELLED: "neutral",
  DESTROYED: "neutral",
  DISABLED: "neutral",
  DRAFT: "neutral",
  NOT_APPLICABLE: "neutral",
  ON_HOLD: "neutral",
  PENDING_DESTRUCTION: "neutral",
  RETENTION_LOCKED: "neutral",
  SKIPPED: "neutral",
  SUPERSEDED: "neutral",
};

function paletteFor(status: string): { bg: string; fg: string; border: string } {
  const key = TONE_TOKEN[STATUS_TO_TONE[status] ?? "info"];
  return {
    bg: `var(--status-${key}-bg)`,
    fg: `var(--status-${key}-fg)`,
    border: `var(--status-${key}-border)`,
  };
}

/**
 * The tone a raw status string carries, in `Badge`'s vocabulary.
 *
 * `STATUS_TO_TONE` above is the widest status map in the product; `Badge` is
 * the component that renders one. This is the join, so a caller with a status
 * STRING can use the canonical component instead of a hand-styled `<span>` —
 * which is what thirteen admin call sites were doing through
 * `statusBadgeStyle`.
 */
export function statusTone(
  status: string,
): "verified" | "pending" | "risk" | "neutral" | "info" {
  return TONE_TOKEN[STATUS_TO_TONE[status] ?? "info"];
}

/**
 * Canonical badge style for a workflow / policy / job / delivery status.
 *
 * Matches the signature of the original
 * `admin/identity/ui-tokens.ts:statusBadgeStyle` so it is a drop-in for
 * existing call sites. Returns a CSSProperties object you can spread or
 * apply directly to a `<span>`.
 */
export function statusBadgeStyle(status: string): CSSProperties {
  const p = paletteFor(status);
  return {
    padding: "3px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    whiteSpace: "nowrap",
    display: "inline-block",
  };
}

function humanize(status: string): string {
  return status.replace(/_/g, " ");
}

export interface StatusBadgeProps {
  status: string;
}

/**
 * Drop-in chip element rendering the canonical status badge with
 * humanized text (`PENDING_DESTRUCTION` → `PENDING DESTRUCTION`).
 *
 * Use this when the rendered text should simply be the humanized
 * status. Call sites that need a custom label should use
 * `statusBadgeStyle` directly on their own `<span>`.
 */
export function StatusBadge({ status }: StatusBadgeProps) {
  return <span style={statusBadgeStyle(status)}>{humanize(status)}</span>;
}
