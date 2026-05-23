/**
 * PHASE 38.4 — Workflow-aware contextual help library.
 *
 * Pure-function lookup. Returns operational help text for a
 * (workflow, surface) pair. Rendered by a small inline help panel on
 * each surface — never as a modal, never as marketing.
 *
 * Hard rules:
 *
 *   1. UX-only. Help text NEVER unlocks a feature.
 *   2. No legal overclaims. No "court-ready", no "guaranteed
 *      admissible", no "100% verified" language.
 *   3. Operational tone only. Two short paragraphs max per entry.
 *   4. Bounded vocabulary. Every (workflow, surface) pair returns a
 *      complete shape — no `undefined` keys at the call site.
 */

import type { WorkflowProfileCode } from "./workflowProfile";

export type HelpSurface =
  | "capture"
  | "evidence"
  | "cases"
  | "reports"
  | "governance"
  | "reviewer-ops"
  | "ops"
  | "teams"
  | "search";

export type WorkflowHelpEntry = {
  /** Short headline rendered above the body. */
  title: string;
  /** One-paragraph body. Operational tone; no legal overclaims. */
  body: string;
};

const DEFAULTS: Record<HelpSurface, WorkflowHelpEntry> = {
  capture: {
    title: "What capture does",
    body:
      "Records are hashed and signed at capture time so the resulting evidence carries an integrity record. The hash + signature are independent of the storage backend; you can verify them later from the public verify page.",
  },
  evidence: {
    title: "Evidence integrity",
    body:
      "Every record carries a SHA-256 hash, a signature, and a custody timeline. Generating a report or verification package projects the current state at that moment; the underlying integrity record stays unchanged.",
  },
  cases: {
    title: "Cases bundle related evidence",
    body:
      "A case (or matter, claim, or investigation depending on your workflow) groups evidence with role-scoped collaboration. Cases do not change the integrity of the underlying evidence.",
  },
  reports: {
    title: "Reports snapshot integrity",
    body:
      "Reports and verification packages snapshot the integrity state at generation time. They are workspace deliverables — they record integrity at the moment of generation and do not assert legal admissibility, authenticity, or 'court-ready' status.",
  },
  governance: {
    title: "Governance controls",
    body:
      "Legal holds, retention windows, and destruction reviews are recorded against evidence and cases. These controls do not change the underlying integrity records; they govern access and lifecycle.",
  },
  "reviewer-ops": {
    title: "Reviewer operations",
    body:
      "Queues route work to reviewers; SLA tracking surfaces breaches; escalations preserve operational continuity. Reviewer actions are audited but do not modify the integrity of the evidence under review.",
  },
  ops: {
    title: "Operations Center",
    body:
      "Operational pressure, queue health, and incidents are aggregated for operator awareness. Acting on an incident is audited; viewing it is not — browse is read-only.",
  },
  teams: {
    title: "Workspace administration",
    body:
      "Workspace administration covers access roles, billing seats, integrations posture, and operational accountability. Every authenticated user has a Personal Space; organizations layer team-scoped access + billing on top. Browse is read-only; explicit invitation and role changes remain audited.",
  },
  search: {
    title: "Operator search",
    body:
      "Operator search spans evidence, workflows, audit events, and cases. Results respect tenant isolation and the actor's capability set — no result here ever bypasses workspace boundaries.",
  },
};

const OVERRIDES: Record<
  WorkflowProfileCode,
  Partial<Record<HelpSurface, WorkflowHelpEntry>>
> = {
  VERIFICATION_DOCUMENTATION: {
    capture: {
      title: "Capture and verify",
      body:
        "Capture records media with hashed, signed integrity. The verification page is automatically reachable once a record is signed; anyone with the link can confirm integrity without an account.",
    },
  },
  LEGAL_CASEWORK: {
    cases: {
      title: "Matters bundle evidence + custody",
      body:
        "A matter groups evidence with chain-of-custody tracking. Open the timeline to review every event recorded against an item before generating a verification package.",
    },
    reports: {
      title: "Evidence reports + verification packages",
      body:
        "Evidence reports summarise the integrity state at the moment of generation. Verification packages bundle the evidence + custody chain for downstream review. Neither asserts legal admissibility — they record integrity.",
    },
  },
  REVIEW_OPERATIONS: {
    "reviewer-ops": {
      title: "Claims + review queues",
      body:
        "Routing distributes incoming submissions to handlers automatically. SLA windows surface breaches on the operational pressure tile; escalations preserve handoff context.",
    },
    cases: {
      title: "Claims at the case level",
      body:
        "Each claim or review matter is its own case. Use the matter-queue filters to surface claims by SLA pressure, governance blockers, or unassigned status.",
    },
  },
  INVESTIGATION_RECONSTRUCTION: {
    cases: {
      title: "Investigations track relationships",
      body:
        "Investigations link evidence across multiple cases. Use the timeline reconstruction view to sequence materials and surface cross-case relationships.",
    },
    evidence: {
      title: "Materials + context",
      body:
        "Capture preserves location, timing, and contextual metadata where available. The relationship intelligence surface aggregates these signals across the workspace.",
    },
  },
  MEDIA_VERIFICATION: {
    reports: {
      title: "Verification briefs",
      body:
        "A verification brief is a publication-ready snapshot of integrity. Each brief carries a public verify link; readers can confirm hashes + signatures without an account.",
    },
    evidence: {
      title: "Media records",
      body:
        "Media records carry the same hash + signature as any other evidence. The public verify page is the canonical place to share integrity proof with readers and editors.",
    },
  },
  GOVERNANCE_COMPLIANCE: {
    governance: {
      title: "Governance posture",
      body:
        "Retention windows, legal holds, and destruction reviews are recorded against evidence. Audit posture aggregates governance signal across the organization workspace.",
    },
    reports: {
      title: "Compliance reports",
      body:
        "Compliance reports aggregate governance signal — retention pressure, legal-hold backlog, audit backlog. They snapshot the posture at generation time.",
    },
  },
  OPERATIONAL_ADMINISTRATION: {
    ops: {
      title: "Command Center signals",
      body:
        "Operational pressure aggregates queue depth, SLA breaches, incident counts, and reviewer saturation. Drill into a section for tenant-scoped detail.",
    },
    "reviewer-ops": {
      title: "Reviewer saturation",
      body:
        "Saturation scores surface reviewers nearing capacity. Use the workload view to rebalance assignments before SLAs slip.",
    },
  },
};

/**
 * Return the workflow-aware help entry for a surface, or the canonical
 * default if the workflow has no override.
 */
export function resolveWorkflowHelp(input: {
  workflow: WorkflowProfileCode;
  surface: HelpSurface;
}): WorkflowHelpEntry {
  const override = OVERRIDES[input.workflow]?.[input.surface];
  if (override) return override;
  return DEFAULTS[input.surface];
}
