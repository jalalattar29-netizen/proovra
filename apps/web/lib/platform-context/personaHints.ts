/**
 * PHASE 38.2 — Persona-aware discoverability hints.
 *
 * Pure-function library. Returns contextual suggestion hints per
 * persona × surface. Surfaces render them as dismissible callouts
 * so enterprise features stay discoverable without modal spam.
 *
 * Hard rules:
 *
 *   1. UX-only. Hints NEVER unlock a feature. A hint that links to a
 *      capability the user lacks should not appear (callers gate the
 *      callout on `useCan(capabilityKey)` when relevant).
 *   2. Bounded copy. Headline + one-sentence body + one CTA. No
 *      marketing language.
 *   3. Dismissible. Callers persist dismissal via localStorage; the
 *      hint library itself is pure.
 *   4. Operational only. Hints surface enterprise workflows; they
 *      never push billing/upgrade content.
 */

import type { WorkspacePersonaProfile } from "./types";

export type PersonaHintSurface =
  | "dashboard"
  | "cases"
  | "evidence"
  | "reports"
  | "governance"
  | "reviewer-ops";

export type PersonaHint = {
  /** Stable id used for localStorage dismissal keys. */
  id: string;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
  /**
   * Optional capability that gates the hint. Callers should NOT render
   * the hint when `useCan(capabilityKey)` is false.
   */
  capabilityKey?: string;
};

const HINTS: Record<
  WorkspacePersonaProfile,
  Partial<Record<PersonaHintSurface, PersonaHint>>
> = {
  INDIVIDUAL: {
    dashboard: {
      id: "individual.dashboard.complete-setup",
      headline: "Tune your workspace",
      body:
        "Pick a persona in workspace settings to adapt navigation, defaults, and labels to your workflow.",
      ctaLabel: "Set up workspace",
      ctaHref: "/settings/persona",
    },
    evidence: {
      id: "individual.evidence.first-capture",
      headline: "Capture verified evidence",
      body:
        "Use Capture to record media with hashed, signed integrity. Reports generate automatically once evidence is signed.",
      ctaLabel: "Open capture",
      ctaHref: "/capture",
    },
  },
  LAWYER: {
    dashboard: {
      id: "lawyer.dashboard.legal-holds",
      headline: "Legal hold + retention controls",
      body:
        "When matter activity grows, enable legal holds to preserve evidence and tag retention windows.",
      ctaLabel: "Open governance",
      ctaHref: "/governance",
      capabilityKey: "LEGAL_HOLD_PLACE",
    },
    cases: {
      id: "lawyer.cases.custody-timeline",
      headline: "Custody timeline visibility",
      body:
        "Every matter carries a chain-of-custody timeline. Review it before generating verification packages.",
      ctaLabel: "Open evidence",
      ctaHref: "/evidence",
    },
  },
  INSURANCE: {
    dashboard: {
      id: "insurance.dashboard.routing",
      headline: "Routing + reviewer queues",
      body:
        "Configure claim routing so incoming submissions land with the right handler automatically.",
      ctaLabel: "Open reviewer ops",
      ctaHref: "/reviewer-ops",
      capabilityKey: "REVIEWER_OPS_VIEW",
    },
    "reviewer-ops": {
      id: "insurance.reviewer-ops.sla",
      headline: "SLA + escalation tracking",
      body:
        "Set SLA windows on claim types so breaches surface immediately on the operational pressure tile.",
      ctaLabel: "Open SLA settings",
      ctaHref: "/reviewer-ops/sla",
      capabilityKey: "SLA_VIEW",
    },
  },
  INVESTIGATOR: {
    dashboard: {
      id: "investigator.dashboard.relationships",
      headline: "Cross-case relationships",
      body:
        "Link related evidence across cases to surface cross-case intelligence in the dashboard.",
      ctaLabel: "Open investigation",
      ctaHref: "/investigation",
    },
    cases: {
      id: "investigator.cases.timeline",
      headline: "Timeline reconstruction",
      body:
        "Use timeline reconstruction to sequence evidence across multiple capture sessions.",
      ctaLabel: "Open timeline",
      ctaHref: "/investigation/timeline",
    },
  },
  JOURNALIST: {
    dashboard: {
      id: "journalist.dashboard.publication",
      headline: "Publication-ready verification",
      body:
        "Once media is signed, a verification brief is generated that you can publish alongside the story.",
      ctaLabel: "Open evidence",
      ctaHref: "/evidence",
    },
    evidence: {
      id: "journalist.evidence.public-verify",
      headline: "Public verification page",
      body:
        "Each signed record carries a public verify URL — readers can confirm integrity without an account.",
      ctaLabel: "Open verify",
      ctaHref: "/verify",
    },
  },
  ENTERPRISE_COMPLIANCE: {
    dashboard: {
      id: "compliance.dashboard.posture",
      headline: "Governance posture",
      body:
        "Set retention policies and audit-export schedules so compliance posture stays current without manual work.",
      ctaLabel: "Open governance",
      ctaHref: "/governance",
      capabilityKey: "GOVERNANCE_VIEW",
    },
    governance: {
      id: "compliance.governance.retention",
      headline: "Retention + destruction reviews",
      body:
        "Configure retention windows and destruction reviews so legacy evidence is handled per policy.",
      ctaLabel: "Open retention",
      ctaHref: "/governance/retention",
      capabilityKey: "RETENTION_MANAGE",
    },
  },
  ADMIN_OPERATOR: {
    dashboard: {
      id: "admin.dashboard.command-center",
      headline: "Command Center signals",
      body:
        "Queue pressure, incidents, and reviewer saturation update here every refresh cycle. Drill into operational pressure for details.",
      ctaLabel: "Open ops center",
      ctaHref: "/operations",
      capabilityKey: "OPS_CENTER_VIEW",
    },
    "reviewer-ops": {
      id: "admin.reviewer-ops.saturation",
      headline: "Reviewer saturation",
      body:
        "Saturation scores surface reviewers nearing capacity so workload can be rebalanced before SLAs slip.",
      ctaLabel: "Open workload",
      ctaHref: "/reviewer-ops/workload",
      capabilityKey: "REVIEWER_OPS_VIEW",
    },
  },
};

/**
 * Return the persona-appropriate hint for a surface, or `null` if no
 * hint exists for that (persona, surface) pair.
 */
export function resolvePersonaHint(input: {
  persona: WorkspacePersonaProfile;
  surface: PersonaHintSurface;
}): PersonaHint | null {
  return HINTS[input.persona]?.[input.surface] ?? null;
}
