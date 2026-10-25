/**
 * Phase O Stage 3 — Stream C route fixes regression pins.
 *
 * Four production Sentry issues were converted from P2022/P2021
 * schema-drift 500s into bounded degraded 200 responses + idempotent
 * seed:
 *
 *   NODE-1P → POST /v1/coding/schemas/seed-defaults
 *             (null constraint on codingSchema.create — service
 *              now upsert-style with per-spec try/catch + degraded
 *              fallback on P2022/P2021)
 *
 *   NODE-1K → POST /v1/packaging/entitlements/apply-product-line
 *             (delegatedAdminGrant.findMany drift in hasDelegatedTier
 *              middleware — service hardened to return false on
 *              P2022/P2021; route adds belt-and-braces degraded 200
 *              payload). Members audit DOM-09 then retired the tier
 *              middleware and its service outright: the route's
 *              pre-handler is the canonical permission guard, which
 *              reads no tier-grant table at all — so the drifted read
 *              is not merely caught, it is gone from the request path.
 *
 *   NODE-1E → GET /v1/trust/status
 *             (status_components.updated_at missing — projectStatusPage
 *              upsert raised P2022; route now wraps in try/catch and
 *              returns { status: null, degraded: true, reason:
 *              "SCHEMA_NOT_READY" } on drift)
 *
 *   NODE-1Q + NODE-1J → GET /v1/admin/runtime/readiness (+ /queues,
 *             /workers, /migrations)
 *             (chainTransfer.updated_at + subprocessor.{category,
 *              country, description} drift — readiness aggregator
 *              already wraps every per-probe in try/catch; the route
 *              now adds an OUTER P2022/P2021 catch so a future
 *              probe regression cannot 500 the whole endpoint)
 *
 * Style: source-contract (file-text). Matches the existing
 * `production-phase-o-stream-a-route-fixes.test.ts`. NO DB I/O.
 * Pins the exact code shape so a future refactor that re-introduces
 * the P2022 → 500 path fails CI.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { routeSource } from "../../../scripts/source-contract/index.mjs";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

const REVIEWER_WORKSPACE_ROUTES = readApi("src/routes/reviewer-workspace.routes.ts");
const CODING_SCHEMA_SERVICE = readApi("src/services/reviewer-workspace/coding-schema.service.ts");
const PRODUCT_LIFECYCLE_ROUTES = readApi("src/routes/product-and-lifecycle.routes.ts");
const PERMISSION_GUARD = readApi("src/middleware/require-workspace-permission.ts");
const ACCESS_POLICY_SERVICE = readApi("src/services/identity/access-policy.service.ts");
const AUTHORIZE_MIDDLEWARE = readApi("src/middleware/authorize.ts");
const TRUST_ROUTES = readApi("src/routes/trust-and-governance.routes.ts");
const RUNTIME_READINESS_ROUTES = readApi("src/routes/runtime-readiness.routes.ts");

// ===========================================================================
// NODE-1P — POST /v1/coding/schemas/seed-defaults
// ===========================================================================

describe("Phase O Stream C — Sentry NODE-1P /v1/coding/schemas/seed-defaults", () => {
  it("seedDefaultSchemas service returns { created, updated, existing, failed }", () => {
    // The legacy `existing` alias is preserved for the web client at
    // apps/web/lib/reviewer-workspace/reviewer-api.ts. The new
    // `updated` field is the canonical name per the Stage 3 spec.
    expect(CODING_SCHEMA_SERVICE).toMatch(/created:\s*number/);
    expect(CODING_SCHEMA_SERVICE).toMatch(/updated:\s*number/);
    expect(CODING_SCHEMA_SERVICE).toMatch(/existing:\s*number/);
    expect(CODING_SCHEMA_SERVICE).toMatch(/failed:\s*number/);
  });

  it("seedDefaultSchemas does an idempotent natural-key lookup by (teamId, slug)", () => {
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /prisma\.codingSchema\.findFirst\([\s\S]{0,300}teamId:\s*input\.teamId[\s\S]{0,200}slug:\s*spec\.slug/,
    );
  });

  it("seedDefaultSchemas wraps each spec in try/catch so one bad row never poisons the pass", () => {
    // Pin the per-spec try/catch + failed counter.
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /for\s*\(\s*const\s+spec\s+of\s+DEFAULT_SCHEMAS\s*\)\s*\{[\s\S]{0,200}try\s*\{/,
    );
    expect(CODING_SCHEMA_SERVICE).toMatch(/failed\s*\+=\s*1/);
  });

  it("the route handler returns degraded 200 on P2022/P2021 instead of 500", () => {
    const slice = routeSource(REVIEWER_WORKSPACE_ROUTES, "POST", "/v1/coding/schemas/seed-defaults");
    expect(slice).toMatch(/try\s*\{[\s\S]{0,400}seedDefaultSchemas/);
    expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
    expect(slice).toMatch(/degraded:\s*true/);
    expect(slice).toMatch(/reason:\s*"SCHEMA_NOT_READY"/);
  });
});

// ===========================================================================
// NODE-1K — POST /v1/packaging/entitlements/apply-product-line
// ===========================================================================

describe("Phase O Stream C — Sentry NODE-1K /v1/packaging/entitlements/apply-product-line", () => {
  it("the route's guard no longer reads the drifted tier-grant table at all", () => {
    // The NODE-1K 500 came from `delegatedAdminGrant.findMany` inside the
    // tier middleware. That middleware and its service are retired; the
    // guard is the canonical permission chain, which decides from the member
    // snapshot (membership + capability grants + delegated scopes).
    expect(PERMISSION_GUARD).toMatch(/evaluateCurrentWorkspace\(req, \{ permission: p \}\)/);
    for (const [name, src] of [
      ["require-workspace-permission.ts", PERMISSION_GUARD],
      ["access-policy.service.ts", ACCESS_POLICY_SERVICE],
      ["authorize.ts", AUTHORIZE_MIDDLEWARE],
    ] as const) {
      expect(src, name).not.toMatch(/delegatedAdminGrant/);
      expect(src, name).not.toMatch(/hasDelegatedTier/);
    }
    // The snapshot loader reads the canonical scope relation instead.
    expect(ACCESS_POLICY_SERVICE).toMatch(/delegatedAdminScopes:\s*\{\s*select:/);
  });

  it("the route handler returns degraded 200 on P2022/P2021 instead of 500", () => {
    const slice = routeSource(
      PRODUCT_LIFECYCLE_ROUTES,
      "POST",
      "/v1/packaging/entitlements/apply-product-line",
    );
    expect(slice).toMatch(/try\s*\{[\s\S]{0,400}applyProductLine/);
    expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
    expect(slice).toMatch(/applied:\s*false/);
    expect(slice).toMatch(/degraded:\s*true/);
    expect(slice).toMatch(/reason:\s*"SCHEMA_NOT_READY"/);
  });

  it("the route's authorization gate is preserved (auth not weakened)", () => {
    // The route MUST still be gated in its pre-handler. The retired
    // ORG_ADMIN tier is now the canonical `billing.manage` permission —
    // OWNER-only by role (not even ADMIN holds it), so the gate is at least
    // as narrow as it was.
    const slice = routeSource(
      PRODUCT_LIFECYCLE_ROUTES,
      "POST",
      "/v1/packaging/entitlements/apply-product-line",
    );
    expect(slice).toMatch(
      /preHandler:\s*\[requireAuth,\s*requireWorkspacePermission\("billing\.manage"\)\]/,
    );
    expect(slice).not.toMatch(/requireDelegatedTier/);
  });
});

// ===========================================================================
// NODE-1E — GET /v1/trust/status
// ===========================================================================

describe("Phase O Stream C — Sentry NODE-1E /v1/trust/status", () => {
  it("the route handler wraps projectStatusPage in try/catch", () => {
    const idx = TRUST_ROUTES.indexOf('"/v1/trust/status"');
    expect(idx, "/v1/trust/status route must exist").toBeGreaterThan(-1);
    // Slice from this route to the next route boundary so we don't
    // accidentally validate a sibling handler.
    const after = TRUST_ROUTES.slice(idx + 1);
    const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
    const slice = TRUST_ROUTES.slice(idx, idx + 1 + (nextRoute > 0 ? nextRoute : 3000));
    expect(slice).toMatch(/try\s*\{[\s\S]{0,400}projectStatusPage/);
    expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
  });

  it("the degraded response shape is { status: null, degraded: true, reason: SCHEMA_NOT_READY }", () => {
    const idx = TRUST_ROUTES.indexOf('"/v1/trust/status"');
    const after = TRUST_ROUTES.slice(idx + 1);
    const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
    const slice = TRUST_ROUTES.slice(idx, idx + 1 + (nextRoute > 0 ? nextRoute : 3000));
    expect(slice).toMatch(/status:\s*null/);
    expect(slice).toMatch(/degraded:\s*true/);
    expect(slice).toMatch(/reason:\s*"SCHEMA_NOT_READY"/);
  });

  it("operator vocabulary stays bounded — no raw error message exposure", () => {
    const idx = TRUST_ROUTES.indexOf('"/v1/trust/status"');
    const after = TRUST_ROUTES.slice(idx + 1);
    const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
    const slice = TRUST_ROUTES.slice(idx, idx + 1 + (nextRoute > 0 ? nextRoute : 3000));
    expect(slice).not.toMatch(/err\.message/);
    expect(slice).not.toMatch(/err\.stack/);
  });
});

// ===========================================================================
// NODE-1Q + NODE-1J — GET /v1/admin/runtime/readiness (+ siblings)
// ===========================================================================

describe("Phase O Stream C — Sentry NODE-1Q + NODE-1J /v1/admin/runtime/readiness", () => {
  it("GET /v1/admin/runtime/readiness wraps runReadinessCheck in try/catch", () => {
    const idx = RUNTIME_READINESS_ROUTES.indexOf('"/v1/admin/runtime/readiness"');
    expect(idx).toBeGreaterThan(-1);
    const after = RUNTIME_READINESS_ROUTES.slice(idx + 1);
    const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
    const slice = RUNTIME_READINESS_ROUTES.slice(
      idx,
      idx + 1 + (nextRoute > 0 ? nextRoute : 3000),
    );
    expect(slice).toMatch(/try\s*\{[\s\S]{0,400}runReadinessCheck/);
    expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
    expect(slice).toMatch(/status:\s*"DEGRADED"/);
    expect(slice).toMatch(/reason:\s*"SCHEMA_NOT_READY"/);
  });

  it("GET /v1/admin/runtime/queues wraps runReadinessCheck in try/catch", () => {
    const idx = RUNTIME_READINESS_ROUTES.indexOf('"/v1/admin/runtime/queues"');
    expect(idx).toBeGreaterThan(-1);
    const after = RUNTIME_READINESS_ROUTES.slice(idx + 1);
    const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
    const slice = RUNTIME_READINESS_ROUTES.slice(
      idx,
      idx + 1 + (nextRoute > 0 ? nextRoute : 3000),
    );
    expect(slice).toMatch(/try\s*\{[\s\S]{0,400}runReadinessCheck/);
    expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
  });

  it("GET /v1/admin/runtime/workers wraps runReadinessCheck in try/catch", () => {
    const idx = RUNTIME_READINESS_ROUTES.indexOf('"/v1/admin/runtime/workers"');
    expect(idx).toBeGreaterThan(-1);
    const after = RUNTIME_READINESS_ROUTES.slice(idx + 1);
    const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
    const slice = RUNTIME_READINESS_ROUTES.slice(
      idx,
      idx + 1 + (nextRoute > 0 ? nextRoute : 3000),
    );
    expect(slice).toMatch(/try\s*\{[\s\S]{0,400}runReadinessCheck/);
    expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
  });

  it("GET /v1/admin/runtime/migrations wraps runMigrationDriftCheck in try/catch", () => {
    const slice = routeSource(RUNTIME_READINESS_ROUTES, "GET", "/v1/admin/runtime/migrations");
    expect(slice).toMatch(/try\s*\{[\s\S]{0,400}runMigrationDriftCheck/);
    expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
  });

  it("the auth gate is STRENGTHENED, not weakened (ADM-P1-003 / OWN-1)", () => {
    /*
     * This used to assert `permission: "audit.read"` and a
     * `requireReadinessActor(req, reply, q.teamId)` call — a TENANT permission
     * deciding access to a payload that answers for the whole deployment. It
     * held for exactly as long as the defect did.
     *
     * Measured against a seeded fixture before the change: a FREE personal-plan
     * owner, passing their OWN workspace id, received 200 on all four of these,
     * including a migration inventory that named four unapplied migrations.
     * OWN-1 makes the family platform-admin only.
     *
     * The assertion is INVERTED rather than dropped. The tenant gate must be
     * absent, and the canonical platform gate must be on every registration.
     * Live status codes across the whole persona matrix are proved in
     * admin-authorization-matrix.integration.test.ts.
     */
    expect(
      RUNTIME_READINESS_ROUTES,
      "the tenant permission must no longer authorise the platform aggregator",
    ).not.toMatch(/permission:\s*"audit\.read"/);
    expect(
      RUNTIME_READINESS_ROUTES,
      "the tenant membership helper must be gone, not merely unused",
    ).not.toMatch(/requireReadinessActor\(/);

    const registrations = RUNTIME_READINESS_ROUTES.match(
      /"\/v1\/admin\/runtime\/[\w-]+"/g,
    );
    expect(registrations?.length, "all four legs are registered").toBe(4);
    const gates = RUNTIME_READINESS_ROUTES.match(
      /preHandler:\s*requirePlatformAdmin/g,
    );
    expect(
      gates?.length,
      "every leg carries the canonical platform-admin gate",
    ).toBe(4);
  });
});

