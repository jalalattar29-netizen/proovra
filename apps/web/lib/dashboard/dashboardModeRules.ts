/**
 * PHASE R3 — Bounded per-mode orchestration rules.
 *
 * The single source of truth for "what does each experience mode
 * emphasize on the dashboard." Every entry is a bounded list that
 * R5/R6 may expand or contract through a deliberate IA decision.
 *
 * RULES (pinned by tests):
 *
 *   1. Quick actions per mode are bounded (max 4).
 *   2. Every quick action `href` points at an EXISTING `app/(app)/`
 *      route. No invented hrefs.
 *   3. Section priority lists reference only canonical section ids
 *      from `CommandCenterEnvelope["sections"]`.
 *   4. Onboarding hints are contextual to the mode — never generic
 *      enterprise emptiness or empty-shell placeholder copy.
 *   5. No mode introduces a route that requires authorization the
 *      user might not have; the action remains a SHORTCUT to an
 *      already-registered route whose own gate decides access.
 */

import type {
  DashboardOnboardingHint,
  DashboardQuickAction,
} from "./types";
import type { WorkspaceExperienceMode } from "../workspace-experience/types";

/**
 * Per-mode section priority. Sections matching the leading ids land
 * first (with `primary` emphasis); the remaining available sections
 * retain canonical order (with `de-emphasized` emphasis after the
 * priority slice).
 */
export const MODE_SECTION_PRIORITY: Record<
  WorkspaceExperienceMode,
  ReadonlyArray<string>
> = {
  PERSONAL: [
    "summary",
    "recentEvidence",
    "caseOperations",
    "pipelineDetail",
    "timeline",
  ],
  ORGANIZATION: [
    "operationalPressure",
    "caseOperations",
    "reviewerOrchestration",
    "pipelineDetail",
    "governancePosture",
  ],
  REVIEW_OPS: [
    "reviewerOrchestration",
    "operationalPressure",
    "queueCongestion",
    "caseOperations",
    "workloadEngine",
  ],
  GOVERNANCE: [
    "governancePosture",
    "auditReadiness",
    "operationalPressure",
    "organizationalIntelligence",
    "caseOperations",
  ],
};

/**
 * Per-mode quick actions. Bounded set of operational shortcuts.
 * Every href is a registered application route — no invented paths.
 */
export const MODE_QUICK_ACTIONS: Record<
  WorkspaceExperienceMode,
  ReadonlyArray<DashboardQuickAction>
> = {
  PERSONAL: [
    {
      id: "personal.capture",
      label: "Capture evidence",
      href: "/capture",
      intent: "primary",
    },
    {
      id: "personal.evidence",
      label: "Review evidence",
      href: "/evidence",
      intent: "secondary",
    },
    {
      id: "personal.reports",
      label: "Continue reports",
      href: "/reports",
      intent: "secondary",
    },
  ],
  ORGANIZATION: [
    {
      id: "org.review",
      label: "Open reviewer queue",
      href: "/reviewer-ops",
      intent: "primary",
    },
    {
      id: "org.escalations",
      label: "Review escalations",
      href: "/reviewer-ops/escalations",
      intent: "primary",
    },
    {
      id: "org.intake",
      label: "Manage intake links",
      href: "/intake-links",
      intent: "secondary",
    },
    {
      id: "org.collaboration",
      label: "Open collaboration",
      href: "/collaboration",
      intent: "secondary",
    },
  ],
  REVIEW_OPS: [
    {
      id: "reviewops.queue",
      label: "Open reviewer queue",
      href: "/reviewer-ops",
      intent: "primary",
    },
    {
      id: "reviewops.escalations",
      label: "Review escalations",
      href: "/reviewer-ops/escalations",
      intent: "primary",
    },
    {
      id: "reviewops.sla",
      label: "Check SLA",
      href: "/reviewer-ops/sla",
      intent: "secondary",
    },
  ],
  GOVERNANCE: [
    {
      id: "gov.posture",
      label: "Review governance posture",
      href: "/governance",
      intent: "primary",
    },
    {
      id: "gov.retention",
      label: "Review retention policy",
      href: "/governance/retention",
      intent: "primary",
    },
    {
      id: "gov.lifecycle",
      label: "Lifecycle reviews",
      href: "/governance/lifecycle",
      intent: "secondary",
    },
  ],
};

/**
 * Per-mode onboarding hint shown when the operator hasn't yet
 * completed setup. Each entry is a single operationally-meaningful
 * action; never generic enterprise emptiness.
 */
export const MODE_ONBOARDING_HINTS: Record<
  WorkspaceExperienceMode,
  DashboardOnboardingHint
> = {
  PERSONAL: {
    label: "Create your first evidence record",
    href: "/capture",
    tone: "positive",
  },
  ORGANIZATION: {
    label: "Configure intake operations",
    href: "/intake-links",
    tone: "neutral",
  },
  REVIEW_OPS: {
    label: "Open the reviewer queue to assign your first workflow",
    href: "/reviewer-ops",
    tone: "neutral",
  },
  GOVERNANCE: {
    label: "Review your workspace's governance posture",
    href: "/governance",
    tone: "neutral",
  },
};
