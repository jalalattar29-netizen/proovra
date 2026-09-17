/**
 * PV-PLACE-001 / PV-DUP-001 — `/admin` IS PLATFORM ADMINISTRATION ONLY.
 *
 * Eleven pages administered the operator's OWN workspace from under the
 * platform console's URL and gate. Owner decision PV-OD-001 moved them to their
 * tenant homes; the identity-providers console merged into the canonical SSO
 * console. These cases pin the move from every side a regression would come
 * from:
 *
 *   - every old URL is a PERMANENT, SINGLE-HOP redirect to the new one, and
 *     the query string travels with it (Next.js forwards it by default, so a
 *     redirect whose destination carries its own query would drop it — none
 *     may);
 *   - the providers redirect precedes the /admin/identity wildcard, so it lands
 *     on the SSO console and not on a page that no longer exists;
 *   - the three `/operations/*` paths that used to redirect INTO the platform
 *     console no longer redirect at all — they are the canonical pages, and a
 *     surviving redirect would make them unreachable;
 *   - no redirect points at a moved URL, which would be a two-hop chain;
 *   - the pages physically live at the new paths and nowhere under /admin;
 *   - each new home is registered with TENANT authority, not PLATFORM_ADMIN.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Redirect = { source: string; destination: string; permanent: boolean };

async function redirects(): Promise<ReadonlyArray<Redirect>> {
  const mod = (await import("../next.config.js" as string)) as unknown as {
    default: { redirects: () => Promise<unknown[]> };
  };
  return (await mod.default.redirects()) as ReadonlyArray<Redirect>;
}

const MOVED: ReadonlyArray<{ from: string; to: string; page: string; routeId: string }> = [
  { from: "/admin/identity", to: "/security-center/identity", page: "security-center/identity/page.tsx", routeId: "security_center.identity" },
  { from: "/admin/identity/permission-matrix", to: "/security-center/identity/permission-matrix", page: "security-center/identity/permission-matrix/page.tsx", routeId: "security_center.identity_permission_matrix" },
  { from: "/admin/identity/runtime", to: "/security-center/identity/runtime", page: "security-center/identity/runtime/page.tsx", routeId: "security_center.identity_runtime" },
  { from: "/admin/identity/scim", to: "/security-center/identity/scim", page: "security-center/identity/scim/page.tsx", routeId: "security_center.identity_scim" },
  { from: "/admin/identity/sessions", to: "/security-center/identity/sessions", page: "security-center/identity/sessions/page.tsx", routeId: "security_center.identity_sessions" },
  { from: "/admin/identity/timeline", to: "/security-center/identity/timeline", page: "security-center/identity/timeline/page.tsx", routeId: "security_center.identity_timeline" },
  { from: "/admin/identity/access-reviews", to: "/security-center/identity/access-reviews", page: "security-center/identity/access-reviews/page.tsx", routeId: "security_center.identity_access_reviews" },
  { from: "/admin/identity/providers", to: "/security-center/sso", page: "security-center/sso/page.tsx", routeId: "security_center.sso" },
  { from: "/admin/security", to: "/security-center/posture", page: "security-center/posture/page.tsx", routeId: "security_center.posture" },
  { from: "/admin/platform/analytics", to: "/operations/analytics", page: "operations/analytics/page.tsx", routeId: "operations.analytics" },
  { from: "/admin/platform/automation", to: "/operations/automation", page: "operations/automation/page.tsx", routeId: "operations.automation" },
  { from: "/admin/platform/reliability", to: "/operations/reliability", page: "operations/reliability/page.tsx", routeId: "operations.reliability" },
];

/** Resolve one path through the redirect list the way Next.js does: first match wins. */
function resolveOnce(rules: ReadonlyArray<Redirect>, path: string): Redirect | null {
  for (const r of rules) {
    if (r.source === path) return r;
    const wildcard = r.source.match(/^(.*)\/:path\*$/);
    if (wildcard && path.startsWith(`${wildcard[1]}/`)) {
      return { ...r, destination: r.destination.replace(":path*", path.slice(wildcard[1].length + 1)) };
    }
  }
  return null;
}

