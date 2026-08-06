/**
 * PHASE 1 PART A — Enterprise 8-pillar information architecture.
 *
 * This module is the SINGLE SOURCE OF TRUTH for PROOVRA's enterprise
 * navigation IA. It replaces the legacy 4-group Phase G0/B operational
 * hierarchy (Workspace / Governance / Outputs / System) with the
 * Phase 0-approved 8-pillar model:
 *
 *   1. Home        — My Work: action queue, notifications, inbox
 *   2. Capture     — Intake edge: capture, intake links, evidence requests, workflows
 *   3. Cases       — Investigation workspace: cases, evidence, search, timeline,
 *                    relationships, graph, intelligence, collaboration, reports
 *   4. Review      — Reviewer workspace: queue, coding, escalations, SLA, ops
 *   5. Governance  — Policy, lifecycle, retention, destruction, posture
 *   6. Operations  — Ops Center, observability, reliability, runbooks, automation
 *   7. Admin       — Workspaces, organizations, integrations, security, settings,
 *                    billing, communications
 *   8. Trust       — In-product trust hub: signer health, anchor health, verify,
 *                    methodology, audit, status
 *
 * Hard rules — pinned by the Phase 1A pillar contract test:
 *
 *   1. The 8 pillar ids are bounded. Adding a pillar requires updating
 *      this file AND the contract test AND the persona visibility map.
 *   2. EVERY route in `ROUTE_REGISTRY` maps to exactly one pillar via
 *      `PILLAR_FOR_ROUTE_ID`. The contract test enforces full coverage.
 *   3. Pillars are role-visible per `PERSONA_PILLAR_VISIBILITY`. Personas
 *      are USE-CASE personas (Phase 38), not roles. HOME and TRUST are
 *      visible to every persona.
 *   4. The visible-node ceiling per persona is 25. The pillar grouping
 *      resolver MUST enforce it (the registry alone does not).
 *   5. This module is consumed by:
 *        - `canonicalNavigationGroups.ts` (re-exports pillar group constants)
 *        - `navigationGroupingResolver.ts` (buckets routes by pillar)
 *        - `pillarMembership` analytics + tests
 *      It MUST NOT import from `routeRegistry.ts` (pure registry; no cycle).
 */


// =============================================================================
// 8 PILLARS — canonical enum + display metadata
// =============================================================================

/** Bounded pillar id enum. Order matters — drives sidebar render order. */
export const PROOVRA_PILLARS = [
  "HOME",
  "CAPTURE",
  "CASES",
  "REVIEW",
  "GOVERNANCE",
  "OPERATIONS",
  "ADMIN",
  "TRUST",
] as const;
export type ProovraPillar = (typeof PROOVRA_PILLARS)[number];

export type PillarDefinition = {
  /** Bounded id. */
  readonly id: ProovraPillar;
  /** Sidebar render order (1-based, ascending). */
  readonly order: number;
  /** Operator-facing pillar label (sidebar group title). */
  readonly title: string;
  /** Short operator-tone description (tooltip + analytics). */
  readonly description: string;
  /** Lucide icon key (mapped by sidebar). */
  readonly iconKey: string;
};

export const PILLAR_DEFINITIONS: ReadonlyArray<PillarDefinition> = [
  {
    id: "HOME",
    order: 1,
    title: "Home",
    description: "Your action queue — what needs you now.",
    iconKey: "home",
  },
  {
    id: "CAPTURE",
    order: 2,
    title: "Capture",
    description: "Record evidence with hashed, signed integrity at source.",
    iconKey: "capture",
  },
  {
    id: "CASES",
    order: 3,
    title: "Cases",
    description: "Investigation workspace: evidence, timeline, relationships, reports.",
    iconKey: "cases",
  },
  {
    id: "REVIEW",
    order: 4,
    title: "Review",
    description: "Reviewer workspace: queue, coding, escalations, SLA.",
    iconKey: "review",
  },
  {
    id: "GOVERNANCE",
    order: 5,
    title: "Governance",
    description: "Policy, retention, destruction, posture — provable disposal.",
    iconKey: "governance",
  },
  {
    id: "OPERATIONS",
    order: 6,
    title: "Operations",
    description: "Operations Center, observability, reliability, automation.",
    iconKey: "operations",
  },
  {
    id: "ADMIN",
    order: 7,
    title: "Admin",
    description: "Workspaces, organizations, integrations, security, billing.",
    iconKey: "admin",
  },
  {
    id: "TRUST",
    order: 8,
    title: "Trust Center",
    description:
      "Trust center, verification methodology, security posture, and provable integrity.",
    iconKey: "trust",
  },
];

