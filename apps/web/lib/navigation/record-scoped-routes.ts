/**
 * B2A-F-13 (Free-user audit 0ea0) — WHICH PAGES SHOW ONE TENANT'S RECORD.
 *
 * After a workspace switch the shell lands on /home from any page that shows a
 * single record of the previous workspace, so another tenant's object never
 * stays on screen under the new header. That list was a hand-written regex
 * naming eight families; /evidence-requests/:id, /redaction/:id,
 * /investigation/cases/:id/graph, /reviewer-ops/:id and
 * /governance-platform/access-reviews/:id were missing and re-rendered under
 * the new workspace with the old record's id.
 *
 * The list is now every dynamic route of the `app/(app)` tree, each classified
 * here as tenant-record or not. `__tests__/free-audit-c1a-shell-nav.test.ts`
 * walks the route tree and fails when a dynamic route is in neither list, so a
 * new record page cannot be forgotten again.
 */

/** Dynamic routes whose page shows a record of the ACTIVE workspace/organization. */
export const RECORD_SCOPED_ROUTE_TEMPLATES: ReadonlyArray<string> = [
  "/cases/[id]",
  "/collaboration-teams/[teamId]",
  "/evidence-requests/[id]",
  "/evidence/[id]",
  "/governance-platform/access-reviews/[campaignId]",
  "/investigation/cases/[caseId]",
  "/organizations/[id]",
  "/redaction/[projectId]",
  "/reviewer-ops/[reviewId]",
  "/teams/[id]",
  "/workflows/[id]",
];

/** Dynamic routes that do not show a tenant record (platform admin, public tokens, legal text). */
export const NON_TENANT_DYNAMIC_ROUTE_TEMPLATES: ReadonlyArray<string> = [
  "/admin/contact-sales/[id]",
  "/admin/customers/[id]",
  "/admin/demo-requests/[id]",
  "/admin/platform/runbooks/[slug]",
  "/admin/users/[id]",
  "/admin/workspaces/[id]",
  "/collaboration-teams/invites/[token]/accept",
  "/org-invites/[token]/accept",
  "/settings/legal/[slug]",
];

/** Static pages that sit where a record id would (never ids). */
const STATIC_SIBLINGS: ReadonlySet<string> = new Set(["/evidence/archive", "/collaboration-teams/invites"]);

function templateToRegex(template: string): RegExp {
  const body = template
    .split("/")
    .map((seg) => (/^\[.+\]$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}(?:/|$)`);
}

const NON_TENANT = NON_TENANT_DYNAMIC_ROUTE_TEMPLATES.map(templateToRegex);
const RECORD = RECORD_SCOPED_ROUTE_TEMPLATES.map(templateToRegex);

/** True when `pathname` shows a single record of the active tenant. */
export function isRecordScopedPath(pathname: string): boolean {
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (NON_TENANT.some((re) => re.test(path))) return false;
  for (const sibling of STATIC_SIBLINGS) {
    if (path === sibling || path.startsWith(`${sibling}/`)) return false;
  }
  return RECORD.some((re) => re.test(path));
}
