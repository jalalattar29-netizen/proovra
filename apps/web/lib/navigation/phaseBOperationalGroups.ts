/**
 * PHASE B — Canonical operational groups.
 *
 * Phase B is the IA Reset that landed AFTER B0 (Workspace/Org operating
 * model), C0 (Reviewer Console), C1 (Matter Workspace), C2 (Collaboration
 * Surfacing), and C3 (Intake Polish). It declares the canonical
 * **operational** hierarchy that the product navigation must surface from
 * Phase B onward:
 *
 *   1. WORKSPACE   — primary operational execution surfaces
 *   2. GOVERNANCE  — secondary operational oversight
 *   3. OUTPUTS     — verification / report / export deliverables
 *   4. SYSTEM      — preferences + support + transparency
 *
 * **Relationship to the Phase R2 sidebar groups in
 * `canonicalNavigationGroups.ts`:**
 *
 *   The R2 sidebar groups (`Primary workflows` / `Workspace` /
 *   `Operations` / `Governance & Compliance`) are the physical group
 *   titles the sidebar renders today, pinned by CR0 baseline tests.
 *   Phase B does NOT rename those titles in this iteration — instead
 *   it defines a parallel **operational hierarchy** (the four groups
 *   below) that is the new source-of-truth for:
 *
 *     • documentation
 *     • analytics / telemetry grouping
 *     • the canonical breadcrumb component
 *     • future sidebar surfacing once a CR6 sign-off retires the R2
 *       group titles
 *
 *   Every route in `ROUTE_REGISTRY` MUST appear in exactly one
 *   `PhaseBOperationalGroup`. The Phase B contract test enforces this.
 *
 * **Hard rules**
 *
 *   * No new top-level group may be added without updating this file
 *     AND the contract test.
 *   * `OPERATIONAL_DESTINATION_TARGET` codifies the ~25 destinations
 *     called out in the Phase B brief.
 *   * Routes intentionally hidden from primary nav (account-tier
 *     settings, public pages, platform-admin sub-pages) STILL belong
 *     to a Phase B group — they just live in the corresponding group's
 *     `secondary` slot rather than its `primary` slot.
 */

export type PhaseBOperationalGroup =
  | "WORKSPACE"
  | "GOVERNANCE"
  | "OUTPUTS"
  | "SYSTEM";

/**
 * Canonical Phase B operational group catalog.
 *
 * `primary` = the destinations that surface in operator-facing top-level
 * navigation. `secondary` = supporting destinations (advanced flows,
 * admin sub-pages, account-tier routes) that still belong to the same
 * operational concept but should NOT appear in primary nav.
 */
