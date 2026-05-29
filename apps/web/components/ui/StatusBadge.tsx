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

const TONE_PALETTE: Record<Tone, { bg: string; fg: string; border: string }> = {
  success: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  warning: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
  danger: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  neutral: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
  info: { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" },
};

/**
 * Canonical status → tone mapping.
 *
 * Unknown statuses fall through to `info` (safe blue), matching the
 * behaviour the legacy local helpers used as their default branch.
 *
 * Notable terminal-passive states (ARCHIVED, DISABLED, SKIPPED,
 * CANCELLED) intentionally render `neutral` slate — they are NOT
 * dangers, they are simply out-of-flow. The legacy workflows page had
 * ARCHIVED in the danger-red bucket; that has been corrected here.
 */
const STATUS_TO_TONE: Record<string, Tone> = {
  // success family
  ACTIVE: "success",
  ALLOW: "success",
  APPROVED: "success",
  APPROVED_INTERNAL: "success",
  COMPLETED: "success",
  DELIVERED: "success",
  PACKAGE_READY: "success",
  REPORT_READY: "success",
  SENT: "success",
  SHARED_EXTERNALLY: "success",

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

  // neutral / terminal-passive family
  ARCHIVED: "neutral",
  CANCELLED: "neutral",
  DESTROYED: "neutral",
  DISABLED: "neutral",
  DRAFT: "neutral",
  LEGAL_HOLD: "neutral",
  NOT_APPLICABLE: "neutral",
  ON_HOLD: "neutral",
  PENDING_DESTRUCTION: "neutral",
  RETAINED: "neutral",
  RETENTION_LOCKED: "neutral",
  SKIPPED: "neutral",
  SUPERSEDED: "neutral",
};

function paletteFor(status: string): { bg: string; fg: string; border: string } {
  const tone = STATUS_TO_TONE[status] ?? "info";
  return TONE_PALETTE[tone];
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
