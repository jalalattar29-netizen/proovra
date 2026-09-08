"use client";

/**
 * PROOVRA Phase 10 — PlanLimitBadge.
 *
 * Small, additive plan-aware chip used by /collaboration-teams pages.
 * Renders a labelled pill ("PRO plan: 1 of 2 teams used") with a
 * tooltip and, when at/over the cap, an inline "Upgrade" link pointing
 * to the canonical billing surface (`/billing`).
 *
 * Design rules:
 *   - Pure presentational. No fetches, no envelope reads. Callers pass
 *     `current`/`max` values they already resolved from the canonical
 *     platform-context envelope.
 *   - Team here is the COLLABORATION TEAM product. This chip never
 *     renders fake workspace terminology and never references the
 *     legacy fake-kind phrase that conflated the Team product with
 *     a workspace.
 *   - Strong types. No `any`, no string overloading. `max` may be a
 *     concrete number or the literal `"unlimited"` so callers can
 *     model ENTERPRISE-tier "no cap" surfaces honestly.
 */

import Link from "next/link";
import type { CSSProperties } from "react";

export type PlanLimitBadgeKind =
  | "TEAMS_USED"
  | "MEMBERS_USED"
  | "GUESTS_USED"
  | "SMS_STATUS"
  | "GUEST_STATUS";

export interface PlanLimitBadgeProps {
  /** Which capacity surface this chip represents. Drives the noun label. */
  kind: PlanLimitBadgeKind;
  /** Current usage count. */
  current: number;
  /**
   * Plan-allowed maximum. Pass the literal string `"unlimited"` when the
   * active plan does not enforce a numeric cap on this surface.
   */
  max: number | "unlimited";
  /**
   * Optional plan label (e.g. "PRO", "TEAM"). When present the chip's
   * accessible description starts with `${planLabel} plan:` to match
   * the visual prefix.
   */
  planLabel?: string;
}

const KIND_NOUNS: Record<PlanLimitBadgeKind, string> = {
  TEAMS_USED: "teams used",
  MEMBERS_USED: "members used",
  GUESTS_USED: "guests used",
  SMS_STATUS: "SMS invites",
  GUEST_STATUS: "guests",
};

/**
 * INLINE METADATA, NOT A CHIP (§2).
 *
 * This was a filled capsule — 999px radius, tinted background, its own border
 * — sitting beside real buttons in a page header, where it read as a control
 * somebody could press. It is a FACT about the workspace, so it is rendered as
 * text: the plan prefix in the muted label ink, the capacity itself in the
 * canonical success green, and red only when the cap is actually reached.
 *
 * Every colour is a canonical token. The numbers, the noun and the accessible
 * label are unchanged, and so is the Upgrade link that appears at the cap.
 */
function capacityTextStyle(atLimit: boolean): CSSProperties {
  return {
    fontSize: "0.78rem",
    fontWeight: 600,
    letterSpacing: "0.01em",
    color: atLimit ? "var(--error, #DC2626)" : "var(--success-standard, #15803D)",
    whiteSpace: "nowrap",
    lineHeight: 1.4,
    fontVariantNumeric: "tabular-nums",
  };
}

const PLAN_PREFIX_STYLE: CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "var(--app-ink-secondary, #667085)",
  whiteSpace: "nowrap",
};

const UPGRADE_LINK_STYLE: CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 600,
  textDecoration: "underline",
  color: "#1e3a8a",
  whiteSpace: "nowrap",
};

function isAtLimit(current: number, max: number | "unlimited"): boolean {
  if (max === "unlimited") return false;
  if (!Number.isFinite(max) || max <= 0) return current >= 0;
  return current >= max;
}

function composeLabel(props: PlanLimitBadgeProps): string {
  const noun = KIND_NOUNS[props.kind];
  const planPrefix = props.planLabel ? `${props.planLabel} plan: ` : "";
  if (props.max === "unlimited") {
    return `${planPrefix}${props.current} ${noun} (unlimited)`;
  }
  return `${planPrefix}${props.current} of ${props.max} ${noun}`;
}

/** The capacity half alone — what the accessible label says after the plan. */
function composeCapacity(props: PlanLimitBadgeProps): string {
  const noun = KIND_NOUNS[props.kind];
  return props.max === "unlimited"
    ? `${props.current} ${noun} (unlimited)`
    : `${props.current} of ${props.max} ${noun}`;
}

export function PlanLimitBadge(props: PlanLimitBadgeProps): JSX.Element {
  const atLimit = isAtLimit(props.current, props.max);
  const label = composeLabel(props);
  const testid = `plan-limit-badge-${props.kind.toLowerCase()}`;

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
      data-testid={testid}
      data-at-limit={atLimit ? "true" : "false"}
      aria-label={label}
      title={label}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", gap: 5, alignItems: "baseline" }}>
        {props.planLabel ? (
          <span style={PLAN_PREFIX_STYLE}>{props.planLabel} plan ·</span>
        ) : null}
        <span style={capacityTextStyle(atLimit)} data-capacity-text>
          {composeCapacity(props)}
        </span>
      </span>
      {atLimit ? (
        <Link
          href="/billing"
          style={UPGRADE_LINK_STYLE}
          aria-label={`Upgrade plan: ${label}`}
          data-testid={`${testid}-upgrade`}
        >
          Upgrade
        </Link>
      ) : null}
    </span>
  );
}

export default PlanLimitBadge;
