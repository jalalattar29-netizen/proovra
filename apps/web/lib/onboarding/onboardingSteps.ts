/**
 * PHASE R7 — Bounded per-mode onboarding step sequences.
 *
 * The single source of truth for "what is the canonical setup
 * journey for an operator in each experience mode?". Each entry is
 * a bounded list (≤5 steps per mode) of action-oriented next-steps
 * pointing at EXISTING registered routes.
 *
 * Hard rules (pinned by R7 tests):
 *
 *   1. Each mode has 3–5 steps. Bounded; no checklist explosion.
 *
 *   2. Every step `href` references an EXISTING `app/(app)/` route.
 *      No invented destinations.
 *
 *   3. Step labels use R4 canonical vocabulary — operational,
 *      calm, no marketing fluff, no developer slang.
 *
 *   4. Personal sequences emphasize capture/evidence/reports/intake.
 *      Organization sequences emphasize workspace/team/intake/queues/
 *      governance. Reviewer + Governance contexts emphasize their
 *      hub workflows.
 *
 *   5. Hub-aware: organization / reviewer / governance sequences
 *      consume R6 hub vocabulary (queues, escalations, retention,
 *      lifecycle) so onboarding leads naturally into hub workflows.
 */

import type { OnboardingStep } from "./types";
import type { WorkspaceExperienceMode } from "../workspace-experience/types";

/**
 * Per-mode bounded onboarding sequence. Sequences are PRESENTATION
 * data only; capability checks remain in `resolveRouteAccess` at the
 * destination route. The resolver never filters by capability — the
 * step always appears (the destination's PageRouteGate handles
 * unauthorized clicks).
 */
export const ONBOARDING_STEPS_BY_MODE: Record<
  WorkspaceExperienceMode,
  ReadonlyArray<OnboardingStep>
> = {
  PERSONAL: [
    {
      id: "personal.capture-first-evidence",
      label: "Create your first evidence record",
      href: "/capture",
      intent: "primary",
    },
    {
      id: "personal.review-recent-evidence",
      label: "Review your recent evidence",
      href: "/evidence",
      intent: "secondary",
    },
    {
      id: "personal.generate-report",
      label: "Generate or view a report",
      href: "/reports",
      intent: "secondary",
    },
    // Phase IA-cleanup — the standalone /collaboration page was
    // retired (now redirects to /inbox). The personal-mode onboarding
    // step now points operators at the canonical attention center
    // where mentions + assigned discussion threads + governance items
    // surface. Step id is preserved so analytics + persona-priority
    // tests that reference it by id stay green; href + label updated
    // to canonical destinations.
    {
      id: "personal.collaboration-basics",
      label: "Check your inbox",
      href: "/inbox",
      intent: "secondary",
    },
    {
      id: "personal.intake-link",
      label: "Set up an intake link (optional)",
      href: "/intake-links",
      intent: "secondary",
    },
  ],
  ORGANIZATION: [
    {
      id: "org.configure-workspace-profile",
      label: "Configure your workspace profile",
      href: "/settings/persona",
      intent: "primary",
    },
    {
      id: "org.invite-collaborators",
      label: "Invite collaborators",
      href: "/teams",
      intent: "primary",
    },
    {
      id: "org.configure-intake-links",
      label: "Configure intake operations",
      href: "/intake-links",
      intent: "secondary",
    },
    {
      id: "org.review-queues",
      label: "Review queues and escalations",
      // Phase Final-Vocab-Alignment — canonical reviewer console.
      href: "/review",
      intent: "secondary",
    },
    {
      id: "org.configure-governance",
      label: "Configure governance and retention",
      href: "/governance",
      intent: "secondary",
    },
  ],
  REVIEW_OPS: [
    {
      id: "reviewer.open-queue",
      label: "Open the reviewer queue",
      // Phase Final-Vocab-Alignment — canonical reviewer console.
      href: "/review",
      intent: "primary",
    },
    {
      id: "reviewer.triage-escalations",
      label: "Triage escalations",
      href: "/reviewer-ops/escalations",
      intent: "primary",
    },
    {
      id: "reviewer.check-sla",
      label: "Check SLA",
      href: "/reviewer-ops/sla",
      intent: "secondary",
    },
  ],
  GOVERNANCE: [
    {
      id: "governance.review-retention",
      label: "Review retention posture",
      href: "/governance/retention",
      intent: "primary",
    },
    {
      id: "governance.open-lifecycle",
      label: "Open lifecycle reviews",
      href: "/governance/lifecycle",
      intent: "primary",
    },
    {
      id: "governance.configure-policy",
      label: "Configure governance policy",
      href: "/governance/policy",
      intent: "secondary",
    },
  ],
};

/** Max bounded sequence length per mode. */
export const ONBOARDING_STEPS_MAX_PER_MODE = 5;

/** Min bounded sequence length per mode (sanity). */
export const ONBOARDING_STEPS_MIN_PER_MODE = 3;