const PILLAR_BY_ID: ReadonlyMap<ProovraPillar, PillarDefinition> = (() => {
  const m = new Map<ProovraPillar, PillarDefinition>();
  for (const def of PILLAR_DEFINITIONS) m.set(def.id, def);
  return m;
})();

export function getPillarDefinition(id: ProovraPillar): PillarDefinition {
  const def = PILLAR_BY_ID.get(id);
  if (!def) {
    throw new Error(`Unknown pillar id: ${id}`);
  }
  return def;
}

// =============================================================================
// ROUTE → PILLAR MAPPING
//
// EVERY route id present in ROUTE_REGISTRY must be mapped here. Routes
// not mapped fall back to ADMIN (so a coverage regression remains
// reachable). The contract test fails when a route is unmapped.
// =============================================================================

export const PILLAR_FOR_ROUTE_ID: ReadonlyMap<string, ProovraPillar> = new Map([
  // -----------------------------------------------------------------
  // HOME
  // -----------------------------------------------------------------
  ["workspace.home", "HOME"],
  ["account.inbox", "HOME"],
  ["workspace.notifications", "HOME"],
  // Phase 6 cleanup — dashboard.insights retired.

  // -----------------------------------------------------------------
  // CAPTURE
  // -----------------------------------------------------------------
  ["workspace.capture", "CAPTURE"],
  ["workspace.intake_links", "CAPTURE"],
  ["workspace.evidence_requests", "CAPTURE"],
  // Phase C — `workspace.workflows` moved from CAPTURE to ADMIN. It
  // administers the EvidenceWorkflowTemplate catalog (Phase B Templates
  // Center), which is a workspace-administration surface, not part of
  // the daily capture/intake flow. See routeRegistry + the
  // SYSTEM/secondary placement in phaseBOperationalGroups.

  // -----------------------------------------------------------------
  // CASES (investigation workspace — single home for case work)
  // -----------------------------------------------------------------
  ["workspace.cases", "CASES"],
  ["workspace.evidence", "CASES"],
  ["workspace.search", "CASES"],
  ["workspace.reports", "CASES"],
  // Phase 12 Point 4 (Pass E) — `workspace.collaboration` removed with
  // its deleted page. The `/v1/collaboration/threads/*` service is
  // untouched; it still powers Evidence Detail → Discussion, which is
  // mapped through `workspace.evidence` above.
  // Phase IA-collapse — `workspace.communications` moved from CASES
  // to OPERATIONS. It is operator-facing SMS/WhatsApp/OTP delivery
  // state, not a daily case work surface.
  ["workspace.intelligence", "CASES"],
  ["investigation.hub", "CASES"],
  ["investigation.timeline", "CASES"],
  ["investigation.relationships", "CASES"],
  ["investigation.graph", "CASES"],
  ["investigation.duplicates", "CASES"],

  // -----------------------------------------------------------------
  // REVIEW (reviewer-facing surfaces)
  // -----------------------------------------------------------------
  ["workspace.review", "REVIEW"],
  ["review.queue", "REVIEW"],
  ["review.queue_detail", "REVIEW"],
  ["review.operations", "REVIEW"],
  ["review.escalations", "REVIEW"],
  ["review.sla", "REVIEW"],
  ["investigation.reviewers", "REVIEW"],
  // Phase 2A — reviewer workspace + adjacent surfaces.
  ["workspace.review_workspace", "REVIEW"],
  ["workspace.review_queues", "REVIEW"],
  // Phase 2B — external reviewer admin surface.
  ["workspace.review_external", "REVIEW"],
  ["workspace.coding_schemas", "REVIEW"],
  ["workspace.review_qc", "REVIEW"],
  ["workspace.review_disagreements", "REVIEW"],
  ["workspace.review_metrics", "REVIEW"],
  // Phase 3A — Redaction projects sit alongside reviewer surfaces.
  ["workspace.review_redaction", "REVIEW"],

  // -----------------------------------------------------------------
  // GOVERNANCE
  // -----------------------------------------------------------------
  ["governance.hub", "GOVERNANCE"],
  ["governance.policy", "GOVERNANCE"],
  ["governance.lifecycle", "GOVERNANCE"],
  ["governance.retention", "GOVERNANCE"],
  ["governance.destruction", "GOVERNANCE"],
  ["governance.notifications", "GOVERNANCE"],
  ["governance.analytics", "GOVERNANCE"],
  ["security_center.mfa_recovery", "GOVERNANCE"],
  // Phase 4A — org-tier governance surfaces.
  ["admin.identity", "GOVERNANCE"],
  ["workspace.intelligence_quality", "GOVERNANCE"],
  ["workspace.audit_transparency", "GOVERNANCE"],
  ["workspace.evidence_lifecycle", "GOVERNANCE"],
  ["workspace.governance_platform", "GOVERNANCE"],

  // -----------------------------------------------------------------
  // OPERATIONS (platform-health, ops-discipline)
  // -----------------------------------------------------------------
  ["platform.ops_center", "OPERATIONS"],
  ["platform.observability", "OPERATIONS"],
  // Phase 8 — Platform production-readiness posture (backup/DR, keys, resiliency).
  ["operations.readiness", "OPERATIONS"],
  // Phase R2 — dedicated PLATFORM_ADMIN gates for the signer/export/recovery
  // ops surfaces (repointed from the weaker workspace.security_center gate).
  ["operations.signers", "OPERATIONS"],
  ["operations.exports", "OPERATIONS"],
  ["operations.recovery", "OPERATIONS"],
  ["platform.reliability", "OPERATIONS"],
  ["platform.queue_ops", "OPERATIONS"],
  // Phase IA-collapse — Messaging operations (SMS / WhatsApp / OTP
  // delivery state + retry/cancel + provider health). Moved here from
  // the CASES pillar.
  ["workspace.communications", "OPERATIONS"],
  ["platform.media_graph", "OPERATIONS"],
  ["platform.runbooks", "OPERATIONS"],
  ["platform.automation", "OPERATIONS"],
  ["platform.analytics", "OPERATIONS"],
  ["dashboard.batch_analysis", "OPERATIONS"],
  ["dashboard.quotas", "OPERATIONS"],

  // -----------------------------------------------------------------
  // ADMIN (workspaces, organizations, integrations, identity, settings)
  // -----------------------------------------------------------------
  ["admin.teams", "ADMIN"],
  ["account.organizations", "ADMIN"],
  ["account.organization-detail", "ADMIN"],
  ["account.organization-setup", "ADMIN"],
  ["platform.provisioning", "ADMIN"],
  // PHASE 12B C10 — restricted internal-staff support/break-glass surface.
  ["platform.support_access", "ADMIN"],
  // Platform Admin Control Center — read-only admin surfaces.
  ["platform.organizations", "ADMIN"],
  ["platform.organization_detail", "ADMIN"],
  ["platform.users", "ADMIN"],
  ["platform.evidence_ops", "ADMIN"],
  ["platform.security", "ADMIN"],
  ["platform.billing", "ADMIN"],
  // Platform Admin Control Center — final-completion read-only surfaces.
  ["platform.platform_health", "ADMIN"],
  ["platform.costs", "ADMIN"],
  ["platform.adoption", "ADMIN"],
  ["platform.search", "ADMIN"],
  ["platform.timeline", "ADMIN"],
  ["platform.alerts", "ADMIN"],
  ["platform.executive", "ADMIN"],
  // P0-6 — previously-unregistered admin console pages.
  ["platform.dashboard", "ADMIN"],
  ["platform.demo_requests", "ADMIN"],
  ["platform.audit", "ADMIN"],
  ["platform.contact_sales", "ADMIN"],
  ["account.org-invite-accept", "ADMIN"],
  // Phase 8 — Organization Admin shell (tabbed surface at
  // /organizations/:id/admin). Org-admin tabs are administrative
  // surfaces, so they belong in the ADMIN pillar alongside the
  // canonical org detail + workspaces + organizations entries.
  ["account.organization_admin", "ADMIN"],
  ["account.organization_admin_overview", "ADMIN"],
  ["account.organization_admin_members", "ADMIN"],
  ["account.organization_admin_departments", "ADMIN"],
  ["account.organization_admin_governance", "ADMIN"],
  // Phase 5 (Enterprise Governance) — external-reviewer grant governance view.
  ["account.organization_admin_governance_external_reviewers", "ADMIN"],
  ["account.organization_admin_access_reviews", "ADMIN"],
  ["account.organization_admin_retention", "ADMIN"],
  ["account.organization_admin_audit", "ADMIN"],
  // Phase 8 (Enterprise Production Readiness) — Bulk invite, Reports, Readiness tabs.
  ["account.organization_admin_bulk_invite", "ADMIN"],
  ["account.organization_admin_reports", "ADMIN"],
  ["account.organization_admin_readiness", "ADMIN"],
  ["account.organization_admin_security", "ADMIN"],
  // Phase 3 (Enterprise Identity) — Domains verification tab.
  ["account.organization_admin_domains", "ADMIN"],
  ["account.organization_admin_trust", "ADMIN"],
  // Phase 4 (Enterprise Administration) — Roles, Billing, Integrations tabs.
  ["account.organization_admin_roles", "ADMIN"],
  ["account.organization_admin_billing", "ADMIN"],
  ["account.organization_admin_integrations", "ADMIN"],
  ["workspace.integrations", "ADMIN"],
  ["workspace.security_center", "ADMIN"],
  // Phase C — workflow templates administration; moved from CAPTURE.
  ["workspace.workflows", "ADMIN"],
  ["account.settings", "ADMIN"],
  // Settings IA remediation (2026-07-16) — dedicated child pages.
  ["account.profile", "ADMIN"],
  ["account.preferences", "ADMIN"],
  ["account.privacy", "ADMIN"],
  // Internal legal routing correction (2026-07-19) — authenticated
  // legal reader lives under /settings/legal/*, same pillar as privacy.
  ["account.legal_document", "ADMIN"],
  // Phase IA-collapse — Account security personal home at
  // /settings/security.
  ["account.security", "ADMIN"],
  // Enterprise AI Program — workspace AI governance + reviewer criteria
  // catalog. Settings-tier management surfaces under /settings/*.
  ["workspace.ai_settings", "ADMIN"],
  ["workspace.reviewer_criteria", "ADMIN"],
  // Notification preferences — personal settings surface under /settings/*.
  ["account.notification_settings", "ADMIN"],
  ["account.billing", "ADMIN"],
  ["platform.admin", "ADMIN"],
  ["workspace.tools", "ADMIN"],
  // Phase 4B — org-tier output / executive surfaces. The pillar
  // classification is operator-facing — these surfaces produce
  // executive snapshots and packaging exports for org admins, but
  // they live under ADMIN until the IA grows a dedicated "Outputs"
  // pillar (currently the Phase B operational group system).
  ["workspace.budget_center", "ADMIN"],
  ["workspace.exchange", "ADMIN"],
  ["workspace.executive", "ADMIN"],
  ["workspace.packaging", "ADMIN"],
  // Phase 5 / 6 / 7 — Collaboration Teams (the constitutional Team
  // product). Lives under CASES pillar because Team work is daily
  // case/evidence collaboration, NOT a new pillar (constitutional
  // rule 4-9: Team is NOT a workspace, Team is core collaboration).
  ["workspace.collaboration_teams", "CASES"],
  ["workspace.collaboration_team_detail", "CASES"],
  ["workspace.collaboration_team_hub", "CASES"],
  // Accept-invite landing — ACCOUNT-tier, so ADMIN.
  ["workspace.collaboration_team_invite_accept", "ADMIN"],

  // -----------------------------------------------------------------
  // TRUST — the authenticated Trust Hub (`workspace.trust`) was removed
  // 2026-07-15. The canonical trust portal is the public Trust Center
  // (`/trust`). The TRUST pillar now classifies only the in-app
  // `/trust-center/*` documentation gate (`workspace.trust_center`),
  // which is NON-navigational (sidebarEligible=false) — so the pillar
  // carries no sidebar entry while the 8-pillar IA stays intact.
  // -----------------------------------------------------------------
  ["workspace.trust_center", "TRUST"],
]);

