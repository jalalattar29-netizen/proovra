/**
 * PHASE R6 — Canonical hub definitions.
 *
 * Bounded per-hub definition: title + subtitle + ≤4 quick actions
 * + member-route-id list + landing-route id. This is the single
 * source of truth for what each operational hub emphasizes.
 *
 * Hard rules (pinned by R6 tests):
 *
 *   1. Each hub has ≤ 4 quick actions. The bound stops feature-
 *      cemetery growth.
 *
 *   2. Every `href` references an EXISTING registered route from
 *      `routeRegistry.ts`. No invented destinations.
 *
 *   3. The `landingRouteId` is the canonical entry point — the
 *      route the hub renders when a user navigates to the hub
 *      surface.
 *
 *   4. `memberRouteIds` is descriptive metadata for tests + future
 *      surfaces; it does NOT change routing or access.
 *
 *   5. Copy uses R4 canonical vocabulary (`TERM_*` constants are
 *      the conceptual reference, though hub copy can be a short
 *      operational phrase rather than a single term).
 */

import type { HubDefinition } from "./types";

export const HUB_DEFINITIONS: Readonly<Record<string, HubDefinition>> = {
  investigation: {
    id: "investigation",
    title: "Investigation Center",
    subtitle:
      "Unified investigation workflows — relationship graph, duplicate review, timelines, and contextual signals.",
    landingRouteId: "investigation.hub",
    quickActions: [
      {
        id: "investigation.timeline",
        label: "Open investigation timeline",
        href: "/investigation/timeline",
        intent: "primary",
      },
      {
        id: "investigation.graph",
        label: "Open relationship graph",
        href: "/investigation/graph",
        intent: "primary",
      },
      {
        id: "investigation.duplicates",
        label: "Review duplicates",
        href: "/investigation/duplicates",
        intent: "secondary",
      },
      {
        id: "investigation.reviewers",
        label: "Open reviewer assignments",
        href: "/investigation/reviewers",
        intent: "secondary",
      },
    ],
    memberRouteIds: [
      "investigation.hub",
      "investigation.timeline",
      "investigation.graph",
      "investigation.duplicates",
      "investigation.relationships",
      "investigation.reviewers",
    ],
  },
  governance: {
    id: "governance",
    title: "Governance Center",
    subtitle:
      "Unified governance workflows — retention posture, lifecycle reviews, governance insights, and policy actions.",
    landingRouteId: "governance.hub",
    quickActions: [
      {
        id: "governance.retention",
        label: "Review retention policy",
        href: "/governance/retention",
        intent: "primary",
      },
      {
        id: "governance.lifecycle",
        label: "Review lifecycle actions",
        href: "/governance/lifecycle",
        intent: "primary",
      },
      {
        id: "governance.analytics",
        label: "Open governance insights",
        href: "/governance/analytics",
        intent: "secondary",
      },
      {
        id: "governance.policy",
        label: "Open governance policy",
        href: "/governance/policy",
        intent: "secondary",
      },
    ],
    memberRouteIds: [
      "governance.hub",
      "governance.retention",
      "governance.lifecycle",
      "governance.destruction",
      "governance.analytics",
      "governance.notifications",
      "governance.policy",
    ],
  },
  reviewer: {
    id: "reviewer",
    title: "Reviewer Center",
    subtitle:
      "Queue-oriented operational workspace — pending reviews, escalations, SLA awareness, and workload focus.",
    landingRouteId: "review.queue",
    quickActions: [
      {
        id: "reviewer.queue",
        label: "Open reviewer queue",
        // Phase Final-Vocab-Alignment — `/reviewer-ops` (the legacy
        // queue index) was retired. The canonical reviewer console
        // is `/review`. `next.config.js` redirects the legacy URL.
        href: "/review",
        intent: "primary",
      },
      {
        id: "reviewer.escalations",
        label: "Review escalations",
        href: "/reviewer-ops/escalations",
        intent: "primary",
      },
      {
        id: "reviewer.sla",
        label: "Check SLA",
        href: "/reviewer-ops/sla",
        intent: "secondary",
      },
    ],
    memberRouteIds: [
      "review.queue",
      "review.escalations",
      "review.sla",
      "review.queue_detail",
    ],
  },
  operations: {
    id: "operations",
    title: "Operations Center",
    subtitle:
      "Operational oversight — system health, runbooks, integrations, observability, and reliability tooling.",
    landingRouteId: "workspace.operations",
    quickActions: [
      {
        id: "operations.observability",
        label: "Open observability",
        href: "/admin/platform/observability",
        intent: "primary",
      },
      {
        id: "operations.runbooks",
        label: "Open runbooks",
        href: "/admin/platform/runbooks",
        intent: "primary",
      },
      {
        id: "operations.integrations",
        label: "Manage integrations",
        href: "/integrations",
        intent: "secondary",
      },
    ],
    memberRouteIds: [
      "workspace.operations",
      "platform.observability",
      "platform.runbooks",
      "platform.reliability",
      "workspace.integrations",
    ],
  },
};

/** Max quick actions allowed per hub (Test pins this). */
export const HUB_QUICK_ACTIONS_MAX = 4;
