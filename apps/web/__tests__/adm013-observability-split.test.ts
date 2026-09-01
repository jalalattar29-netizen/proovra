/**
 * ADM-013 PHASE 1 — the observability split, proven.
 *
 * ===========================================================================
 * WHAT THIS GATE EXISTS TO CATCH
 * ===========================================================================
 * `1afd5e0f` moved `/v1/ops/metrics` and `/v1/ops/alerts` behind the
 * platform-admin gate. The web page that consumed them was not updated in that
 * commit, so between it and this one `/admin/platform/observability` called two
 * URLs that answered 403 to every non-platform caller and passed a `teamId` the
 * payload never consulted. The page was BROKEN, not merely mis-scoped, and no
 * test noticed — because every existing assertion was about the GATE, and the
 * gate was correct. The defect was in the caller.
 *
 * So these assertions are about the CALLER, the URLs it names, and the words
 * its links use. They read source text on purpose: a render test can prove a
 * component renders, and cannot prove that no site in the app still spells the
 * old destination.
 *
 * ===========================================================================
 * THE FOUR CLAIMS
 * ===========================================================================
 *   1. The platform page has no workspace input of any kind, and reads only
 *      the three platform-gated endpoints.
 *   2. The two capabilities are separate, and the registry gates each surface
 *      with the one that matches its data.
 *   3. The resolver's truth table is exhaustive, including the null arm — an
 *      actor with neither authority gets NO link, not a disabled one.
 *   4. No tenant surface hardcodes the platform href any more.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import {
  PLATFORM_OBSERVABILITY_HREF,
  WORKSPACE_HEALTH_HREF,
  resolveHealthDestination,
} from "../lib/navigation/healthDestination";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const OBSERVABILITY_PAGE = join(
  APP_ROOT,
  "app/(app)/admin/platform/observability/page.tsx",
);
const WORKSPACE_HEALTH_PAGE = join(
  APP_ROOT,
  "app/(app)/operations/health/page.tsx",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

/** Strip block and line comments so a prose mention is not read as code. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

// ---------------------------------------------------------------------------
// 1. The platform page is workspace-independent.
// ---------------------------------------------------------------------------

test("platform observability reads ONLY the three platform-gated endpoints", () => {
  const src = code(read(OBSERVABILITY_PAGE));
  for (const url of [
    "/v1/admin/platform/metrics",
    "/v1/admin/platform/alerts",
    "/v1/admin/platform/readiness",
  ]) {
    assert.ok(src.includes(url), `platform observability no longer reads ${url}`);
  }
});

test("platform observability names no tenant endpoint and no teamId", () => {
  const src = code(read(OBSERVABILITY_PAGE));
  // `/v1/ops/metrics` and `/v1/ops/alerts` are platform-gated since 1afd5e0f;
  // naming them here means the page 403s for its own audience.
  assert.ok(
    !src.includes("/v1/ops/metrics"),
    "platform observability still calls /v1/ops/metrics — that URL is platform-gated and takes a teamId the payload ignores",
  );
  assert.ok(!src.includes("/v1/ops/alerts"), "still calls /v1/ops/alerts");
  assert.ok(
    !/teamId/.test(src),
    "the platform observability page still mentions teamId in code — a global payload must not take, default, or display a workspace id",
  );
});

test("every apiFetch on the platform page targets /v1/admin/platform/", () => {
  // Stronger than a denylist of known-bad URLs, and the reason the denylist
  // would not have been enough: the defect was a URL that was CORRECT when it
  // was written. Pinning the prefix means a future edit that reaches for any
  // other endpoint — tenant-scoped, ungated, or not yet invented — fails here
  // instead of shipping a 403 to the page's own audience.
  const src = code(read(OBSERVABILITY_PAGE));
  const calls = [...src.matchAll(/apiFetch\(\s*["`]([^"`]+)["`]/g)].map(
    (m) => m[1],
  );
  assert.ok(calls.length >= 3, `expected at least 3 apiFetch calls, saw ${calls.length}`);
  const offenders = calls.filter((u) => !u.startsWith("/v1/admin/platform/"));
  assert.deepEqual(
    offenders,
    [],
    "these reads are not on the platform-gated namespace",
  );
});

test("platform observability resolves no active workspace", () => {
  const src = code(read(OBSERVABILITY_PAGE));
  for (const hook of [
    "useActiveSpaceId",
    "useActiveWorkspaceId",
    "useTeamId",
    "useWorkspaceId",
  ]) {
    assert.ok(
      !src.includes(hook),
      `${hook}() is still called on the platform observability page — switching the active workspace must not be able to change a value there`,
    );
  }
});

test("platform observability states its scope on screen", () => {
  const src = read(OBSERVABILITY_PAGE);
  assert.ok(
    src.includes("Scope: Platform"),
    "the page must SAY it is platform-scoped; `operational_incidents_open 76` was read as one workspace's count precisely because nothing on the page contradicted that",
  );
});

// ---------------------------------------------------------------------------
// 2. Two capabilities, two surfaces.
// ---------------------------------------------------------------------------

type Route = {
  id: string;
  href: string;
  requiredCapabilities: ReadonlyArray<string>;
  requiredActiveSpace: string;
};

const routes = ROUTE_REGISTRY as ReadonlyArray<Route>;

test("platform.observability is gated by PLATFORM_TELEMETRY_VIEW", () => {
  const r = routes.find((x) => x.href === PLATFORM_OBSERVABILITY_HREF);
  assert.ok(r, "platform.observability is not registered");
  assert.deepEqual(r!.requiredCapabilities, ["PLATFORM_TELEMETRY_VIEW"]);
  assert.equal(r!.requiredActiveSpace, "PLATFORM_ADMIN");
});

test("workspace.operations_health is gated by WORKSPACE_HEALTH_VIEW, tenant space", () => {
  const r = routes.find((x) => x.href === WORKSPACE_HEALTH_HREF);
  assert.ok(r, "the workspace health route is not registered");
  assert.deepEqual(r!.requiredCapabilities, ["WORKSPACE_HEALTH_VIEW"]);
  assert.equal(
    r!.requiredActiveSpace,
    "PERSONAL_OR_ORG",
    "workspace health must NOT be platform-gated — it is the tenant's own data",
  );
});

test("the two surfaces never share a capability key", () => {
  const platform = routes.find((x) => x.href === PLATFORM_OBSERVABILITY_HREF)!;
  const workspace = routes.find((x) => x.href === WORKSPACE_HEALTH_HREF)!;
  const shared = platform.requiredCapabilities.filter((c) =>
    workspace.requiredCapabilities.includes(c),
  );
  assert.deepEqual(
    shared,
    [],
    "one key gating both scopes is the exact contradiction this phase removes",
  );
});

test("the workspace health page reads only workspace-scoped endpoints", () => {
  const src = code(read(WORKSPACE_HEALTH_PAGE));
  assert.ok(src.includes("/operations/health"));
  assert.ok(src.includes("/operations/alerts"));
  for (const forbidden of [
    "/v1/ops/metrics",
    "/v1/ops/alerts",
    "/v1/admin/platform/",
    "snapshotMetrics",
  ]) {
    assert.ok(
      !src.includes(forbidden),
      `the workspace health page reaches ${forbidden} — the tenant surface must not be able to touch platform telemetry`,
    );
  }
});

test("the workspace health route registers on the canonical /v1/teams prefix", () => {
  const src = code(read(WORKSPACE_HEALTH_PAGE));
  assert.ok(
    src.includes("/v1/teams/"),
    "the page must call /v1/teams/:id/... — /v1/workspaces is a rewrite ALIAS and a route registered there is permanently unreachable (see 527fcb2e)",
  );
});

// ---------------------------------------------------------------------------
// 3. The resolver truth table — all four combinations.
// ---------------------------------------------------------------------------

test("resolveHealthDestination: platform wins when the actor holds both", () => {
  const d = resolveHealthDestination({
    canPlatformTelemetry: true,
    canWorkspaceHealth: true,
  });
  assert.equal(d?.scope, "PLATFORM");
  assert.equal(d?.href, PLATFORM_OBSERVABILITY_HREF);
  assert.equal(d?.label, "Open Platform Observability");
});

test("resolveHealthDestination: platform-only", () => {
  const d = resolveHealthDestination({
    canPlatformTelemetry: true,
    canWorkspaceHealth: false,
  });
  assert.equal(d?.href, PLATFORM_OBSERVABILITY_HREF);
});

test("resolveHealthDestination: workspace-only gets the workspace surface", () => {
  const d = resolveHealthDestination({
    canPlatformTelemetry: false,
    canWorkspaceHealth: true,
  });
  assert.equal(d?.scope, "WORKSPACE");
  assert.equal(d?.href, WORKSPACE_HEALTH_HREF);
  assert.equal(d?.label, "View workspace health");
});

test("resolveHealthDestination: neither authority yields NO link", () => {
  assert.equal(
    resolveHealthDestination({
      canPlatformTelemetry: false,
      canWorkspaceHealth: false,
    }),
    null,
    "an actor with neither authority must get no control at all — a visible control that refuses on click is worse than an absent one",
  );
});

test("every destination label names its scope", () => {
  for (const flags of [
    { canPlatformTelemetry: true, canWorkspaceHealth: false },
    { canPlatformTelemetry: false, canWorkspaceHealth: true },
  ]) {
    const d = resolveHealthDestination(flags)!;
    assert.ok(
      /platform/i.test(d.label) || /workspace/i.test(d.label),
      `"${d.label}" names neither scope — a link that does not say what it opens is how a platform page came to read as a workspace page`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. No tenant surface hardcodes the platform destination.
// ---------------------------------------------------------------------------

/**
 * The files permitted to name `/admin/platform/observability` in CODE.
 *
 * `healthDestination.ts` owns the constant. The observability page is the
 * destination itself. `admin-nav-config.ts` is the platform console's own nav.
 * `runbooks` is a platform page cross-linking a platform sibling. Anything
 * else naming this href is a tenant surface pointing at a page its readers
 * cannot open.
 */
