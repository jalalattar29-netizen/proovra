/**
 * Phase 32.8 Foundation — Canonical capability registry.
 *
 * This module is the ONE place where (role, scope, plan, isPlatformAdmin)
 * is converted into a CapabilityMap. The frontend MUST consume the
 * resolved booleans only — it MUST NOT re-derive any of them locally.
 *
 * Hard rules:
 *
 *   1. Function is PURE — same input always yields the same output.
 *
 *   2. The result is always a complete CapabilityMap. EVERY key in
 *      CAPABILITY_KEYS is present. No missing keys, no extras.
 *
 *   3. Read-only capabilities (DASHBOARD_VIEW, EVIDENCE_VIEW, etc.)
 *      are GRANTED in personal workspaces — a user can always see
 *      their own evidence. Team-collaboration capabilities
 *      (TEAM_MANAGE, BULK_ACTIONS, REVIEWER_OPS_ACT) require team
 *      scope + sufficient role.
 *
 *   4. PRO/TEAM plan never weakens role authority. A PRO user on a
 *      personal workspace is the OWNER of that workspace.
 *
 *   5. Platform admin elevates platform-tier capabilities only
 *      (PLATFORM_ADMIN, OBSERVABILITY_VIEW, RUNBOOKS_VIEW). It does
 *      NOT silently grant workspace mutation across other people's
 *      workspaces — those still require explicit membership.
 */

import {
  CAPABILITY_KEYS,
  type CapabilityKey,
  type CapabilityMap,
  type WorkspacePlan,
  type WorkspaceRole,
  type WorkspaceScope,
  type ResolvedWorkspaceKind,
} from "./types.js";

export type CapabilityResolverInput = {
  /**
   * @deprecated ATTENTION ARCHITECTURE — legacy two-value scope. Retained so existing
   * callers keep compiling; prefer `workspaceKind`, which distinguishes
   * OWNED from ORGANIZATION. When both are supplied, `workspaceKind`
   * decides and `scope` is ignored.
   */
  scope: WorkspaceScope | null;
  role: WorkspaceRole | null;
  plan: WorkspacePlan | null;
  isPlatformAdmin: boolean;
  /**
   * ATTENTION ARCHITECTURE (2026-08-22) — CANONICAL structural kind of the active
   * workspace. Optional during migration; when omitted the resolver falls
   * back to `scope`, which cannot tell OWNED from ORGANIZATION.
   */
  workspaceKind?: ResolvedWorkspaceKind | null;
  /**
   * PHASE 4B — can this workspace's package PRODUCE operational conditions?
   *
   * ONE pre-resolved boolean, deliberately. The caller derives it from the
   * canonical commercial catalog; this module never learns a feature name.
   * That keeps the resolver a pure role/kind function and keeps commercial
   * vocabulary out of an authorization input — a property the E8 contract
   * test pins by asserting this type's shape stays free of feature and
   * guest-actor nouns.
   */
  packageProducesOperationalConditions?: boolean | null;
  /**
   * PHASE 4B — ACTIVE member count of the workspace. A shared workspace
   * always has operations to coordinate, whatever its package includes.
   */
  memberCount?: number | null;
};

/**
 * ATTENTION ARCHITECTURE — one place that answers "which structural kind is this?", so a
 * caller that has not yet been migrated to `workspaceKind` still gets a
 * consistent (if coarser) answer instead of a second derivation.
 */
function effectiveKind(input: CapabilityResolverInput): ResolvedWorkspaceKind {
  if (input.workspaceKind) return input.workspaceKind;
  if (input.scope === "PERSONAL") return "PERSONAL";
  // A legacy TEAM scope cannot distinguish OWNED from ORGANIZATION. OWNED
  // is the weaker of the two for gating purposes, so it is the safe
  // stand-in until the caller supplies the real kind.
  if (input.scope === "TEAM") return "OWNED";
  return "UNKNOWN";
}

