/**
 * PHASE 38.6 — Canonical route registry.
 *
 * One canonical record per product route. This is the SOURCE OF TRUTH
 * for:
 *
 *   - route existence (which routes the app knows about)
 *   - required capabilities (which capability keys unlock the route)
 *   - active-space requirements (PERSONAL_OR_ORG, ORGANIZATION_ONLY,
 *     NONE)
 *   - fallback behavior when access is denied
 *   - workflow tags (drive ordering / emphasis, NOT access)
 *   - All Tools surface visibility
 *
 * Hard rules pinned by tests:
 *
 *   1. Workflow profiles never appear as `requiredCapabilities`. They
 *      drive `workflowTags` only.
 *   2. `advancedByDefault: true` demotes a route to More/Advanced for
 *      workflows that don't tag it — but the route remains reachable.
 *   3. Capability-allowed routes are reachable from at least one
 *      navigation surface (sidebar OR All Tools OR command palette).
 *   4. Account-tier routes (settings, billing, pricing) declare
 *      `requiredActiveSpace: "NONE"` so they NEVER hide on workspace
 *      issues.
 */

import type { CapabilityKey } from "../platform-context/types";

export const ROUTE_DOMAINS = [
  "PUBLIC",
  "ACCOUNT",
  "PERSONAL_WORKSPACE",
  "ORGANIZATION_WORKSPACE",
  "TEAM_ONLY",
  "GOVERNANCE",
  "REVIEW_OPERATIONS",
  "OPS",
  "PLATFORM_ADMIN",
] as const;
export type RouteDomain = (typeof ROUTE_DOMAINS)[number];

export const REQUIRED_ACTIVE_SPACES = [
  "NONE",
  "PERSONAL_OR_ORG",
  "ORGANIZATION_ONLY",
  "PLATFORM_ADMIN",
] as const;
export type RequiredActiveSpace = (typeof REQUIRED_ACTIVE_SPACES)[number];

export const FALLBACK_BEHAVIORS = [
  "LOAD",
  "DEGRADED",
  "REQUEST_ACCESS",
  "CREATE_ORG",
  "UPGRADE",
  "HIDDEN_IF_NO_CAPABILITY",
] as const;
export type FallbackBehavior = (typeof FALLBACK_BEHAVIORS)[number];

export type RouteDefinition = {
  /** Stable id used in tests + nav + analytics. */
  id: string;
  /** App route path (Next.js). */
  href: string;
  /** Operator-facing label. */
  label: string;
  /** Short, operationally-toned description. */
  description: string;
  domain: RouteDomain;
  /**
   * Capability keys the actor must have to USE the route. Empty array
   * means "no capability check beyond the active-space requirement".
   * If any required capability is missing, the access resolver applies
   * `fallbackBehavior` (typically `REQUEST_ACCESS`).
   */
  requiredCapabilities: ReadonlyArray<CapabilityKey>;
  requiredActiveSpace: RequiredActiveSpace;
  fallbackBehavior: FallbackBehavior;
  /**
   * Workflow tags that PRIORITIZE the route in the sidebar / dashboard.
   * NEVER used as a gate by the access resolver.
   */
  workflowTags: ReadonlyArray<string>;
  /** When true, the route renders under More/Advanced by default. */
  advancedByDefault: boolean;
  /** When true, the command palette returns this route as a result. */
  commandPaletteVisible: boolean;
  /** When true, the All Tools surface lists this route. */
  allToolsVisible: boolean;
  /** When true, the sidebar may render this route directly. */
  sidebarEligible: boolean;
};

/**
 * Canonical product routes. Additive — extend this list when adding new
 * routes. Each entry is a single source of truth that nav, page gates,
 * and All Tools all read from.
 */
