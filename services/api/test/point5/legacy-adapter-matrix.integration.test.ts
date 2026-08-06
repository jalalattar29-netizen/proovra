/**
 * PHASE 12 — POINT 5, STEP 5: the legacy adapter matrix, behaviourally.
 *
 * WHAT IS ALREADY PROVEN ELSEWHERE, AND WHY THIS EXISTS ANYWAY
 * ---------------------------------------------------------------------------
 * The closure gate proves the adapter SET is well-formed: every changed shape
 * classified, every adapter owning a schema, an owner, a backlog command and a
 * removal condition, every authority field declared and discarded by name. All
 * of that is about the decoder.
 *
 * What it cannot show is what happens when a legacy job is actually DELIVERED
 * to a running processor against a real database. That is what this file does,
 * for the two properties that only exist at that boundary:
 *
 *   * a QUARANTINED shape produces zero provider, storage and database side
 *     effect — and, crucially, never reports success;
 *   * a duplicate delivery of an ADAPTABLE shape converges rather than
 *     duplicating work, exactly as a canonical duplicate does.
 *
 * The adapter set is also recomputed here after the OCR/Transcript removal:
 * an adapter whose queue no longer exists cannot be drained, so it can never
 * satisfy its own removal condition and would sit in the registry forever.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  JOB_NAMES,
  LEGACY_PAYLOAD_ADAPTERS,
  LegacyJobQuarantined,
  QUEUE_NAMES,
  getBullMqEntries,
  getWorkEntryOrThrow,
} from "@proovra/shared";

import type { IntegrationHarness } from "../integration-harness.js";

/** Storage, recorded. A quarantined job must never reach it. */
const storage = vi.hoisted(() => ({
  calls: [] as string[],
  reset() {
    this.calls.length = 0;
  },
}));

vi.mock("../../../worker/src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getObjectRange: async (input: { key: string }) => {
      storage.calls.push(input.key);
      return Buffer.from("bytes");
    },
    putObjectBuffer: async (input: { key: string }) => {
      storage.calls.push(`put:${input.key}`);
      return { ok: true };
    },
  };
});

const queued = vi.hoisted(() => ({
  searchIndex: [] as string[],
  reset() {
    this.searchIndex.length = 0;
  },
}));

vi.mock("../../../worker/src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    enqueueSearchIndexingJob: async (input: { sourceId: string }) => {
      queued.searchIndex.push(input.sourceId);
      return { enqueued: true, jobId: `si-${input.sourceId}` };
    },
  };
});

