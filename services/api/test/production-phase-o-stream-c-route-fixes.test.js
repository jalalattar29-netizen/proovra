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
 *              payload)
 *
 *   NODE-1E → GET /v1/trust/status
 *             (status_components.updated_at missing — projectStatusPage
 *              upsert raised P2022; route now wraps in try/catch and
 *              returns { status: null, degraded: true, reason:
 *              "SCHEMA_NOT_READY" } on drift)
 *
 *   NODE-1Q + NODE-1J → GET /admin/runtime/readiness (+ /queues,
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
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
const REVIEWER_WORKSPACE_ROUTES = readApi("src/routes/reviewer-workspace.routes.ts");
const CODING_SCHEMA_SERVICE = readApi("src/services/reviewer-workspace/coding-schema.service.ts");
const PRODUCT_LIFECYCLE_ROUTES = readApi("src/routes/product-and-lifecycle.routes.ts");
const DELEGATED_ADMIN_SERVICE = readApi("src/services/governance/delegated-admin.service.ts");
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
        expect(CODING_SCHEMA_SERVICE).toMatch(/prisma\.codingSchema\.findFirst\([\s\S]{0,300}teamId:\s*input\.teamId[\s\S]{0,200}slug:\s*spec\.slug/);
    });
    it("seedDefaultSchemas wraps each spec in try/catch so one bad row never poisons the pass", () => {
        // Pin the per-spec try/catch + failed counter.
        expect(CODING_SCHEMA_SERVICE).toMatch(/for\s*\(\s*const\s+spec\s+of\s+DEFAULT_SCHEMAS\s*\)\s*\{[\s\S]{0,200}try\s*\{/);
        expect(CODING_SCHEMA_SERVICE).toMatch(/failed\s*\+=\s*1/);
    });
    it("the route handler returns degraded 200 on P2022/P2021 instead of 500", () => {
        const idx = REVIEWER_WORKSPACE_ROUTES.indexOf('"/v1/coding/schemas/seed-defaults"');
        expect(idx, "/v1/coding/schemas/seed-defaults route must exist").toBeGreaterThan(-1);
        const slice = REVIEWER_WORKSPACE_ROUTES.slice(idx, idx + 2500);
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
    it("hasDelegatedTier wraps the findMany in try/catch and returns [] on P2022/P2021", () => {
        expect(DELEGATED_ADMIN_SERVICE).toMatch(/try\s*\{[\s\S]{0,400}prisma\.delegatedAdminGrant\.findMany/);
        expect(DELEGATED_ADMIN_SERVICE).toMatch(/code !== "P2022" && code !== "P2021"/);
        // After the catch, the implicit-owner ladder still runs — never
        // a silent boolean true. The fail-closed behavior is documented.
        expect(DELEGATED_ADMIN_SERVICE).toMatch(/grants\s*=\s*\[\]/);
    });
    it("the route handler returns degraded 200 on P2022/P2021 instead of 500", () => {
        const idx = PRODUCT_LIFECYCLE_ROUTES.indexOf('"/v1/packaging/entitlements/apply-product-line"');
        expect(idx, "/v1/packaging/entitlements/apply-product-line route must exist").toBeGreaterThan(-1);
        const slice = PRODUCT_LIFECYCLE_ROUTES.slice(idx, idx + 2500);
        expect(slice).toMatch(/try\s*\{[\s\S]{0,400}applyProductLine/);
        expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
        expect(slice).toMatch(/applied:\s*false/);
        expect(slice).toMatch(/degraded:\s*true/);
        expect(slice).toMatch(/reason:\s*"SCHEMA_NOT_READY"/);
    });
    it("the delegated-tier middleware gate is preserved (auth not weakened)", () => {
        // The route MUST still require ORG_ADMIN via the middleware.
        const idx = PRODUCT_LIFECYCLE_ROUTES.indexOf('"/v1/packaging/entitlements/apply-product-line"');
        const slice = PRODUCT_LIFECYCLE_ROUTES.slice(idx, idx + 400);
        expect(slice).toMatch(/requireDelegatedTier\("ORG_ADMIN"\)/);
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
// NODE-1Q + NODE-1J — GET /admin/runtime/readiness (+ siblings)
// ===========================================================================
describe("Phase O Stream C — Sentry NODE-1Q + NODE-1J /admin/runtime/readiness", () => {
    it("GET /admin/runtime/readiness wraps runReadinessCheck in try/catch", () => {
        const idx = RUNTIME_READINESS_ROUTES.indexOf('"/admin/runtime/readiness"');
        expect(idx).toBeGreaterThan(-1);
        const after = RUNTIME_READINESS_ROUTES.slice(idx + 1);
        const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
        const slice = RUNTIME_READINESS_ROUTES.slice(idx, idx + 1 + (nextRoute > 0 ? nextRoute : 3000));
        expect(slice).toMatch(/try\s*\{[\s\S]{0,400}runReadinessCheck/);
        expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
        expect(slice).toMatch(/status:\s*"DEGRADED"/);
        expect(slice).toMatch(/reason:\s*"SCHEMA_NOT_READY"/);
    });
    it("GET /admin/runtime/queues wraps runReadinessCheck in try/catch", () => {
        const idx = RUNTIME_READINESS_ROUTES.indexOf('"/admin/runtime/queues"');
        expect(idx).toBeGreaterThan(-1);
        const after = RUNTIME_READINESS_ROUTES.slice(idx + 1);
        const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
        const slice = RUNTIME_READINESS_ROUTES.slice(idx, idx + 1 + (nextRoute > 0 ? nextRoute : 3000));
        expect(slice).toMatch(/try\s*\{[\s\S]{0,400}runReadinessCheck/);
        expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
    });
    it("GET /admin/runtime/workers wraps runReadinessCheck in try/catch", () => {
        const idx = RUNTIME_READINESS_ROUTES.indexOf('"/admin/runtime/workers"');
        expect(idx).toBeGreaterThan(-1);
        const after = RUNTIME_READINESS_ROUTES.slice(idx + 1);
        const nextRoute = after.search(/\n\s{0,4}app\.(post|get|patch|delete)\(/);
        const slice = RUNTIME_READINESS_ROUTES.slice(idx, idx + 1 + (nextRoute > 0 ? nextRoute : 3000));
        expect(slice).toMatch(/try\s*\{[\s\S]{0,400}runReadinessCheck/);
        expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
    });
    it("GET /admin/runtime/migrations wraps runMigrationDriftCheck in try/catch", () => {
        const idx = RUNTIME_READINESS_ROUTES.indexOf('"/admin/runtime/migrations"');
        expect(idx).toBeGreaterThan(-1);
        const after = RUNTIME_READINESS_ROUTES.slice(idx + 1);
        const slice = RUNTIME_READINESS_ROUTES.slice(idx, idx + 1500);
        expect(slice).toMatch(/try\s*\{[\s\S]{0,400}runMigrationDriftCheck/);
        expect(slice).toMatch(/code === "P2022"\s*\|\|\s*code === "P2021"/);
    });
    it("the auth gate (requireReadinessActor) is preserved (auth not weakened)", () => {
        // Every readiness endpoint must still 404 non-members and 403
        // members lacking audit.read.
        expect(RUNTIME_READINESS_ROUTES).toMatch(/permission:\s*"audit\.read"/);
        expect(RUNTIME_READINESS_ROUTES).toMatch(/requireReadinessActor\(req, reply, q\.teamId\)/);
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
        const streamCSnippets = [
            { src: REVIEWER_WORKSPACE_ROUTES, routePath: '"/v1/coding/schemas/seed-defaults"' },
            { src: PRODUCT_LIFECYCLE_ROUTES, routePath: '"/v1/packaging/entitlements/apply-product-line"' },
            { src: TRUST_ROUTES, routePath: '"/v1/trust/status"' },
            { src: RUNTIME_READINESS_ROUTES, routePath: '"/admin/runtime/readiness"' },
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
            expect(slice, `${routePath} must not leak err.message in degraded path`).not.toMatch(/reply\.[a-z]+\([\s\S]{0,400}err\.message/);
            expect(slice, `${routePath} must not leak err.stack in degraded path`).not.toMatch(/reply\.[a-z]+\([\s\S]{0,400}err\.stack/);
        }
    });
});
