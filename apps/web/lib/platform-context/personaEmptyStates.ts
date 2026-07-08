/**
 * PHASE 38-CLOSURE — Persona-aware empty states.
 *
 * Pure-function lookup. Returns the canonical empty-state copy for a
 * (persona, surface) pair. Surfaces fall back to a sensible default
 * when the persona has no override.
 *
 * Hard rules:
 *
 *   - NEVER hides routes; capabilities decide whether a feature is
 *     reachable. This helper only changes the COPY rendered on the
 *     empty state.
 *   - NEVER fabricates analytics or metrics.
 *   - Strings are bounded. Every value is short, operationally
 *     meaningful, and avoids legal overclaims.
 */

import type { WorkspacePersonaProfile } from "./types";

export type EmptyStateSurface =
  | "cases"
  | "reports"
  | "evidence"
  | "search"
  | "reviewer-ops"
  | "governance"
  | "ops"
  | "home";

export type PersonaEmptyState = {
  title: string;
  body: string;
  primaryCtaLabel: string;
  primaryCtaHref: string;
};

const DEFAULTS: Record<EmptyStateSurface, PersonaEmptyState> = {
  cases: {
    title: "No cases yet",
    body:
      "Create your first case and attach verified evidence to track progress.",
    primaryCtaLabel: "Create a case",
    primaryCtaHref: "/cases?action=create",
  },
  reports: {
    title: "No reports yet",
    body:
      "Reports are generated from signed evidence. Capture or upload evidence to make a report available.",
    primaryCtaLabel: "Open evidence",
    primaryCtaHref: "/evidence",
  },
  evidence: {
    title: "No evidence yet",
    body:
      "Capture or upload media to generate a hashed, signed evidence record.",
    primaryCtaLabel: "Start capture",
    primaryCtaHref: "/capture",
  },
  search: {
    title: "No results",
    body: "Refine the filters or change the active workspace to broaden the search.",
    primaryCtaLabel: "Clear filters",
    primaryCtaHref: "/search",
  },
  "reviewer-ops": {
    title: "Reviewer Operations not yet active",
    body: "Switch into a team workspace to coordinate review assignments and SLAs.",
    primaryCtaLabel: "Switch workspace",
    primaryCtaHref: "/workspaces",
  },
  governance: {
    title: "Governance posture inactive",
    body: "Governance controls activate inside organization workspaces.",
    primaryCtaLabel: "Manage organizations",
    primaryCtaHref: "/organizations",
  },
  ops: {
    title: "No active operational incidents",
    body: "Operational pressure, queue health, and incidents appear here as your team operates.",
    primaryCtaLabel: "Open operations",
    primaryCtaHref: "/operations",
  },
  home: {
    title: "Welcome to PROOVRA",
    body: "Capture, verify, and report on evidence with end-to-end integrity.",
    primaryCtaLabel: "Start capture",
    primaryCtaHref: "/capture",
  },
};

const OVERRIDES: Record<
  WorkspacePersonaProfile,
  Partial<Record<EmptyStateSurface, PersonaEmptyState>>
> = {
  INDIVIDUAL: {
    cases: {
      title: "Start your first case",
      body:
        "Group related evidence into a case so reports and verification can reference them together.",
      primaryCtaLabel: "Create a case",
      primaryCtaHref: "/cases?action=create",
    },
    home: {
      title: "Capture, verify, report",
      body:
        "Use Capture to record media with hashed, signed integrity. Reports are generated automatically once evidence is signed.",
      primaryCtaLabel: "Start capture",
      primaryCtaHref: "/capture",
    },
  },
  LAWYER: {
    cases: {
      title: "Create your first matter",
      body:
        "Attach verified evidence and chain-of-custody timelines to track the matter end-to-end.",
      primaryCtaLabel: "Create a matter",
      primaryCtaHref: "/cases?action=create",
    },
    reports: {
      title: "No evidence reports yet",
      body:
        "Evidence reports surface here once captured material is signed and a report is generated.",
      primaryCtaLabel: "Open evidence library",
      primaryCtaHref: "/evidence",
    },
    governance: {
      title: "Legal hold + retention controls",
      body:
        "Manage legal holds, retention, and destruction reviews from the organization workspace.",
      primaryCtaLabel: "Open governance",
      primaryCtaHref: "/governance",
    },
  },
  INSURANCE: {
    cases: {
      title: "Start a claim",
      body:
        "Open a claim, route to the right handler, and track SLA pressure from the queue.",
      primaryCtaLabel: "Open claims queue",
      primaryCtaHref: "/cases",
    },
    "reviewer-ops": {
      title: "Claims queue is empty",
      body:
        "Routed claims, handler assignments, and SLA breaches will appear here as work arrives.",
      primaryCtaLabel: "Configure routing",
      primaryCtaHref: "/reviewer-ops",
    },
  },
  INVESTIGATOR: {
    cases: {
      title: "Create your first investigation",
      body:
        "Investigations group materials, timelines, and relationships across multiple cases.",
      primaryCtaLabel: "Create an investigation",
      primaryCtaHref: "/cases?action=create",
    },
    evidence: {
      title: "Capture or import materials",
      body:
        "Investigations operate over materials with chain-of-custody and location context preserved.",
      primaryCtaLabel: "Start capture",
      primaryCtaHref: "/capture",
    },
  },
  JOURNALIST: {
    evidence: {
      title: "No media records yet",
      body:
        "Capture or upload media to generate a hash + signature you can publish alongside the story.",
      primaryCtaLabel: "Start capture",
      primaryCtaHref: "/capture",
    },
    reports: {
      title: "No verification briefs yet",
      body:
        "Generate a verification brief from a signed media record to share with editors or readers.",
      primaryCtaLabel: "Open evidence",
      primaryCtaHref: "/evidence",
    },
  },
  ENTERPRISE_COMPLIANCE: {
    governance: {
      title: "Define governance posture",
      body:
        "Set retention, legal-hold, and destruction policies once an organization workspace is active.",
      primaryCtaLabel: "Open governance",
      primaryCtaHref: "/governance",
    },
    cases: {
      title: "No review matters yet",
      body:
        "Open a review matter to bundle audit-relevant evidence with policy attestations.",
      primaryCtaLabel: "Create a review matter",
      primaryCtaHref: "/cases?action=create",
    },
  },
  ADMIN_OPERATOR: {
    ops: {
      title: "Operations Center is quiet",
      body:
        "Queue pressure, incidents, and reviewer saturation will appear here when operational signal arrives.",
      primaryCtaLabel: "Open Command Center",
      primaryCtaHref: "/dashboard",
    },
  },
};

/**
 * Resolve the empty-state copy for a (persona, surface) pair.
 */
export function resolvePersonaEmptyState(input: {
  persona: WorkspacePersonaProfile;
  surface: EmptyStateSurface;
}): PersonaEmptyState {
  const override = OVERRIDES[input.persona]?.[input.surface];
  if (override) return override;
  return DEFAULTS[input.surface];
}
