/**
 * Phase 31.19 — contract tests for the isolated subsystem queues
 * (mi-search-index, graph-reconcile).
 *
 * PHASE 12 — POINT 5 removed `mi-ocr` and `mi-transcript` from this file
 * because it removed them from the runtime. They were a second authority for
 * capabilities the media-intelligence queue already owns end to end, and their
 * processors logged `not_configured_completed` and returned success — a false
 * terminal signal for extraction that never ran. The cases that pinned that
 * behaviour are not weakened here; their SUBJECT no longer exists, and a
 * stays-removed guard lives in
 * `services/api/test/phase-12-point5-ocr-transcript-authority.test.ts`.
 *
 * PHASE 12 — POINT 5 moved the queue-shape assertions from SOURCE REGEX to the
 * REGISTRY.
 *
 * They used to pin literal declarations — `ocrQueueName = "mi-ocr"`, a
 * per-queue `buildOcrJobId`, a `genericIdempotentEnqueue(` call — which is
 * exactly the duplication this phase removed. Those names are now aliases of
 * registry values, the four job-id builders collapsed into one
 * `buildCanonicalJobId`, and the private enqueue ladder is gone. A test that
 * pins a deleted symbol fails as a missing symbol, which reads as a broken test
 * rather than a broken contract.
 *
 * The GUARANTEES are unchanged and are now asserted where they actually live:
 * one queue name, one job name, one deterministic id prefix and one bounded
 * retry policy per chain. What stays source-scanned is the set of facts about
 * the BOOTSTRAP and the PROCESSOR FILE that no runtime value can express —
 * failure isolation, bounded concurrency, no bare PrismaClient, no
 * reviewer-private column.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  JOB_NAMES,
  QUEUE_NAMES,
  buildCanonicalJobId,
  getWorkEntryOrThrow,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const QUEUE_SRC = readSource("../src/queue.ts");
const INDEX_SRC = readSource("../src/index.ts");
const PROCESSORS_SRC = readSource("../src/subsystem-queue-processors.ts");

// =============================================================================
// Queue declarations — asserted against the registry
// =============================================================================

const SUBSYSTEM_CHAINS = [
  {
    work: JOB_NAMES.INDEX_MEDIA_INTELLIGENCE,
    queue: QUEUE_NAMES.MI_SEARCH_INDEX,
    prefix: "mi-search-index",
  },
  {
    work: JOB_NAMES.RECONCILE_TEAM_GRAPH,
    queue: QUEUE_NAMES.GRAPH_RECONCILE,
    prefix: "graph-reconcile",
  },
] as const;

describe("Phase 31.19 — queue declarations", () => {
  it("each subsystem chain has ONE queue name and ONE job name", () => {
    for (const c of SUBSYSTEM_CHAINS) {
      const entry = getWorkEntryOrThrow(c.work);
      expect(entry.queueName, c.work).toBe(c.queue);
      expect(entry.transport, c.work).toBe("bullmq");
    }
  });

  it("each subsystem queue takes its options from the registry, not a literal", () => {
    for (const c of SUBSYSTEM_CHAINS) {
      const entry = getWorkEntryOrThrow(c.work);
      expect(QUEUE_SRC, c.work).toContain("queueOptions(JOB_NAMES.");
      expect(entry.retry.attempts, c.work).toBeGreaterThan(0);
    }
    // The per-queue `attempts: 3, backoff: { type: "exponential" … }` blocks
    // are gone; no literal is left to drift from the registry.
    expect(QUEUE_SRC).not.toMatch(/attempts: \d+,\s*\n\s*backoff:/);
  });

  it("each subsystem chain has a bounded retry + exponential backoff", () => {
    for (const c of SUBSYSTEM_CHAINS) {
      const entry = getWorkEntryOrThrow(c.work);
      expect(entry.retry.attempts, c.work).toBeLessThanOrEqual(25);
      expect(entry.retry.backoff, c.work).toBe("exponential");
      expect(entry.retry.backoffDelayMs, c.work).toBeGreaterThan(0);
      expect(entry.retry.timeoutMs, c.work).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("each chain has a deterministic, prefix-scoped job id", () => {
    for (const c of SUBSYSTEM_CHAINS) {
      const entry = getWorkEntryOrThrow(c.work);
      expect(entry.jobIdPrefix, c.work).toBe(c.prefix);
      const prefixed = { jobIdPrefix: entry.jobIdPrefix! };
      expect(buildCanonicalJobId(prefixed, "abc")).toBe(
        buildCanonicalJobId(prefixed, "abc"),
      );
      expect(
        buildCanonicalJobId(prefixed, "abc").startsWith(`${c.prefix}-`),
      ).toBe(true);
    }
  });

  it("the part-addressed enqueue helper requires an evidence part (anti-leak)", () => {
    // `mi-exif` is now the only part-addressed extraction chain: the OCR and
    // transcript helpers this case also covered were deleted with their
    // queues, having never had a caller in any commit.
    const exifIdx = QUEUE_SRC.indexOf("export async function enqueueExifJob");
    expect(exifIdx).toBeGreaterThan(0);
    expect(QUEUE_SRC.slice(exifIdx, exifIdx + 800)).toMatch(
      /evidence_part_id_required/,
    );
  });

  it("enqueue helpers use the ONE shared enqueue authority", () => {
    // `genericIdempotentEnqueue` is deleted. It was the worker's private copy
    // of the collapse-or-replace ladder; the api had its own, and the two had
    // already drifted on whether a collapsed enqueue reports success.
    expect(QUEUE_SRC).not.toMatch(/genericIdempotentEnqueue/);
    expect(QUEUE_SRC).toMatch(/enqueueCanonicalJob\(/);
  });
});

// =============================================================================
// Worker registrations in index.ts
// =============================================================================

describe("Phase 31.19 — worker registrations", () => {
  it("registers each new worker via safeRegisterWorker (failure isolation)", () => {
    expect(INDEX_SRC).toMatch(/safeRegisterWorker\("mi-search-index"/);
    expect(INDEX_SRC).toMatch(/safeRegisterWorker\("graph-reconcile"/);
  });

  it("WorkerKind union includes the subsystem kinds", () => {
    const idx = INDEX_SRC.indexOf("type WorkerKind");
    expect(idx).toBeGreaterThan(0);
    const slice = INDEX_SRC.slice(idx, idx + 600);
    expect(slice).toMatch(/"mi-search-index"/);
    expect(slice).toMatch(/"graph-reconcile"/);
  });

  it("shutdown closes each worker (null-checked) and each queue", () => {
    expect(INDEX_SRC).toMatch(/miSearchIndexWorker/);
    expect(INDEX_SRC).toMatch(/graphReconcileWorker/);
    expect(INDEX_SRC).toMatch(/await miSearchIndexQueue\.close\(\)/);
    expect(INDEX_SRC).toMatch(/await graphReconcileQueue\.close\(\)/);
  });

  it("each worker is bounded — concurrency 1 or 2", () => {
    // mi-search-index: 2 (lightweight delegate).
    const siIdx = INDEX_SRC.indexOf('safeRegisterWorker("mi-search-index"');
    expect(INDEX_SRC.slice(siIdx, siIdx + 400)).toMatch(/concurrency: 2/);
    // graph-reconcile: 1 (Postgres-heavy).
    const grIdx = INDEX_SRC.indexOf('safeRegisterWorker("graph-reconcile"');
    expect(INDEX_SRC.slice(grIdx, grIdx + 400)).toMatch(/concurrency: 1/);
  });
});

// =============================================================================
// Processors — privacy + bootstrap invariants
// =============================================================================

describe("Phase 31.19 — subsystem processor source contract", () => {
  it("NEVER constructs a bare PrismaClient — imports the shared instance from ./db.js", () => {
    // Code-only check (strip comments so documentation referencing the past
    // hotfix does not trigger it).
    const code = PROCESSORS_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /\/\/[^\n]*/g,
      "",
    );
    expect(code).not.toMatch(/new PrismaClient\(/);
    expect(PROCESSORS_SRC).toMatch(/import \{ prisma \} from "\.\/db\.js"/);
  });

  it("no processor here completes work it did not do", () => {
    // POINT 5 — the INVERSE of the case this replaces. `mi-ocr` and
    // `mi-transcript` used to log `not_configured_completed` and return
    // success, and the old case pinned that as intended behaviour. It is not:
    // reporting completion for extraction that never ran is a false terminal
    // state. Both processors are gone and nothing here may reintroduce them.
    const code = PROCESSORS_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /\/\/[^\n]*/g,
      "",
    );
    expect(code).not.toMatch(/not_configured_completed/);
    expect(code).not.toMatch(/processOcrJob|processTranscriptJob/);
  });

  it("mi-search-index delegates to the existing search-indexing queue", () => {
    expect(PROCESSORS_SRC).toMatch(/enqueueSearchIndexingJob/);
    expect(PROCESSORS_SRC).toMatch(/kind: "evidence"/);
  });

  it("graph-reconcile passes the worker's shared prisma to the read-only reconciler", () => {
    // PHASE 12 — POINT 5: the workspace no longer comes off `job.data`. It is
    // resolved from a Team row — whose Organization must still be ACTIVE —
    // before the reconciler is called at all. The contract this pins is
    // unchanged: the worker passes its OWN prisma client, not a globally
    // imported one.
    expect(PROCESSORS_SRC).toMatch(
      /reconcileTeamGraph\(\s*\n?\s*ctx\.workspaceId,\s*\n?\s*prisma\s*[,)]/,
    );
  });

  it("no subsystem processor reads a tenant off the wire", () => {
    // The whole point of the rewrite above: `job.data` is decoded, never
    // destructured for authority.
    expect(PROCESSORS_SRC).not.toMatch(/job\.data\.teamId/);
    expect(PROCESSORS_SRC).toMatch(/decodeCanonicalJob\(/);
  });

  it("processors do NOT read or project reviewer-private fields", () => {
    const code = PROCESSORS_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /\/\/[^\n]*/g,
      "",
    );
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