export const PHASE_B_OPERATIONAL_GROUPS: ReadonlyArray<{
  id: PhaseBOperationalGroup;
  title: string;
  description: string;
  /** Operator-readable summary used in the runbook + sidebar tooltip. */
  hint: string;
  /** Route ids that should appear in operator-facing primary nav. */
  primary: ReadonlyArray<string>;
  /** Route ids that belong to this group but are not primary nav. */
  secondary: ReadonlyArray<string>;
}> = [
  // ---------------------------------------------------------------------
  // WORKSPACE — primary operational execution
  // ---------------------------------------------------------------------
  {
    id: "WORKSPACE",
    title: "Workspace",
    description:
      "Primary operational execution surfaces. Where evidence is captured, organised, reviewed, and coordinated.",
    hint: "Daily operational work happens here.",
    primary: [
      "workspace.home",
      "workspace.review",
      "workspace.cases",
      "workspace.evidence",
      "workspace.capture",
      "workspace.intake_links",
      "account.inbox",
      "workspace.search",
      // Phase 2A — canonical reviewer-operator surfaces. These are daily
      // operational pages (workspace + queues), so they live in WORKSPACE
      // primary alongside `workspace.review`. The Phase 2A coding/qc/
      // disagreement/metrics admin tools sit in secondary below.
      "workspace.review_workspace",
      "workspace.review_queues",
    ],
    secondary: [
      "workspace.evidence_requests",
      "review.queue",
      "review.queue_detail",
      "review.escalations",
      "review.sla",
      "review.operations",
      // Phase C — `workspace.workflows` moved from WORKSPACE/secondary
      // to SYSTEM/secondary. It administers workflow templates, not
      // operational instance execution; the reviewer execution surface
      // lives in `/review` (workspace.review). Keeping it in WORKSPACE
      // would re-advertise the misleading "operations" framing the
      // Phase B IA reset deliberately retired.
      //
      // Phase IA-collapse — `workspace.communications` reclassified
      // out of WORKSPACE into SYSTEM/secondary: it is operator-facing
      // messaging delivery state, not a workspace execution surface.
      // `workspace.collaboration` stays here as a legacy entry — the
      // page now redirects to /inbox (next.config.js); the registry
      // entry remains so contract tests pinning id+href still pass.
      "workspace.collaboration",
      "workspace.intelligence",
      "investigation.hub",
      "investigation.timeline",
      "investigation.relationships",
      "investigation.graph",
      "investigation.duplicates",
      "investigation.reviewers",
      // Phase 2A — coding-schema admin + QC + disagreement-queue +
      // reviewer-metrics. Reviewer-tier admin surfaces (not daily flow),
      // discoverable via WORKSPACE secondary.
      "workspace.coding_schemas",
      "workspace.review_qc",
      "workspace.review_disagreements",
      "workspace.review_metrics",
      // Phase 3A — Reviewer-tier redaction projects surface; sits
      // alongside the reviewer admin surfaces above.
      "workspace.review_redaction",
      // Phase 5 / 6 — Collaboration Teams. The Team product is core
      // collaboration (constitutional rule 4-7) — it lives in WORKSPACE,
      // not in a separate Team-Workspace group (Team is NOT a workspace
      // per the constitution). Detail + invite-accept surfaces are deep
      // links so they live in secondary.
      "workspace.collaboration_teams",
      "workspace.collaboration_team_detail",
      "workspace.collaboration_team_hub",
      "workspace.collaboration_team_invite_accept",
    ],
  },

  // ---------------------------------------------------------------------
  // GOVERNANCE — oversight, policy, organization
  // ---------------------------------------------------------------------
  {
    id: "GOVERNANCE",
    title: "Governance",
    description:
      "Operational oversight: organizations, policies, retention, lifecycle, audit, security.",
    hint: "Optional governance overlay — discoverable but never primary noise for solo users.",
    primary: [
      "governance.hub",
      "account.organizations",
      "admin.teams",
      // Phase 1A — Trust hub is the cross-organisation transparency
      // surface (methodology, verification, signers, subprocessors,
      // privacy). Lives in GOVERNANCE primary because it's the operator-
      // facing trust + transparency control.
      "workspace.trust",
    ],
    secondary: [
      // Phase IA-collapse — `workspace.security_center` (renamed
      // "Identity & Security") demoted from GOVERNANCE/primary to
      // /secondary. Personal account security moved to
      // `account.security` (under SYSTEM/primary); this entry remains
      // the workspace operator-facing identity console (MFA policy,
      // trusted devices, session revocations, MFA recovery approvals).
      "workspace.security_center",
      "governance.policy",
      "governance.retention",
      "governance.lifecycle",
      "governance.destruction",
      "governance.notifications",
      "governance.analytics",
      "account.organization-detail",
      "account.org-invite-accept",
      // Phase 8 — Organization Admin shell + 9 tab leaves. Tabbed
      // org-administration surface reached from the org detail page's
      // "Open Admin →" CTA. Lives in GOVERNANCE secondary because the
      // tabs are org-tier oversight (members, departments, governance,
      // access reviews, retention, audit, security, trust) — not daily
      // operator flow. sidebarEligible: false in the route registry,
      // so they never compete with the canonical Phase B primary
      // destinations.
      "account.organization_admin",
      "account.organization_admin_overview",
      "account.organization_admin_members",
      "account.organization_admin_departments",
      "account.organization_admin_governance",
      "account.organization_admin_access_reviews",
      "account.organization_admin_retention",
      "account.organization_admin_audit",
      "account.organization_admin_security",
      "account.organization_admin_trust",
      // Final Closure Remediation Part A — `security_center.mfa_recovery`
      // is the MFA-recovery approvals console reached from the Security
      // Center. It belongs to the Governance group (member-identity
      // oversight) and is discoverable via cmd-K + All Tools.
      "security_center.mfa_recovery",
      // Phase 2B — External Reviewer Portal internal admin (issue, resend,
      // revoke invitations + monitor portal sessions). Reviewer-tier
      // governance surface, not daily reviewer flow.
      "workspace.review_external",
      // Phase 4A — Org-tier governance surfaces. Trust Center, audit
      // transparency, evidence lifecycle, and the executive/governance
      // platform pages. Org Admin / Compliance surfaces — secondary in
      // GOVERNANCE because they're org-overlay, not daily ops.
      "admin.identity",
      "workspace.intelligence_quality",
      "workspace.audit_transparency",
      "workspace.evidence_lifecycle",
      "workspace.governance_platform",
    ],
  },

  // ---------------------------------------------------------------------
  // OUTPUTS — verification deliverables
  // ---------------------------------------------------------------------
  {
    id: "OUTPUTS",
    title: "Outputs",
    description:
      "Verification deliverables: signed Report PDFs, Verification Package ZIPs, exports.",
    hint: "Report PDF vs Verification Package ZIP are distinct artifacts (Phase A2 vocabulary).",
    primary: ["workspace.reports"],
    secondary: [
      // Phase 4B — Org-tier output deliverable surfaces. Packaging =
      // export bundles. Exchange = signed-bundle delivery channel.
      // Executive = operator-facing executive dashboard. Intelligence
      // platform + budget center = org-tier rollups that produce
      // export-ready snapshots.
      "workspace.exchange",
      "workspace.executive",
      "workspace.intelligence_platform",
      "workspace.packaging",
      "workspace.budget_center",
    ],
  },

  // ---------------------------------------------------------------------
  // SYSTEM — preferences, account, platform admin
  // ---------------------------------------------------------------------
  {
    id: "SYSTEM",
    title: "System",
    description:
      "Personal preferences, account-tier settings, integrations, platform admin, and operational health.",
    hint: "Preferences + transparency. Solo-user safe.",
    primary: [
      "account.settings",
      // Phase IA-collapse — Account security personal home at
      // /settings/security. ACCOUNT-tier, NONE active space; always
      // loads. Lives in SYSTEM primary alongside account.settings
      // because both are personal preference / personal-control
      // surfaces.
      "account.security",
      "account.billing",
      "workspace.notifications",
      "workspace.integrations",
      "workspace.tools",
    ],
    secondary: [
      "account.persona",
      // Phase IA-collapse — `workspace.communications` (renamed
      // "Messaging operations") moved from WORKSPACE/secondary to
      // SYSTEM/secondary alongside the other ops health surfaces. It
      // is an operator-facing SMS/WhatsApp/OTP delivery state console,
      // not a workspace execution surface.
      "workspace.communications",
      // Phase C — `workspace.workflows` administers the
      // EvidenceWorkflowTemplate catalog. It is an administration
      // surface (Phase B reframed the page from a misleading
      // "operations center" to a Templates Center). SYSTEM/secondary
      // is the correct home — alongside notifications, integrations,
      // and the other workspace-administration surfaces.
      "workspace.workflows",
      // Phase Final-A3-PT2 retired `dashboard.api_keys` (route id and
      // page deleted; canonical surface is `workspace.integrations`,
      // already in `primary` above).
      "dashboard.quotas",
      "dashboard.insights",
      "dashboard.batch_analysis",
      "platform.ops_center",
      "platform.observability",
      "platform.runbooks",
      "platform.reliability",
      "platform.media_graph",
      "platform.automation",
      "platform.analytics",
      // Phase Final-Closure-Verification — `platform.queue_ops` (the
      // BullMQ queue triage surface at `/operations/queues`) was
      // promoted from typed-URL-only to a discoverable canonical
      // surface; map it to SYSTEM/secondary so the Phase B coverage
      // contract still holds.
      "platform.queue_ops",
      "platform.admin",
    ],
  },
];

