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
import { CAPABILITY_KEYS, } from "./types.js";
function emptyMap() {
    const out = {};
    for (const key of CAPABILITY_KEYS)
        out[key] = false;
    return out;
}
function setMany(map, keys, value) {
    for (const k of keys) {
        map[k] = value;
    }
}
/**
 * Resolve the bounded capability matrix for a viewer.
 *
 * Returns a CapabilityMap with every CAPABILITY_KEY mapped to a boolean.
 */
export function resolveCapabilities(input) {
    const map = emptyMap();
    const { scope, role, isPlatformAdmin } = input;
    const isPersonal = scope === "PERSONAL";
    const isTeam = scope === "TEAM";
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
        setMany(map, [
            "ACCOUNT_SETTINGS_VIEW",
            "ACCOUNT_BILLING_VIEW",
            "ACCOUNT_UPGRADE_VIEW",
            "ORGANIZATION_CREATE",
            "ORGANIZATION_JOIN",
        ], true);
        if (isPlatformAdmin) {
            setMany(map, [
                "PLATFORM_ADMIN",
                "OPS_CENTER_VIEW",
                "OBSERVABILITY_VIEW",
                "RUNBOOKS_VIEW",
                "SECURITY_CENTER_VIEW",
                "DASHBOARD_VIEW",
            ], true);
        }
        return map;
    }
    // ============================================================
    // Universally-available (workspace-scoped read) capabilities.
    // ============================================================
    setMany(map, [
        "DASHBOARD_VIEW",
        "EVIDENCE_VIEW",
        "EVIDENCE_CAPTURE",
        "CASES_VIEW",
        "REPORTS_VIEW",
        "SEARCH_VIEW",
        "SETTINGS_VIEW",
    ], true);
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
        setMany(map, [
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
        ], true);
        // Personal cases have no team assignments — CASE_ASSIGN stays
        // false. No reviewer ops, no governance acts, no team manage.
        // OPS_CENTER_VIEW is an operator capability and is NOT granted
        // to personal users.
    }
    // ============================================================
    // Team-workspace shape
    // ============================================================
    if (isTeam) {
        setMany(map, [
            "TEAM_VIEW",
            "REVIEWER_OPS_VIEW",
            "SLA_VIEW",
            "ESCALATIONS_VIEW",
            "GOVERNANCE_VIEW",
            "LIFECYCLE_VIEW",
            "OPS_CENTER_VIEW",
            "OBSERVABILITY_VIEW",
            "RUNBOOKS_VIEW",
        ], true);
        if (isWriter) {
            setMany(map, [
                "CASES_MANAGE",
                "REVIEWER_OPS_ACT",
                "REVIEW_ASSIGN",
                "REVIEW_REASSIGN",
                "REVIEW_ESCALATE",
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
            ], true);
        }
        if (isAdmin) {
            setMany(map, [
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
            ], true);
        }
        if (isOwner) {
            // OWNER gets everything ADMIN does + nothing extra here. Kept
            // as a branch for clarity / future expansion.
            map.BILLING_MANAGE = true;
        }
    }
    // ============================================================
    // Platform admin elevation
    // ============================================================
    if (isPlatformAdmin) {
        setMany(map, [
            "PLATFORM_ADMIN",
            "OPS_CENTER_VIEW",
            "OBSERVABILITY_VIEW",
            "RUNBOOKS_VIEW",
            "SECURITY_CENTER_VIEW",
        ], true);
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
    setMany(map, [
        "ACCOUNT_SETTINGS_VIEW",
        "ACCOUNT_BILLING_VIEW",
        "ACCOUNT_UPGRADE_VIEW",
        "ORGANIZATION_CREATE",
        "ORGANIZATION_JOIN",
    ], true);
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
        setMany(map, [
            "PERSONAL_CAPTURE",
            "PERSONAL_EVIDENCE_VIEW",
            "PERSONAL_CASES_VIEW",
            "PERSONAL_REPORTS_VIEW",
            "PERSONAL_SEARCH_VIEW",
        ], true);
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
        setMany(map, [
            "ORG_EVIDENCE_VIEW",
            "ORG_CASES_VIEW",
            "ORG_REPORTS_VIEW",
            "ORG_SEARCH_VIEW",
            "ORG_REVIEWER_OPS_VIEW",
            "ORG_GOVERNANCE_VIEW",
            "ORG_OPS_VIEW",
        ], true);
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
export function resolvePersona(input) {
    if (input.scope === "PERSONAL")
        return "INDIVIDUAL";
    if (input.scope !== "TEAM")
        return "INDIVIDUAL";
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
