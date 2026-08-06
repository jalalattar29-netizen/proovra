/**
 * PHASE 12 — POINT 5: ONE OCR authority, ONE transcript authority.
 *
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * Both capabilities had two registered paths.
 *
 *   REAL     `media-intelligence` queue, run kinds `extract_ocr_azure` and
 *            `extract_transcript_deepgram`, addressing a durable
 *            `MediaIntelligenceRun`: policy reload, atomic claim with a
 *            generation fence, provider call through the budget-gated
 *            adapter, terminal write, stranded-run reconciler.
 *
 *   STUB     the `mi-ocr` and `mi-transcript` queues. Their processors
 *            resolved the evidence part, logged `not_configured_completed`
 *            and RETURNED SUCCESS. No extraction, no run row, no terminal
 *            state, no provider — while the registry credited them with an
 *            `EvidencePart` durable authority, an `ai_provider` external
 *            boundary and a reconciler that had no way to find their work.
 *
 * Two authorities per capability is the condition Point 5 exists to remove,
 * and "completed" for work that never ran is a false terminal state. The stub
 * path is gone: queues, producers, processors, worker registrations, registry
 * entries, legacy adapters and operator projections.
 *
 * WHY DELETING IT WAS SAFE
 * ---------------------------------------------------------------------------
 * Not by argument — by measurement. `enqueueOcrJob` and `enqueueTranscriptJob`
 * had NO CALLER IN ANY COMMIT of this repository. Neither queue has ever held
 * a job, so no in-flight legacy payload can exist and neither needs a legacy
 * adapter. This file asserts that property structurally so a future author
 * cannot reintroduce the producers and quietly re-create the second authority.
 *
 * WHAT REPLACES `not_configured_completed`
 * ---------------------------------------------------------------------------
 * An explicit, canonical refusal. `providerNotConfiguredReason` is evaluated
 * in the internal extract route BEFORE the parts query, before object storage
 * and before `runProviderOperation`, so an unconfigured provider produces
 * `provider_not_configured:<PROVIDER>` — which the worker persists as a FAILED
 * run — instead of a success with zero records. No completion claim, no run
 * stuck PROCESSING, no provider budget consumed.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  CANONICAL_WORK_REGISTRY,
  JOB_NAMES,
  LEGACY_PAYLOAD_ADAPTERS,
  QUEUE_NAMES,
  getBullMqEntries,
} from "@proovra/shared";
import { MEDIA_INTELLIGENCE_JOB_KINDS } from "@proovra/shared";

import { providerNotConfiguredReason } from "../src/routes/internal-media-intelligence-extract.routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

function src(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

/** Strip comments so a NOTE ABOUT the removal is not mistaken for the thing. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const WORKER_QUEUE = src("services/worker/src/queue.ts");
const WORKER_INDEX = src("services/worker/src/index.ts");
const WORKER_TELEMETRY = src("services/worker/src/telemetry.ts");
const SUBSYSTEM = src("services/worker/src/subsystem-queue-processors.ts");
const MI_PROCESSOR = src("services/worker/src/media-intelligence.processor.ts");

// ===========================================================================
// The canonical authority
// ===========================================================================

describe("POINT 5 — OCR and transcript each have exactly one authority", () => {
  it("OCR extraction runs on ONE registered work unit", () => {
    // The authority is the run kind on the media-intelligence chain, not a
    // queue of its own. Anything else that claims to extract OCR is a second
    // authority by definition.
    expect(MEDIA_INTELLIGENCE_JOB_KINDS).toContain("extract_ocr_azure");

    const ocrUnits = CANONICAL_WORK_REGISTRY.filter((e) =>
      /ocr/i.test(e.workName),
    );
    expect(ocrUnits.map((e) => e.workName)).toEqual([]);

    const entry = CANONICAL_WORK_REGISTRY.find(
      (e) => e.workName === JOB_NAMES.RUN_MEDIA_INTELLIGENCE,
    );
    expect(entry).toBeDefined();
    expect(entry?.durableAuthority.model).toBe("MediaIntelligenceRun");
    expect(entry?.externalBoundary).toBe("ai_provider");
    expect(entry?.claim).not.toBeNull();
    expect(entry?.reconciler).toBe(
      "services/worker/src/intelligence-run-reconciler.ts",
    );
  });

  it("transcript extraction runs on the SAME one unit", () => {
    expect(MEDIA_INTELLIGENCE_JOB_KINDS).toContain(
      "extract_transcript_deepgram",
    );
    const transcriptUnits = CANONICAL_WORK_REGISTRY.filter((e) =>
      /transcript/i.test(e.workName),
    );
    expect(transcriptUnits.map((e) => e.workName)).toEqual([]);
  });

  it("the real provider branches dispatch from the run kind, not a payload field", () => {
    expect(MI_PROCESSOR).toMatch(
      /if \(kind === "extract_ocr_azure"\)[\s\S]{0,200}processExtractOcrAzureJob/,
    );
    expect(MI_PROCESSOR).toMatch(
      /if \(kind === "extract_transcript_deepgram"\)[\s\S]{0,200}processExtractTranscriptDeepgramJob/,
    );
  });

  it("both real branches take a claim fence and carry it into every terminal write", () => {
    // The property that stops a worker whose lease expired from writing its
    // late outcome over its replacement's result.
    for (const fn of [
      "processExtractOcrAzureJob",
      "processExtractTranscriptDeepgramJob",
    ]) {
      const start = MI_PROCESSOR.indexOf(`async function ${fn}(`);
      expect(start, fn).toBeGreaterThan(0);
      const body = MI_PROCESSOR.slice(start, start + 6000);
      expect(body, fn).toMatch(/markRunProcessing\(runId, teamId, prisma\)/);
      expect(body, fn).toMatch(/if \(proc\.ok\) runFence = proc\.fence/);
      expect(body, fn).toMatch(
        /markRunCompleted\(runId, teamId, prisma, runFence\)/,
      );
      expect(body, fn).toMatch(
        /markRunFailed\(runId, teamId, errorSummary, prisma, runFence\)/,
      );
    }
  });
});

// ===========================================================================
// Stays-removed
// ===========================================================================

describe("POINT 5 — the duplicate stub authority stays removed", () => {
  it("no `mi-ocr` / `mi-transcript` queue name exists in the name authority", () => {
    const queueNames = Object.values(QUEUE_NAMES) as string[];
    expect(queueNames).not.toContain("mi-ocr");
    expect(queueNames).not.toContain("mi-transcript");
  });

  it("no `ExtractOcr` / `ExtractTranscript` job name exists", () => {
    const jobNames = Object.values(JOB_NAMES) as string[];
    expect(jobNames).not.toContain("ExtractOcr");
    expect(jobNames).not.toContain("ExtractTranscript");
  });

  it("no registry entry, of any transport, names either queue", () => {
    // Compared as strings deliberately: `QueueName` no longer includes either
    // literal, so a typed comparison would be a compile error rather than a
    // measurement — and the point is to measure the DATA, not the type.
    const offenders = CANONICAL_WORK_REGISTRY.filter((e) =>
      ["mi-ocr", "mi-transcript"].includes(e.queueName as string),
    ).map((e) => e.workName);
    expect(offenders).toEqual([]);
  });

  it("the worker declares no queue, producer or registration for either", () => {
    for (const [label, text] of [
      ["queue.ts", WORKER_QUEUE],
      ["index.ts", WORKER_INDEX],
      ["telemetry.ts", WORKER_TELEMETRY],
    ] as const) {
      const body = code(text);
      expect(body, label).not.toMatch(/ocrQueue|transcriptQueue/);
      expect(body, label).not.toMatch(/enqueueOcrJob|enqueueTranscriptJob/);
      expect(body, label).not.toMatch(/"mi-ocr"|"mi-transcript"/);
    }
  });

  it("no processor logs a completion it did not perform", () => {
    expect(code(SUBSYSTEM)).not.toMatch(/not_configured_completed/);
    expect(code(SUBSYSTEM)).not.toMatch(
      /processOcrJob|processTranscriptJob/,
    );
  });

  it("no legacy adapter is retained for a queue that never held a job", () => {
    const names = LEGACY_PAYLOAD_ADAPTERS.map((a) => a.jobName);
    expect(names).not.toContain("ExtractOcr");
    expect(names).not.toContain("ExtractTranscript");
  });

  it("CURRENT_RUNTIME no-op processors = 0", () => {
    // A processor whose only effect is a log line has no durable authority to
    // reload, nothing for a reconciler to find, and no terminal state to be
    // truthful about. There must be none.
    for (const entry of CANONICAL_WORK_REGISTRY) {
      if (entry.implementation !== "CURRENT_RUNTIME") continue;
      expect(entry.terminalWriter.trim(), entry.workName).not.toBe("");
      expect(entry.durableAuthority.model.trim(), entry.workName).not.toBe("");
    }
  });
});

// ===========================================================================
// Conservation, recomputed from the settled tree
// ===========================================================================

describe("POINT 5 — runtime-unit conservation after the removal", () => {
  it("the BullMQ set is 1:1 with processed queues and holds no removed chain", () => {
    const bullmq = getBullMqEntries();
    const queueNames = bullmq.map((e) => e.queueName);
    // Every BullMQ entry names a distinct queue.
    expect(new Set(queueNames).size).toBe(bullmq.length);
    expect(queueNames).not.toContain("mi-ocr");
    expect(queueNames).not.toContain("mi-transcript");
  });

  it("every registry entry's queue name is a live name in the name authority", () => {
    const live = new Set(Object.values(QUEUE_NAMES) as string[]);
    for (const entry of CANONICAL_WORK_REGISTRY) {
      if (!entry.queueName) continue;
      expect(live.has(entry.queueName), entry.workName).toBe(true);
    }
  });
});

// ===========================================================================
// The explicit unconfigured-provider state
// ===========================================================================

describe("POINT 5 — an unconfigured provider produces a bounded refusal", () => {
  it("returns a canonical bounded reason when the adapter is unbound or not READY", () => {
    // In the unit environment no provider credentials are bound, so both
    // probes are NOT_CONFIGURED. The reason is a fixed token plus the provider
    // name — never a credential, never a raw SDK error.
    for (const [kind, provider] of [
      ["ocr_azure", "AZURE_DOCUMENT_INTELLIGENCE"],
      ["transcript_deepgram", "DEEPGRAM_TRANSCRIPT"],
    ] as const) {
      const reason = providerNotConfiguredReason(kind);
      expect(reason, kind).toBe(`provider_not_configured:${provider}`);
      expect(reason!.length).toBeLessThanOrEqual(240);
    }
  });

  it("the route decides configuration BEFORE storage, parts and the provider call", () => {
    const routeSrc = src(
      "services/api/src/routes/internal-media-intelligence-extract.routes.ts",
    );
    const decide = routeSrc.indexOf("const notConfigured = providerNotConfiguredReason(kind)");
    const parts = routeSrc.indexOf("evidence_parts");
    const storage = routeSrc.indexOf("getObjectRange({");
    const provider = routeSrc.indexOf("await runProviderOperation({");
    expect(decide).toBeGreaterThan(0);
    expect(decide).toBeLessThan(parts);
    expect(decide).toBeLessThan(storage);
    expect(decide).toBeLessThan(provider);
  });

  it("the refusal is a failure, so the worker cannot record it as a completed run", () => {
    const routeSrc = src(
      "services/api/src/routes/internal-media-intelligence-extract.routes.ts",
    );
    const at = routeSrc.indexOf("if (notConfigured) {");
    expect(at).toBeGreaterThan(0);
    const block = routeSrc.slice(at, at + 400);
    expect(block).toMatch(/success: false/);
    expect(block).toMatch(/recordsCreated: 0/);
    expect(block).toMatch(/error: notConfigured/);
  });
});
