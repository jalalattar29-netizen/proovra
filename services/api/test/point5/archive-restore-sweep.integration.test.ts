/**
 * POINT 5 — ArchiveRestoreSweep, proven by EXECUTION (WS-SCHED / PRO-P3DZ-04).
 *
 *   durable authority  EvidenceArchiveRestoreRequest (written by the route)
 *   producer           none — a due request row is the work
 *   executor           services/worker/src/governance/archive-restore.ts
 *   claim              a LEASE: REQUESTED (or RUNNING with an expired lease)
 *                      -> RUNNING, one conditional update
 *   terminal writer    the same module (COMPLETED / FAILED, each conditional)
 *   external boundary  object storage, READ ONLY
 *
 * The object store is the ONE thing substituted, through the module's own
 * injectable `IntegrityObjectReader`: an in-memory versioned bucket that
 * records every read. The claim, the verification, the lifecycle move, the
 * custody events and the reconciliation-run record are the real production
 * code against live PostgreSQL. `provenCase` is called only AFTER the
 * assertions it names.
 */
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";
import type { WorkspaceFixture } from "./family-harness.js";

const fanout = vi.hoisted(() => ({ reindexed: [] as string[] }));

// The search re-index enqueue after a completed restore is Redis-backed and
// best-effort in production; recorded here instead of reaching a queue.
vi.mock("../../../worker/src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    enqueueSearchIndexingJob: async (input: { sourceId: string }) => {
      fanout.reindexed.push(input.sourceId);
      return { enqueued: true };
    },
  };
});

type Restore = typeof import("../../../worker/src/governance/archive-restore.js");
type Reader = import("../../../worker/src/integrity-recheck.js").IntegrityObjectReader;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** A versioned bucket: key -> versionId -> bytes. Every read is recorded. */
class VersionedStore {
  objects = new Map<string, Map<string, Buffer>>();
  down = false;
  reads: string[] = [];
  /** Runs once, inside the next stream read (the window a stale attempt sits in). */
  duringNextStream: null | (() => Promise<void>) = null;
  put(key: string, bytes: Buffer): string {
    const versionId = `v-${randomUUID().slice(0, 12)}`;
    if (!this.objects.has(key)) this.objects.set(key, new Map());
    this.objects.get(key)!.set(versionId, bytes);
    return versionId;
  }
  private resolve(o: { key: string; versionId: string | null }): Buffer {
    this.reads.push(o.key);
    if (this.down) {
      throw Object.assign(new Error("SlowDown"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    }
    const bytes = o.versionId ? this.objects.get(o.key)?.get(o.versionId) : undefined;
    if (!bytes) {
      throw Object.assign(new Error("NoSuchVersion"), { name: "NoSuchVersion", $metadata: { httpStatusCode: 404 } });
    }
    return bytes;
  }
  reader: Reader = {
    head: async (o) => ({ sizeBytes: this.resolve(o).length }),
    stream: async (o) => {
      const bytes = this.resolve(o);
      const hook = this.duringNextStream;
      if (hook) {
        this.duringNextStream = null;
        await hook();
      }
      return Readable.from([bytes]);
    },
  };
  readsOf(key: string): number {
    return this.reads.filter((k) => k === key).length;
  }
}

describe("Point 5 — ArchiveRestoreSweep (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let restore: Restore;
  let own: WorkspaceFixture;
  let foreign: WorkspaceFixture;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    restore = await import("../../../worker/src/governance/archive-restore.js");
    own = {
      teamId: harness.fixtures.teamA.teamId,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      evidenceId: harness.fixtures.teamA.evidenceId,
      caseId: harness.fixtures.teamA.caseId,
    };
    foreign = {
      teamId: harness.fixtures.teamB.teamId,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
      evidenceId: harness.fixtures.teamB.evidenceId,
      caseId: harness.fixtures.teamB.caseId,
    };
  }, 900_000);

  afterAll(async () => {
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  }, 300_000);