// ===========================================================================
// Bounded guards — no silent suppression, no auth weakening
// ===========================================================================

describe("Phase O Stream C — bounded guards", () => {
  it("no silent error suppression — every catch surfaces SCHEMA_NOT_READY explicitly", () => {
    // Every Stream-C edited file must mention SCHEMA_NOT_READY at
    // least once. If a future refactor reverts to swallow-and-200,
    // this guard fires.
    expect(REVIEWER_WORKSPACE_ROUTES).toMatch(/SCHEMA_NOT_READY/);
    expect(PRODUCT_LIFECYCLE_ROUTES).toMatch(/SCHEMA_NOT_READY/);
    expect(TRUST_ROUTES).toMatch(/SCHEMA_NOT_READY/);
    expect(RUNTIME_READINESS_ROUTES).toMatch(/SCHEMA_NOT_READY/);
  });

  it("no Prisma error JSON / stack leak in the new Stream-C catch arms", () => {
    // Source-contract negative pin scoped to the Stream-C edits
    // (each route's degraded-200 reply block must NOT include
    // err.message / err.stack). We deliberately do NOT scan the
    // entire route file because pre-existing handlers may legitimately
    // use err.message in non-Stream-C catch paths.
    const streamCSnippets: ReadonlyArray<{ src: string; routePath: string }> = [
      { src: REVIEWER_WORKSPACE_ROUTES, routePath: '"/v1/coding/schemas/seed-defaults"' },
      { src: PRODUCT_LIFECYCLE_ROUTES, routePath: '"/v1/packaging/entitlements/apply-product-line"' },
      { src: TRUST_ROUTES, routePath: '"/v1/trust/status"' },
      { src: RUNTIME_READINESS_ROUTES, routePath: '"/v1/admin/runtime/readiness"' },
    ];
    for (const { src, routePath } of streamCSnippets) {
      const idx = src.indexOf(routePath);
      expect(idx, `route ${routePath} must exist`).toBeGreaterThan(-1);
      const after = src.slice(idx + 1);
      const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
      const slice = src.slice(idx, idx + 1 + (nextRoute > 0 ? nextRoute : 3000));
      // Forbid leak inside the Stream-C catch arm. We allow
      // err.code (bounded). Reject err.message + err.stack in any
      // reply.* call within this slice.
      expect(slice, `${routePath} must not leak err.message in degraded path`).not.toMatch(
        /reply\.[a-z]+\([\s\S]{0,400}err\.message/,
      );
      expect(slice, `${routePath} must not leak err.stack in degraded path`).not.toMatch(
        /reply\.[a-z]+\([\s\S]{0,400}err\.stack/,
      );
    }
  });
});