/**
 * Resolve the pillar for a given route id. Returns ADMIN as the
 * coverage-safe fallback so an unmapped route remains reachable in the
 * sidebar rather than silently disappearing. The contract test rejects
 * unmapped routes so production never sees the fallback.
 */
export function pillarForRoute(routeId: string): ProovraPillar {
  return PILLAR_FOR_ROUTE_ID.get(routeId) ?? "ADMIN";
}

// (2026-07-20) The PERSONA → PILLAR VISIBILITY overlay (UNIVERSAL_PILLARS,
// PERSONA_PILLAR_OVERLAY, visiblePillarsForPersona, orderedPillarsForPersona)
// was removed with the workspace-persona feature. Pillar visibility is
// decided upstream by capabilities / plan / role; the surface-tier gate
// and capability map remain the authoritative access decision.

// =============================================================================
// HARD VISIBILITY CEILING — sidebar node budget
// =============================================================================

/**
 * Phase 0 + Phase 1A non-negotiable ceiling: a sidebar role MUST never
 * render more than this many visible navigation nodes (excluding the
 * "More / Advanced" disclosure container and the All Tools entry).
 *
 * The pillar grouping resolver clamps to this number by demoting the
 * lowest-priority overflow items into More/Advanced.
 */
export const MAX_VISIBLE_SIDEBAR_NODES = 25 as const;
