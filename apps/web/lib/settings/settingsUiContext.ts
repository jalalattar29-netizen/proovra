/**
 * Canonical Settings UI-context resolver (2026-07-16).
 *
 * ONE pure derivation that decides which Settings-overview sections are
 * RELEVANT for the current account/workspace/plan/role — including the
 * billing context that replaces the old context-blind "Current plan: FREE"
 * card. Inputs come exclusively from the backend-computed platform-context
 * envelope (never from labels or frontend-only plan names).
 *
 * RELEVANCE ONLY — never authorization. Every destination this resolver
 * points at keeps its own backend enforcement (route gates + API auth).
 * Universal personal account sections (profile, security, preferences,
 * privacy, notifications) are NEVER plan- or role-gated here.
 */

export type SettingsBillingContext = {
  /** Which billing reality applies to the ACTIVE workspace. */
  contextType: "personal" | "organization" | "enterprise-contract";
  /** Human plan label for display (e.g. "FREE", "PRO", "TEAM"). */
  displayPlan: string;
  /** Label prefix that makes the scope unambiguous. */
  scopeLabel: string;
  /** True when the viewer may open billing management for this context. */
  canManageBilling: boolean;
  /** Where the card's action routes (null = no action for this viewer). */
  billingHref: string | null;
  /** Organization name when the plan is inherited from an organization. */
  managedByOrgName: string | null;
};

export type SettingsUiContext = {
  // ACCOUNT — universal, never gated.
  showProfile: true;
  showSecurity: true;
  showPreferences: true;
  showPrivacy: true;
  // WORKSPACE
  showNotifications: boolean;
  activeWorkspaceName: string;
  /**
   * The viewer's role in the ACTIVE organization, or null outside one.
   *
   * LEGACY FIELD MIGRATION (2026-09-04) — Settings read this from
   * `envelope.workspace.membership.role`. `envelope.workspace` is in its
   * deprecation window (`phase-37-95-scale-closure` names the replacement:
   * `envelope.organizations` + `envelope.personalSpace`), and this file
   * already resolves `activeOrg` from exactly that — the organization whose
   * id matches the active space and whose membership is ACTIVE.
   *
   * Null in a personal space, because a personal space has no organization
   * role to hold. It was null there before too; the difference is where the
   * answer comes from.
   */
  activeRole: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
  isPersonalWorkspace: boolean;
  showAiSettings: boolean;
  showReviewerCriteria: boolean;
  // BILLING
  billing: SettingsBillingContext;
  // ORGANIZATION ADMINISTRATION (links only; controls stay in org admin)
  showOrgAdminLinks: boolean;
  orgAdminOrgId: string | null;
};

export type SettingsUiContextInput = {
  activeSpace: {
    type: "PERSONAL" | "ORGANIZATION" | null;
    id: string | null;
    displayName?: string | null;
  } | null;
  /** Plan of the ACTIVE workspace (org plan when ORGANIZATION). */
  workspacePlan: string | null;
  /** Account-tier plan (personal Entitlement). */
  accountPlan: string | null;
  /**
   * PHASE 12 POINT 4 STEP 1 — SERVER-projected authority to open billing
   * management for the ACTIVE workspace, read from
   * `envelope.capabilities.BILLING_MANAGE`.
   *
   * This replaces the former `activeOrgRole === "OWNER" || "ADMIN"` client
   * comparison. `capability-registry.ts` grants BILLING_MANAGE to exactly the
   * OWNER/ADMIN membership the billing routes enforce, so the affordance and
   * the enforcement cannot disagree.
   *
   * `null` = envelope loading / degraded / capability absent → FAIL CLOSED
   * (no billing action rendered).
   */
  canManageBilling: boolean | null;
  /**
   * SERVER-projected authority to administer the ACTIVE workspace, read from
   * `envelope.capabilities.SETTINGS_MANAGE`. Gates the organization-admin
   * LINKS only (the org-admin surfaces keep their own server gate).
   * `null` = unknown → FAIL CLOSED (links hidden).
   */
  canManageWorkspaceSettings: boolean | null;
  /**
   * SERVER-derived enterprise-contract flag (`envelope.flags
   * .isEnterpriseWorkspace`, computed from the commercial catalog /
   * enterprise contract). Replaces the client `orgPlan === "ENTERPRISE"`
   * comparison that made the browser the commercial authority.
   */
  isEnterpriseWorkspace: boolean;
  organizations: ReadonlyArray<{
    id: string;
    name?: string | null;
    displayName?: string | null;
    membershipStatus: "ACTIVE" | "PENDING" | "INACTIVE";
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
    plan?: string | null;
  }>;
  /** Canonical plan feature flags from envelope.planFeatures. */
  planFeatures?: {
    reviewerOperationsIncluded: boolean;
    /**
     * Monthly AI-assistance allowance (0 = not included, n>0 = cap,
     * null = custom/Enterprise, undefined = envelope predates the field).
     */
    aiAssistanceMonthlyOperations?: number | null;
  } | null;
};

