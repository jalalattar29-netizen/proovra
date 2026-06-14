/**
 * Phase CAPTURE-ARTIFACT-PIPELINE — worker contract lock.
 *
 * The Evidence finalize endpoint (services/api/.../evidence-complete
 * .service.ts:1252) enqueues `enqueueGenerateReportJob(evidenceId)`
 * AFTER signing succeeds. The job lands in the BullMQ queue named
 * `report` (services/api/.../queue/report-queue.ts) with job name
 * `GenerateReportJob` (packages/shared/src/report-queue.ts).
 *
 * If nothing CONSUMES that queue, every Capture hangs at SIGNED
 * forever — no Report row, no VerificationPackage, no transition to
 * REPORTED, no downloadable artifact. The consumer is the worker
 * process at services/worker/src/index.ts which registers a
 * `new Worker(reportQueueName, processGenerateReport, ...)`.
 *
 * A future refactor that drops the worker registration (e.g.
 * accidentally renaming the queue, removing the handler import, or
 * gating the registration behind a feature flag) would silently
 * break the entire Capture → Evidence → Report → Verification
 * pipeline. This file locks the registration contract so such a
 * regression fails CI loudly, not in production.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const WORKER_INDEX = readFileSync(
  resolve(REPO_ROOT, "services", "worker", "src", "index.ts"),
  "utf8",
);
const PROCESSOR = readFileSync(
  resolve(REPO_ROOT, "services", "worker", "src", "processor.ts"),
  "utf8",
);
const REPORT_QUEUE = readFileSync(
  resolve(REPO_ROOT, "services", "api", "src", "queue", "report-queue.ts"),
  "utf8",
);
const SHARED_REPORT_QUEUE = readFileSync(
  resolve(REPO_ROOT, "packages", "shared", "src", "report-queue.ts"),
  "utf8",
);
const WORKER_QUEUE = readFileSync(
  resolve(REPO_ROOT, "services", "worker", "src", "queue.ts"),
  "utf8",
);
const ROOT_PKG = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

describe("Worker report-queue contract", () => {
  it("api side: report-queue.ts constructs a BullMQ Queue using reportQueueName", () => {
    expect(REPORT_QUEUE).toMatch(/reportQueueName\s*=\s*"report"/);
    expect(REPORT_QUEUE).toMatch(/new Queue\(\s*reportQueueName/);
  });

  it("api side: enqueueGenerateReportJob is exported (used by completeEvidence)", () => {
    expect(REPORT_QUEUE).toMatch(/export\s+(async\s+)?function\s+enqueueGenerateReportJob/);
  });

  it("shared: job name is `GenerateReportJob`", () => {
    expect(SHARED_REPORT_QUEUE).toMatch(/generateReportJobName\s*=\s*"GenerateReportJob"/);
  });

  it("worker: queue.ts exports the SAME `reportQueueName = \"report\"` literal", () => {
    // If the api side ever drifts to a different queue name, the
    // worker would silently consume a queue that no producer feeds,
    // and the api would push into a queue no consumer reads. This
    // single-source-of-truth check prevents that split-brain.
    expect(WORKER_QUEUE).toMatch(/reportQueueName\s*=\s*"report"/);
  });

  it("worker: registers a Worker for the report queue using processGenerateReport", () => {
    // Imports the shared queue name AND the processor.
    expect(WORKER_INDEX).toMatch(/import\s+\{[\s\S]*?reportQueueName[\s\S]*?\}/);
    expect(WORKER_INDEX).toMatch(/import\s+\{[\s\S]*?processGenerateReport[\s\S]*?\}/);
    // Registers via safeRegisterWorker so a thrown error during boot
    // is caught + alerted instead of crashing the whole worker.
    expect(WORKER_INDEX).toMatch(
      /safeRegisterWorker\(\s*"report"\s*,\s*\(\)\s*=>\s*\n?\s*new Worker\(\s*reportQueueName/,
    );
    // Handler is wired to processGenerateReport (allow wrapping
    // helpers like wrapJobHandlerWithOtelContext to appear between).
    expect(WORKER_INDEX).toMatch(/processGenerateReport/);
  });

  it("processor: processGenerateReport writes Evidence.status = REPORTED on success", () => {
    // This is the actual SIGNED → REPORTED transition; without it
    // the polling loop on the Evidence Detail page would never
    // terminate. The text below pins both: (1) the import of the
    // status enum, (2) the status update inside an Evidence update
    // call.
    expect(PROCESSOR).toMatch(/EvidenceStatus\.REPORTED/);
    expect(PROCESSOR).toMatch(/status:\s*EvidenceStatus\.REPORTED/);
    expect(PROCESSOR).toMatch(/reportGeneratedAtUtc:/);
    expect(PROCESSOR).toMatch(/latestReportVersion:/);
  });

  it("root package.json: `pnpm dev` starts API + worker + web concurrently", () => {
    // Phase CAPTURE-ARTIFACT-PIPELINE — without this script, devs run
    // `pnpm dev:web` only and every Capture hangs at SIGNED because
    // nothing consumes the report queue. The script MUST include
    // all three workspaces.
    expect(ROOT_PKG.scripts?.dev, "root package.json must define a `dev` script").toBeTruthy();
    const dev = ROOT_PKG.scripts!.dev!;
    expect(dev).toMatch(/--parallel/);
    expect(dev).toMatch(/proovra-api/);
    expect(dev).toMatch(/proovra-worker/);
    expect(dev).toMatch(/proovra-web/);
  });

  it("root package.json: individual dev:api / dev:worker / dev:web scripts exist (sub-targets)", () => {
    expect(ROOT_PKG.scripts?.["dev:api"]).toMatch(/proovra-api/);
    expect(ROOT_PKG.scripts?.["dev:worker"]).toMatch(/proovra-worker/);
    expect(ROOT_PKG.scripts?.["dev:web"]).toMatch(/proovra-web/);
  });
});
