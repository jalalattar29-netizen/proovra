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
];
export const REQUIRED_ACTIVE_SPACES = [
    "NONE",
    "PERSONAL_OR_ORG",
    "ORGANIZATION_ONLY",
    "PLATFORM_ADMIN",
];
export const FALLBACK_BEHAVIORS = [
    "LOAD",
    "DEGRADED",
    "REQUEST_ACCESS",
    "CREATE_ORG",
    "UPGRADE",
    "HIDDEN_IF_NO_CAPABILITY",
];
/**
 * Canonical product routes. Additive — extend this list when adding new
 * routes. Each entry is a single source of truth that nav, page gates,
 * and All Tools all read from.
 */
export const ROUTE_REGISTRY = [
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
        description: "Organizations you belong to (governance, members, workspaces, audit).",
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
        description: "Accept an invitation token issued by an organization administrator.",
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
        description: "Operational items that require your attention (pending invites, governance events, admin signals).",
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
        description: "Group evidence into cases, matters, claims, or investigations.",
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
    // Final Closure Remediation Part A — MfaRecoveryRequestApproval was
    // HARD_TO_FIND: backend service + UI page existed but no registry
    // entry, no command-palette entry, only a deep link from /settings/
    // security. Now a first-class route so cmd-K + All Tools both
    // surface it. `sidebarEligible: false` because /security-center is
    // already in the sidebar — the parent page now links to this
    // console with an explicit "Open MFA recovery console" button.
    {
        id: "security_center.mfa_recovery",
        href: "/security-center/mfa-recovery",
        label: "MFA recovery approvals",
        description: "Approve or reject member MFA recovery requests with full audit history.",
        domain: "ORGANIZATION_WORKSPACE",
        requiredCapabilities: ["SECURITY_CENTER_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: ["OPERATIONAL_ADMINISTRATION"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "platform.runbooks",
        href: "/ops/runbooks",
        label: "Runbooks",
        description: "Operator runbook catalog for incidents and recovery.",
        domain: "OPS",
        requiredCapabilities: ["RUNBOOKS_VIEW"],
        // PHASE 4 — Operations is a platform-admin area, not a workspace.
        // Non-platform-admins MUST not see this surface anywhere
        // (constitutional rule 9; see docs/architecture/phase-4-route-persona-matrix.md §3.8).
        requiredActiveSpace: "PLATFORM_ADMIN",
        fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",
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
        label: "Governance Posture",
        description: "Read-only lifecycle posture overview.",
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
        // PHASE 4 — Operations is a platform-admin area (rule 9).
        requiredActiveSpace: "PLATFORM_ADMIN",
        fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",
        workflowTags: ["OPERATIONAL_ADMINISTRATION"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
    },
    {
        id: "review.queue_detail",
        // Phase 38.12 — canonical href is the queue-anchored entry
        // `/reviewer-ops/queue`. The runtime page lives at
        // `app/(app)/reviewer-ops/[reviewId]/page.tsx` (dynamic param);
        // the canonical href in the registry stays queue-anchored so the
        // route surfaces as "reached from the queue" rather than as a
        // dynamic-id template URL that operators can't actually type.
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
        // PHASE 4 — Operations is a platform-admin area (rule 9).
        requiredActiveSpace: "PLATFORM_ADMIN",
        fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",
        workflowTags: ["OPERATIONAL_ADMINISTRATION"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        // Final Closure Remediation Part E — flipped from false to true so
        // SREs see Reliability ops in the sidebar's Operations group
        // without prior knowledge.
        sidebarEligible: true,
    },
    // Phase Final-Closure-Verification — `/operations/queues` was the
    // canonical BullMQ queue-triage surface but lived only at typed URL;
    // not in sidebar, not in cmd-K, not in "all tools". Operators
    // discovered it through tribal knowledge. Now `commandPaletteVisible:
    // true` so SREs can jump to it from anywhere.
    {
        id: "platform.queue_ops",
        href: "/operations/queues",
        label: "Queue operations",
        description: "BullMQ queue triage — failed jobs, replay safety, DLQ, stuck OTS.",
        domain: "OPS",
        requiredCapabilities: ["OPS_CENTER_VIEW"],
        // PHASE 4 — Operations is a platform-admin area (rule 9).
        requiredActiveSpace: "PLATFORM_ADMIN",
        fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",
        workflowTags: ["OPERATIONAL_ADMINISTRATION"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        // Final Closure Remediation Part E — flipped from false to true so
        // Queue Operations sits in the canonical Operations sidebar group.
        sidebarEligible: true,
    },
    {
        id: "platform.media_graph",
        href: "/ops/media-graph",
        label: "Media intelligence ops",
        description: "Media intelligence + investigation graph operational metrics.",
        domain: "OPS",
        requiredCapabilities: ["OBSERVABILITY_VIEW"],
        // PHASE 4 — Operations is a platform-admin area (rule 9).
        requiredActiveSpace: "PLATFORM_ADMIN",
        fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",
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
    // PHASE 6 — Team Collaboration Platform. The canonical Team UI
    // surface. Available to BOTH personal and organization workspaces
    // (constitutional rule 4-7: Team is core collaboration, Organization
    // is optional). UI label is "Teams"; URL path uses
    // `/collaboration-teams` to avoid colliding with the legacy
    // /teams/[id] workspace-admin page.
    //
    // No capability gate: any workspace member can SEE the Teams page;
    // creation is permitted whenever the user has an active workspace.
    // Per-team management permissions are enforced at the backend
    // service layer (LEAD/ADMIN/MEMBER/VIEWER/EXTERNAL).
    {
        id: "workspace.collaboration_teams",
        href: "/collaboration-teams",
        label: "Teams",
        description: "Collaboration teams — coordinate people, assignments, and evidence work.",
        domain: "PERSONAL_WORKSPACE",
        requiredCapabilities: [],
        requiredActiveSpace: "PERSONAL_OR_ORG",
        fallbackBehavior: "DEGRADED",
        workflowTags: [
            "LEGAL_CASEWORK",
            "REVIEW_OPERATIONS",
            "INVESTIGATION_RECONSTRUCTION",
            "VERIFICATION_DOCUMENTATION",
        ],
        advancedByDefault: false,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
    },
    {
        id: "workspace.collaboration_team_detail",
        href: "/collaboration-teams/[teamId]",
        label: "Team detail",
        description: "Team detail surface — members, invites, assignments, activity, settings.",
        domain: "PERSONAL_WORKSPACE",
        requiredCapabilities: [],
        requiredActiveSpace: "PERSONAL_OR_ORG",
        fallbackBehavior: "DEGRADED",
        workflowTags: ["LEGAL_CASEWORK", "REVIEW_OPERATIONS"],
        advancedByDefault: true,
        // Detail page reached from /collaboration-teams; not listed
        // independently in discovery surfaces.
        commandPaletteVisible: false,
        allToolsVisible: false,
        sidebarEligible: false,
    },
    {
        id: "workspace.collaboration_team_hub",
        href: "/collaboration-teams/[teamId]/collaboration",
        label: "Team collaboration hub",
        description: "Comments, mentions, notifications, preferences, guests, access review.",
        domain: "PERSONAL_WORKSPACE",
        requiredCapabilities: [],
        requiredActiveSpace: "PERSONAL_OR_ORG",
        fallbackBehavior: "DEGRADED",
        workflowTags: ["LEGAL_CASEWORK", "REVIEW_OPERATIONS"],
        advancedByDefault: true,
        commandPaletteVisible: false,
        allToolsVisible: false,
        sidebarEligible: false,
    },
    {
        id: "workspace.collaboration_team_invite_accept",
        href: "/collaboration-teams/invites/[token]/accept",
        label: "Accept team invite",
        description: "Accept a Team invitation via secure token.",
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
    // Phase Final-A3-PT2 — `/dashboard/api-keys` retired. The canonical
    // surface is `/integrations` (team-scoped, durable, audit-backed).
    // The old route now redirects via `next.config.js`. Registry entry
    // removed so cmd-K + "all tools" no longer surface it.
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
        // PHASE 4 — page does not exist (no app/(app)/dashboard/quotas/page.tsx).
        // Constitutional rule 11: no visible route may lead to Page Not Found.
        // Hide everywhere until the surface ships.
        commandPaletteVisible: false,
        allToolsVisible: false,
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
        // PHASE 4 — page does not exist; hide everywhere (rule 11).
        commandPaletteVisible: false,
        allToolsVisible: false,
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
        // PHASE 4 — page does not exist; hide everywhere (rule 11).
        commandPaletteVisible: false,
        allToolsVisible: false,
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
        // -------------------------------------------------------------------------
        // Investigation-suite audit (persona-fit decision):
        // The reviewer-intelligence console surfaces review-workflow queues,
        // escalations, and external-reviewer grants — content that is only
        // meaningful for actors who actually perform or coordinate review work.
        // Personal / solo personas (FREE / PAYG) and most PRO single-operator
        // users have no reviewer queue to inspect; surfacing this in the
        // primary sidebar yields an empty surface that reads as broken.
        //
        // Decision: keep this route reachable from the command palette and
        // the All Tools index (so review-capable actors can always navigate
        // to it), but remove it from the always-on sidebar surface. Personas
        // that actually perform review work reach it via the review pillar.
        // requiredCapabilities, requiredActiveSpace, and fallbackBehavior are
        // intentionally unchanged — backend gating is the authority.
        // -------------------------------------------------------------------------
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
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
    // Phase Final-Vocab-Alignment — `/review` is the single canonical
    // reviewer console (Queue · Mine · Escalations · SLA · Workload).
    // The legacy `/reviewer-ops` index has been retired:
    //   * the page file was deleted
    //   * `next.config.js` redirects `/reviewer-ops` → `/review`
    //   * the legacy registry entry below was removed so cmd-K + "all
    //     tools" no longer surface a competing reviewer entry-point
    // The per-workflow mutation inspector `/reviewer-ops/[reviewId]` is
    // a DIFFERENT surface and remains. The SLA / escalations sub-routes
    // also remain at their canonical `/reviewer-ops/*` paths and are
    // registered separately below.
    {
        id: "workspace.review",
        href: "/review",
        label: "Review",
        description: "Canonical reviewer console — queue, escalations, SLA, workload.",
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
    // Phase Final-Vocab-Alignment — `review.queue` retained as an id
    // because the sidebar (AppSidebarV2), hub landing routes
    // (hubDefinitions.ts), persona priority lists, the disclosure model,
    // and the permission matrix all reference it. Its `href` now points
    // at the canonical `/review` console (the old `/reviewer-ops` index
    // was deleted and redirects to `/review` via next.config.js). To
    // avoid two competing sidebar entries with the same href, this
    // entry is `commandPaletteVisible: false` + `sidebarEligible: false`
    // — it is a pure id-binding kept for backward compatibility with
    // the persona/hub machinery.
    {
        id: "review.queue",
        href: "/review",
        label: "Reviewer queue",
        description: "Reviewer queue (canonical surface; legacy /reviewer-ops index redirects here).",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: ["REVIEWER_OPS_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "CREATE_ORG",
        workflowTags: ["REVIEW_OPERATIONS", "OPERATIONAL_ADMINISTRATION"],
        advancedByDefault: false,
        commandPaletteVisible: false,
        allToolsVisible: false,
        sidebarEligible: false,
    },
    // Phase B — Phase 13 per-evidence review operations queue.
    {
        id: "review.operations",
        href: "/review/operations",
        label: "Review operations",
        description: "Per-evidence review stage queue (Phase 13).",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: ["REVIEWER_OPS_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "CREATE_ORG",
        workflowTags: ["REVIEW_OPERATIONS"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    // Phase B — Phase C3 intake inspector.
    {
        id: "workspace.evidence_requests",
        href: "/evidence-requests",
        label: "Evidence requests",
        description: "Phase C3 intake-request inspector — checklist fulfillment, response review, re-request.",
        domain: "PERSONAL_WORKSPACE",
        requiredCapabilities: ["INTAKE_LINKS_MANAGE"],
        requiredActiveSpace: "PERSONAL_OR_ORG",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: ["LEGAL_CASEWORK", "REVIEW_OPERATIONS"],
        advancedByDefault: true,
        // PHASE 4 — root list page does not exist (only the [id] detail page
        // ships). Constitutional rule 11: no visible route may lead to Page
        // Not Found. Detail page remains reachable from MatterWorkspace.
        // Re-enable in Phase 5 when the root list page ships.
        commandPaletteVisible: false,
        allToolsVisible: false,
        sidebarEligible: false,
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
        // PHASE 4 — Operations is a platform-admin area (rule 9).
        requiredActiveSpace: "PLATFORM_ADMIN",
        fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",
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
        description: "Bounded operational automation: trigger + action rules with audit history.",
        domain: "OPS",
        requiredCapabilities: ["AUTOMATION_VIEW"],
        // PHASE 4 — Operations is a platform-admin area (rule 9).
        requiredActiveSpace: "PLATFORM_ADMIN",
        fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",
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
        description: "Bounded operational analytics: real counts from real tables. No fake metrics, no AI predictions, no legal/admissibility scores.",
        domain: "OPS",
        requiredCapabilities: ["ANALYTICS_VIEW"],
        // PHASE 4 — Operations is a platform-admin area (rule 9).
        requiredActiveSpace: "PLATFORM_ADMIN",
        fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",
        workflowTags: ["OPERATIONAL_ADMINISTRATION"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    // Phase G0 (B0.5) — canonical frontend route is now `/workspaces`.
    // The legacy `/teams` page file continues to render the same
    // `WorkspaceAdministrationHome` component as a backward-compatible
    // alias so deep links + old bookmarks never break. Backend
    // `/v1/teams/*` endpoints are unchanged; that migration belongs in
    // a separate backend phase. The route id remains `admin.teams`
    // because tests + capability mappings key off the literal — only
    // the user-facing href flipped.
    //
    // Phase 9 audit note: route id is historical; canonical href is /workspaces;
    // this is workspace-admin tenancy, NOT the constitutional Team product
    // (see id=workspace.collaboration_teams).
    {
        id: "admin.teams",
        href: "/workspaces",
        label: "Workspaces",
        description: "Personal Workspace + organization-governed Workspaces management.",
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
    // ---------------------------------------------------------------------------
    // Phase 1A — Trust pillar surface. Canonical id `workspace.trust` points
    // at the real Trust hub page (apps/web/app/(app)/trust/page.tsx) which
    // composes verification methodology, public-verify, offline verifier,
    // signers, c2pa operations, subprocessors, privacy + retention surfaces.
    // ---------------------------------------------------------------------------
    {
        id: "workspace.trust",
        href: "/trust",
        label: "Trust",
        description: "Trust center hub — methodology, verification, signers, subprocessors, privacy.",
        // Trust hub renders workspace-anchored content (trust articles + subprocessor
        // snapshot + verification methodology for THIS workspace). It is a workspace
        // surface, NOT an account-tier surface, so domain=PERSONAL_WORKSPACE +
        // requiredActiveSpace=PERSONAL_OR_ORG matches the pattern used by every other
        // workspace-anchored route (workspace.evidence, workspace.cases, ...). Active
        // space is required so the trust dashboard knows which workspace's articles
        // to project — access is not weakened.
        domain: "PERSONAL_WORKSPACE",
        requiredCapabilities: [],
        requiredActiveSpace: "PERSONAL_OR_ORG",
        fallbackBehavior: "LOAD",
        workflowTags: ["TRUST_AND_GOVERNANCE"],
        advancedByDefault: false,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
    },
    // ---------------------------------------------------------------------------
    // Phase 2A — Reviewer Workspace surfaces. Canonical ids for the new
    // Phase 2A pages. Each entry points at the REAL page on disk; nothing
    // here invents an empty route. Pillar mapping lives in pillarRegistry.
    // ---------------------------------------------------------------------------
    {
        id: "workspace.review_workspace",
        href: "/review/workspace",
        label: "Reviewer workspace",
        description: "Reviewer operational surface — coding panel, hotkeys, evidence + coding side-by-side.",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: ["REVIEWER_OPS_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: ["REVIEW_OPERATIONS"],
        advancedByDefault: false,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
    },
    {
        id: "workspace.coding_schemas",
        href: "/review/schemas",
        label: "Coding schemas",
        description: "Coding schema admin — fields, versioning, workflow binding.",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: ["REVIEWER_OPS_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: ["REVIEW_OPERATIONS"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.review_qc",
        href: "/review/qc",
        label: "Reviewer QC",
        description: "QC sample queue + verdict capture + accuracy metrics.",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: ["REVIEWER_OPS_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: ["REVIEW_OPERATIONS"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.review_disagreements",
        href: "/review/disagreements",
        label: "Reviewer disagreements",
        description: "Challenge → second review → supervisor → resolution queue.",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: ["REVIEWER_OPS_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: ["REVIEW_OPERATIONS"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.review_metrics",
        href: "/review/metrics",
        label: "Reviewer metrics",
        description: "Reviewer throughput, approval/escalation rates, QC accuracy, rework.",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: ["REVIEWER_OPS_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: ["REVIEW_OPERATIONS"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    // ---------------------------------------------------------------------------
    // Phase 2A Closure — bulk operations queue. Points at the canonical
    // /review/queues page (operator queues + bulk action bar).
    // ---------------------------------------------------------------------------
    {
        id: "workspace.review_queues",
        href: "/review/queues",
        label: "Reviewer queues",
        description: "Multi-select reviewer queues + bulk action bar.",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: ["REVIEWER_OPS_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: ["REVIEW_OPERATIONS"],
        advancedByDefault: false,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
    },
    // ---------------------------------------------------------------------------
    // Phase 2B — External Reviewer Portal internal admin surface. The portal
    // itself lives at /portal (token-gated); this id binds the internal
    // invitation/management page at /review/external.
    // ---------------------------------------------------------------------------
    {
        id: "workspace.review_external",
        href: "/review/external",
        label: "External reviewer management",
        description: "Issue, resend, revoke external reviewer invitations + monitor portal sessions.",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: ["REVIEWER_OPS_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: ["REVIEW_OPERATIONS"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
    },
    // ---------------------------------------------------------------------------
    // Stage 3 — Backfill registry entries for pages that called PageRouteGate
    // with routeIds the registry didn't yet know about. Without these the
    // PageRouteGate "unknown id → render children" fall-through left these
    // surfaces completely unprotected. Each entry below points at the REAL
    // page on disk; nothing here invents an empty route.
    // ---------------------------------------------------------------------------
    {
        id: "admin.identity",
        href: "/settings/security",
        label: "Identity operations",
        description: "Enterprise identity operations hub — SAML, SCIM, identity audit, active sessions.",
        domain: "ORGANIZATION_WORKSPACE",
        requiredCapabilities: ["SECURITY_CENTER_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.intelligence_quality",
        href: "/intelligence-quality",
        label: "Intelligence Quality",
        description: "Provider, reviewer, and team correction analytics. Aggregate-only, never raw extraction.",
        domain: "ORGANIZATION_WORKSPACE",
        requiredCapabilities: ["GOVERNANCE_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.trust_center",
        href: "/trust-center",
        // -------------------------------------------------------------------------
        // workspace-surface audit — label clarification:
        // Renamed from "Trust Center" to "Trust & Compliance" per Section 6
        // of the audit. The new label makes the compliance-discovery pathway
        // explicit (this surface bundles methodology, AI disclosure, security,
        // and subprocessor disclosures used by audit reviewers and procurement).
        // -------------------------------------------------------------------------
        label: "Trust & Compliance",
        description: "Versioned platform-trust documentation — methodology, AI disclosure, security, subprocessors.",
        domain: "ORGANIZATION_WORKSPACE",
        requiredCapabilities: ["GOVERNANCE_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.audit_transparency",
        href: "/audit-transparency",
        label: "Audit & Transparency Center",
        description: "Federated audit timeline across provider usage, corrections, redaction, policy, video, portal. Bounded counts only — never PII.",
        domain: "GOVERNANCE",
        requiredCapabilities: ["GOVERNANCE_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.budget_center",
        href: "/budget-center",
        label: "Budget Center",
        description: "Per-scope spend, remaining budget, projected burn, breach timeline. Bounded ids only.",
        domain: "ORGANIZATION_WORKSPACE",
        requiredCapabilities: ["GOVERNANCE_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.evidence_lifecycle",
        href: "/evidence-lifecycle",
        label: "Lifecycle Operations",
        description: "Configure & execute lifecycle actions.",
        domain: "GOVERNANCE",
        requiredCapabilities: ["LIFECYCLE_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.exchange",
        href: "/exchange",
        label: "Exchange",
        description: "Evidence exchange packages — share, export, legal production, internal transfer.",
        domain: "ORGANIZATION_WORKSPACE",
        requiredCapabilities: ["EXPORT_GOVERNANCE_MANAGE"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.executive",
        href: "/executive",
        label: "Executive Dashboard",
        description: "Cross-domain enterprise metrics with historical trend. Aggregate-only, never PII.",
        domain: "ORGANIZATION_WORKSPACE",
        requiredCapabilities: ["GOVERNANCE_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        // -------------------------------------------------------------------------
        // workspace-surface audit — persona rationale:
        // Executive Dashboard is the C-suite consumption surface for org-tier
        // metrics, but it was previously cmd-K-only, so leadership personas
        // (ORG + GOVERNANCE_VIEW) could not discover it without prior URL
        // knowledge. Flipping sidebarEligible to true so the dashboard appears
        // in the Governance pillar for actors who actually have the capability.
        // Backend gating (GOVERNANCE_VIEW + ORGANIZATION_ONLY) is unchanged —
        // PERSONAL workspaces and non-governance actors still cannot see it.
        // -------------------------------------------------------------------------
        sidebarEligible: true,
    },
    {
        id: "workspace.governance_platform",
        href: "/governance-platform",
        label: "Governance Platform",
        description: "Enterprise org-level governance — orgs, departments, delegated admin, policies, access reviews, cross-org.",
        domain: "GOVERNANCE",
        requiredCapabilities: ["GOVERNANCE_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.intelligence_platform",
        href: "/intelligence-platform",
        // -------------------------------------------------------------------------
        // workspace-surface audit — label clarification:
        // Renamed from "Intelligence Platform" to "Intelligence" per Section 6
        // of the audit. The "Platform" suffix added enterprise noise without
        // operator value; the surface is the enterprise intelligence console.
        // The personal-tier `workspace.intelligence` route uses the same
        // operator-facing label but is gated to PERSONAL_OR_ORG + EVIDENCE_VIEW
        // so the two never appear in the same persona's sidebar simultaneously.
        // -------------------------------------------------------------------------
        label: "Intelligence",
        description: "Enterprise intelligence layer — provider health, cost summary, budgets, bounded operator workflows.",
        domain: "ORGANIZATION_WORKSPACE",
        requiredCapabilities: ["GOVERNANCE_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        // -------------------------------------------------------------------------
        // workspace-surface audit — persona rationale:
        // Enterprise intelligence dashboards were buried in cmd-K only; org
        // governance actors (ORG + GOVERNANCE_VIEW) had no sidebar pathway to
        // them. Flipping sidebarEligible to true exposes the surface in the
        // Governance pillar for capable actors. Backend gating
        // (GOVERNANCE_VIEW + ORGANIZATION_ONLY) is unchanged.
        // -------------------------------------------------------------------------
        sidebarEligible: true,
    },
    {
        id: "workspace.packaging",
        href: "/packaging",
        label: "Packaging",
        description: "Plan entitlements per product line — Capture & Verify, Investigations, Enterprise.",
        domain: "ORGANIZATION_WORKSPACE",
        requiredCapabilities: ["EXPORT_GOVERNANCE_MANAGE"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "workspace.review_redaction",
        href: "/redaction",
        label: "Redaction Projects",
        description: "Workspace redaction projects list + per-workspace summary. Bounded review-pillar entry point.",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: ["REVIEWER_OPS_VIEW"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: ["REVIEW_OPERATIONS"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    // ---------------------------------------------------------------------------
    // Phase 8 — Organization Admin shell. The /organizations/:id/admin surface
    // is a tabbed shell (overview / members / departments / governance /
    // access-reviews / retention / audit / security / trust) that aggregates
    // org-tier administration into a single canonical entry point. The shell
    // index + 9 tab pages each wrap in <PageRouteGate routeId="account.
    // organization-detail"> today; the registry entries below give every tab
    // first-class cmd-K + All Tools discoverability without putting them in
    // the sidebar (sidebarEligible: false — org detail is the canonical
    // sidebar entry, the admin shell is reached from that page's CTA).
    //
    // domain: ACCOUNT + requiredActiveSpace: NONE means personal-only users
    // never see these in cmd-K (the routes resolve via org membership at
    // /organizations/:id which already 404s for non-members). advancedByDefault:
    // true keeps them out of any persona's top-N tagged surfacing.
    //
    // No new capabilities — the underlying org endpoints enforce per-tab
    // role checks (ORG_OWNER / ORG_ADMIN required for mutating tabs).
    // ---------------------------------------------------------------------------
    {
        id: "account.organization_admin",
        href: "/organizations/:id/admin",
        label: "Organization admin",
        description: "Org admin shell — members, departments, governance, access reviews, retention, audit, security, trust.",
        domain: "ACCOUNT",
        requiredCapabilities: [],
        requiredActiveSpace: "NONE",
        fallbackBehavior: "LOAD",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "account.organization_admin_overview",
        href: "/organizations/:id/admin/overview",
        label: "Organization admin — Overview",
        description: "Read-only posture summary across members, workspaces, audit, retention, and governance.",
        domain: "ACCOUNT",
        requiredCapabilities: [],
        requiredActiveSpace: "NONE",
        fallbackBehavior: "LOAD",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "account.organization_admin_members",
        href: "/organizations/:id/admin/members",
        label: "Organization admin — Members",
        description: "Manage organization members, roles, and pending invitations.",
        domain: "ACCOUNT",
        requiredCapabilities: [],
        requiredActiveSpace: "NONE",
        fallbackBehavior: "LOAD",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "account.organization_admin_departments",
        href: "/organizations/:id/admin/departments",
        label: "Organization admin — Departments",
        description: "Departments and scoped membership inside the organization.",
        domain: "ACCOUNT",
        requiredCapabilities: [],
        requiredActiveSpace: "NONE",
        fallbackBehavior: "LOAD",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "account.organization_admin_governance",
        href: "/organizations/:id/admin/governance",
        label: "Organization admin — Governance",
        description: "Deep-links to org-tier governance surfaces (policies, posture, lifecycle).",
        domain: "ACCOUNT",
        requiredCapabilities: [],
        requiredActiveSpace: "NONE",
        fallbackBehavior: "LOAD",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "account.organization_admin_access_reviews",
        href: "/organizations/:id/admin/access-reviews",
        label: "Organization admin — Access reviews",
        description: "Access review campaigns and per-item decisions across the organization.",
        domain: "ACCOUNT",
        requiredCapabilities: [],
        requiredActiveSpace: "NONE",
        fallbackBehavior: "LOAD",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "account.organization_admin_retention",
        href: "/organizations/:id/admin/retention",
        label: "Organization admin — Retention",
        description: "Organization-level retention posture and destruction reviews.",
        domain: "ACCOUNT",
        requiredCapabilities: [],
        requiredActiveSpace: "NONE",
        fallbackBehavior: "LOAD",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "account.organization_admin_audit",
        href: "/organizations/:id/admin/audit",
        label: "Organization admin — Audit",
        description: "Organization audit timeline — invitations, role changes, governance events.",
        domain: "ACCOUNT",
        requiredCapabilities: [],
        requiredActiveSpace: "NONE",
        fallbackBehavior: "LOAD",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "account.organization_admin_security",
        href: "/organizations/:id/admin/security",
        label: "Organization admin — Security",
        description: "Organization security posture: MFA, SSO, SCIM, sessions readiness with deep-links to canonical surfaces.",
        domain: "ACCOUNT",
        requiredCapabilities: [],
        requiredActiveSpace: "NONE",
        fallbackBehavior: "LOAD",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
    {
        id: "account.organization_admin_trust",
        href: "/organizations/:id/admin/trust",
        label: "Organization admin — Trust",
        description: "Organization trust center deep-links and methodology references.",
        domain: "ACCOUNT",
        requiredCapabilities: [],
        requiredActiveSpace: "NONE",
        fallbackBehavior: "LOAD",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: false,
    },
];
/**
 * Lookup helper. Returns null for unknown ids.
 */
export function getRouteDefinition(id) {
    return ROUTE_REGISTRY.find((r) => r.id === id) ?? null;
}
