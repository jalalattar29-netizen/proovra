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
  const activeOrgRole = activeOrg?.role ?? null;
  const isActiveOrgAdmin = activeOrgRole === "OWNER" || activeOrgRole === "ADMIN";
  const orgName =
    activeOrg?.displayName ?? activeOrg?.name ?? input.activeSpace?.displayName ?? "your organization";

  // -------------------------------------------------------------------------
  // Billing context — replaces the context-blind personal-plan card.
  //   - PERSONAL workspace → the user's own plan, clearly labeled personal.
  //   - ORGANIZATION workspace → the ORG's plan. Ordinary members see it as
  //     "Managed by <org>" with NO self-service action; org OWNER/ADMIN get
  //     the billing action. ENTERPRISE reads as a managed contract with no
  //     self-service upgrade CTA.
  // -------------------------------------------------------------------------
  let billing: SettingsBillingContext;
  if (!isOrg) {
    billing = {
      contextType: "personal",
      displayPlan: planLabel(input.accountPlan ?? input.workspacePlan),
      scopeLabel: "Personal plan",
      canManageBilling: true,
      billingHref: "/billing",
      managedByOrgName: null,
    };
  } else {
    const orgPlan = planLabel(input.workspacePlan ?? activeOrg?.plan);
    const isEnterprise = orgPlan === "ENTERPRISE";
    billing = {
      contextType: isEnterprise ? "enterprise-contract" : "organization",
      displayPlan: orgPlan,
      scopeLabel: isEnterprise ? "Organization agreement" : "Organization plan",
      canManageBilling: isActiveOrgAdmin,
      // Enterprise is contract-managed: even admins get no self-service
      // upgrade CTA; non-admin members get no billing action at all.
      billingHref: isActiveOrgAdmin && !isEnterprise ? "/billing" : null,
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
    showOrgAdminLinks: isActiveOrgAdmin,
    orgAdminOrgId: isActiveOrgAdmin ? activeOrgId : null,
  };
}
