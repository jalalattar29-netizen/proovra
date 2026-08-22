/**
 * ATTENTION ARCHITECTURE — PHASE 4A RELEASE GATE (2026-08-22).
 *
 * `/operations` is becoming the TENANT Operations Center. Before that gate
 * can be relaxed, every PROOVRA-INTERNAL console that used to live beneath
 * it must have moved somewhere that is independently platform-admin-gated.
 *
 * WHY THE ORDER MATTERS
 * ---------------------
 * The audit found a complete, tenant-scoped operations backend
 * (`OperationalIncident`, `/v1/ops/*` with ack / resolve / assign) sitting
 * behind `requiredActiveSpace: "PLATFORM_ADMIN"` on the web route, while
 * eleven genuine platform consoles sat under the SAME `/operations/*`
 * namespace. Relaxing the parent first would have exposed cross-tenant
 * observability, queue replay and signer custody to every workspace
 * member for exactly as long as it took to notice.
 *
 * So the moves happen first and this test is the gate that proves it.
 * It is deliberately written against the ROUTE REGISTRY and the FILE
 * SYSTEM rather than against a running app, so it fails at build time
 * rather than in an environment.
 *
 * WHAT IT PROVES
 * --------------
 *   1. No `/operations/*` child is platform-admin-gated any more — i.e.
 *      nothing internal is still hiding under the tenant namespace.
 *   2. Every moved console is registered under the platform namespace AND
 *      still carries the platform-admin gate.
 *   3. The page files physically moved (a registry href alone would be a
 *      lie if the old page still resolved).
 *   4. A tenant context is denied every platform route, and the denial is
 *      the invisible `PLATFORM_ADMIN_ONLY` one — not a "request access"
 *      panel that would confirm the surface exists.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The eleven consoles moved out of the tenant namespace in Phase 4A. */
const MOVED_CONSOLES = [
  "runbooks",
  "observability",
  "reliability",
  "queues",
  "media-graph",
  "automation",
  "analytics",
  "readiness",
  "signers",
  "exports",
  "recovery",
] as const;

/**
 * The two `/operations/*` children that are genuinely tenant surfaces and
 * therefore stay. Both were already `PERSONAL_OR_ORG` before this phase.
 */
const TENANT_OPERATIONS_CHILDREN = ["quotas", "batch-analysis"] as const;

type Route = {
  id: string;
  href: string;
  domain: string;
  requiredActiveSpace?: string;
  requiredCapabilities?: ReadonlyArray<string>;
  fallbackBehavior?: string;
};

const routes = ROUTE_REGISTRY as ReadonlyArray<Route>;

function isPlatformGated(r: Route): boolean {
  return r.requiredActiveSpace === "PLATFORM_ADMIN" || r.domain === "PLATFORM_ADMIN";
}

// ---------------------------------------------------------------------------
// 1. The tenant namespace holds nothing internal.
// ---------------------------------------------------------------------------

test("no /operations/* child is platform-admin gated", () => {
  const offenders = routes
    .filter((r) => r.href.startsWith("/operations/"))
    .filter(isPlatformGated)
    .map((r) => `${r.id} (${r.href})`);
  assert.deepEqual(
    offenders,
    [],
    "a platform-only console is still registered under the tenant /operations namespace — " +
      "unlocking /operations would expose it",
  );
});

test("the only /operations/* children left are the known tenant surfaces", () => {
  const children = routes
    .filter((r) => r.href.startsWith("/operations/"))
    .map((r) => r.href.replace("/operations/", ""))
    .sort();
  assert.deepEqual(children, [...TENANT_OPERATIONS_CHILDREN].sort());
});

// ---------------------------------------------------------------------------
// 2 + 3. Every moved console is registered AND physically relocated.
// ---------------------------------------------------------------------------

for (const slug of MOVED_CONSOLES) {
  test(`platform console "${slug}" is registered under /admin/platform and gated`, () => {
    const r = routes.find((x) => x.href === `/admin/platform/${slug}`);
    assert.ok(r, `no route registered for /admin/platform/${slug}`);
    assert.ok(
      isPlatformGated(r!),
      `/admin/platform/${slug} must remain platform-admin gated after the move`,
    );
  });

  test(`platform console "${slug}" physically moved off /operations`, () => {
    const oldPath = resolve(APP_ROOT, `app/(app)/operations/${slug}/page.tsx`);
    const newPath = resolve(
      APP_ROOT,
      `app/(app)/admin/platform/${slug}/page.tsx`,
    );
    assert.equal(
      existsSync(oldPath),
      false,
      `app/(app)/operations/${slug}/page.tsx still exists — the registry href moved but the page did not, so the old URL still resolves`,
    );
    assert.equal(
      existsSync(newPath),
      true,
      `app/(app)/admin/platform/${slug}/page.tsx is missing`,
    );
  });
}

