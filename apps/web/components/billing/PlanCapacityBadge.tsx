"use client";

/**
 * PlanCapacityBadge — canonical capacity badge for plan-limit
 * indicators across collaboration-teams and adjacent surfaces.
 *
 * Phase 10 UX rule (binding):
 *   - There is exactly one capacity-badge presentation in the product.
 *     All pages render the same chip for "within-limit", "near-limit"
 *     (>= 80% of `limit`), and "at-limit" (>= 100% of `limit`).
 *   - Counts MUST come from /v1/platform-context (or the billing-context
 *     endpoint already exposed by the new helpers). This component does
 *     NOT fabricate or fetch counts; callers pass the canonical
 *     `used` / `limit` values they already read.
 *   - Upgrade CTAs link to /billing (canonical).
 *
 * Vocabulary discipline:
 *   - "Capacity" here is plan-limit capacity. It is NOT a workspace.
 *     Team is not Workspace; this component never renders workspace
 *     terminology. It is a billing/plan UX primitive only.
 */

import type { CSSProperties } from "react";
import Link from "next/link";

export type PlanCapacityBadgeState = "within-limit" | "near-limit" | "at-limit";

export interface PlanCapacityBadgeProps {
  /** Current usage count (e.g. members in use, invites sent). */
  used: number;
  /**
   * Plan-allowed capacity. Pass `null` to indicate "no plan limit
   * known" (badge renders a neutral unknown variant instead of
   * fabricating a state).
   */
  limit: number | null;
  /** Short noun describing what is being counted (e.g. "members", "invites"). */
  label: string;
  /**
   * Optional href for the upgrade CTA. When the badge is at or near
   * the cap and an href is supplied, a small "Upgrade" link is
   * rendered next to the chip. Should point at the canonical
   * `/billing` route (or a deep link under it).
   */
  upgradeCtaHref?: string;
  /**
   * Optional override for the percentage threshold that flips the
   * badge into the "near-limit" state. Defaults to 0.8 (80%).
   */
  nearLimitRatio?: number;
  /**
   * Optional aria-label override. By default the component composes a
   * description from `used`, `limit`, and `label` so that screen
   * readers and disabled-button tooltips can reuse the same string.
   */
  ariaLabel?: string;
}

const TONE: Record<
  PlanCapacityBadgeState | "unknown",
  { bg: string; fg: string; border: string; label: string }
> = {
  "within-limit": {
    bg: "#ecfdf5",
    fg: "#065f46",
    border: "#a7f3d0",
    label: "Within plan",
  },
  "near-limit": {
    bg: "#fef3c7",
    fg: "#78350f",
    border: "#fde68a",
    label: "Near plan limit",
  },
  "at-limit": {
    bg: "#fef2f2",
    fg: "#991b1b",
    border: "#fecaca",
    label: "Plan limit reached",
  },
  unknown: {
    bg: "#f1f5f9",
    fg: "#475569",
    border: "#cbd5e1",
    label: "Plan limit unknown",
  },
};

function resolveState(
  used: number,
  limit: number | null,
  nearLimitRatio: number
): PlanCapacityBadgeState | "unknown" {
  if (limit === null || !Number.isFinite(limit)) return "unknown";
  if (limit <= 0) {
    // A zero-capacity plan with any use is at-limit; with zero use,
    // we still surface "at-limit" so callers can disable mutating
    // actions deterministically.
    return "at-limit";
  }
  const usedSafe = Number.isFinite(used) && used > 0 ? used : 0;
  if (usedSafe >= limit) return "at-limit";
  if (usedSafe / limit >= nearLimitRatio) return "near-limit";
  return "within-limit";
}

function chipStyle(
  state: PlanCapacityBadgeState | "unknown"
): CSSProperties {
  const p = TONE[state];
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    whiteSpace: "nowrap",
    lineHeight: 1.4,
  };
}

const UPGRADE_LINK_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textDecoration: "underline",
  color: "#1e3a8a",
};

/**
 * Compose the canonical accessible description for a capacity badge.
 * Exported so disabled-button call sites can reuse the exact same
 * sentence in their `aria-label` / `title` tooltip when they suppress
 * an action because the cap was hit.
 */
export function describePlanCapacity(
  used: number,
  limit: number | null,
  label: string
): string {
  if (limit === null || !Number.isFinite(limit)) {
    return `${used} ${label} used; plan limit unavailable`;
  }
  return `${used} of ${limit} ${label} used`;
}

export function PlanCapacityBadge({
  used,
  limit,
  label,
  upgradeCtaHref,
  nearLimitRatio = 0.8,
  ariaLabel,
}: PlanCapacityBadgeProps) {
  const state = resolveState(used, limit, nearLimitRatio);
  const tone = TONE[state];
  const description = ariaLabel ?? describePlanCapacity(used, limit, label);
  const showUpgrade =
    Boolean(upgradeCtaHref) && (state === "near-limit" || state === "at-limit");

  const countLabel =
    limit === null || !Number.isFinite(limit)
      ? `${used} ${label}`
      : `${used} / ${limit} ${label}`;

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
      aria-label={description}
      title={description}
    >
      <span style={chipStyle(state)} aria-hidden="true">
        <span>{tone.label}</span>
        <span style={{ opacity: 0.7 }}>·</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {countLabel}
        </span>
      </span>
      {showUpgrade && upgradeCtaHref ? (
        <Link
          href={upgradeCtaHref}
          style={UPGRADE_LINK_STYLE}
          aria-label={`Upgrade plan: ${description}`}
        >
          Upgrade
        </Link>
      ) : null}
    </span>
  );
}

export default PlanCapacityBadge;