function planLabel(plan: string | null | undefined): string {
  return (plan ?? "FREE").toUpperCase();
}

export function deriveSettingsUiContext(
  input: SettingsUiContextInput,
): SettingsUiContext {
  const isOrg = input.activeSpace?.type === "ORGANIZATION";
  const activeOrgId = isOrg ? (input.activeSpace?.id ?? null) : null;
  const activeOrg = activeOrgId
    ? (input.organizations.find(
        (o) => o.id === activeOrgId && o.membershipStatus === "ACTIVE",
      ) ?? null)
    : null;
  // PHASE 12 POINT 4 STEP 1 — both authorities are SERVER projections now.
  // The former `activeOrgRole === "OWNER" || activeOrgRole === "ADMIN"` client
  // comparison is gone; `activeOrg` survives for the display NAME only.
  const canManageBilling = input.canManageBilling === true;
  const canAdministerWorkspace = input.canManageWorkspaceSettings === true;
  const orgName =
    activeOrg?.displayName ?? activeOrg?.name ?? input.activeSpace?.displayName ?? "your organization";

  // -------------------------------------------------------------------------
  // Billing context — replaces the context-blind personal-plan card.
  //   - PERSONAL workspace → the user's own plan, clearly labeled personal.
  //   - ORGANIZATION workspace → the ORG's plan. Ordinary members see it as
  //     "Managed by <org>" with NO self-service action; holders of the
  //     server-projected BILLING_MANAGE capability get the billing action.
  //     An enterprise contract reads as managed with no self-service upgrade
  //     CTA.
  //
  // Both the authority (`canManageBilling`) and the contract classification
  // (`isEnterpriseWorkspace`) are SERVER projections. The plan STRINGS below
  // are used for the display label only — never for a decision.
  // -------------------------------------------------------------------------
  let billing: SettingsBillingContext;
  if (!isOrg) {
    billing = {
      contextType: "personal",
      displayPlan: planLabel(input.accountPlan ?? input.workspacePlan),
      scopeLabel: "Personal plan",
      canManageBilling,
      billingHref: canManageBilling ? "/billing" : null,
      managedByOrgName: null,
    };
  } else {
    const isEnterprise = input.isEnterpriseWorkspace;
    billing = {
      contextType: isEnterprise ? "enterprise-contract" : "organization",
      displayPlan: planLabel(input.workspacePlan ?? activeOrg?.plan),
      scopeLabel: isEnterprise ? "Organization agreement" : "Organization plan",
      canManageBilling,
      // An enterprise contract is sales-managed: even admins get no
      // self-service upgrade CTA; members without BILLING_MANAGE get no
      // billing action at all.
      billingHref: canManageBilling && !isEnterprise ? "/billing" : null,
      managedByOrgName: orgName,
    };
  }

  return {
    showProfile: true,
    showSecurity: true,
    showPreferences: true,
    showPrivacy: true,
    // Notification preferences are workspace-scoped and exist for every
    // workspace kind; the child page itself handles workspace selection.
    showNotifications: true,
    activeWorkspaceName: isOrg ? orgName : "Personal Space",
    isPersonalWorkspace: !isOrg,
    // AI assistance/governance is a real per-workspace surface for
    // personal AND org workspaces (route workspace.ai_settings; API
    // enforces owner/admin on write) — EXCEPT a personal plan whose AI
    // allowance is 0 (FREE): no AI is included, so no card renders
    // (2026-07-17 remediation §10; the page itself shows an honest
    // "not included" surface if reached directly). Reviewer criteria
    // only means anything where reviewer operations are commercially
    // included.
    showAiSettings: !(
      !isOrg && input.planFeatures?.aiAssistanceMonthlyOperations === 0
    ),
    showReviewerCriteria: input.planFeatures?.reviewerOperationsIncluded === true,
    billing,
    showOrgAdminLinks: isOrg && canAdministerWorkspace,
    activeRole: activeOrg?.role ?? null,
    orgAdminOrgId: isOrg && canAdministerWorkspace ? activeOrgId : null,
  };
}