// ---------------------------------------------------------------------------
// 4. A tenant is denied every platform route, invisibly.
// ---------------------------------------------------------------------------

const TENANT_CAPABILITIES = {
  // A generously-capable tenant: workspace OWNER of an enterprise-plan
  // workspace. If even this context cannot reach a platform console, no
  // tenant context can.
  DASHBOARD_VIEW: true,
  EVIDENCE_VIEW: true,
  OPERATIONS_VIEW: true,
  OPERATIONS_ACKNOWLEDGE: true,
  OPERATIONS_ASSIGN: true,
  OPERATIONS_RESOLVE: true,
  OPERATIONS_SUPPRESS: true,
  SECURITY_CENTER_VIEW: true,
  TEAM_MANAGE: true,
  ANALYTICS_VIEW: true,
  AUTOMATION_VIEW: true,
  // Deliberately granted, to prove the ACTIVE-SPACE gate — not merely the
  // capability loop — is what stops a tenant.
  OPS_CENTER_VIEW: true,
  OBSERVABILITY_VIEW: true,
  RUNBOOKS_VIEW: true,
} as Record<string, boolean>;

for (const slug of MOVED_CONSOLES) {
  test(`tenant is denied /admin/platform/${slug}, invisibly`, () => {
    const route = routes.find((x) => x.href === `/admin/platform/${slug}`);
    assert.ok(route);
    const decision = resolveRouteAccess({
      route: route as never,
      activeSpaceType: "ORGANIZATION",
      isPlatformAdmin: false,
      capabilities: TENANT_CAPABILITIES as never,
      isEnterpriseWorkspace: true,
    } as never);
    assert.equal(decision.canLoad, false, `tenant could LOAD /admin/platform/${slug}`);
    assert.equal(
      decision.canSeeNav,
      false,
      `/admin/platform/${slug} is visible in tenant navigation — platform surfaces must be invisible, not merely denied`,
    );
    assert.equal(
      decision.accessState,
      "PLATFORM_ADMIN_ONLY",
      "denial must be the anti-enumerating PLATFORM_ADMIN_ONLY state",
    );
  });
}

test("a platform admin CAN reach the moved consoles", () => {
  for (const slug of MOVED_CONSOLES) {
    const route = routes.find((x) => x.href === `/admin/platform/${slug}`);
    assert.ok(route);
    const decision = resolveRouteAccess({
      route: route as never,
      activeSpaceType: "ORGANIZATION",
      isPlatformAdmin: true,
      capabilities: TENANT_CAPABILITIES as never,
      isEnterpriseWorkspace: false,
    } as never);
    assert.equal(
      decision.canLoad,
      true,
      `platform admin denied /admin/platform/${slug} — elevation must satisfy the granular capability loop`,
    );
  }
});

// ---------------------------------------------------------------------------
// Backward compatibility — every moved URL must still resolve.
// ---------------------------------------------------------------------------

test("every moved console has a permanent redirect from its old /operations URL", async () => {
  // next.config.js is plain JS with no declaration file; the shape is
  // asserted structurally right below, which is the point of the test.
  const mod = (await import("../next.config.js" as string)) as unknown as {
    default: { redirects: () => Promise<unknown[]> };
  };
  const config = mod.default;
  const redirects = (await config.redirects()) as ReadonlyArray<{
    source: string;
    destination: string;
    permanent: boolean;
  }>;
  for (const slug of MOVED_CONSOLES) {
    const hit = redirects.find((r) => r.source === `/operations/${slug}`);
    assert.ok(hit, `no redirect registered for the old URL /operations/${slug}`);
    assert.equal(hit!.destination, `/admin/platform/${slug}`);
    assert.equal(
      hit!.permanent,
      true,
      "platform console redirects must be permanent — these URLs are in bookmarks and runbooks",
    );
  }
});

test("no redirect source is also a redirect destination (no loops)", async () => {
  // next.config.js is plain JS with no declaration file; the shape is
  // asserted structurally right below, which is the point of the test.
  const mod = (await import("../next.config.js" as string)) as unknown as {
    default: { redirects: () => Promise<unknown[]> };
  };
  const config = mod.default;
  const redirects = (await config.redirects()) as ReadonlyArray<{
    source: string;
    destination: string;
  }>;
  const sources = new Set(redirects.map((r) => r.source));
  const looping = redirects
    .filter((r) => sources.has(r.destination.split("?")[0].split("#")[0]))
    .map((r) => `${r.source} -> ${r.destination}`);
  assert.deepEqual(looping, [], "redirect loop detected");
});