function emptyMap(): CapabilityMap {
  const out = {} as Record<string, boolean>;
  for (const key of CAPABILITY_KEYS) out[key] = false;
  return out as CapabilityMap;
}

function setMany(
  map: CapabilityMap,
  keys: ReadonlyArray<CapabilityKey>,
  value: boolean,
): void {
  for (const k of keys) {
    map[k] = value;
  }
}

/**
 * Resolve the bounded capability matrix for a viewer.
 *
 * Returns a CapabilityMap with every CAPABILITY_KEY mapped to a boolean.
 */
export function resolveCapabilities(input: CapabilityResolverInput): CapabilityMap {
  const map = emptyMap();

  const { scope, role, isPlatformAdmin } = input;
  // ATTENTION ARCHITECTURE — classification now runs through the canonical kind. `isTeam`
  // keeps its long-standing meaning ("a shared, non-personal workspace")
  // and is now the union of the two kinds the legacy scope collapsed.
  const kind = effectiveKind(input);
  const isPersonal = kind === "PERSONAL";
  const isOwnedWorkspace = kind === "OWNED";
  const isOrganizationWorkspace = kind === "ORGANIZATION";
  const isTeam = isOwnedWorkspace || isOrganizationWorkspace;
  const isOwner = role === "OWNER";
  const isAdmin = role === "ADMIN" || role === "OWNER";
  const isMember = role === "MEMBER" || isAdmin;
  const isViewer = role === "VIEWER";
  const isWriter = isMember && !isViewer;

  // No workspace at all — the user can see their account surfaces only.
  if (!scope) {
    map.SETTINGS_VIEW = true;
    // Account-tier capabilities are tier-independent and must remain
    // reachable in the degraded path so an authenticated user can still
    // get to billing/settings/create-or-join an organization.
    setMany(
      map,
      [
        "ACCOUNT_SETTINGS_VIEW",
        "ACCOUNT_BILLING_VIEW",
        "ACCOUNT_UPGRADE_VIEW",
        "ORGANIZATION_CREATE",
        "ORGANIZATION_JOIN",
      ],
      true,
    );
    if (isPlatformAdmin) {
      setMany(
        map,
        [
          "PLATFORM_ADMIN",
          "OPS_CENTER_VIEW",
          "OBSERVABILITY_VIEW",
          "RUNBOOKS_VIEW",
          "SECURITY_CENTER_VIEW",
          "DASHBOARD_VIEW",
        ],
        true,
      );
    }
    return map;
  }

  // ============================================================
  // Universally-available (workspace-scoped read) capabilities.
  // ============================================================

  setMany(
    map,
    [
      "DASHBOARD_VIEW",
      "EVIDENCE_VIEW",
      "EVIDENCE_CAPTURE",
      "CASES_VIEW",
      "REPORTS_VIEW",
      "SEARCH_VIEW",
      "SETTINGS_VIEW",
    ],
    true,
  );

  // Writers (non-viewer) get evidence & report management.
  if (isWriter) {
    setMany(map, ["EVIDENCE_MANAGE", "REPORTS_GENERATE"], true);
  }

  // ============================================================
  // Personal-workspace shape
  // ============================================================
  //
  // The viewer is the OWNER of their own personal workspace. They
  // can manage their own evidence, generate their own reports,
  // adjust their own settings. They do NOT get team-collaboration
  // surfaces (Reviewer Ops, Governance, Teams, bulk actions).
  if (isPersonal) {
    setMany(
      map,
      [
        "EVIDENCE_MANAGE",
        "CASES_MANAGE",
        "CASE_STATUS_CHANGE",
        "CASE_EVIDENCE_LINK",
        "CASE_COMMENT",
        "CASE_COMMENT_RESOLVE",
        "REPORTS_GENERATE",
        "SETTINGS_MANAGE",
        // Phase ROUTE-FIX — Billing and Teams are ACCOUNT-LEVEL
        // surfaces, not workspace-operator surfaces. A personal
        // user must be able to:
        //   - view their personal subscription/plan (BILLING_VIEW)
        //     and upgrade to Pro / create a team
        //   - reach the Teams page as a CREATE-team entry point
        //     (TEAM_VIEW). TEAM_MANAGE is still gated to team
        //     OWNER/ADMIN so personal users see a "create team"
        //     surface rather than an operator surface.
        "BILLING_VIEW",
        "TEAM_VIEW",
        // Phase IA-intake-access-fix — Intake Links is a core
        // self-serve feature for PRO/TEAM users (lawyers,
        // journalists, investigators, consultants, and small
        // offices). The Personal Space user is the OWNER of their
        // own workspace and must be able to create and manage
        // intake links from there. Plan-tier gating (FREE/PAYG
        // redirect) is enforced upstream by the surface-tier
        // middleware — granting the capability here does not
        // widen access for FREE/PAYG.
        "INTAKE_LINKS_MANAGE",
      ],
      true,
    );
    // Personal cases have no team assignments — CASE_ASSIGN stays
    // false. No reviewer ops, no governance acts, no team manage.
    // OPS_CENTER_VIEW is an operator capability and is NOT granted
    // to personal users.
  }

  // ============================================================
  // Team-workspace shape
  // ============================================================
  if (isTeam) {
    setMany(
      map,
      [
        "TEAM_VIEW",
        "REVIEWER_OPS_VIEW",
        "SLA_VIEW",
        "ESCALATIONS_VIEW",
        "GOVERNANCE_VIEW",
        "LIFECYCLE_VIEW",
        // PHASE 4A (2026-08-22) — OPS_CENTER_VIEW / OBSERVABILITY_VIEW /
        // RUNBOOKS_VIEW were granted here and are PLATFORM-tier keys
        // gating `/platform/*`. Every route carrying them has always been
        // `requiredActiveSpace: "PLATFORM_ADMIN"`, so no tenant surface
        // ever consumed them — the grant was dead and contradicted the
        // gate. Tenant operational access is `OPERATIONS_VIEW` below.
      ],
      true,
    );

    if (isWriter) {
      setMany(
        map,
        [
          "CASES_MANAGE",
          "REVIEWER_OPS_ACT",
          "REVIEW_ASSIGN",
          "REVIEW_REASSIGN",
          "REVIEW_ESCALATE",
          // Phase IA-intake-completion — REVIEWER (and any writer) can
          // create intake links because they already hold
          // `workflow.intake_link.create` in the role-permission matrix
          // (packages/shared/src/permissions.ts). Without this flag the
          // /intake-links surface denied them via PageRouteGate even
          // though the backend would have accepted the create call.
          "INTAKE_LINKS_MANAGE",
          // Phase 32.8D-frontend-closure — every non-VIEWER team
          // member can change case status, link evidence, and
          // comment. Per-case CaseAssignment role gating is enforced
          // server-side in the route guards.
          "CASE_STATUS_CHANGE",
          "CASE_EVIDENCE_LINK",
          "CASE_COMMENT",
          "CASE_COMMENT_RESOLVE",
          // Phase ROUTE-FIX — Billing read access is granted to every
          // non-VIEWER team member. Viewing the plan/seats page is
          // account-tier; managing billing (BILLING_MANAGE) remains
          // OWNER/ADMIN only.
          "BILLING_VIEW",
          // Phase E3 — every team writer can read automation rules +
          // run history (visibility is part of operational discipline).
          // AUTOMATION_MANAGE (create/edit/enable/disable) stays
          // OWNER/ADMIN only, granted in the isAdmin branch below.
          "AUTOMATION_VIEW",
          // Phase E4 — operational analytics is a read-only surface;
          // any team writer can see it. Personal-workspace owners
          // (who are team writers in their personal space) also get
          // the simplified-analytics view via this capability.
          "ANALYTICS_VIEW",
        ],
        true,
      );
    }

    if (isAdmin) {
      setMany(
        map,
        [
          "TEAM_MANAGE",
          "BILLING_VIEW",
          "BILLING_MANAGE",
          "INTEGRATIONS_MANAGE",
          "INTAKE_LINKS_MANAGE",
          "SETTINGS_MANAGE",
          "GOVERNANCE_ACT",
          "LEGAL_HOLD_PLACE",
          "LEGAL_HOLD_RELEASE",
          "RETENTION_MANAGE",
          "EXPORT_GOVERNANCE_MANAGE",
          "SECURITY_CENTER_VIEW",
          "BULK_ACTIONS",
          // CASE_ASSIGN is reserved for OWNER/ADMIN. Per-case
          // CaseAssignment OWNER also gets it server-side.
          "CASE_ASSIGN",
          // Phase E3 — only OWNER/ADMIN may create/edit/enable/
          // disable automation rules. Writers can VIEW but not MANAGE.
          "AUTOMATION_MANAGE",
        ],
        true,
      );
    }

    if (isOwner) {
      // OWNER gets everything ADMIN does + nothing extra here. Kept
      // as a branch for clarity / future expansion.
      map.BILLING_MANAGE = true;
    }
  }

  // ============================================================
  // PHASE 4B (2026-08-22) — TENANT OPERATIONS.
  //
  // Gated on whether the workspace can PRODUCE operational conditions,
  // never on a plan name. Two independent qualifiers:
  //
  //   1. The package includes a condition-producing feature (reports,
  //      verification packages, intake, reviewer operations). A solo
  //      Pro investigator qualifies; a Free personal space does not.
  //   2. The workspace is SHARED (>1 ACTIVE member). The moment two
  //      operators exist, "has anyone dealt with this?" needs shared
  //      state regardless of package.
  //
  // A PERSONAL Free workspace reaches neither, so it gets no Operations
  // surface — its integrity failures stay a notification plus the
  // Evidence record's own remediation path, which is the right amount
  // of ceremony for one operator and one record.
  // ============================================================
  const packageProducesConditions =
    input.packageProducesOperationalConditions === true;
  const workspaceIsShared = (input.memberCount ?? 0) > 1;
  // UNKNOWN never qualifies — an unprovable workspace fails closed.
  const kindCanOperate = isPersonal || isTeam;
  const canOperate =
    kindCanOperate && (packageProducesConditions || workspaceIsShared);

  if (canOperate) {
    map.OPERATIONS_VIEW = true;
    // VIEWER may look and may not act. Every mutation below requires a
    // non-viewer role; assignment and suppression additionally require
    // admin tier, mirroring CASE_ASSIGN and GOVERNANCE_ACT.
    if (isWriter) {
      map.OPERATIONS_ACKNOWLEDGE = true;
      map.OPERATIONS_RESOLVE = true;
    }
    if (isAdmin) {
      map.OPERATIONS_ASSIGN = true;
      map.OPERATIONS_SUPPRESS = true;
    }
  }

  // ============================================================
  // Platform admin elevation
  // ============================================================
  if (isPlatformAdmin) {
    setMany(
      map,
      [
        "PLATFORM_ADMIN",
        "OPS_CENTER_VIEW",
        "OBSERVABILITY_VIEW",
        "RUNBOOKS_VIEW",
        "SECURITY_CENTER_VIEW",
      ],
      true,
    );
  }

  // ============================================================
  // ENTERPRISE TENANT MODEL — account / personal / org keys.
  //
  // Computed from the same (scope, role, isPlatformAdmin) inputs that drove
  // the legacy keys above. The legacy keys remain populated for backward
  // compatibility for one phase; new pages should consume these instead.
  //
  //   ACCOUNT_*  — always-available to an authenticated user
  //   PERSONAL_* — gated to scope=PERSONAL
  //   ORG_*      — gated to scope=TEAM + role
  // ============================================================

  // Account-tier — every authenticated user can manage their identity,
  // see billing, view upgrade paths, create or join organizations.
  setMany(
    map,
    [
      "ACCOUNT_SETTINGS_VIEW",
      "ACCOUNT_BILLING_VIEW",
      "ACCOUNT_UPGRADE_VIEW",
      "ORGANIZATION_CREATE",
      "ORGANIZATION_JOIN",
    ],
    true,
  );

  // Personal-space-tier — granted only when the active space is PERSONAL.
  // Read capabilities are always granted in personal mode (the user owns
  // their own evidence by definition).
  //
  // @deprecated PHASE 3 — The PERSONAL_* grants below are DEAD: no
  //   route, no UI surface, and no service reads these keys. The
  //   equivalent non-namespaced keys (EVIDENCE_VIEW, CASES_VIEW,
  //   REPORTS_VIEW, SEARCH_VIEW, EVIDENCE_CAPTURE) remain the
  //   canonical gating keys and ARE granted above in personal mode.
  //   We retain these grants in Phase 3 to avoid a destructive
  //   capability-shape change pre-Phase-4 — a Phase 3 source-contract
  //   test asserts they continue to be granted with no behaviour
  //   change. See docs/architecture/domain-debt-register.md (DBT-CAP-01).
  if (isPersonal) {
    setMany(
      map,
      [
        "PERSONAL_CAPTURE",
        "PERSONAL_EVIDENCE_VIEW",
        "PERSONAL_CASES_VIEW",
        "PERSONAL_REPORTS_VIEW",
        "PERSONAL_SEARCH_VIEW",
      ],
      true,
    );
  }

  // Organization-tier — granted only when the active space is an
  // organization (TEAM scope). Role-aware: viewers do NOT get governance
  // act or team manage; admins do; billing manage is OWNER/ADMIN.
  //
  // @deprecated PHASE 3 — The ORG_* grants below are DEAD: no
  //   route, no UI surface, and no service reads these keys. The
  //   equivalent non-namespaced keys (EVIDENCE_VIEW, CASES_VIEW,
  //   REPORTS_VIEW, SEARCH_VIEW, REVIEWER_OPS_VIEW, GOVERNANCE_VIEW,
  //   OPS_CENTER_VIEW, TEAM_MANAGE, BILLING_MANAGE) remain the
  //   canonical gating keys. Retained in Phase 3 to avoid a
  //   destructive capability-shape change pre-Phase-4.
  //   See docs/architecture/domain-debt-register.md (DBT-CAP-01).
  if (isTeam) {
    setMany(
      map,
      [
        "ORG_EVIDENCE_VIEW",
        "ORG_CASES_VIEW",
        "ORG_REPORTS_VIEW",
        "ORG_SEARCH_VIEW",
        "ORG_REVIEWER_OPS_VIEW",
        "ORG_GOVERNANCE_VIEW",
        "ORG_OPS_VIEW",
      ],
      true,
    );
    if (isAdmin) {
      setMany(map, ["ORG_TEAM_MANAGE", "ORG_BILLING_MANAGE"], true);
    }
  }

  return map;
}

/**
 * Bounded persona resolution from (role + scope).
 *
 * Used for downstream UI ordering — does NOT gate capabilities.
 */
export function resolvePersona(input: {
  scope: WorkspaceScope | null;
  role: WorkspaceRole | null;
}): "INDIVIDUAL" | "WORKSPACE_OWNER" | "TEAM_ADMIN" | "TEAM_MEMBER" | "TEAM_VIEWER" {
  if (input.scope === "PERSONAL") return "INDIVIDUAL";
  if (input.scope !== "TEAM") return "INDIVIDUAL";
  switch (input.role) {
    case "OWNER":
      return "WORKSPACE_OWNER";
    case "ADMIN":
      return "TEAM_ADMIN";
    case "VIEWER":
      return "TEAM_VIEWER";
    default:
      return "TEAM_MEMBER";
  }
}
