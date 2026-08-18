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
    bg: "var(--status-verified-bg, #ecfdf5)",
    fg: "var(--status-verified-fg, #065f46)",
    border: "var(--status-verified-border, #a7f3d0)",
    solid: "var(--status-verified-solid, #10b981)",
  },
  pending: {
    bg: "var(--status-pending-bg, #fef3c7)",
    fg: "var(--status-pending-fg, #78350f)",
    border: "var(--status-pending-border, #fde68a)",
    solid: "var(--status-pending-solid, #f59e0b)",
  },
  risk: {
    bg: "var(--status-risk-bg, #fef2f2)",
    fg: "var(--status-risk-fg, #991b1b)",
    border: "var(--status-risk-border, #fecaca)",
    solid: "var(--status-risk-solid, #dc2626)",
  },
  neutral: {
    bg: "var(--status-neutral-bg, #f1f5f9)",
    fg: "var(--status-neutral-fg, #475569)",
    border: "var(--status-neutral-border, #cbd5e1)",
    solid: "var(--status-neutral-solid, #64748b)",
  },
  governance: {
    bg: "var(--status-governance-bg, #eeebff)",
    fg: "var(--status-governance-fg, #4634c9)",
    border: "var(--status-governance-border, #d6cffb)",
    solid: "var(--status-governance-solid, #7C3AED)",
  },
  info: {
    bg: "var(--status-info-bg, #eff6ff)",
    fg: "var(--status-info-fg, #1e40af)",
    border: "var(--status-info-border, #bfdbfe)",
    solid: "var(--status-info-solid, #2563eb)",
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
