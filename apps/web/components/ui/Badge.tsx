"use client";

/**
 * Badge — semantic status chip (Phase 7 foundation).
 *
 * A thin, token-driven wrapper over the canonical status vocabulary.
 * For raw workflow/policy status STRINGS (e.g. "PENDING_DESTRUCTION")
 * keep using the existing `<StatusBadge status="…" />` /
 * `statusBadgeStyle()` in `components/ui/StatusBadge.tsx` — this Badge is
 * the human-facing PROOVRA tone set used when a component already knows
 * the intent:
 *
 *   verified   restrained green   (proven / passed / active-good)
 *   pending    amber              (in-flight / needs review)
 *   risk       red                (failed / destructive / flagged)
 *   neutral    slate              (draft / archived / out-of-flow)
 *   governance violet             (policy / compliance / trust)
 *   info       blue               (default / informational)
 *
 * Every tone pairs a background with an accessible on-tint text colour
 * and a hairline border — NEVER colour-only, so it reads for colour-blind
 * users and passes contrast. Text label is always present.
 *
 * USAGE
 *   <Badge tone="verified">Verified</Badge>
 *   <Badge tone="governance" subtle>Policy</Badge>
 *   <Badge tone="risk" dot>At risk</Badge>
 */

import React from "react";
import { StatusBadge, statusBadgeStyle } from "./StatusBadge";

export type BadgeTone =
  | "verified"
  | "pending"
  | "risk"
  | "neutral"
  | "governance"
  | "info";

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Render a leading status dot for extra (non-colour) signal. */
  dot?: boolean;
  /** Lighter weight for dense tables. */
  subtle?: boolean;
  children: React.ReactNode;
}

const TONE_VARS: Record<
  BadgeTone,
  { bg: string; fg: string; border: string; solid: string }
> = {
  verified: {
    bg: "var(--status-verified-bg)",
    fg: "var(--status-verified-fg)",
    border: "var(--status-verified-border)",
    solid: "var(--status-verified-solid)",
  },
  pending: {
    bg: "var(--status-pending-bg)",
    fg: "var(--status-pending-fg)",
    border: "var(--status-pending-border)",
    solid: "var(--status-pending-solid)",
  },
  risk: {
    bg: "var(--status-risk-bg)",
    fg: "var(--status-risk-fg)",
    border: "var(--status-risk-border)",
    solid: "var(--status-risk-solid)",
  },
  neutral: {
    bg: "var(--status-neutral-bg)",
    fg: "var(--status-neutral-fg)",
    border: "var(--status-neutral-border)",
    solid: "var(--status-neutral-solid)",
  },
  governance: {
    bg: "var(--status-governance-bg)",
    fg: "var(--status-governance-fg)",
    border: "var(--status-governance-border)",
    solid: "var(--status-governance-solid)",
  },
  info: {
    bg: "var(--status-info-bg)",
    fg: "var(--status-info-fg)",
    border: "var(--status-info-border)",
    solid: "var(--status-info-solid)",
  },
};

export function Badge({
  tone = "neutral",
  dot = false,
  subtle = false,
  children,
  style,
  className,
  ...rest
}: BadgeProps) {
  const c = TONE_VARS[tone];
  return (
    <span
      {...rest}
      data-ui-badge
      data-tone={tone}
      className={["ui-badge", className].filter(Boolean).join(" ")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: dot ? 6 : 0,
        padding: "3px 10px",
        fontSize: 12,
        fontWeight: subtle ? 600 : 650,
        lineHeight: 1.4,
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {dot ? (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: c.solid,
            flexShrink: 0,
          }}
        />
      ) : null}
      {children}
    </span>
  );
}

// Re-export the raw-status primitives so consumers can pull everything
// badge-related from one module.
export { StatusBadge, statusBadgeStyle };

export default Badge;
