/**
 * Canonical admin-console navigation list.
 *
 * SINGLE SOURCE OF TRUTH. Both `AdminConsoleNav.tsx` (rendered above the
 * content area on every `/admin/*` sub-page) and `app/(app)/admin/page.tsx`
 * (the admin landing page's top pill row) import this list so the two
 * surfaces can never drift again.
 *
 * Items here are the top-level admin sections only. Deep sub-pages under
 * `/admin/identity/*` are surfaced from the `/admin/identity` console grid
 * rather than the pill nav, so the nav does not become a long scrolling row.
 *
 * RBAC is enforced at the layout level via `PageRouteGate routeId="platform.admin"`
 * (see `app/(app)/admin/layout.tsx`) and by backend RBAC on every
 * `/v1/admin/*` route. This list is the UX layer.
 */

export type AdminNavItem = {
  href: string;
  label: string;
};

export const ADMIN_NAV_ITEMS: ReadonlyArray<AdminNavItem> = [
  { href: "/admin", label: "Console Home" },
  { href: "/admin/executive", label: "Executive" },
  // Platform Admin Control Center — customer/org/user/ops/billing/security.
  { href: "/admin/organizations", label: "Customers & Orgs" },
  { href: "/admin/users", label: "Users & Identity" },
  { href: "/admin/search", label: "Search" },
  { href: "/admin/dashboard", label: "Platform Analytics" },
  { href: "/admin/evidence-ops", label: "Evidence Ops" },
  { href: "/admin/adoption", label: "Adoption" },
  { href: "/admin/billing", label: "Billing & Revenue" },
  { href: "/admin/costs", label: "Costs" },
  { href: "/admin/security", label: "Security & Incidents" },
  { href: "/admin/platform-health", label: "Platform Health" },
  { href: "/admin/alerts", label: "Alerts" },
  { href: "/admin/timeline", label: "Timeline" },
  // Enterprise provisioning was reachable only by direct URL — surface it.
  { href: "/admin/provisioning", label: "Enterprise Provisioning" },
  { href: "/admin/demo-requests", label: "Demo Requests" },
  { href: "/admin/audit", label: "Audit Integrity" },
  { href: "/admin/identity", label: "Identity Governance" },
  // Platform operations surfaces (platform-admin only, reachable from the
  // admin console so no internal route requires guessing a URL).
  { href: "/operations/readiness", label: "Operations Readiness" },
  { href: "/operations/observability", label: "Observability" },
  { href: "/tools", label: "Tools" },
] as const;
