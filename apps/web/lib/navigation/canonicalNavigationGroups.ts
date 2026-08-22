/**
 * PHASE R2 + PHASE G0 — Canonical navigation group definitions.
 *
 * The bounded vocabulary of sidebar groups + the bounded set of route
 * ids that may appear in the primary (root) group.
 *
 * **Phase G0 (Operational Convergence Wave 1) — sidebar rewrite (B.1):**
 *
 *   The previous R2 group titles (`Primary workflows`, `Operations`,
 *   `Governance & Compliance`) are retired. The sidebar now renders
 *   the Phase B canonical operational hierarchy (Workspace ·
 *   Governance · Outputs · System) — matching
 *   `phaseBOperationalGroups.ts`.
 *
 *   The CR0 baseline test pin (`ALLOWED_ROOT_GROUP_TITLES`) has been
 *   updated in the same PR.
 *
 * Rules:
 *
 *   1. The primary group is BOUNDED. Workflow / persona may NOT
 *      promote a non-canonical route into root nav. Workflow can
 *      still influence ordering and emphasis within other groups.
 *
 *   2. Group titles are pinned by CR0 + the Phase G0 contract test
 *      (`phase-g0-operational-convergence.test.ts`). New root groups
 *      require a CR6 sign-off.
 *
 *   3. Adding or removing an id from `CANONICAL_PRIMARY_ROUTE_IDS`
 *      is a deliberate IA decision that requires updating this file
 *      + tests in the same PR.
 *
 * Phase B primary nav (post-G0):
 *   Workspace  · Home · Review · Matters · Evidence · Capture · Intake · Inbox · Search
 *   Governance · hub · Organizations · Security · Workspaces (admin)
 *   Outputs    · Reports
 *   System     · Settings · Billing · Notifications · Integrations · All Tools
 */

/**
 * The bounded set of route ids allowed in the root "Primary
 * workflows" group. Anything else that workflow-exposure would have
 * placed in `primaryItems` is rerouted to its domain group instead
 * (so it remains discoverable, just not at root prominence).
 */
export const CANONICAL_PRIMARY_ROUTE_IDS: ReadonlySet<string> = new Set([
  "workspace.home",
  "workspace.review",
  "workspace.cases",
  "workspace.evidence",
  "workspace.capture",
  "workspace.intake_links",
  "account.notifications",
  "workspace.search",
  "workspace.reports",
]);

/**
 * Phase G0 (B.1) — canonical sidebar groups.
 *
 * The titles align with `phaseBOperationalGroups.ts`. Group ids keep
 * the `sidebar.*` prefix to stay distinguishable from the Phase B
 * operational group enum used by breadcrumb / analytics.
 *
 * `sourceDomains` drives which route-registry `domain` rolls into
 * which sidebar group. `REVIEW_OPERATIONS` + `OPS` fold into the
 * Workspace group because review work is operator-facing daily
 * execution (Phase B intent). Platform-admin / observability /
 * runbook routes live in `OPS` but are marked
 * `advancedByDefault: true` and route into System via the secondary
 * disclosure surface.
 */

// SIDEBAR_GROUP_PRIMARY is retained as an internal alias for the
// Workspace group's primary row, kept to minimise churn in the
// grouping resolver. The TITLE is now "Workspace" (CR0 pin updated).
export const SIDEBAR_GROUP_PRIMARY = {
  id: "sidebar.primary-workflows",
  title: "Workspace",
  domain: "PRIMARY_WORKFLOWS",
} as const;

export const SIDEBAR_GROUP_WORKSPACE = {
  id: "sidebar.workspace",
  title: "Workspace",
  domain: "PERSONAL_WORKSPACE",
  /** Route-registry domains that feed this group. */
  sourceDomains: [
    "PERSONAL_WORKSPACE",
    "ORGANIZATION_WORKSPACE",
    "TEAM_ONLY",
    "REVIEW_OPERATIONS",
  ],
} as const;

export const SIDEBAR_GROUP_GOVERNANCE = {
  id: "sidebar.governance",
  title: "Governance",
  domain: "GOVERNANCE",
  sourceDomains: ["GOVERNANCE"],
} as const;

export const SIDEBAR_GROUP_OUTPUTS = {
  id: "sidebar.outputs",
  title: "Outputs",
  domain: "OUTPUTS",
  /**
   * Outputs has no route-registry domain of its own today — Reports
   * lives in PERSONAL_WORKSPACE. The grouping resolver routes
   * specific route ids into this group based on Phase B group
   * mapping.
   */
  sourceDomains: [] as ReadonlyArray<string>,
} as const;

export const SIDEBAR_GROUP_SYSTEM = {
  id: "sidebar.system",
  title: "System",
  domain: "SYSTEM",
  /**
   * OPS routes fold into System because they are platform-health
   * surfaces, not daily operator execution.
   */
  sourceDomains: ["OPS", "ACCOUNT"],
} as const;

/**
 * @deprecated Phase G0 — retained only for backward compatibility
 * with grep-style tests that still scan the canonical groups module.
 * The grouping resolver no longer renders a dedicated Operations
 * group; review work folds into Workspace and platform-health folds
 * into System.
 */
export const SIDEBAR_GROUP_OPERATIONS = {
  id: "sidebar.operations",
  title: "Workspace",
  domain: "WORKSPACE_LEGACY",
  sourceDomains: [] as ReadonlyArray<string>,
} as const;

/**
 * Bounded set of allowed root group titles. Synchronized with the
 * CR0 baseline test (`ALLOWED_ROOT_GROUP_TITLES`) — updated in the
 * same Phase G0 PR. Adding a new title here without updating CR0 is
 * a contract break.
 *
 * The "More / Advanced" disclosure container is still permitted but
 * is rendered as an in-group accordion, not a root group.
 */
export const ALLOWED_ROOT_GROUP_TITLES: ReadonlyArray<string> = [
  SIDEBAR_GROUP_WORKSPACE.title,
  SIDEBAR_GROUP_GOVERNANCE.title,
  SIDEBAR_GROUP_OUTPUTS.title,
  SIDEBAR_GROUP_SYSTEM.title,
  "All Tools",
  "More / Advanced",
];

/**
 * Cleaner copy for the degraded-route chips that previously rendered
 * raw architecture words. Used by `AppSidebarV2.tsx`'s
 * `degradationChip()` after R2 Part 7.
 *
 *   BEFORE → AFTER (R2 Part 7)
 *   "Org"     → "Requires organization"
 *   "Access"  → "Requires permission"
 *   "Setup"   → "Setup needed"        (kept; operationally clearer)
 *   "Upgrade" → "Upgrade required"    (kept; operationally clearer)
 */
export const DEGRADATION_CHIP_LABELS = {
  NEEDS_ORGANIZATION: "Requires organization",
  NEEDS_PERSONAL_OR_ORG: "Setup needed",
  DENIED_NO_CAPABILITY: "Requires permission",
  NEEDS_UPGRADE: "Upgrade required",
} as const;
