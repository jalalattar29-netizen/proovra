"use client";

/**
 * PlanGateBadge — canonical feature/channel-gating badge for plan
 * entitlement indicators across the product.
 *
 * Companion to PlanCapacityBadge:
 *   - PlanCapacityBadge: how much of a plan-limit has been consumed
 *     (used / limit counts).
 *   - PlanGateBadge: whether the current plan unlocks a given feature
 *     at all (capability gate), with a CTA to upgrade if not.
 *
 * Phase 10 UX rule (binding):
 *   - Replaces ad-hoc strings like "PAYG and above" with a single,
 *     consistent component. All gated surfaces use this chip.
 *   - Plan values MUST come from the caller's already-read billing
 *     context (e.g. /v1/platform-context or the billing-context helper
 *     surfaces). This component does NOT fetch or fabricate plan state.
 *   - Upgrade CTAs link to /billing (canonical). Callers may deep-link
 *     under /billing but never to legacy /teams or fake routes.
 *   - Disabled-state CTAs surface a tooltip + aria-label explaining the
 *     gate, so keyboard / screen-reader users see the same reason a
 *     mouse user sees on hover.
 *
 * Vocabulary discipline:
 *   - Plan values describe SUBSCRIPTION TIER, not workspace kind.
 *     Workspace kinds remain PERSONAL | ORGANIZATION elsewhere. Plans
 *     here describe billing tier only (FREE / PAYG / PRO / TEAM /
 *     ENTERPRISE). This component never renders workspace terminology.
 */

import type { CSSProperties } from "react";
import Link from "next/link";

/**
 * Canonical plan-tier vocabulary for gating UX.
 *
 * Ordered from least- to most-capable for plan-comparison purposes.
 * Callers pass `requiredPlan` (the minimum tier that unlocks `feature`)
 * and `currentPlan` (the plan currently held). When `currentPlan` is
 * unknown the component renders a conservative "Plan unknown" state
 * without fabricating an upgrade verdict.
 */
export type PlanTier = "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE";

const PLAN_RANK: Record<PlanTier, number> = {
  FREE: 0,
  PAYG: 1,
  PRO: 2,
  TEAM: 3,
  ENTERPRISE: 4,
};

const PLAN_LABEL: Record<PlanTier, string> = {
  FREE: "Free",
  PAYG: "PAYG",
  PRO: "PRO",
  TEAM: "TEAM",
  ENTERPRISE: "Enterprise",
};

export type PlanGateState = "unlocked" | "locked" | "unknown";

export interface PlanGateBadgeProps {
  /**
   * Short noun describing the gated feature or channel
   * (e.g. "Public verify", "Reviewer portal", "SSO").
   * Used in the chip label and accessible description.
   */
  feature: string;
  /**
   * Minimum plan tier that unlocks `feature`.
   */
  requiredPlan: PlanTier;
  /**
   * The plan currently in effect for the caller's billing context.
   * Pass `null` when the plan is genuinely unknown (e.g. degraded
   * envelope) — the badge renders an "unknown" state instead of
   * pretending the user is on FREE.
   */
  currentPlan: PlanTier | null;
  /**
   * Optional href for the upgrade CTA. Should point at /billing
   * (canonical) or a deep link under it.
   */
  upgradeCtaHref?: string;
  /**
   * Force the badge into a disabled presentation regardless of plan
   * comparison. Use this when the surrounding action button is also
   * disabled (e.g. legal hold, retention freeze) — the badge will
   * reflect that the CTA cannot be taken right now and surface the
   * explanation via tooltip + aria-label.
   */
  disabled?: boolean;
  /**
   * Optional aria-label override. Defaults to a composed description
   * built from `feature`, `requiredPlan`, and `currentPlan` so screen
   * readers and disabled-CTA tooltips can reuse the same sentence.
   */
  ariaLabel?: string;
}

const TONE: Record<
  PlanGateState,
  { bg: string; fg: string; border: string; label: string }
