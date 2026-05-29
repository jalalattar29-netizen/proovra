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
  { href: "/admin/dashboard", label: "Platform Analytics" },
  { href: "/admin/audit", label: "Audit Integrity" },
  { href: "/admin/demo-requests", label: "Demo Requests" },
  { href: "/admin/identity", label: "Identity Governance" },
] as const;