for (const m of MOVED) {
  test(`${m.from} is a permanent single-hop redirect to ${m.to}`, async () => {
    const rules = await redirects();
    const hit = resolveOnce(rules, m.from);
    assert.ok(hit, `${m.from} must still resolve — bookmarks and emailed links point at it`);
    assert.equal(hit!.destination, m.to);
    assert.equal(hit!.permanent, true);
    assert.ok(!hit!.destination.includes("?"), "the destination must not replace the caller's query");
    assert.equal(resolveOnce(rules, hit!.destination), null, `${m.to} must not redirect again`);
  });

  test(`${m.to} is a real page, and nothing is left under /admin`, () => {
    assert.ok(existsSync(resolve(APP_ROOT, "app/(app)", m.page)), `${m.page} must exist`);
    const old = m.from.replace(/^\//, "");
    assert.equal(
      existsSync(resolve(APP_ROOT, "app/(app)", old, "page.tsx")),
      false,
      `app/(app)/${old}/page.tsx must be gone — a page under /admin would still resolve before the redirect`,
    );
  });

  test(`${m.routeId} is registered at ${m.to} with tenant authority`, () => {
    const r = (ROUTE_REGISTRY as ReadonlyArray<{
      id: string;
      href: string;
      requiredActiveSpace: string;
      requiredCapabilities: ReadonlyArray<string>;
      domain: string;
    }>).find((x) => x.id === m.routeId);
    assert.ok(r, `${m.routeId} must be registered`);
    assert.equal(r!.href, m.to);
    assert.notEqual(r!.requiredActiveSpace, "PLATFORM_ADMIN");
    assert.notEqual(r!.domain, "PLATFORM_ADMIN");
    assert.ok(!r!.requiredCapabilities.includes("PLATFORM_ADMIN"));
  });
}

test("the providers redirect wins over the /admin/identity wildcard", async () => {
  const rules = await redirects();
  const providers = rules.findIndex((r) => r.source === "/admin/identity/providers");
  const wildcard = rules.findIndex((r) => r.source === "/admin/identity/:path*");
  assert.ok(providers >= 0 && wildcard >= 0);
  assert.ok(providers < wildcard, "first match wins; the specific rule must come first");
});

test("the three /operations pages are no longer redirect sources", async () => {
  const rules = await redirects();
  for (const path of ["/operations/analytics", "/operations/automation", "/operations/reliability"]) {
    assert.equal(
      rules.find((r) => r.source === path),
      undefined,
      `${path} is the canonical page now; a redirect from it would make it unreachable`,
    );
  }
});

test("no redirect anywhere points INTO a moved URL (no two-hop chains)", async () => {
  const rules = await redirects();
  const movedFrom = new Set(MOVED.map((m) => m.from));
  const chained = rules
    .filter((r) => movedFrom.has(r.destination) || r.destination.startsWith("/admin/identity/"))
    .map((r) => `${r.source} -> ${r.destination}`);
  assert.deepEqual(chained, []);
});

test("the old admin-identity route ids are gone from the registry", () => {
  const ids = new Set((ROUTE_REGISTRY as ReadonlyArray<{ id: string }>).map((r) => r.id));
  for (const gone of [
    "admin.identity",
    "admin.identity_providers",
    "admin.identity_permission_matrix",
    "admin.identity_runtime",
    "admin.identity_scim",
    "admin.identity_sessions",
    "admin.identity_timeline",
    "admin.identity_access_reviews",
    "platform.security",
    "platform.analytics",
    "platform.automation",
    "platform.reliability",
  ]) {
    assert.equal(ids.has(gone), false, `${gone} must not survive the move`);
  }
});
