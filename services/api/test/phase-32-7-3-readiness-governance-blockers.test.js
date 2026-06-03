/**
 * Phase 32.7.3 — Final readiness/governance blockers fix.
 *
 * Three production blockers closed by this phase:
 *
 *   1. REDIS FALSE CRITICAL.
 *      `redis-cli ping` returned PONG and the worker logged
 *      `redis.connection.ready`, yet the readiness probe reported
 *      CRITICAL with "Stream isn't writeable and enableOfflineQueue
 *      options is false". Root cause: the Phase 32.6.1 ping client
 *      combined `lazyConnect: true` with `enableOfflineQueue:
 *      false`. When `ping()` runs on a still-connecting stream,
 *      ioredis throws synchronously because it cannot buffer the
 *      command. The fix is to explicitly `await client.connect()`
 *      BEFORE calling `ping()` so the stream is known-writeable.
 *      The fast-fail config (connectTimeout: 500, maxRetries: 0,
 *      retryStrategy: null) is preserved verbatim.
 *
 *   2. WORKERS DEGRADED with `no_recent_reconcile` when the worker
 *      cannot authenticate to the reconcile endpoint. The readiness
 *      reader did not previously look at the env vars that gate
 *      that authentication. The fix adds an env-precondition check:
 *      if NEITHER `REVIEWER_OPS_CRON_SECRET` NOR
 *      `INTEGRATION_CRON_SECRET` is set on the API, the reader
 *      now returns DEGRADED with the bounded
 *      `reconcile_cron_secret_missing` reasonCode and names both
 *      env keys in the remediation hint, instead of the misleading
 *      "worker may not have started yet".
 *
 *   3. GOVERNANCE_SCHEMA_UNAVAILABLE while runtime schema HEALTHY.
 *      The runtime schema validator confirms TABLE existence but
 *      not COLUMN existence. `listLegalHoldsForTeam` and
 *      `listCaseLegalHolds` used `findMany({...})` with no `select`
 *      clause — Prisma's default-select pulls every model field,
 *      so if any non-projected column was missing in production
 *      (e.g. `created_at`, `updated_at`, `release_note`), the
 *      query P2022d and `runGovernanceHandler` mapped it to 503.
 *      The fix is to add bounded `select` clauses that request
 *      ONLY the columns the projection uses. If the genuinely
 *      missing column is one of the projected columns, the 503
 *      still fires — but now the schema gap is narrowed to a
 *      specific projection set instead of "any column on the
 *      model".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
// =============================================================================
// Part 1 — Redis ping race fix
// =============================================================================
describe("Phase 32.7.3 — Redis readiness probe explicitly connects before pinging", () => {
    const SRC = readApi("src/runtime/runtime-readiness.ts");
    const fnIdx = SRC.indexOf("async function checkRedis");
    const fnEnd = SRC.indexOf("\nfunction checkS3ObjectLock", fnIdx);
    const fn = SRC.slice(fnIdx, fnEnd);
    it("explicitly awaits `pingClient.connect()` BEFORE `ping()`", () => {
        expect(fn).toMatch(/await withTimeout\(pingClient\.connect\(\)/);
        // The connect MUST appear before the ping in source order.
        const connectIdx = fn.indexOf("pingClient.connect()");
        const pingIdx = fn.indexOf("pingClient.ping()");
        expect(connectIdx).toBeGreaterThan(-1);
        expect(pingIdx).toBeGreaterThan(-1);
        expect(connectIdx).toBeLessThan(pingIdx);
    });
    it("fast-fail config is preserved (connectTimeout: 500, maxRetries: 0, retryStrategy: null)", () => {
        expect(fn).toMatch(/connectTimeout:\s*500/);
        expect(fn).toMatch(/maxRetriesPerRequest:\s*0/);
        expect(fn).toMatch(/retryStrategy:\s*\(\)\s*=>\s*null/);
        expect(fn).toMatch(/lazyConnect:\s*true/);
    });
    it("connect is bounded by the same 1000ms outer timeout as ping", () => {
        // Both withTimeout calls use 1000ms as the bound. This keeps
        // the probe fast-fail across the whole connect+ping sequence
        // (which is still under the 2000ms CHECK_TIMEOUT_MS budget).
        expect(fn).toMatch(/withTimeout\(pingClient\.connect\(\),\s*null,\s*1000\)/);
        expect(fn).toMatch(/withTimeout\(pingClient\.ping\(\),\s*null,\s*1000\)/);
    });
    it("CRITICAL path still surfaces elapsedMs + errClass + errCode (Phase 32.7.1 metadata)", () => {
        const catchIdx = fn.indexOf("} catch (err)");
        const catchSlice = fn.slice(catchIdx);
        expect(catchSlice).toMatch(/elapsedMs/);
        expect(catchSlice).toMatch(/errClass/);
        expect(catchSlice).toMatch(/errCode/);
    });
});
// =============================================================================
// Part 2 — Workers check detects missing cron secret env
// =============================================================================
describe("Phase 32.7.3 — workers readiness detects missing cron secret env", () => {
    const SRC = readApi("src/runtime/runtime-readiness.ts");
    const fnIdx = SRC.indexOf("async function checkWorkers");
    const fnEnd = SRC.indexOf("\n}\n", fnIdx);
    const fn = SRC.slice(fnIdx, fnEnd);
    it("reads both REVIEWER_OPS_CRON_SECRET and INTEGRATION_CRON_SECRET via envPresent", () => {
        expect(fn).toMatch(/envPresent\(\s*"REVIEWER_OPS_CRON_SECRET"\s*\)/);
        expect(fn).toMatch(/envPresent\(\s*"INTEGRATION_CRON_SECRET"\s*\)/);
    });
    it("returns DEGRADED with `reconcile_cron_secret_missing` when both are absent", () => {
        expect(fn).toMatch(/reasonCode:\s*"reconcile_cron_secret_missing"/);
        expect(fn).toMatch(/if\s*\(\s*!hasReviewerOpsCron\s*&&\s*!hasIntegrationCron\s*\)/);
    });
    it("remediation hint names BOTH env keys explicitly", () => {
        const idx = fn.indexOf('reasonCode: "reconcile_cron_secret_missing"');
        const slice = fn.slice(idx, idx + 1200);
        expect(slice).toMatch(/REVIEWER_OPS_CRON_SECRET/);
        expect(slice).toMatch(/INTEGRATION_CRON_SECRET/);
    });
    it("metadata exposes the env presence flags for SRE dashboards", () => {
        expect(fn).toMatch(/hasReviewerOpsCronSecret/);
        expect(fn).toMatch(/hasIntegrationCronSecret/);
    });
    it("falls through to no_recent_reconcile only when AT LEAST ONE cron secret IS set", () => {
        // Verify the no_recent_reconcile branch comes AFTER the
        // cron-secret-missing check, not before. Source-order check.
        const cronIdx = fn.indexOf('reasonCode: "reconcile_cron_secret_missing"');
        const noRecentIdx = fn.lastIndexOf('reasonCode: "no_recent_reconcile"');
        expect(cronIdx).toBeGreaterThan(-1);
        expect(noRecentIdx).toBeGreaterThan(cronIdx);
    });
});
// =============================================================================
// Part 3 — Legal-holds findMany uses bounded `select`
// =============================================================================
describe("Phase 32.7.3 — listLegalHoldsForTeam uses explicit `select`", () => {
    const SRC = readApi("src/services/governance.service.ts");
    it("declares LEGAL_HOLD_SELECT constant with the projection's exact columns", () => {
        const constIdx = SRC.indexOf("const LEGAL_HOLD_SELECT");
        expect(constIdx).toBeGreaterThan(-1);
        const block = SRC.slice(constIdx, constIdx + 1500);
        expect(block).toMatch(/as const/);
        for (const field of [
            "id",
            "teamId",
            "evidenceId",
            "caseId",
            "title",
            "reason",
            "status",
            "placedByUserId",
            "placedAtUtc",
            "releasedByUserId",
            "releasedAtUtc",
            "releaseNote",
        ]) {
            const re = new RegExp(`${field}:\\s*true`);
            expect(block, `LEGAL_HOLD_SELECT missing ${field}: true`).toMatch(re);
        }
    });
    it("findMany call passes the explicit select", () => {
        const fnIdx = SRC.indexOf("export async function listLegalHoldsForTeam");
        expect(fnIdx).toBeGreaterThan(-1);
        const fnSlice = SRC.slice(fnIdx, fnIdx + 1200);
        expect(fnSlice).toMatch(/client\.evidenceLegalHold\.findMany\(\{[\s\S]{0,800}select:\s*LEGAL_HOLD_SELECT/);
    });
    it("does NOT use the legacy default-select shape (Prisma pulls every column)", () => {
        const fnIdx = SRC.indexOf("export async function listLegalHoldsForTeam");
        const fnSlice = SRC.slice(fnIdx, fnIdx + 800);
        // The signature explicitly declares the bounded projection
        // type, NOT the full DbLegalHold[].
        expect(fnSlice).toMatch(/Promise<LegalHoldProjection\[\]>/);
    });
    it("`createdAt` and `updatedAt` are NOT in the select (route doesn't project them)", () => {
        // These are the most likely missing-column culprits per the
        // Phase 32.7.3 brief's "etc." hint. They are intentionally
        // omitted from the bounded select.
        const selectIdx = SRC.indexOf("LEGAL_HOLD_SELECT");
        const selectEnd = SRC.indexOf("} as const", selectIdx);
        const selectBlock = SRC.slice(selectIdx, selectEnd);
        expect(selectBlock).not.toMatch(/createdAt:\s*true/);
        expect(selectBlock).not.toMatch(/updatedAt:\s*true/);
    });
    it("projectLegalHold accepts LegalHoldProjection (bounded type)", () => {
        expect(SRC).toMatch(/export function projectLegalHold\(hold:\s*LegalHoldProjection\)/);
    });
});
describe("Phase 32.7.3 — listCaseLegalHolds uses explicit `select`", () => {
    const SRC = readApi("src/services/governance/case-legal-hold.service.ts");
    it("declares CASE_LEGAL_HOLD_SELECT constant with the projection's exact columns", () => {
        const constIdx = SRC.indexOf("const CASE_LEGAL_HOLD_SELECT");
        expect(constIdx).toBeGreaterThan(-1);
        const block = SRC.slice(constIdx, constIdx + 1500);
        expect(block).toMatch(/as const/);
        // Phase 32.7.4 — createdAt / updatedAt removed from this
        // select. The dedicated Phase 32.7.4 test file
        // (phase-32-7-4-case-legal-holds-503-fix.test.ts) enforces
        // that narrowing; this test now only asserts the surviving
        // bounded set.
        for (const field of [
            "id",
            "teamId",
            "caseId",
            "title",
            "status",
            "placedByUserId",
            "placedAtUtc",
            "releasedByUserId",
            "releasedAtUtc",
        ]) {
            const re = new RegExp(`${field}:\\s*true`);
            expect(block, `CASE_LEGAL_HOLD_SELECT missing ${field}: true`).toMatch(re);
        }
    });
    it("findMany call passes the explicit select", () => {
        const fnIdx = SRC.indexOf("export async function listCaseLegalHolds");
        expect(fnIdx).toBeGreaterThan(-1);
        const fnSlice = SRC.slice(fnIdx, fnIdx + 1500);
        expect(fnSlice).toMatch(/client\.caseLegalHold\.findMany\(\{[\s\S]{0,800}select:\s*CASE_LEGAL_HOLD_SELECT/);
    });
    it("does NOT include `reason` or `releaseNote` (route never returns them — internal only)", () => {
        // The original projection comment explicitly says "reason /
        // releaseNote deliberately omitted — internal only". The
        // bounded select preserves that omission.
        const selectIdx = SRC.indexOf("CASE_LEGAL_HOLD_SELECT");
        const selectEnd = SRC.indexOf("} as const", selectIdx);
        const selectBlock = SRC.slice(selectIdx, selectEnd);
        expect(selectBlock).not.toMatch(/^\s*reason:\s*true/m);
        expect(selectBlock).not.toMatch(/^\s*releaseNote:\s*true/m);
    });
    it("projectCaseLegalHold accepts CaseLegalHoldProjection (bounded type)", () => {
        expect(SRC).toMatch(/export function projectCaseLegalHold\(hold:\s*CaseLegalHoldProjection\)/);
    });
});
// =============================================================================
// Part 4 — Governance error wrapper preserved (no weakening)
// =============================================================================
describe("Phase 32.7.3 — governance fail-closed contract preserved", () => {
    const SRC = readApi("src/routes/_governance-error-bound.ts");
    it("still catches Prisma P2022 / P2021 / P2025 → 503 governance_schema_unavailable", () => {
        expect(SRC).toMatch(/P2022/);
        expect(SRC).toMatch(/P2021/);
        expect(SRC).toMatch(/P2025/);
        expect(SRC).toMatch(/code:\s*"governance_schema_unavailable"/);
        expect(SRC).toMatch(/reply\.code\(503\)/);
    });
    it("non-schema-drift errors still re-thrown (no silent permissive default)", () => {
        expect(SRC).toMatch(/throw err/);
    });
});
// =============================================================================
// Part 5 — Route handlers still call the bounded select-using helpers
// =============================================================================
describe("Phase 32.7.3 — route handlers unchanged; the fix is service-side only", () => {
    const SRC = readApi("src/routes/governance.routes.ts");
    it("/v1/governance/legal-holds still calls listLegalHoldsForTeam inside runGovernanceHandler", () => {
        const routeIdx = SRC.indexOf('"/v1/governance/legal-holds"');
        expect(routeIdx).toBeGreaterThan(-1);
        const routeBody = SRC.slice(routeIdx, routeIdx + 2000);
        expect(routeBody).toMatch(/runGovernanceHandler\(reply,/);
        expect(routeBody).toMatch(/listLegalHoldsForTeam/);
        expect(routeBody).toMatch(/projectLegalHold/);
    });
    it("/v1/governance/case-legal-holds GET routes via per-endpoint optional-subsystem handler (Phase 32.7.6)", () => {
        // Phase 32.7.6 — the case-legal-holds GET no longer uses
        // runGovernanceHandler. It now uses an explicit try/catch with
        // `isPrismaTableOrColumnMissing(err)` that returns 200 with an
        // empty array when the underlying table/column is missing
        // (Phase 14 feature not deployed in this environment). The
        // service helpers `listCaseLegalHolds` + `projectCaseLegalHold`
        // are still called.
        const routeIdx = SRC.indexOf('app.get(\n    "/v1/governance/case-legal-holds"');
        expect(routeIdx).toBeGreaterThan(-1);
        const nextHandler = SRC.indexOf("app.post(", routeIdx);
        const routeBody = SRC.slice(routeIdx, nextHandler);
        expect(routeBody).not.toMatch(/runGovernanceHandler\(/);
        expect(routeBody).toMatch(/isPrismaTableOrColumnMissing\(err\)/);
        expect(routeBody).toMatch(/listCaseLegalHolds/);
        expect(routeBody).toMatch(/projectCaseLegalHold/);
    });
});