  /** A sealed record in the Retention Archive whose original is in `store`. */
  async function archivedRecord(store: VersionedStore, fixture: WorkspaceFixture) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: fixture.teamId },
      select: { organizationId: true },
    });
    const bytes = Buffer.from(`point5-archive-restore-${randomUUID()}`);
    const key = `evidence/${randomUUID()}/original.bin`;
    const versionId = store.put(key, bytes);
    const row = await prisma.evidence.create({
      data: {
        title: `point5-archive-restore-${randomUUID().slice(0, 8)}`,
        type: "PHOTO",
        status: "SIGNED",
        lifecycleState: "RETENTION_ARCHIVED",
        retentionArchivedAtUtc: new Date(Date.now() - 86_400_000),
        deletedAt: new Date(Date.now() - 100 * 86_400_000),
        teamId: fixture.teamId,
        organizationId: team.organizationId,
        ownerUserId: fixture.ownerUserId,
        storageBucket: "point5-archive-restore-bucket",
        storageKey: key,
        storageVersionId: versionId,
        fileSha256: sha256(bytes),
        signedAtUtc: new Date(Date.now() - 200 * 86_400_000),
        signatureBase64: "cG9pbnQ1LWFyY2hpdmUtcmVzdG9yZQ==",
        signingKeyId: "point5-archive-restore-key",
        signingKeyVersion: 1,
        fingerprintHash: sha256(`fp-${key}`),
        fingerprintCanonicalJson: JSON.stringify({ key }),
      } as never,
      select: { id: true },
    });
    return { id: row.id, key };
  }

  /** The durable intent, exactly as the route writes it. */
  async function requestRestore(
    evidenceId: string,
    fixture: WorkspaceFixture,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.evidenceArchiveRestoreRequest.create({
      data: {
        evidenceId,
        teamId: fixture.teamId,
        requestedByUserId: fixture.ownerUserId,
        idempotencyKey: `point5-archive-restore:${randomUUID()}`,
        ...overrides,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  const lifecycle = async (id: string) =>
    (await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { lifecycleState: true } })).lifecycleState;
  const requestRow = (id: string) =>
    prisma.evidenceArchiveRestoreRequest.findUniqueOrThrow({
      where: { id },
      select: { status: true, attemptCount: true, failureCode: true, leaseUntilUtc: true, completedAtUtc: true },
    });
  const custodyCount = (evidenceId: string, eventType: string) =>
    prisma.custodyEvent.count({ where: { evidenceId, eventType: eventType as never } });
  const runRows = () =>
    prisma.governanceReconciliationRun.count({ where: { kind: "ARCHIVE_RESTORE" as never } });

  it("the request row is the durable intent: no row restores nothing, a due row is restored under a recorded run", async () => {
    const store = new VersionedStore();
    const idle = await archivedRecord(store, own);
    const asked = await archivedRecord(store, own);
    restore.__resetArchiveRestoreSweepHeartbeat();

    // An archived record nobody asked to restore is never read and never moved.
    const requestId = await requestRestore(asked.id, own);
    const runsBefore = await runRows();
    const swept = await restore.runArchiveRestoreSweep({ reader: store.reader });
    expect(swept.recorded).toBe(true);
    expect(await runRows()).toBe(runsBefore + 1);
    expect(store.readsOf(idle.key)).toBe(0);
    expect(await lifecycle(idle.id)).toBe("RETENTION_ARCHIVED");

    // The requested one: verified against storage, then back to ACTIVE.
    expect(swept.outcomes).toContainEqual({ requestId, evidenceId: asked.id, outcome: "COMPLETED" });
    expect(store.readsOf(asked.key)).toBeGreaterThan(0);
    expect(await lifecycle(asked.id)).toBe("ACTIVE");
    expect(await requestRow(requestId)).toMatchObject({ status: "COMPLETED", attemptCount: 1, leaseUntilUtc: null });
    expect(await custodyCount(asked.id, "ARCHIVE_RESTORE_STARTED")).toBe(1);
    expect(await custodyCount(asked.id, "ARCHIVE_RESTORE_COMPLETED")).toBe(1);
    expect(fanout.reindexed).toContain(asked.id);
    provenCase("archiverestore.durable.intent_before_work");
  });

  it("the record is re-read at execution: one that left the archive is not restored, and the workspace comes from the record", async () => {
    const store = new VersionedStore();
    // Claimed for destruction after the restore was requested.
    const gone = await archivedRecord(store, own);
    const goneRequest = await requestRestore(gone.id, own);
    await prisma.evidence.update({ where: { id: gone.id }, data: { destructionClaimedAtUtc: new Date() } as never });
    const outcome = await restore.runArchiveRestoreRequest(goneRequest, { reader: store.reader });
    expect(outcome).toMatchObject({ outcome: "FAILED", failureCode: "STATE_CHANGED" });
    expect(store.readsOf(gone.key), "storage is not read for a record that left the archive").toBe(0);
    expect(await lifecycle(gone.id)).toBe("RETENTION_ARCHIVED");
    expect(await requestRow(goneRequest)).toMatchObject({ status: "FAILED", failureCode: "STATE_CHANGED" });

    // A request row naming ANOTHER workspace does not move the record there:
    // the integrity observation is recorded under the record's own team.
    const rec = await archivedRecord(store, own);
    const forged = await requestRestore(rec.id, own, { teamId: foreign.teamId });
    expect(await restore.runArchiveRestoreRequest(forged, { reader: store.reader })).toMatchObject({ outcome: "COMPLETED" });
    const after = await prisma.evidence.findUniqueOrThrow({ where: { id: rec.id }, select: { teamId: true, lifecycleState: true } });
    expect(after).toEqual({ teamId: own.teamId, lifecycleState: "ACTIVE" });
    const checks = await prisma.evidenceIntegrityCheck.findMany({ where: { evidenceId: rec.id }, select: { teamId: true } });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.teamId === own.teamId)).toBe(true);
    provenCase("archiverestore.tenant.workspace_reloaded");
  });

  it("restoring one workspace's record reads and changes nothing of another's", async () => {
    const store = new VersionedStore();
    const mine = await archivedRecord(store, own);
    const theirs = await archivedRecord(store, foreign);
    const theirHead = await prisma.custodyEvent.count({ where: { evidenceId: theirs.id } });
    const requestId = await requestRestore(mine.id, own);
    const outcomes = await restore.processArchiveRestoreRequests({ reader: store.reader });
    expect(outcomes).toContainEqual({ requestId, evidenceId: mine.id, outcome: "COMPLETED" });
    expect(await lifecycle(mine.id)).toBe("ACTIVE");
    expect(await lifecycle(theirs.id)).toBe("RETENTION_ARCHIVED");
    expect(store.readsOf(theirs.key)).toBe(0);
    expect(await prisma.custodyEvent.count({ where: { evidenceId: theirs.id } })).toBe(theirHead);
    expect(await prisma.evidenceArchiveRestoreRequest.count({ where: { evidenceId: theirs.id } })).toBe(0);
    provenCase("archiverestore.tenant.cross_workspace_denied");
  });

  it("two concurrent sweepers: one claim, one restore", async () => {
    const store = new VersionedStore();
    const rec = await archivedRecord(store, own);
    const requestId = await requestRestore(rec.id, own);
    const results = await Promise.all([
      restore.runArchiveRestoreRequest(requestId, { reader: store.reader }),
      restore.runArchiveRestoreRequest(requestId, { reader: store.reader }),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.find((r) => r !== null)).toMatchObject({ outcome: "COMPLETED" });
    expect(await requestRow(requestId)).toMatchObject({ status: "COMPLETED", attemptCount: 1 });
    expect(await custodyCount(rec.id, "ARCHIVE_RESTORE_STARTED")).toBe(1);
    expect(await custodyCount(rec.id, "ARCHIVE_RESTORE_COMPLETED")).toBe(1);
    provenCase("archiverestore.claim.one_winner");
  });

  it("a live lease is not stolen; an expired one is resumed", async () => {
    const store = new VersionedStore();
    const rec = await archivedRecord(store, own);
    const now = new Date();
    const requestId = await requestRestore(rec.id, own, {
      status: "RUNNING",
      startedAtUtc: now,
      attemptCount: 1,
      leaseUntilUtc: new Date(now.getTime() + restore.ARCHIVE_RESTORE_LEASE_MS),
    });
    expect(await restore.runArchiveRestoreRequest(requestId, { reader: store.reader, now })).toBeNull();
    expect((await restore.processArchiveRestoreRequests({ reader: store.reader, now })).filter((o) => o.requestId === requestId)).toEqual([]);
    expect(await requestRow(requestId)).toMatchObject({ status: "RUNNING", attemptCount: 1 });
    expect(await lifecycle(rec.id)).toBe("RETENTION_ARCHIVED");
    expect(store.readsOf(rec.key)).toBe(0);
    provenCase("archiverestore.claim.active_not_stolen");

    // Its worker died: after the lease the request is due again and completes.
    const later = new Date(now.getTime() + restore.ARCHIVE_RESTORE_LEASE_MS + 1000);
    expect(await restore.runArchiveRestoreRequest(requestId, { reader: store.reader, now: later })).toMatchObject({ outcome: "COMPLETED" });
    expect(await requestRow(requestId)).toMatchObject({ status: "COMPLETED", attemptCount: 2 });
    expect(await lifecycle(rec.id)).toBe("ACTIVE");
    // Resumed, not restarted: STARTED is appended by a first attempt only.
    expect(await custodyCount(rec.id, "ARCHIVE_RESTORE_STARTED")).toBe(0);
  });

  it("a duplicate execution of a completed request is a no-op", async () => {
    const store = new VersionedStore();
    const rec = await archivedRecord(store, own);
    const requestId = await requestRestore(rec.id, own);
    expect(await restore.runArchiveRestoreRequest(requestId, { reader: store.reader })).toMatchObject({ outcome: "COMPLETED" });
    const reads = store.readsOf(rec.key);
    const events = await prisma.custodyEvent.count({ where: { evidenceId: rec.id } });
    const first = await requestRow(requestId);

    expect(await restore.runArchiveRestoreRequest(requestId, { reader: store.reader })).toBeNull();
    expect((await restore.processArchiveRestoreRequests({ reader: store.reader })).filter((o) => o.requestId === requestId)).toEqual([]);
    expect(store.readsOf(rec.key)).toBe(reads);
    expect(await prisma.custodyEvent.count({ where: { evidenceId: rec.id } })).toBe(events);
    expect(await requestRow(requestId)).toEqual(first);
    expect(await lifecycle(rec.id)).toBe("ACTIVE");
    provenCase("archiverestore.idempotency.duplicate_is_noop");
  });

  it("a stale attempt cannot overwrite the terminal state another attempt wrote", async () => {
    const store = new VersionedStore();
    const rec = await archivedRecord(store, own);
    const requestId = await requestRestore(rec.id, own);
    const t0 = new Date();
    // Attempt A is reading the original when its lease runs out; attempt B
    // (a later tick) claims the request and completes the restore.
    store.duringNextStream = async () => {
      const afterLease = new Date(t0.getTime() + restore.ARCHIVE_RESTORE_LEASE_MS + 1000);
      expect(await restore.runArchiveRestoreRequest(requestId, { reader: store.reader, now: afterLease })).toMatchObject({
        outcome: "COMPLETED",
      });
    };
    const stale = await restore.runArchiveRestoreRequest(requestId, { reader: store.reader, now: t0 });
    // A finishes late: it restores nothing a second time and fails nothing.
    expect(stale).toMatchObject({ outcome: "FAILED", failureCode: "STATE_CHANGED" });
    expect(await requestRow(requestId)).toMatchObject({ status: "COMPLETED", failureCode: null, attemptCount: 2 });
    expect(await lifecycle(rec.id)).toBe("ACTIVE");
    expect(await custodyCount(rec.id, "ARCHIVE_RESTORE_COMPLETED")).toBe(1);
    expect(await custodyCount(rec.id, "ARCHIVE_RESTORE_FAILED")).toBe(0);
    provenCase("archiverestore.terminal.stale_cannot_overwrite");
  });

  it("a store that cannot answer is not a verdict: the request stays open and the record stays archived", async () => {
    const store = new VersionedStore();
    const rec = await archivedRecord(store, own);
    const requestId = await requestRestore(rec.id, own);
    store.down = true;
    expect(await restore.runArchiveRestoreRequest(requestId, { reader: store.reader })).toMatchObject({
      outcome: "RETRY",
      failureCode: "STORAGE_UNAVAILABLE",
    });
    expect(await requestRow(requestId)).toMatchObject({ status: "REQUESTED", failureCode: null, completedAtUtc: null });
    expect(await lifecycle(rec.id)).toBe("RETENTION_ARCHIVED");
    expect(await custodyCount(rec.id, "ARCHIVE_RESTORE_FAILED")).toBe(0);
    expect(await prisma.evidenceIntegrityCheck.count({ where: { evidenceId: rec.id } }), "no verdict is recorded").toBe(0);

    store.down = false;
    expect(await restore.runArchiveRestoreRequest(requestId, { reader: store.reader })).toMatchObject({ outcome: "COMPLETED" });
    expect(await lifecycle(rec.id)).toBe("ACTIVE");
    provenCase("archiverestore.provider.unknown_outcome_non_terminal");
  });
});
