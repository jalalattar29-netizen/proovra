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

function chipStyle(atLimit: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: "0.78rem",
    fontWeight: 600,
    letterSpacing: "0.02em",
    background: atLimit ? "rgba(186,80,80,0.12)" : "rgba(62,96,99,0.10)",
    color: atLimit ? "#7c2d2d" : "#3e6063",
    border: `1px solid ${
      atLimit ? "rgba(186,80,80,0.30)" : "rgba(79,112,107,0.20)"
    }`,
    whiteSpace: "nowrap",
    lineHeight: 1.4,
  };
}

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
      <span style={chipStyle(atLimit)} aria-hidden="true">
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{label}</span>
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
