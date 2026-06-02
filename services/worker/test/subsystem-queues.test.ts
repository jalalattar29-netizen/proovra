/**
 * Phase 31.19 — source-contract tests for the four newly isolated
 * subsystem queues (mi-ocr, mi-transcript, mi-search-index,
 * graph-reconcile).
 *
 * Each test reads the source and asserts:
 *   * dedicated queue name is declared with the canonical prefix
 *   * dedicated job name is declared
 *   * deterministic `buildXJobId` helper exists
 *   * `enqueueX` helper enforces team/evidence scoping where
 *     applicable
 *   * the worker registration uses `safeRegisterWorker(<kind>, ...)`
 *     so a processor failure cannot crash the worker process
 *   * shutdown closes both worker + queue
 *   * NO bare PrismaClient construction in the new processor file
 *   * processors are wired to import the shared `prisma` from
 *     ./db.js (not a bare instantiation)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const QUEUE_SRC = readSource("../src/queue.ts");
const INDEX_SRC = readSource("../src/index.ts");
const PROCESSORS_SRC = readSource("../src/subsystem-queue-processors.ts");

// =============================================================================
// Queue declarations
// =============================================================================

describe("Phase 31.19 — queue declarations", () => {
  it("declares mi-ocr queue name + job name", () => {
    expect(QUEUE_SRC).toMatch(/ocrQueueName = "mi-ocr"/);
    expect(QUEUE_SRC).toMatch(/ocrJobName = "ExtractOcr"/);
    expect(QUEUE_SRC).toMatch(/export const ocrQueue = new Queue\(ocrQueueName/);
  });

  it("declares mi-transcript queue name + job name", () => {
    expect(QUEUE_SRC).toMatch(/transcriptQueueName = "mi-transcript"/);
    expect(QUEUE_SRC).toMatch(/transcriptJobName = "ExtractTranscript"/);
    expect(QUEUE_SRC).toMatch(
      /export const transcriptQueue = new Queue\(transcriptQueueName/,
    );
  });

  it("declares mi-search-index queue name + job name", () => {
    expect(QUEUE_SRC).toMatch(/miSearchIndexQueueName = "mi-search-index"/);
    expect(QUEUE_SRC).toMatch(/miSearchIndexJobName = "IndexMediaIntelligence"/);
    expect(QUEUE_SRC).toMatch(
      /export const miSearchIndexQueue = new Queue\(miSearchIndexQueueName/,
    );
  });

  it("declares graph-reconcile queue name + job name", () => {
    expect(QUEUE_SRC).toMatch(/graphReconcileQueueName = "graph-reconcile"/);
    expect(QUEUE_SRC).toMatch(/graphReconcileJobName = "ReconcileTeamGraph"/);
    expect(QUEUE_SRC).toMatch(
      /export const graphReconcileQueue = new Queue\(graphReconcileQueueName/,
    );
  });

  it("each new queue has bounded retry + exponential backoff", () => {
    const newQueueNames = [
      "ocrQueue",
      "transcriptQueue",
      "miSearchIndexQueue",
      "graphReconcileQueue",
    ];
    for (const name of newQueueNames) {
      const idx = QUEUE_SRC.indexOf(`export const ${name} = new Queue(`);
      expect(idx).toBeGreaterThan(0);
      const slice = QUEUE_SRC.slice(idx, idx + 800);
      expect(slice).toMatch(/attempts: \d+/);
      expect(slice).toMatch(/backoff:\s*\{\s*type: "exponential"/);
      // Visible-to-ops behavior: don't drop failed jobs (DLQ-shaped).
      // Two of the four ops-friendly queues use `removeOnFail: false`;
      // mi-search-index uses 200 for a bounded retention window.
      expect(slice).toMatch(/removeOnFail:\s*(false|200)/);
    }
  });

  it("each queue has a deterministic idempotent job-id builder", () => {
    expect(QUEUE_SRC).toMatch(
      /function buildOcrJobId\(evidencePartId: string\): string \{\s*return `mi-ocr-\$\{evidencePartId\}`/,
    );
    expect(QUEUE_SRC).toMatch(
      /function buildTranscriptJobId\(evidencePartId: string\): string \{\s*return `mi-transcript-\$\{evidencePartId\}`/,
    );
    expect(QUEUE_SRC).toMatch(
      /function buildMiSearchIndexJobId\(evidenceId: string\): string \{\s*return `mi-search-index-\$\{evidenceId\}`/,
    );
    expect(QUEUE_SRC).toMatch(
      /function buildGraphReconcileJobId\(teamId: string\): string \{\s*return `graph-reconcile-\$\{teamId\}`/,
    );
  });

  it("ocr/transcript enqueue helpers require evidencePartId (anti-leak)", () => {
    const ocrIdx = QUEUE_SRC.indexOf("export async function enqueueOcrJob");
    expect(ocrIdx).toBeGreaterThan(0);
    const ocrSlice = QUEUE_SRC.slice(ocrIdx, ocrIdx + 800);
    expect(ocrSlice).toMatch(/evidence_part_id_required/);

    const trIdx = QUEUE_SRC.indexOf("export async function enqueueTranscriptJob");
    expect(trIdx).toBeGreaterThan(0);
    const trSlice = QUEUE_SRC.slice(trIdx, trIdx + 800);
    expect(trSlice).toMatch(/evidence_part_id_required/);
  });

  it("enqueue helpers use the shared idempotent enqueue path", () => {
    expect(QUEUE_SRC).toMatch(/genericIdempotentEnqueue\(/);
  });
});

// =============================================================================
// Worker registrations in index.ts
// =============================================================================

describe("Phase 31.19 — worker registrations", () => {
  it("registers each new worker via safeRegisterWorker (failure isolation)", () => {
    expect(INDEX_SRC).toMatch(/safeRegisterWorker\("mi-ocr"/);
    expect(INDEX_SRC).toMatch(/safeRegisterWorker\("mi-transcript"/);
    expect(INDEX_SRC).toMatch(/safeRegisterWorker\("mi-search-index"/);
    expect(INDEX_SRC).toMatch(/safeRegisterWorker\("graph-reconcile"/);
  });

  it("WorkerKind union includes the four new kinds", () => {
    const idx = INDEX_SRC.indexOf("type WorkerKind");
    expect(idx).toBeGreaterThan(0);
    const slice = INDEX_SRC.slice(idx, idx + 600);
    expect(slice).toMatch(/"mi-ocr"/);
    expect(slice).toMatch(/"mi-transcript"/);
    expect(slice).toMatch(/"mi-search-index"/);
    expect(slice).toMatch(/"graph-reconcile"/);
  });

  it("shutdown closes each worker (null-checked) and each queue", () => {
    expect(INDEX_SRC).toMatch(/ocrWorker/);
    expect(INDEX_SRC).toMatch(/transcriptWorker/);
    expect(INDEX_SRC).toMatch(/miSearchIndexWorker/);
    expect(INDEX_SRC).toMatch(/graphReconcileWorker/);
    expect(INDEX_SRC).toMatch(/await ocrQueue\.close\(\)/);
    expect(INDEX_SRC).toMatch(/await transcriptQueue\.close\(\)/);
    expect(INDEX_SRC).toMatch(/await miSearchIndexQueue\.close\(\)/);
    expect(INDEX_SRC).toMatch(/await graphReconcileQueue\.close\(\)/);
  });

  it("each worker is bounded — concurrency 1 or 2", () => {
    // mi-ocr: concurrency 1 (vendor calls can be slow).
    const ocrIdx = INDEX_SRC.indexOf('safeRegisterWorker("mi-ocr"');
    const ocrSlice = INDEX_SRC.slice(ocrIdx, ocrIdx + 400);
    expect(ocrSlice).toMatch(/concurrency: 1/);
    // mi-transcript: same.
    const trIdx = INDEX_SRC.indexOf('safeRegisterWorker("mi-transcript"');
    const trSlice = INDEX_SRC.slice(trIdx, trIdx + 400);
    expect(trSlice).toMatch(/concurrency: 1/);
    // mi-search-index: 2 (lightweight delegate).
    const siIdx = INDEX_SRC.indexOf('safeRegisterWorker("mi-search-index"');
    const siSlice = INDEX_SRC.slice(siIdx, siIdx + 400);
    expect(siSlice).toMatch(/concurrency: 2/);
    // graph-reconcile: 1 (Postgres-heavy).
    const grIdx = INDEX_SRC.indexOf('safeRegisterWorker("graph-reconcile"');
    const grSlice = INDEX_SRC.slice(grIdx, grIdx + 400);
    expect(grSlice).toMatch(/concurrency: 1/);
  });
});

// =============================================================================
// Processors — privacy + bootstrap invariants
// =============================================================================

describe("Phase 31.19 — subsystem processor source contract", () => {
  it("NEVER constructs a bare PrismaClient — imports the shared instance from ./db.js", () => {
    // Code-only check (strip comments so the documentation referencing
    // the past hotfix doesn't trigger).
    const code = PROCESSORS_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/new PrismaClient\(/);
    expect(PROCESSORS_SRC).toMatch(/import \{ prisma \} from "\.\/db\.js"/);
  });

  it("mi-ocr / mi-transcript log NOT_CONFIGURED completion (no fake extraction)", () => {
    expect(PROCESSORS_SRC).toMatch(/mi_ocr\.not_configured_completed/);
    expect(PROCESSORS_SRC).toMatch(/mi_transcript\.not_configured_completed/);
  });

  it("mi-search-index delegates to the existing search-indexing queue", () => {
    expect(PROCESSORS_SRC).toMatch(/enqueueSearchIndexingJob/);
    expect(PROCESSORS_SRC).toMatch(/kind: "evidence"/);
  });

  it("graph-reconcile passes the worker's shared prisma to the read-only reconciler", () => {
    // Phase 14 evolution: reconcileTeamGraph now accepts an optional
    // third `hooks` argument carrying `onReconciled` so post-reconcile
    // can enqueue a search re-index without shared-runtime depending
    // on the worker queue. The call may now span multiple lines and
    // include the hooks object. The contract this test pins (worker
    // passes its OWN prisma client, not a globally-imported one) is
    // preserved — accept either the legacy single-line shape OR the
    // new multi-line shape with the hooks argument.
    expect(PROCESSORS_SRC).toMatch(
      /reconcileTeamGraph\(\s*job\.data\.teamId,\s*prisma\s*[,)]/,
    );
  });

  it("processors do NOT read or project reviewer-private fields", () => {
    const code = PROCESSORS_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // None of these subsystem processors should reference reviewer-
    // private columns.
    expect(code).not.toMatch(/reviewer_email/);
    expect(code).not.toMatch(/reviewer_display_name/);
    expect(code).not.toMatch(/token_hash/);
    expect(code).not.toMatch(/safe_note/);
    expect(code).not.toMatch(/escalation_reason/);
    expect(code).not.toMatch(/rejection_reason/);
    expect(code).not.toMatch(/paused_reason/);
    expect(code).not.toMatch(/resolution_note/);
    expect(code).not.toMatch(/suppression_reason/);
  });
});