export const ROUTE_REGISTRY: ReadonlyArray<RouteDefinition> = [
  // ---------------------------------------------------------------------------
  // ACCOUNT-tier: never hidden by workspace issues.
  // ---------------------------------------------------------------------------
  {
    id: "account.settings",
    href: "/settings",
    label: "Account settings",
    description: "Profile, identity, sessions, security, notifications.",
    domain: "ACCOUNT",
    requiredCapabilities: ["ACCOUNT_SETTINGS_VIEW"],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",
    workflowTags: [],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.billing",
    href: "/billing",
    label: "Billing",
    description: "Account-tier plan, invoices, payment methods.",
    domain: "ACCOUNT",
    requiredCapabilities: ["ACCOUNT_BILLING_VIEW"],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",
    workflowTags: [],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.persona",
    href: "/settings/persona",
    label: "Workflow profile",
    description: "Choose workflows that personalize layout and defaults.",
    domain: "ACCOUNT",
    requiredCapabilities: ["ACCOUNT_SETTINGS_VIEW"],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",
    workflowTags: [],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Phase A.1 — Operational cohesion: register the Phase 2.7X Stage 3+4+5
  // Organization surfaces in the canonical route registry. They were
  // intentionally NOT registered when the Stage 3 surface first shipped
  // ("reachable only by URL for now" per the Stage 3 readiness doc).
  // Registration here gives them the same PageRouteGate / loading /
  // denied / command-palette / discoverability treatment every other
  // canonical surface gets. Sidebar promotion remains OFF — the
  // existing `admin.teams` Workspace Administration index is still the
  // primary entry point for org management, matching the dual-read
  // discipline the Stage 3 readiness doc established. Command-palette
  // (cmd-K) + deep links from CommandCenter are the discoverability
  // path for power users.
  {
    id: "account.organizations",
    href: "/organizations",
    label: "Organizations",
    description:
      "Organizations you belong to (governance, members, workspaces, audit).",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",
    workflowTags: [],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "account.organization-detail",
    href: "/organizations/:id",
    label: "Organization detail",
    description: "Members, workspaces, pending invites, and audit timeline.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",
    workflowTags: [],
    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "account.org-invite-accept",
    href: "/org-invites/:token/accept",
    label: "Accept organization invite",
    description:
      "Accept an invitation token issued by an organization administrator.",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",
    workflowTags: [],
    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  // Phase C — Operational Inbox. Caller-scoped unified attention
  // stream. Domain ACCOUNT because it's identity-level, not workspace-
  // scoped; the underlying inbox endpoint already filters to data the
  // caller is authorized to see. Command-palette eligible so power
  // users can jump straight there.
  {
    id: "account.inbox",
    href: "/inbox",
    label: "Inbox",
    description:
      "Operational items that require your attention (pending invites, governance events, admin signals).",
    domain: "ACCOUNT",
    requiredCapabilities: [],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",
    workflowTags: [],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },

  // ---------------------------------------------------------------------------
  // Personal-OR-org workspace surfaces.
  // ---------------------------------------------------------------------------
  {
    id: "workspace.home",
    href: "/home",
    label: "Home",
    description: "Workspace overview and quick actions.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["DASHBOARD_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: [
      "VERIFICATION_DOCUMENTATION",
      "LEGAL_CASEWORK",
      "REVIEW_OPERATIONS",
      "INVESTIGATION_RECONSTRUCTION",
      "MEDIA_VERIFICATION",
      "GOVERNANCE_COMPLIANCE",
      "OPERATIONAL_ADMINISTRATION",
    ],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.capture",
    href: "/capture",
    label: "Capture",
    description: "Record media with hashed, signed integrity.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_CAPTURE"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: [
      "VERIFICATION_DOCUMENTATION",
      "INVESTIGATION_RECONSTRUCTION",
      "MEDIA_VERIFICATION",
    ],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.evidence",
    href: "/evidence",
    label: "Evidence",
    description: "Browse and manage evidence records.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: [
      "VERIFICATION_DOCUMENTATION",
      "LEGAL_CASEWORK",
      "INVESTIGATION_RECONSTRUCTION",
      "MEDIA_VERIFICATION",
    ],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.cases",
    href: "/cases",
    label: "Cases",
    description:
      "Group evidence into cases, matters, claims, or investigations.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["CASES_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["LEGAL_CASEWORK", "REVIEW_OPERATIONS"],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.reports",
    href: "/reports",
    label: "Reports",
    description: "Generated report snapshots and verification packages.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["REPORTS_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["LEGAL_CASEWORK", "MEDIA_VERIFICATION"],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.search",
    href: "/search",
    label: "Search",
    description: "Operator search across evidence, workflows, audit events.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["SEARCH_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: [
      "INVESTIGATION_RECONSTRUCTION",
      "VERIFICATION_DOCUMENTATION",
    ],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.notifications",
    href: "/notifications",
    label: "Notifications",
    description: "Workspace delivery log + retry actions.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["SETTINGS_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.integrations",
    href: "/integrations",
    label: "Integrations",
    description: "API keys and webhook endpoints for this workspace.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["INTEGRATIONS_MANAGE"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.intake_links",
    href: "/intake-links",
    label: "Intake links",
    description: "Create and manage workflow intake links for external submissions.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["INTAKE_LINKS_MANAGE"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["LEGAL_CASEWORK", "REVIEW_OPERATIONS"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.workflows",
    href: "/workflows",
    label: "Workflows",
    description: "Workflow instances and templates active in this workspace.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["LEGAL_CASEWORK", "REVIEW_OPERATIONS"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.security_center",
    href: "/security-center",
    label: "Security Center",
    description: "MFA policy, trusted devices, session revocations.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["SECURITY_CENTER_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "platform.runbooks",
    href: "/ops/runbooks",
    label: "Runbooks",
    description: "Operator runbook catalog for incidents and recovery.",
    domain: "OPS",
    requiredCapabilities: ["RUNBOOKS_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "review.escalations",
    href: "/reviewer-ops/escalations",
    label: "Escalations",
    description: "Escalation lifecycle: acknowledge, reassign, resolve, suppress.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["ESCALATIONS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",
    workflowTags: ["REVIEW_OPERATIONS", "OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.policy",
    href: "/governance/policy",
    label: "Governance policy",
    description: "Preservation, SLA, and step-up enforcement policies.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["GOVERNANCE_ACT"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",
    workflowTags: ["GOVERNANCE_COMPLIANCE", "OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.analytics",
    href: "/governance/analytics",
    label: "Governance insights",
    description: "Bounded compliance metrics: lifecycle, retention, drift, reconciliation runs.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",
    workflowTags: ["GOVERNANCE_COMPLIANCE"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.lifecycle",
    href: "/governance/lifecycle",
    label: "Lifecycle",
    description: "Evidence lifecycle, retention triggers, archival events.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["LIFECYCLE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",
    workflowTags: ["GOVERNANCE_COMPLIANCE"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.destruction",
    href: "/governance/destruction",
    label: "Destruction reviews",
    description: "Pending destruction reviews, dispositions, audit records.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["RETENTION_MANAGE"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",
    workflowTags: ["GOVERNANCE_COMPLIANCE"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.notifications",
    href: "/governance/notifications",
    label: "Governance notifications",
    description: "Governance event subscriptions and notification routing.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",
    workflowTags: ["GOVERNANCE_COMPLIANCE"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "platform.observability",
    href: "/ops/observability",
    label: "Observability",
    description: "Runtime metrics + firing alerts.",
    domain: "OPS",
    requiredCapabilities: ["OBSERVABILITY_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "review.queue_detail",
    href: "/reviewer-ops/queue",
    label: "Review workspace",
    description: "Per-review workspace: lifecycle, SLA, escalation, action surface.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",
    workflowTags: ["REVIEW_OPERATIONS"],
    advancedByDefault: true,
    // Detail page reached from the queue — not listed independently in
    // discoverability surfaces.
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },
  {
    id: "workspace.communications",
    href: "/communications",
    label: "Communications",
    description: "Workspace communications and external messaging activity.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["REVIEW_OPERATIONS", "LEGAL_CASEWORK"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "workspace.intelligence",
    href: "/intelligence",
    label: "Intelligence",
    description: "Reviewer-and-above intelligence operations console.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["INVESTIGATION_RECONSTRUCTION", "MEDIA_VERIFICATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "investigation.timeline",
    href: "/investigation/timeline",
    label: "Investigation timeline",
    description: "Reconstructed timeline view across signals and evidence.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["INVESTIGATION_RECONSTRUCTION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "investigation.relationships",
    href: "/investigation/relationships",
    label: "Investigation relationships",
    description: "Evidence relationship inspector and cross-case mapping.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["INVESTIGATION_RECONSTRUCTION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "platform.reliability",
    href: "/operations/reliability",
    label: "Reliability operations",
    description: "Upload pipeline, session-state recovery, queue policy summaries.",
    domain: "OPS",
    requiredCapabilities: ["OPS_CENTER_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "platform.media_graph",
    href: "/ops/media-graph",
    label: "Media intelligence ops",
    description: "Media intelligence + investigation graph operational metrics.",
    domain: "OPS",
    requiredCapabilities: ["OBSERVABILITY_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "workspace.collaboration",
    href: "/collaboration",
    label: "Collaboration",
    description: "Reviewer-and-above discussion threads across the workspace.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["REVIEW_OPERATIONS", "LEGAL_CASEWORK"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "dashboard.api_keys",
    href: "/dashboard/api-keys",
    label: "API keys",
    description: "Workspace API keys and rate-limit settings.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["SETTINGS_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "dashboard.quotas",
    href: "/dashboard/quotas",
    label: "Quotas & usage",
    description: "Account quotas, usage breakdown, and reset windows.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["DASHBOARD_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "dashboard.insights",
    href: "/dashboard/insights",
    label: "Operational insights",
    description: "Workspace operational analytics and distribution metrics.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["DASHBOARD_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "dashboard.batch_analysis",
    href: "/dashboard/batch-analysis",
    label: "Batch analysis",
    description: "Batch processing jobs and queue status.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["DASHBOARD_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "investigation.graph",
    href: "/investigation/graph",
    label: "Investigation graph",
    description: "Graph explorer for evidence relationships.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["INVESTIGATION_RECONSTRUCTION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "investigation.duplicates",
    href: "/investigation/duplicates",
    label: "Duplicate review",
    description: "Detect and review duplicate evidence across the workspace.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["INVESTIGATION_RECONSTRUCTION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "investigation.reviewers",
    href: "/investigation/reviewers",
    label: "Reviewer intelligence",
    description: "Reviewer intelligence console — analyst workload + signal context.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["INVESTIGATION_RECONSTRUCTION", "REVIEW_OPERATIONS"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "investigation.hub",
    href: "/investigation",
    label: "Investigation overview",
    description: "Signals, recent graph activity, queue health.",
    domain: "PERSONAL_WORKSPACE",
    requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "DEGRADED",
    workflowTags: ["INVESTIGATION_RECONSTRUCTION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },

  // ---------------------------------------------------------------------------
  // ORGANIZATION-only operator surfaces.
  // ---------------------------------------------------------------------------
  {
    id: "review.queue",
    href: "/reviewer-ops",
    label: "Reviewer Operations",
    description: "Routing queues, SLA tracking, escalations.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["REVIEWER_OPS_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",
    workflowTags: ["REVIEW_OPERATIONS", "OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "review.sla",
    href: "/reviewer-ops/sla",
    label: "SLA tracking",
    description: "SLA windows + breach signals.",
    domain: "REVIEW_OPERATIONS",
    requiredCapabilities: ["SLA_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",
    workflowTags: ["REVIEW_OPERATIONS"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.hub",
    href: "/governance",
    label: "Governance",
    description: "Legal holds, retention, audit posture, policy workflows.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["GOVERNANCE_VIEW"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "CREATE_ORG",
    workflowTags: ["GOVERNANCE_COMPLIANCE", "LEGAL_CASEWORK"],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "governance.retention",
    href: "/governance/retention",
    label: "Retention",
    description: "Retention windows and destruction reviews.",
    domain: "GOVERNANCE",
    requiredCapabilities: ["RETENTION_MANAGE"],
    requiredActiveSpace: "ORGANIZATION_ONLY",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["GOVERNANCE_COMPLIANCE"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  {
    id: "platform.ops_center",
    href: "/ops",
    label: "Operations Center",
    description: "Operational pressure, queue health, incidents.",
    domain: "OPS",
    requiredCapabilities: ["OPS_CENTER_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: true,
  },
  // Phase E3 — Operational Automation Foundation. Lives UNDER the
  // Operations Center hub (`/ops/automation`), NOT as a root nav item.
  // No new root entries are introduced — the 32.8 canonical primaries
  // remain bounded at 6.
  {
    id: "platform.automation",
    href: "/ops/automation",
    label: "Automation rules",
    description:
      "Bounded operational automation: trigger + action rules with audit history.",
    domain: "OPS",
    requiredCapabilities: ["AUTOMATION_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  // Phase E4 — Bounded operational analytics. Lives UNDER the Operations
  // Center hub (`/ops/analytics`), NOT as a root nav item. The 32.8
  // canonical primaries remain bounded at 6. Read-only surface; every
  // metric is source-traceable to a real Prisma model, never fabricated.
  {
    id: "platform.analytics",
    href: "/ops/analytics",
    label: "Operational analytics",
    description:
      "Bounded operational analytics: real counts from real tables. No fake metrics, no AI predictions, no legal/admissibility scores.",
    domain: "OPS",
    requiredCapabilities: ["ANALYTICS_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG",
    fallbackBehavior: "REQUEST_ACCESS",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },
  {
    id: "admin.teams",
    href: "/teams",
    label: "Workspaces",
    description: "Personal space + organizations management.",
    domain: "ACCOUNT",
    requiredCapabilities: ["TEAM_VIEW"],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",
    workflowTags: [],
    advancedByDefault: false,
    commandPaletteVisible: true,
    allToolsVisible: true,
    sidebarEligible: false,
  },

  // ---------------------------------------------------------------------------
  // Platform-admin only.
  // ---------------------------------------------------------------------------
  {
    id: "platform.admin",
    href: "/admin",
    label: "Platform admin",
    description: "Platform-level administration (PLATFORM_ADMIN only).",
    domain: "PLATFORM_ADMIN",
    requiredCapabilities: ["PLATFORM_ADMIN"],
    requiredActiveSpace: "PLATFORM_ADMIN",
    fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",
    workflowTags: ["OPERATIONAL_ADMINISTRATION"],
    advancedByDefault: true,
    commandPaletteVisible: false,
    allToolsVisible: false,
    sidebarEligible: false,
  },

  // ---------------------------------------------------------------------------
  // The All Tools surface itself.
  // ---------------------------------------------------------------------------
  {
    id: "workspace.tools",
    href: "/tools",
    label: "All Tools",
    description: "Searchable index of every product surface.",
    domain: "ACCOUNT",
    requiredCapabilities: ["ACCOUNT_SETTINGS_VIEW"],
    requiredActiveSpace: "NONE",
    fallbackBehavior: "LOAD",
    workflowTags: [],
    advancedByDefault: true,
    commandPaletteVisible: true,
    allToolsVisible: false, // self-reference; doesn't list itself
    sidebarEligible: false,
  },
];

/**
 * Lookup helper. Returns null for unknown ids.
 */
export function getRouteDefinition(id: string): RouteDefinition | null {
  return ROUTE_REGISTRY.find((r) => r.id === id) ?? null;
}