const ALLOWED_HREF_OWNERS = new Set([
  // Owns the constant.
  "lib/navigation/healthDestination.ts",
  // The canonical route record — the registry is where an href is DECLARED.
  "lib/navigation/routeRegistry.ts",
  // The destination itself.
  "app/(app)/admin/platform/observability/page.tsx",
  // A platform page cross-linking a platform sibling; both need the same gate.
  "app/(app)/admin/platform/runbooks/page.tsx",
  // The platform console's own navigation.
  "components/admin/admin-nav-config.ts",
]);

function walkSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkSources(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

test("no unowned source names /admin/platform/observability in code", () => {
  const offenders: string[] = [];
  for (const file of walkSources(APP_ROOT)) {
    const rel = file.slice(APP_ROOT.length + 1).replace(/\\/g, "/");
    if (ALLOWED_HREF_OWNERS.has(rel)) continue;
    // Tests that merely assert about the split are allowed to name it.
    // Tests are allowed to name the href: asserting about a destination is not
    // sending a reader to it.
    if (rel.startsWith("__tests__/")) continue;
    if (code(read(file)).includes("/admin/platform/observability")) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these files hardcode the platform observability href instead of asking useHealthDestination() where health lives for the current actor",
  );
});

test("OperationalEmptyState can be told what its diagnostics link says", () => {
  const src = read(
    join(APP_ROOT, "components/operational/OperationalEmptyState.tsx"),
  );
  assert.ok(
    src.includes("diagnosticsLabel"),
    "the diagnostics link text is fixed again — every caller sent a platform surface under the word 'diagnostics', which named neither the scope nor the authority",
  );
});
