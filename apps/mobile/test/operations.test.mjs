/**
 * OPERATIONS — quotas and batch-analysis projections.
 *
 * The load-bearing claims:
 *   - a percentage is never invented from a denominator that does not exist.
 *     `used / 0` is Infinity and `0 / 0` is NaN, and both render as a bar of a
 *     width nobody measured;
 *   - a counter the endpoint did not return is absent, not zero. "We have no
 *     figure for this" and "this is zero" are different statements on a page
 *     about allowances;
 *   - the batch endpoint's own `progress` has no zero guard, so the projection
 *     must not pass its NaN through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/operations.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const O = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const quotaPayload = (over = {}) => ({
  data: {
    analyses: { limit: 10000, used: 250, remaining: 9750, resetDate: "2026-10-01T00:00:00.000Z" },
    batchJobs: { limit: 100, used: 4, remaining: 96 },
    apiKeys: { limit: 50, used: 50, remaining: 0 },
    teamMembers: { limit: 10, used: 8, remaining: 2 },
    ...over,
  },
});

/* -------------------------------------------------------------------- quotas */

test("the four canonical allowance lines are projected in the web's order", () => {
  const lines = O.parseQuotas(quotaPayload());
  assert.deepEqual(
    lines.map((l) => l.key),
    ["analyses", "batchJobs", "apiKeys", "teamMembers"],
  );
  assert.equal(lines[0].used, 250);
  assert.equal(lines[0].remaining, 9750);
  assert.equal(lines[0].resetIso, "2026-10-01T00:00:00.000Z");
});

test("a counter the endpoint omits is absent, not a zero allowance", () => {
  const payload = quotaPayload();
  delete payload.data.apiKeys;
  const lines = O.parseQuotas(payload);
  assert.deepEqual(
    lines.map((l) => l.key),
    ["analyses", "batchJobs", "teamMembers"],
  );
});

test("no percentage is invented from an unusable denominator", () => {
  assert.equal(O.quotaPercent(5, 0), null);
  assert.equal(O.quotaPercent(0, 0), null);
  assert.equal(O.quotaPercent(1, -10), null);
  assert.equal(O.quotaPercent(1, Number.NaN), null);
  assert.equal(O.quotaPercent(Number.NaN, 10), null);

  // And a real one is clamped rather than reported past 100.
  assert.equal(O.quotaPercent(0, 10), 0);
  assert.equal(O.quotaPercent(5, 10), 50);
  assert.equal(O.quotaPercent(30, 10), 100);
});

test("the tone follows the web's three bands", () => {
  assert.equal(O.quotaTone(null), "neutral");
  assert.equal(O.quotaTone(0), "verified");
  assert.equal(O.quotaTone(69), "verified");
  assert.equal(O.quotaTone(70), "pending");
  assert.equal(O.quotaTone(89), "pending");
  assert.equal(O.quotaTone(90), "risk");
  assert.equal(O.quotaTone(100), "risk");
});

test("usage stats are null when the endpoint reports none", () => {
  assert.equal(O.parseUsageStats({}), null);
  assert.equal(O.parseUsageStats({ data: {} }), null);
  assert.equal(O.parseUsageStats(null), null);
});

test("a missing cost is null, not a free service", () => {
  const stats = O.parseUsageStats({
    data: { dailyAnalyses: { today: 3, thisWeek: 9, thisMonth: 40 } },
  });
  assert.equal(stats.today, 3);
  assert.equal(stats.averageCostPerAnalysis, null);
  assert.equal(stats.totalCost, null);
});

/* ------------------------------------------------------------ batch analysis */

const job = (over = {}) => ({
  id: "job-1",
  name: "Nightly batch",
  status: "processing",
  totalItems: 10,
  processedItems: 4,
  failedItems: 1,
  progress: 50,
  createdAt: "2026-09-20T10:00:00.000Z",
  completedAt: null,
  ...over,
});

test("a job with no id is dropped rather than rendered as a dead row", () => {
  const jobs = O.parseBatchJobs({ data: [job(), job({ id: null }), null, "x"] });
  assert.equal(jobs.length, 1);
});

test("a zero-item job reports no progress instead of NaN", () => {
  // The endpoint computes (processed + failed) / totalItems with no guard.
  const [j] = O.parseBatchJobs({
    data: [job({ totalItems: 0, processedItems: 0, failedItems: 0, progress: Number.NaN })],
  });
  assert.equal(j.progress, null);
});

test("progress is clamped to 0-100", () => {
  const [high] = O.parseBatchJobs({ data: [job({ progress: 480 })] });
  assert.equal(high.progress, 100);
  const [low] = O.parseBatchJobs({ data: [job({ progress: -12 })] });
  assert.equal(low.progress, 0);
});

test("every BatchStatus value has a tone and a readable label", () => {
  for (const s of ["pending", "processing", "completed", "failed", "cancelled"]) {
    assert.ok(O.batchStatusTone(s), s);
  }
  assert.equal(O.batchStatusTone("completed"), "verified");
  assert.equal(O.batchStatusTone("failed"), "risk");
  // An unknown status is neutral, never silently "completed".
  assert.equal(O.batchStatusTone("something-new"), "neutral");

  assert.equal(O.batchStatusLabel("processing"), "Processing");
  assert.equal(O.batchStatusLabel(""), "Unknown");
});

