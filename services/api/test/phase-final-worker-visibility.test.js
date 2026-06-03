/**
 * Phase Final-Worker-Visibility — contract test.
 *
 * Pins two closures:
 *
 * 1. **OTS upgrade loop control.** The processor now uses a stable
 *    jobId per evidenceId (so BullMQ's `attempts` ceiling is enforced
 *    across re-enqueues) and a 30-day global attempt budget anchored
 *    on `evidence.createdAt`. When the budget is exhausted the row
 *    is marked FAILED with reason `OTS_GLOBAL_BUDGET_EXHAUSTED` and a
 *    matching custody event is appended; no further re-enqueues.
 *
 * 2. **Queue heartbeat coverage.** `services/worker/src/index.ts`'s
 *    queue-health sampler now reports EVERY live queue declared in
 *    `services/worker/src/queue.ts`, not just `report` /
 *    `ots-upgrade` / `evidence-purge`.
 *
 * Both pins are file-content assertions so they survive without a
 * running worker.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readWorker(rel) {
    return readFileSync(fileURLToPath(new URL(`../../worker/${rel}`, import.meta.url)), "utf8");
}
// ============================================================================
// OTS upgrade loop control
// ============================================================================
describe("Phase Final-Worker-Visibility — OTS upgrade attempt budget", () => {
    const otsProc = readWorker("src/ots-upgrade.processor.ts");
    it("exports a stable follow-up jobId helper (no timestamp in jobId)", () => {
        expect(otsProc).toMatch(/export function buildFollowUpJobId/);
        // The new helper takes only `evidenceId` — no second arg.
        expect(otsProc).toMatch(/export function buildFollowUpJobId\(evidenceId: string\): string/);
        // The follow-up jobId prefix is the stable form.
        expect(otsProc).toMatch(/OTS_FOLLOWUP_JOB_PREFIX\s*=\s*["']ots-upgrade-followup-["']/);
    });
    it("the global attempt budget helpers are wired (env-overridable, default 30 days)", () => {
        expect(otsProc).toMatch(/getOtsGlobalBudgetMs/);
        expect(otsProc).toMatch(/isOtsGlobalBudgetExhausted/);
        expect(otsProc).toMatch(/OTS_GLOBAL_BUDGET_DAYS_DEFAULT\s*=\s*30/);
        expect(otsProc).toMatch(/process\.env\.OTS_GLOBAL_BUDGET_DAYS/);
    });
    it("the processor checks the budget before re-enqueueing on PENDING", () => {
        expect(otsProc).toMatch(/isOtsGlobalBudgetExhausted\(/);
        expect(otsProc).toMatch(/OTS_GLOBAL_BUDGET_EXHAUSTED/);
        expect(otsProc).toMatch(/global_budget_exhausted/);
        expect(otsProc).toMatch(/ots\.upgrade\.budget_exhausted/);
    });
    it("the follow-up jobId is now stable — no `upgradedAt.getTime()` baked in", () => {
        // The old pattern (baking the timestamp into the id) defeated
        // the attempts ceiling. The closure removes it.
        expect(otsProc).not.toMatch(/buildFollowUpJobId\([^)]*upgradedAt[^)]*\)/);
        // The single call site must use the stable form.
        expect(otsProc).toMatch(/buildFollowUpJobId\(evidenceId\)/);
    });
    it("the evidence select includes createdAt (the budget window anchor)", () => {
        expect(otsProc).toMatch(/createdAt:\s*true/);
    });
});
// ============================================================================
// Queue heartbeat coverage
// ============================================================================
describe("Phase Final-Worker-Visibility — heartbeat sampler covers every live queue", () => {
    const idx = readWorker("src/index.ts");
    const REQUIRED_QUEUES = [
        "reportQueueName",
        "reportDlqQueueName",
        "otsUpgradeQueueName",
        "evidencePurgeQueueName",
        "searchIndexingQueueName",
        "mediaIntelligenceQueueName",
        "mediaIntelligenceDlqQueueName",
        "derivedAssetsQueueName",
        "exifQueueName",
        "ocrQueueName",
        "transcriptQueueName",
        "miSearchIndexQueueName",
        "graphReconcileQueueName",
        "graphDomainSyncQueueName",
        "graphTimelineSyncQueueName",
        "graphSearchProjectionQueueName",
        "orgHealthRefreshQueueName",
    ];
    for (const q of REQUIRED_QUEUES) {
        it(`sampleQueueHealthOnce() samples ${q}`, () => {
            // Each queue name must appear inside `snapshotQueueHealth([...])`.
            // We look for the queue name token AS A KEY in the snapshot
            // list (not just anywhere in the file — many of these are
            // also passed to the Worker constructor below).
            const samplerBlock = idx.match(/snapshotQueueHealth\(\[([\s\S]*?)\]\)/);
            expect(samplerBlock, "snapshotQueueHealth([...]) not found").not.toBeNull();
            expect(samplerBlock[1]).toMatch(new RegExp(`\\b${q}\\b`));
        });
    }
    it("does not regress to the old 3-queue heartbeat", () => {
        // Negative assertion: the sampler array MUST NOT be limited to
        // just report / ots / purge.
        const samplerBlock = idx.match(/snapshotQueueHealth\(\[([\s\S]*?)\]\)/);
        expect(samplerBlock).not.toBeNull();
        const body = samplerBlock[1];
        // Count `name:` keys; we expect at least 14.
        const nameKeyCount = (body.match(/\bname:/g) ?? []).length;
        expect(nameKeyCount, `heartbeat sampler covers ${nameKeyCount} queues; expected ≥14`).toBeGreaterThanOrEqual(14);
    });
});
