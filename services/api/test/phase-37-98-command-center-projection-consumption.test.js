/**
 * PHASE 37.98 — Command Center projection consumption + staleness.
 *
 * Source-contract assertions proving:
 *   - the Command Center service IMPORTS the projection read helper,
 *   - the envelope declares the projection-backed summary field with
 *     staleness metadata,
 *   - the staleness policy uses the canonical "fresh | stale | missing"
 *     vocabulary,
 *   - the BullMQ refresh queue + worker are wired in the worker entrypoint,
 *   - the refresh processor scopes every count by the input teamId.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWorker(rel) {
    return readFileSync(fileURLToPath(new URL(`../../worker/${rel}`, import.meta.url)), "utf8");
}
const CMD_CENTER = readApi("src/services/dashboard/command-center.service.ts");
const REFRESH_SVC = readApi("src/services/dashboard/projections/refresh-org-health.service.ts");
const WORKER_QUEUE = readWorker("src/queue.ts");
const WORKER_PROCESSORS = readWorker("src/subsystem-queue-processors.ts");
const WORKER_INDEX = readWorker("src/index.ts");
// =============================================================================
// PART 1 — Command Center now imports + consumes projection
// =============================================================================
describe("Phase 37.98 — Command Center consumes projection", () => {
    it("imports readLatestOrgHealthProjection from the projection service", () => {
        expect(CMD_CENTER).toMatch(/import\s*\{\s*readLatestOrgHealthProjection\s*\}\s*from\s*"\.\/projections\/refresh-org-health\.service\.js"/);
    });
    it("calls readLatestOrgHealthProjection in the envelope build path", () => {
        expect(CMD_CENTER).toMatch(/readLatestOrgHealthProjection\(/);
    });
    it("envelope declares projectionSummary with the canonical staleness shape", () => {
        expect(CMD_CENTER).toMatch(/\bprojectionSummary:\s*\{/);
        expect(CMD_CENTER).toMatch(/projectionStatus:\s*"fresh"\s*\|\s*"stale"\s*\|\s*"missing"/);
        expect(CMD_CENTER).toMatch(/projectionRefreshedAt:/);
        expect(CMD_CENTER).toMatch(/projectionAgeSeconds:/);
        expect(CMD_CENTER).toMatch(/usedLiveFallback:\s*boolean/);
        expect(CMD_CENTER).toMatch(/\bteamId:\s*string/);
    });
    it("envelope counts include the projection-backed fields", () => {
        expect(CMD_CENTER).toMatch(/evidenceCount:\s*number/);
        expect(CMD_CENTER).toMatch(/caseCount:\s*number/);
        expect(CMD_CENTER).toMatch(/pendingReportCount:\s*number/);
        expect(CMD_CENTER).toMatch(/pendingPackageCount:\s*number/);
        expect(CMD_CENTER).toMatch(/openIncidentCount:\s*number/);
        expect(CMD_CENTER).toMatch(/slaBreachCount:\s*number/);
        expect(CMD_CENTER).toMatch(/governanceBlockerCount:\s*number/);
        expect(CMD_CENTER).toMatch(/recentVerificationCount:\s*number/);
    });
    it("projection-summary helper has a bounded freshness threshold", () => {
        expect(CMD_CENTER).toMatch(/PROJECTION_FRESH_THRESHOLD_SEC\s*=\s*\d+/);
    });
    it("falls back to bounded live counts when projection is missing", () => {
        // The fallback path queries evidence + case counts ONLY (no global
        // table scans, no unbounded findMany).
        expect(CMD_CENTER).toMatch(/buildProjectionSummary[\s\S]{0,3000}prisma\.evidence\.count\(\s*\{\s*where:\s*\{[\s\S]{0,80}teamId/);
        expect(CMD_CENTER).toMatch(/buildProjectionSummary[\s\S]{0,3000}prisma\.case\.count\(\s*\{\s*where:\s*\{[\s\S]{0,80}teamId/);
    });
});
// =============================================================================
// PART 2 — Worker queue + processor + worker registration
// =============================================================================
describe("Phase 37.98 — refresh pipeline wired in worker", () => {
    it("queue.ts declares orgHealthRefreshQueue + payload type", () => {
        expect(WORKER_QUEUE).toMatch(/orgHealthRefreshQueueName\s*=\s*"org-health-refresh"/);
        expect(WORKER_QUEUE).toMatch(/orgHealthRefreshJobName\s*=\s*"RefreshOrgHealthProjection"/);
        expect(WORKER_QUEUE).toMatch(/orgHealthRefreshQueue\s*=\s*new Queue\(/);
        expect(WORKER_QUEUE).toMatch(/export type OrgHealthRefreshJobPayload[\s\S]{0,80}teamId:\s*string/);
    });
    it("the queue has bounded retry config (attempts + backoff)", () => {
        expect(WORKER_QUEUE).toMatch(/orgHealthRefreshQueue[\s\S]{0,500}attempts:\s*\d/);
        expect(WORKER_QUEUE).toMatch(/orgHealthRefreshQueue[\s\S]{0,500}backoff:\s*\{/);
    });
    it("subsystem-queue-processors.ts exports processOrgHealthRefreshJob", () => {
        expect(WORKER_PROCESSORS).toMatch(/export async function processOrgHealthRefreshJob/);
    });
    it("processor scopes every count by the input teamId (no cross-tenant scan)", () => {
        const fnIdx = WORKER_PROCESSORS.indexOf("processOrgHealthRefreshJob");
        const fnBody = WORKER_PROCESSORS.slice(fnIdx, fnIdx + 5000);
        const counts = [...fnBody.matchAll(/\.count\(\s*\{[\s\S]*?\}\s*\)/g)];
        expect(counts.length).toBeGreaterThan(0);
        for (const m of counts) {
            expect(/teamId/.test(m[0]), `Every refresh count must filter by teamId. Offender: ${m[0].slice(0, 200)}`).toBe(true);
        }
    });
    it("processor rejects an empty teamId loudly (no global refresh)", () => {
        const fnIdx = WORKER_PROCESSORS.indexOf("processOrgHealthRefreshJob");
        const fnBody = WORKER_PROCESSORS.slice(fnIdx, fnIdx + 5000);
        expect(fnBody).toMatch(/if \(!teamId\)/);
        expect(fnBody).toMatch(/skipped_missing_team_id/);
    });
    it("worker/index.ts imports the processor + registers it", () => {
        expect(WORKER_INDEX).toMatch(/processOrgHealthRefreshJob/);
        expect(WORKER_INDEX).toMatch(/orgHealthRefreshWorker/);
        expect(WORKER_INDEX).toMatch(/"org-health-refresh"[\s\S]{0,200}orgHealthRefreshWorker/);
    });
    it("worker shutdown closes the org-health-refresh worker + queue", () => {
        expect(WORKER_INDEX).toMatch(/\["org-health-refresh",\s*orgHealthRefreshWorker\]/);
        expect(WORKER_INDEX).toMatch(/orgHealthRefreshQueue\.close\(\)/);
    });
    it("WorkerKind includes the new queue", () => {
        expect(WORKER_INDEX).toMatch(/\|\s*"org-health-refresh"/);
    });
});
// =============================================================================
// PART 3 — Refresh service contract (unchanged-from-Phase-37.97; reasserted)
// =============================================================================
describe("Phase 37.98 — refresh service contract reassertion", () => {
    it("refresh service requires teamId + scopes every count by teamId", () => {
        expect(REFRESH_SVC).toMatch(/if \(!input\.teamId\)/);
        const counts = [...REFRESH_SVC.matchAll(/\.count\(\s*\{[\s\S]*?\}\s*\)/g)];
        for (const m of counts) {
            expect(/teamId/.test(m[0])).toBe(true);
        }
    });
    it("readLatestOrgHealthProjection filters by teamId (no global read)", () => {
        expect(REFRESH_SVC).toMatch(/findFirst\(\s*\{\s*where:\s*\{\s*teamId:\s*input\.teamId\s*\}/);
    });
});
