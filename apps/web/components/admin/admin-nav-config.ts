/**
 * THE Platform Admin navigation.
 *
 * SINGLE SOURCE OF TRUTH. `AdminConsoleNav` and the `/admin` landing page both
 * import this list, so the two surfaces cannot drift.
 *
 * ADM-013 / ADM-025 / ADM-033 (2026-08-27) — REBUILT.
 *
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * Three separate problems in one list.
 *
 * VOCABULARY (ADM-033). "Customers & Orgs", "Users & Identity", "Platform
 * Analytics", "Evidence Ops", "Security & Incidents", "Identity Governance" —
 * six labels for concepts the API and the data model name differently again.
 * The word "Team" meant four different populations depending on the page.
 *
 * SCOPE (ADM-013). "Identity Governance" pointed at `/admin/identity`, which is
 * a WORKSPACE-scoped surface: it calls `/v1/identity/*` bound to the admin's own
 * active workspace. It is not platform administration and listing it here told
 * an operator it was. The same is true of nine of the twelve `/admin/platform/*`
 * pages. Those surfaces are being re-homed; until they are, they are OFF this
 * nav — a link that promises platform scope and delivers one workspace is worse
 * than no link.
 *
 * TENANT LEAK. `/tools` is the tenant All-Tools index and left the console
 * entirely. Removed.
 *
 * THE STRUCTURE NOW
 * ---------------------------------------------------------------------------
 * Nine sections, each answering one operator question, in the order an operator
 * actually moves: what is happening → who are they → what do they have → who
 * pays → what is broken → is the platform healthy → what did we do.
 *
 * The specialist lead surfaces (Demo requests, Contact sales, Provisioning,
 * Adoption, Costs, Search) are kept — they are operationally useful and each
 * answers a question none of the nine does — but they are grouped after the
 * control-plane core rather than interleaved with it.
 */

export type AdminNavItem = {
  href: string;
  label: string;
  /** The question this surface answers. Rendered as the nav tooltip. */
  purpose: string;
  group: "CONTROL_PLANE" | "COMMERCIAL" | "PLATFORM";
};

export const ADMIN_NAV_ITEMS: ReadonlyArray<AdminNavItem> = [
  {
    href: "/admin",
    label: "Overview",
    purpose: "What is happening across PROOVRA right now?",
    group: "CONTROL_PLANE",
  },
  {
    href: "/admin/customers",
    label: "Customers",
    purpose: "Which companies are our customers?",
    group: "CONTROL_PLANE",
  },
  {
    href: "/admin/workspaces",
    label: "Workspaces",
    purpose: "What customer spaces exist, and what governs each one?",
    group: "CONTROL_PLANE",
  },
  {
    href: "/admin/users",
    label: "People",
    purpose: "Who are our users, and what do they pay for?",
    group: "CONTROL_PLANE",
  },
  {
    href: "/admin/billing",
    label: "Billing",
    purpose: "Who pays for what, and what is failing?",
    group: "CONTROL_PLANE",
  },
  {
    href: "/admin/operations",
    label: "Operations",
    purpose: "What is broken, and whose is it?",
    group: "CONTROL_PLANE",
  },
  {
    href: "/admin/evidence-ops",
    label: "Evidence health",
    purpose: "What evidence is stuck or failed, and for whom?",
    group: "CONTROL_PLANE",
  },
  {
    href: "/admin/platform-health",
    label: "System health",
    purpose: "Is the infrastructure healthy?",
    group: "CONTROL_PLANE",
  },
  {
    href: "/admin/audit",
    label: "Admin activity",
    purpose: "What did we do, and who did it?",
    group: "CONTROL_PLANE",
  },

  // ---- Commercial / go-to-market specialists -------------------------------
  {
    href: "/admin/provisioning",
    label: "Provisioning",
    purpose: "Activate an enterprise customer.",
    group: "COMMERCIAL",
  },
  {
    href: "/admin/demo-requests",
    label: "Demo requests",
    purpose: "Triage inbound demo requests.",
    group: "COMMERCIAL",
  },
  {
    href: "/admin/contact-sales",
    label: "Contact sales",
    purpose: "Triage inbound sales inquiries.",
    group: "COMMERCIAL",
  },
  {
    href: "/admin/executive",
    label: "Executive",
    purpose: "Revenue, leads and usage KPIs.",
    group: "COMMERCIAL",
  },

  // ---- Platform analysis ---------------------------------------------------
  {
    href: "/admin/search",
    label: "Search",
    purpose: "Find any customer, workspace, person or record.",
    group: "PLATFORM",
  },
  {
    href: "/admin/adoption",
    label: "Adoption",
    purpose: "Which capabilities are actually being used?",
    group: "PLATFORM",
  },
  {
    href: "/admin/costs",
    label: "Costs",
    purpose: "What are we spending with providers?",
    group: "PLATFORM",
  },
  {
    href: "/admin/dashboard",
    label: "Traffic",
    purpose: "Marketing funnel, geography and page analytics.",
    group: "PLATFORM",
  },
  {
    href: "/admin/support-access",
    label: "Support access",
    purpose: "Support-access and break-glass grants.",
    group: "PLATFORM",
  },
  {
    href: "/admin/platform/readiness",
    label: "Readiness",
    purpose: "Production readiness posture.",
    group: "PLATFORM",
  },
  {
    // ADM-013 PHASE 1 — promoted OUT of TENANT_SCOPED_ADMIN_PATHS. The page no
    // longer resolves an active workspace, no longer passes a teamId, and reads
    // three platform-gated endpoints. It is genuinely platform-wide now, so it
    // belongs in the nav instead of behind the "this is not what it says it is"
    // banner.
    href: "/admin/platform/observability",
    label: "Observability",
    purpose: "Is the runtime healthy, and what is firing?",
    group: "PLATFORM",
  },
] as const;

/**
 * Surfaces that live under `/admin/*` but are NOT platform administration.
 *
 * Each of these resolves a `teamId` from the operator's own active workspace
 * and calls a tenant API. They are deliberately absent from the nav above and
 * are listed here so the omission is a recorded decision rather than something
 * that looks like an oversight to the next person reading this file. The
 * re-homing work is ADM-013; until it lands they remain reachable by URL and by
 * the command palette, and `AdminTenantScopeNotice` tells an operator who
 * arrives on one exactly what they are looking at.
 */
export const TENANT_SCOPED_ADMIN_PATHS: ReadonlyArray<string> = [
  "/admin/identity",
  "/admin/identity/providers",
  "/admin/identity/scim",
  "/admin/identity/sessions",
  "/admin/identity/permission-matrix",
  "/admin/identity/access-reviews",
  "/admin/identity/runtime",
  "/admin/identity/timeline",
  "/admin/platform/queues",
  "/admin/platform/exports",
  "/admin/platform/signers",
  "/admin/platform/media-graph",
  "/admin/platform/recovery",
  "/admin/platform/reliability",
  "/admin/platform/automation",
  "/admin/platform/analytics",
] as const;
