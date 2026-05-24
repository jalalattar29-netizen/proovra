/**
 * PHASE R2 — Canonical navigation group definitions.
 *
 * The bounded vocabulary of sidebar groups + the bounded set of route
 * ids that may appear in the primary (root) group. Other routes
 * continue to render in their domain-derived group ("Workspace",
 * "Operations", "Governance & Compliance") or in "More / Advanced".
 *
 * Rules:
 *
 *   1. The primary group is BOUNDED. Workflow / persona may NOT
 *      promote a non-canonical route into root nav. Workflow can
 *      still influence ordering and emphasis within other groups.
 *
 *   2. Group titles are pinned by CR0
 *      (`phase-cr0-system-freeze-baseline.test.ts` Part 2). New root
 *      groups require a CR6 sign-off.
 *
 *   3. Adding or removing an id from `CANONICAL_PRIMARY_ROUTE_IDS`
 *      is a deliberate IA decision that requires updating the R2
 *      doc + tests in the same PR.
 *
 * R2 Part 1 — "Root primary nav ONLY: Home, Capture, Evidence,
 * Cases, Reports, Search."
 */

/**
 * The bounded set of route ids allowed in the root "Primary
 * workflows" group. Anything else that workflow-exposure would have
 * placed in `primaryItems` is rerouted to its domain group instead
 * (so it remains discoverable, just not at root prominence).
 */
export const CANONICAL_PRIMARY_ROUTE_IDS: ReadonlySet<string> = new Set([
  "workspace.home",
  "workspace.capture",
  "workspace.evidence",
  "workspace.cases",
  "workspace.reports",
  "workspace.search",
]);

/**
 * Canonical sidebar group ids + titles. These mirror the existing
 * `buildSidebarGroups` output so the IA stays stable; R2 formalizes
 * the contract.
 */
export const SIDEBAR_GROUP_PRIMARY = {
  id: "sidebar.primary-workflows",
  title: "Primary workflows",
  domain: "PRIMARY_WORKFLOWS",
} as const;

export const SIDEBAR_GROUP_WORKSPACE = {
  id: "sidebar.workspace",
  title: "Workspace",
  domain: "PERSONAL_WORKSPACE",
  /** Route-registry domains that feed this group. */
  sourceDomains: ["PERSONAL_WORKSPACE", "ORGANIZATION_WORKSPACE", "TEAM_ONLY"],
} as const;

export const SIDEBAR_GROUP_OPERATIONS = {
  id: "sidebar.operations",
  title: "Operations",
  domain: "OPS",
  sourceDomains: ["REVIEW_OPERATIONS", "OPS"],
} as const;

export const SIDEBAR_GROUP_GOVERNANCE = {
  id: "sidebar.governance",
  title: "Governance & Compliance",
  domain: "GOVERNANCE",
  sourceDomains: ["GOVERNANCE"],
} as const;

/**
 * Bounded set of allowed root group titles. Synchronized with the
 * CR0 baseline test (`ALLOWED_ROOT_GROUP_TITLES`). Adding a new
 * title here without updating the CR0 pin is a contract break.
 */
export const ALLOWED_ROOT_GROUP_TITLES: ReadonlyArray<string> = [
  SIDEBAR_GROUP_PRIMARY.title,
  SIDEBAR_GROUP_WORKSPACE.title,
  SIDEBAR_GROUP_OPERATIONS.title,
  SIDEBAR_GROUP_GOVERNANCE.title,
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