/**
 * Phase B destination budget. The brief calls for ~25 operator-facing
 * primary destinations. The actual primary count (sum of `primary` arrays
 * across all four groups) is asserted by the contract test against this
 * ceiling.
 */
export const OPERATIONAL_DESTINATION_TARGET = {
  target: 25,
  /** Hard upper bound; the contract test fails if exceeded. */
  ceiling: 30,
} as const;

/**
 * Reverse lookup — route id → Phase B group id.
 *
 * Built once at module load. Routes NOT in this map are guaranteed by
 * the contract test to be absent from `ROUTE_REGISTRY`.
 */
const ROUTE_TO_GROUP: ReadonlyMap<string, PhaseBOperationalGroup> = (() => {
  const m = new Map<string, PhaseBOperationalGroup>();
  for (const group of PHASE_B_OPERATIONAL_GROUPS) {
    for (const id of group.primary) m.set(id, group.id);
    for (const id of group.secondary) m.set(id, group.id);
  }
  return m;
})();

export function operationalGroupForRoute(
  routeId: string,
): PhaseBOperationalGroup | null {
  return ROUTE_TO_GROUP.get(routeId) ?? null;
}

/**
 * Returns the operator-readable Phase B group descriptor for a route,
 * suitable for breadcrumb rendering.
 */
export function operationalGroupDescriptor(
  routeId: string,
): { id: PhaseBOperationalGroup; title: string } | null {
  const groupId = operationalGroupForRoute(routeId);
  if (!groupId) return null;
  const group = PHASE_B_OPERATIONAL_GROUPS.find((g) => g.id === groupId);
  if (!group) return null;
  return { id: group.id, title: group.title };
}
