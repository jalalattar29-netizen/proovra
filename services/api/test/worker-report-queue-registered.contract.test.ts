/**
 * Phase CAPTURE-ARTIFACT-PIPELINE — worker contract lock.
 *
 * The guarantee: if nothing CONSUMES the report queue, every Capture hangs at
 * SIGNED forever — no Report row, no VerificationPackage, no transition to
 * REPORTED, no downloadable artifact. A refactor that renames the queue, drops
 * the worker registration or unhooks the handler must fail CI loudly rather
 * than in production.
 *
 * PHASE 12 — POINT 5 rewrote HOW that guarantee is checked.
 *
 * The original file pinned it by regex over four source files, two of which no
 * longer exist: `services/api/src/queue/report-queue.ts` and
 * `packages/shared/src/report-queue.ts` were the api's private producer and its
 * private job-name/job-id/payload copy, and both were deleted when the report
 * chain converged onto the shared registry. A test that reads a deleted file
 * does not fail informatively — it fails as a missing file, which reads as a
 * broken test rather than a broken contract.
 *
 * So the same guarantee is now asserted against the REGISTRY, which is what the
 * producer and the consumer both derive from. Queue name, job name and retry
 * policy are one value each; there is no second copy left to drift. What stays
 * source-scanned is the one property no runtime assertion can see: that the
 * worker process actually binds a Worker to that queue at boot, which is a fact
 * about the bootstrap file rather than about any value.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { JOB_NAMES, QUEUE_NAMES, getWorkEntryOrThrow } from "@proovra/shared";

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
const ROOT_PKG = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

describe("Worker report-queue contract", () => {
  const entry = getWorkEntryOrThrow(JOB_NAMES.GENERATE_REPORT);

  it("the report chain has ONE queue name and ONE job name", () => {
    expect(entry.queueName).toBe(QUEUE_NAMES.REPORT);
    expect(entry.workName).toBe("GenerateReportJob");
    expect(entry.transport).toBe("bullmq");
  });

  it("the report chain names a durable authority, not an evidence id", () => {
    // The regression this pins: the payload used to carry
    // `{ evidenceId, forceRegenerate }`, and `forceRegenerate` was an
    // authorization outcome arriving as an unverified boolean.
    expect(entry.durableAuthority.model).toBe("ReportGenerationRequest");
    expect(entry.durableAuthority.createdBySynchronousPath).toBe(true);
  });

  it("worker: registers a Worker for the report queue using processGenerateReport", () => {
    expect(WORKER_INDEX).toMatch(/import\s+\{[\s\S]*?reportQueueName[\s\S]*?\}/);
    expect(WORKER_INDEX).toMatch(/import\s+\{[\s\S]*?processGenerateReport[\s\S]*?\}/);
    // Registered via safeRegisterWorker so a thrown error during boot is
    // caught + alerted instead of crashing the whole worker.
    expect(WORKER_INDEX).toMatch(
      /safeRegisterWorker\(\s*"report"\s*,\s*\(\)\s*=>\s*\n?\s*new Worker\(\s*reportQueueName/,
    );
    expect(WORKER_INDEX).toMatch(/processGenerateReport/);
  });

  it("processor: processGenerateReport writes Evidence.status = REPORTED on success", () => {
    // The actual SIGNED → REPORTED transition; without it the polling loop on
    // the Evidence Detail page would never terminate.
    expect(PROCESSOR).toMatch(/status:\s*EvidenceStatus\.REPORTED/);
    expect(PROCESSOR).toMatch(/reportGeneratedAtUtc:/);
    expect(PROCESSOR).toMatch(/latestReportVersion:/);
  });

  it("root package.json: `pnpm dev` starts API + worker + web concurrently", () => {
    // Without this script, devs run `pnpm dev:web` only and every Capture
    // hangs at SIGNED because nothing consumes the report queue.
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