> = {
  unlocked: {
    bg: "#ecfdf5",
    fg: "#065f46",
    border: "#a7f3d0",
    label: "Included in plan",
  },
  locked: {
    bg: "#fef3c7",
    fg: "#78350f",
    border: "#fde68a",
    label: "Requires upgrade",
  },
  unknown: {
    bg: "#f1f5f9",
    fg: "#475569",
    border: "#cbd5e1",
    label: "Plan unknown",
  },
};

function resolveState(
  requiredPlan: PlanTier,
  currentPlan: PlanTier | null
): PlanGateState {
  if (currentPlan === null) return "unknown";
  const required = PLAN_RANK[requiredPlan];
  const current = PLAN_RANK[currentPlan];
  if (!Number.isFinite(required) || !Number.isFinite(current)) {
    return "unknown";
  }
  return current >= required ? "unlocked" : "locked";
}

function chipStyle(state: PlanGateState): CSSProperties {
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

const UPGRADE_LINK_DISABLED_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textDecoration: "underline",
  color: "#94a3b8",
  cursor: "not-allowed",
  pointerEvents: "none",
};

/**
 * Compose the canonical accessible description for a plan-gate badge.
 * Exported so disabled-CTA call sites can reuse the exact same
 * sentence in their `aria-label` / `title` tooltip.
 */
export function describePlanGate(
  feature: string,
  requiredPlan: PlanTier,
  currentPlan: PlanTier | null,
  disabled?: boolean
): string {
  const requiredLabel = PLAN_LABEL[requiredPlan];
  if (currentPlan === null) {
    return `${feature} requires ${requiredLabel} or higher; current plan unavailable`;
  }
  const state = resolveState(requiredPlan, currentPlan);
  const currentLabel = PLAN_LABEL[currentPlan];
  if (disabled) {
    return `${feature} is not available right now (requires ${requiredLabel} or higher; current plan ${currentLabel})`;
  }
  if (state === "unlocked") {
    return `${feature} is included in your ${currentLabel} plan`;
  }
  return `${feature} requires ${requiredLabel} or higher; current plan ${currentLabel}`;
}

export function PlanGateBadge({
  feature,
  requiredPlan,
  currentPlan,
  upgradeCtaHref,
  disabled,
  ariaLabel,
}: PlanGateBadgeProps): JSX.Element {
  const baseState = resolveState(requiredPlan, currentPlan);
  // When `disabled` is forced and the gate would otherwise read
  // "unlocked", we still mark the badge as locked-style so the
  // surrounding disabled CTA reads consistently. We do not fake an
  // "unlocked" badge next to a disabled action.
  const state: PlanGateState =
    disabled && baseState === "unlocked" ? "locked" : baseState;

  const tone = TONE[state];
  const description = ariaLabel ?? describePlanGate(
    feature,
    requiredPlan,
    currentPlan,
    disabled
  );

  const showUpgrade =
    Boolean(upgradeCtaHref) && (state === "locked" || state === "unknown");

  const chipLabel =
    state === "locked"
      ? `${tone.label} · ${PLAN_LABEL[requiredPlan]}`
      : state === "unknown"
        ? tone.label
        : `${tone.label} · ${PLAN_LABEL[requiredPlan]}`;

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
      aria-label={description}
      title={description}
      data-plan-gate-state={state}
      data-plan-gate-feature={feature}
    >
      <span style={chipStyle(state)} aria-hidden="true">
        <span>{chipLabel}</span>
      </span>
      {showUpgrade && upgradeCtaHref ? (
        disabled ? (
          <span
            style={UPGRADE_LINK_DISABLED_STYLE}
            aria-disabled="true"
            aria-label={description}
            title={description}
          >
            Upgrade
          </span>
        ) : (
          <Link
            href={upgradeCtaHref}
            style={UPGRADE_LINK_STYLE}
            aria-label={`Upgrade plan: ${description}`}
          >
            Upgrade
          </Link>
        )
      ) : null}
    </span>
  );
}

export default PlanGateBadge;