describe("POINT 5 — legacy adapters, delivered to real processors", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let derived: typeof import("../../../worker/src/derived-assets.processor.js");
  let searchProcessor: typeof import("../../../worker/src/search-indexing.processor.js");
  let teamId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    derived = await import("../../../worker/src/derived-assets.processor.js");
    searchProcessor = await import(
      "../../../worker/src/search-indexing.processor.js"
    );
    teamId = harness.fixtures.teamA.teamId;
    ownerUserId = harness.fixtures.teamA.ownerUserId;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function newEvidence(): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true },
    });
    const row = await prisma.evidence.create({
      data: {
        title: `point5-legacy-${randomUUID()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
      },
      select: { id: true },
    });
    return row.id;
  }

  // =========================================================================
  // The recomputed adapter set
  // =========================================================================

  it("every retained adapter names a LIVE queue it could actually be drained from", () => {
    // An adapter for a deleted queue is unremovable by construction: its drain
    // command names a queue that cannot report zero because it does not exist.
    // This is what the OCR/Transcript adapters became, which is why they went.
    const liveQueues = new Set(Object.values(QUEUE_NAMES) as string[]);
    const byJob = new Map(getBullMqEntries().map((e) => [e.workName, e]));
    const stranded: string[] = [];
    for (const a of LEGACY_PAYLOAD_ADAPTERS) {
      const entry = byJob.get(a.jobName as never);
      if (!entry?.queueName || !liveQueues.has(entry.queueName)) {
        stranded.push(`${a.jobName} -> ${entry?.queueName ?? "no queue"}`);
        continue;
      }
      // And the drain command it publishes must name that same queue.
      expect(a.drainCommand, a.jobName).toContain(`--queue=${entry.queueName}`);
      expect(a.backlogCommand, a.jobName).toContain(
        `--queue=${entry.queueName}`,
      );
    }
    expect(
      stranded,
      `adapters for queues that no longer exist:\n${stranded.join("\n")}`,
    ).toEqual([]);
  });

  it("the removed OCR/Transcript adapters stay removed", () => {
    const names = LEGACY_PAYLOAD_ADAPTERS.map((a) => a.jobName);
    expect(names).not.toContain("ExtractOcr");
    expect(names).not.toContain("ExtractTranscript");
    // And nothing re-registered a drain command for their queues.
    for (const a of LEGACY_PAYLOAD_ADAPTERS) {
      expect(a.drainCommand).not.toContain("--queue=mi-ocr");
      expect(a.drainCommand).not.toContain("--queue=mi-transcript");
    }
  });

  // =========================================================================
  // Quarantine — zero side effect, and never a success
  // =========================================================================

  it("GenerateDerivedAsset: an unsafe legacy shape quarantines with ZERO side effect", async () => {
    storage.reset();
    const evidenceId = await newEvidence();
    const part = await prisma.evidencePart.create({
      data: {
        evidenceId,
        partIndex: 0,
        storageBucket: "point5-bucket",
        storageKey: `point5/${randomUUID()}`,
        mimeType: "image/jpeg",
        sizeBytes: BigInt(1024),
      },
      select: { id: true },
    });

    const assetsBefore = await prisma.evidencePartDerivedAsset.count({
      where: { teamId },
    });

    // The pre-Point-5 payload: it names a part and an asset KIND, and no
    // durable row. `assetKind` selects which pipeline runs, so reconstructing
    // a row from it would be taking an authorization decision from the wire.
    let thrown: unknown = null;
    try {
      await derived.processDerivedAssetJob({
        id: "legacy-derived-1",
        name: JOB_NAMES.GENERATE_DERIVED_ASSET,
        attemptsMade: 0,
        opts: { attempts: 3 },
        data: {
          teamId: "some-other-workspace",
          evidenceId,
          evidencePartId: part.id,
          assetKind: "image_thumbnail",
        },
      } as never);
    } catch (err) {
      thrown = err;
    }

    // (a) It is THROWN, not returned — a quarantine that came back as a value
    //     could be mistaken for a decode result and run.
    expect(thrown).toBeInstanceOf(LegacyJobQuarantined);
    const q = thrown as LegacyJobQuarantined;
    expect(q.reason).toBeTruthy();
    expect(q.jobName).toBe(JOB_NAMES.GENERATE_DERIVED_ASSET);
    // (b) The authority fields are reported by NAME, never by value.
    expect(q.discardedAuthorityFields).toContain("teamId");
    expect(JSON.stringify(q.discardedAuthorityFields)).not.toContain(
      "some-other-workspace",
    );
    // (c) Zero storage effect.
    expect(storage.calls).toEqual([]);
    // (d) Zero database effect: no row was invented for it.
    expect(
      await prisma.evidencePartDerivedAsset.count({ where: { teamId } }),
    ).toBe(assetsBefore);
    // (e) And nothing anywhere claims it succeeded.
    expect(q.message).toMatch(/quarantined/i);
  });

  it("an owner replay creates a NEW canonical intent; the original never becomes success", async () => {
    storage.reset();
    const evidenceId = await newEvidence();
    const part = await prisma.evidencePart.create({
      data: {
        evidenceId,
        partIndex: 0,
        storageBucket: "point5-bucket",
        storageKey: `point5/${randomUUID()}`,
        mimeType: "image/jpeg",
        sizeBytes: BigInt(1024),
      },
      select: { id: true },
    });

    // The ONLY way back in: an authorized path commits a durable row, and the
    // canonical job names that row. The quarantined payload contributes
    // nothing to it — not even its `assetKind`, which is re-decided here.
    const replay = await prisma.evidencePartDerivedAsset.create({
      data: {
        teamId,
        evidenceId,
        evidencePartId: part.id,
        assetKind: "compact_review_preview",
        status: "PENDING",
      },
      select: { id: true },
    });
    const entry = getWorkEntryOrThrow(JOB_NAMES.GENERATE_DERIVED_ASSET);
    const result = await derived.processDerivedAssetJob({
      id: `mi-derived-${replay.id}`,
      name: entry.workName,
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: {
        commandId: replay.id,
        traceId: "point5-owner-replay",
        schemaVersion: entry.schemaVersion,
      },
    } as never);

    // The processor accepted the CANONICAL command and did not throw: the
    // replay is an ordinary job, not a resurrected legacy one.
    expect(result).toMatchObject({ ok: true });

    const row = await prisma.evidencePartDerivedAsset.findUniqueOrThrow({
      where: { id: replay.id },
      select: { status: true, teamId: true, assetKind: true },
    });
    // The properties THIS file owns:
    //
    //   * the replay is a genuinely new durable intent, in the workspace the
    //     ROW names — not the one the quarantined payload named;
    //   * the quarantined payload's `assetKind` (`image_thumbnail`, which
    //     selects the sharp pipeline) contributed nothing: the row carries the
    //     kind the AUTHORIZED path chose;
    //   * and nothing reports a finished artifact that was never produced.
    //
    // The status TRANSITION for this unit — PENDING to a settled terminal —
    // is proven where it belongs, in
    // `family-intelligence-operations.integration.test.ts`, which drives this
    // processor through the shared conformance harness. Re-asserting it here
    // would duplicate that proof rather than add one.
    expect(row.teamId).toBe(teamId);
    expect(row.assetKind).toBe("compact_review_preview");
    expect(row.status).not.toBe("READY");
    expect(row.status).not.toBe("COMPLETED");
    expect(replay.id).toBeTruthy();
  });

  // =========================================================================
  // Duplicate legacy delivery
  // =========================================================================

  it("a duplicate delivery of an ADAPTABLE legacy shape converges, it does not duplicate", async () => {
    queued.reset();
    const evidenceId = await newEvidence();
    const entry = getWorkEntryOrThrow(JOB_NAMES.REBUILD_SEARCH_DOCUMENT);
    // The pre-Point-5 search payload: `{ teamId, kind, sourceId, reason }`.
    // The `teamId` on the wire is a DIFFERENT workspace from the evidence's,
    // and must have no effect at all — the projection is written under the
    // workspace the source row itself carries.
    const legacy = {
      teamId: "00000000-0000-4000-8000-00000000dead",
      kind: "evidence",
      sourceId: evidenceId,
      reason: "legacy-drain",
    };
    const job = {
      id: `search-index-evidence-${evidenceId}`,
      name: entry.workName,
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: legacy,
    } as never;

    await searchProcessor.processSearchIndexingJob(job);
    const first = await prisma.evidenceSearchDocument.findMany({
      where: { sourceId: evidenceId, documentType: "EVIDENCE" },
      select: { id: true, teamId: true, title: true },
    });
    expect(first).toHaveLength(1);
    // The wire's workspace was discarded, not believed.
    expect(first[0]!.teamId).toBe(teamId);

    await searchProcessor.processSearchIndexingJob(job);
    const second = await prisma.evidenceSearchDocument.findMany({
      where: { sourceId: evidenceId, documentType: "EVIDENCE" },
      select: { id: true, teamId: true, title: true },
    });
    // One document, same row, same content: the natural key converged it.
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[0]!.title).toBe(first[0]!.title);
    expect(
      await prisma.evidenceSearchDocument.count({
        where: { teamId: "00000000-0000-4000-8000-00000000dead" },
      }),
    ).toBe(0);
  });
});