test("jobs are listed newest first", () => {
  const jobs = O.sortBatchJobs(
    O.parseBatchJobs({
      data: [
        job({ id: "old", createdAt: "2026-09-01T00:00:00.000Z" }),
        job({ id: "new", createdAt: "2026-09-21T00:00:00.000Z" }),
        job({ id: "mid", createdAt: "2026-09-10T00:00:00.000Z" }),
      ],
    }),
  );
  assert.deepEqual(jobs.map((j) => j.id), ["new", "mid", "old"]);
});

/* ------------------------------------------------- the paths are the real ones */

test("the projections address the canonical endpoints", () => {
  assert.equal(O.QUOTA_PATH, "/v1/quotas");
  assert.equal(O.USAGE_STATS_PATH, "/v1/usage-stats");
  assert.equal(O.BATCH_ANALYSIS_PATH, "/v1/batch-analysis");
});

/* --------------------------------------------- batch analysis: the lifecycle */

const j = (status) => ({
  id: "b1",
  name: "n",
  status,
  totalItems: 3,
  processedItems: 0,
  failedItems: 0,
  progress: 0,
  createdAtIso: null,
  completedAtIso: null,
});

test("every lifecycle path is built from the job id", () => {
  assert.equal(O.buildBatchJobPath("b 1"), "/v1/batch-analysis/b%201");
  assert.equal(O.buildBatchProcessPath("b1"), "/v1/batch-analysis/b1/process");
  assert.equal(O.buildBatchCancelPath("b1"), "/v1/batch-analysis/b1/cancel");
  assert.equal(O.buildBatchExportPath("b1"), "/v1/batch-analysis/b1/export");
});

test("the draft is checked before the request, not after", () => {
  // Both are VALIDATION_ERROR at the route. A round trip to be told so is a
  // round trip the phone did not need.
  assert.match(O.validateBatchDraft("", ["e1"]), /name/i);
  assert.match(O.validateBatchDraft("  ", ["e1"]), /name/i);
  assert.match(O.validateBatchDraft("n", []), /record/i);
  assert.equal(O.validateBatchDraft("n", ["e1"]), null);
});

test("an empty description is absent, not an empty string", () => {
  // The route takes `description?`. Sending "" records a description the user
  // did not write.
  assert.deepEqual(O.buildBatchCreateBody(" n ", ["e1"], "   "), {
    name: "n",
    evidenceIds: ["e1"],
  });
  assert.equal(O.buildBatchCreateBody("n", ["e1"], " why ").description, "why");
});

test("the created id is read from the response envelope", () => {
  assert.equal(O.readCreatedBatchId({ data: { id: "b9" } }), "b9");
  assert.equal(O.readCreatedBatchId({ id: "b9" }), null);
  assert.equal(O.readCreatedBatchId(null), null);
});

test("cancel is offered wherever the service actually cancels", () => {
  // BD-1 CLOSED. `cancelJob` acted ONLY on PROCESSING and returned success for
  // `pending` having changed nothing, so offering it there reported a
  // cancellation that did not happen and the job ran anyway. This test
  // asserted the withholding, which was right while the service was wrong.
  //
  // The service now cancels both non-terminal states, so withholding it would
  // BE the untruth — a pending job is the easiest one to stop.
  assert.equal(O.canCancelBatch(j("processing")), true);
  assert.equal(O.canCancelBatch(j("pending")), true);
  // A job that has already finished answers 409 and is not offered.
  for (const terminal of ["completed", "failed", "cancelled"]) {
    assert.equal(O.canCancelBatch(j(terminal)), false, `${terminal} is terminal`);
  }
});

test("the export waits until the job has stopped running", () => {
  assert.equal(O.canExportBatch(j("processing")), false);
  assert.equal(O.canExportBatch(j("pending")), false);
  for (const s of ["completed", "failed", "cancelled"]) {
    assert.equal(O.canExportBatch(j(s)), true);
  }
});

test("the /results aggregate is NOT read, and the module says why", () => {
  /*
   * GET /v1/batch-analysis/:id/results is dispositioned SUPERSEDED_REMOVE, and
   * its triage states that it aggregates "classification/moderation/tag fields
   * that processBatch never writes". The service confirms it: a completed item
   * carries only { status, analysisMode, summary, evidence, warnings }.
   *
   * A card of classifications and an average confidence built from it would be
   * an empty list and a zero, presented as an analysis of the operator's
   * evidence. That is worse than an absence, because a reader would take
   * "0 classifications" as a finding about their records.
   */
  assert.equal(O.buildBatchResultsPath, undefined);
  assert.equal(O.parseBatchAggregate, undefined);
  assert.equal(O.canReadBatchResults, undefined);
});

test("what the batch DOES do is stated, in the service's own words", () => {
  assert.match(O.BATCH_ANALYSIS_MODE_NOTE, /metadata only/i);
  assert.match(
    O.BATCH_ANALYSIS_MODE_NOTE,
    /does not determine factual truth, authorship, authenticity, or legal admissibility/i,
  );
});

test("the export filename cannot escape the cache directory", () => {
  assert.equal(O.batchExportFilename("../../etc/passwd"), "batch-______etc_passwd.csv");
  assert.equal(O.batchExportFilename("b1"), "batch-b1.csv");
});
