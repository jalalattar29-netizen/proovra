/**
 * Round 3 worker remediation (PRO-100, PRO-102..PRO-109, PRO-111): the real
 * worker functions against live PostgreSQL 16 (pgvector), Redis and an object
 * store bucket this suite creates for itself.
 *
 * Every case drives the production function and checks the durable rows it
 * leaves, with an authorized control and a cross-tenant or out-of-scope
 * negative control:
 *
 *   WORKERS-02  a drift incident blocks the package gate; the sweep has a
 *               cursor; the default probe HEADs the sealed version
 *   WORKERS-04  the cost projection counts COMPLETED transitions only
 *   WORKERS-05  redaction release / FAILED are fenced to the current claim
 *   WORKERS-06  a transient OCR failure leaves the run retryable
 *   WORKERS-07  a Personal NULL-team record's run passes the processor gate
 *   WORKERS-08  two concurrent mi-embed anchors embed and charge once
 *   WORKERS-09  worker-written search documents carry the projection version
 *   WORKERS-10  the MFA digest reaches admins past the first 100
 *   WORKERS-11  redaction renders nothing for a record that left service
 *   WORKERS-13  abandoned PENDING runs are settled and stop crowding the page
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  CreateBucketCommand,
  PutObjectCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SEARCH_PROJECTION_VERSION } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = typeof import("../src/db.js")["prisma"];

const TAG = randomUUID().slice(0, 8);
const BUCKET = `rem3-wg-${TAG}`;
const LOCK_BUCKET = `rem3-wg-lock-${TAG}`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVR4nGM4wcVFEmIY1cA1GkonhmvSAAC0z9wBqCZTNAAAAABJRU5ErkJggg==",
  "base64",
);
const days = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("round 3 worker remediation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: Prisma;
  let s3: S3Client;
  let worker: {
    search: typeof import("../../worker/src/search-indexing.processor.js");
    digest: typeof import("../../worker/src/mfa-recovery-digest.js");
    reconciler: typeof import("../../worker/src/intelligence-run-reconciler.js");
    mi: typeof import("../../worker/src/media-intelligence.processor.js");
    embed: typeof import("../../worker/src/mi-embed.processor.js");
    writer: typeof import("../../worker/src/redaction/redaction-derivative-writer.js");
    redaction: typeof import("../../worker/src/redaction/redaction-derivative.processor.js");
    incidents: typeof import("../../worker/src/governance/incident-emitter.js");
    gate: typeof import("../../worker/src/governance/package-eligibility-gate.js");
    immutable: typeof import("../../worker/src/governance/immutable-storage-reconciliation.worker.js");
    storage: typeof import("../../worker/src/storage.js");
    telemetry: typeof import("../../worker/src/telemetry.js");
  };
  let archive: typeof import("../src/services/lifecycle/archive-tier.service.js");
  let tracker: typeof import("@proovra/shared-runtime/media-intelligence");

  const A = () => harness.fixtures.teamA;
  const B = () => harness.fixtures.teamB;
  const P = () => harness.fixtures.personal;

  async function ev(
    teamId: string | null,
    ownerUserId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const organizationId = teamId
      ? (await prisma.team.findUnique({ where: { id: teamId }, select: { organizationId: true } }))
          ?.organizationId ?? null
      : null;
    const title = `REM3WG-${TAG}-${randomBytes(3).toString("hex")}`;
    return prisma.evidence.create({
      data: {
        title,
        displayFileName: `${title}.txt`,
        type: "DOCUMENT",
        status: "CREATED",
        teamId,
        organizationId,
        ownerUserId,
        ...extra,
      } as never,
      select: { id: true },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    Object.assign(process.env, {
      SEMANTIC_SEARCH_ENABLED: "true",
      SEMANTIC_EMBEDDINGS_PROVIDER: "local-deterministic",
      SEMANTIC_EMBEDDING_DIMENSIONS: "1536",
    });
    worker = {
      search: await import("../../worker/src/search-indexing.processor.js"),
      digest: await import("../../worker/src/mfa-recovery-digest.js"),
      reconciler: await import("../../worker/src/intelligence-run-reconciler.js"),
      mi: await import("../../worker/src/media-intelligence.processor.js"),
      embed: await import("../../worker/src/mi-embed.processor.js"),
      writer: await import("../../worker/src/redaction/redaction-derivative-writer.js"),
      redaction: await import("../../worker/src/redaction/redaction-derivative.processor.js"),
      incidents: await import("../../worker/src/governance/incident-emitter.js"),
      gate: await import("../../worker/src/governance/package-eligibility-gate.js"),
      immutable: await import("../../worker/src/governance/immutable-storage-reconciliation.worker.js"),
      storage: await import("../../worker/src/storage.js"),
      telemetry: await import("../../worker/src/telemetry.js"),
    };
    archive = await import("../src/services/lifecycle/archive-tier.service.js");
    tracker = await import("@proovra/shared-runtime/media-intelligence");
    // This suite's own buckets: one versioned, one with Object Lock.
    s3 = worker.storage.s3;
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await s3.send(
      new PutBucketVersioningCommand({ Bucket: BUCKET, VersioningConfiguration: { Status: "Enabled" } }),
    );
    await s3.send(new CreateBucketCommand({ Bucket: LOCK_BUCKET, ObjectLockEnabledForBucket: true }));
  }, 600_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 180_000);

  // ---------------------------------------------------------------------------
  it("WORKERS-14: a worker's lease identity is never the bare pid", async () => {
    const { resolveWorkerId } = worker.telemetry;
    const saved = { WORKER_ID: process.env.WORKER_ID, HOSTNAME: process.env.HOSTNAME };
    try {
      process.env.WORKER_ID = "replica-a";
      expect(resolveWorkerId()).toBe("replica-a");
      delete process.env.WORKER_ID;
      process.env.HOSTNAME = "pod-7f9c";
      expect(resolveWorkerId()).toBe(`pod-7f9c-${process.pid}`);
      delete process.env.HOSTNAME;
      // PID 1 in every exec-form container: the pid alone would be "worker-1"
      // for every replica. The per-process suffix keeps them apart and is
      // stable for this process's lifetime.
      const id = resolveWorkerId();
      expect(id).toMatch(new RegExp(`^worker-${process.pid}-[0-9a-f]{8}$`));
      expect(resolveWorkerId()).toBe(id);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  // ---------------------------------------------------------------------------
  it("WORKERS-09: a worker-written search document carries the current projection version", async () => {
    const job = (id: string) =>
      ({ id: `si-${id}`, name: "RebuildSearchDocument", attemptsMade: 0, data: { commandId: `evidence:${id}`, traceId: "rem3", schemaVersion: 1 } }) as never;
    const mine = await ev(A().teamId, A().ownerUserId);
    const theirs = await ev(B().teamId, B().ownerUserId);
    await worker.search.processSearchIndexingJob(job(theirs.id));
    const theirsBefore = await prisma.evidenceSearchDocument.findMany({ where: { sourceId: theirs.id } });
    await worker.search.processSearchIndexingJob(job(mine.id));
    const doc = await prisma.evidenceSearchDocument.findFirstOrThrow({
      where: { sourceId: mine.id },
      select: { teamId: true, projectionVersion: true },
    });
    expect(doc.teamId).toBe(A().teamId);
    expect(doc.projectionVersion).toBe(SEARCH_PROJECTION_VERSION);
    // A second build (the update branch) keeps it.
    await prisma.evidenceSearchDocument.updateMany({ where: { sourceId: mine.id }, data: { projectionVersion: 1 } });
    await worker.search.processSearchIndexingJob(job(mine.id));
    expect(
      (await prisma.evidenceSearchDocument.findFirstOrThrow({ where: { sourceId: mine.id } })).projectionVersion,
    ).toBe(SEARCH_PROJECTION_VERSION);
    // The other tenant's document is untouched by A's job.
    expect(await prisma.evidenceSearchDocument.findMany({ where: { sourceId: theirs.id } })).toEqual(theirsBefore);
  }, 120_000);

  // ---------------------------------------------------------------------------
  it("WORKERS-10: the MFA-recovery digest reaches every admin, 100 per tick", async () => {
    const admins: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const email = `rem3-wg-${TAG}-${i}@example.invalid`;
      const u = await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email } as never });
      await prisma.teamMember.create({ data: { teamId: A().teamId, userId: u.id, role: "ADMIN" } as never });
      admins.push(u.id);
    }
    // A suspended admin is not a recipient (negative control).
    const suspendedEmail = `rem3-wg-${TAG}-suspended@example.invalid`;
    const suspended = await prisma.user.create({ data: { email: suspendedEmail, provider: "EMAIL", providerUserId: suspendedEmail } as never });
    await prisma.teamMember.create({ data: { teamId: A().teamId, userId: suspended.id, role: "ADMIN", status: "SUSPENDED" } as never });
    await prisma.mfaRecoveryRequest.create({
      data: { userId: A().memberUserId, teamId: A().teamId, status: "PENDING_ADMIN_REVIEW", reason: "rem3", expiresAt: days(-7), createdAt: days(2) } as never,
    });
    const eligible = [...admins, A().ownerUserId, A().adminUserId];
    const logged = () => prisma.mfaRecoveryAdminDigestLog.count({ where: { userId: { in: eligible } } });

    const r1 = await worker.digest.runMfaRecoveryDigest({ trigger: "rem3" });
    expect(r1.adminsAttempted).toBe(100);
    const r2 = await worker.digest.runMfaRecoveryDigest({ trigger: "rem3" });
    // Before the fix the second tick attempted nobody and 22 were never told.
    expect(r2.adminsAttempted).toBe(eligible.length - 100);
    expect(await logged()).toBe(eligible.length);
    const r3 = await worker.digest.runMfaRecoveryDigest({ trigger: "rem3" });
    expect(r3.adminsAttempted).toBe(0);
    expect(await prisma.mfaRecoveryAdminDigestLog.count({ where: { userId: suspended.id } })).toBe(0);
  }, 300_000);

  // ---------------------------------------------------------------------------
  it("WORKERS-13: abandoned PENDING runs are settled and no longer crowd the stranded page", async () => {
    const e = await ev(A().teamId, A().ownerUserId);
    const mk = (attemptCount: number, at: Date) =>
      prisma.mediaIntelligenceRun.create({
        data: { teamId: A().teamId, evidenceId: e.id, kind: "compute_perceptual_hashes", status: "PENDING", attemptCount, updatedAtUtc: at },
        select: { id: true },
      });
    const ab1 = await mk(5, new Date("2000-01-01T00:00:00Z"));
    const ab2 = await mk(5, new Date("2000-01-02T00:00:00Z"));
    const eligible = await mk(0, new Date("2000-06-01T00:00:00Z"));
    const r1 = await worker.reconciler.runIntelligenceRunReconciler({ batchSize: 2, trigger: "rem3" });
    expect(r1.ok).toBe(true);
    const states = await prisma.mediaIntelligenceRun.findMany({
      where: { id: { in: [ab1.id, ab2.id, eligible.id] } },
      select: { id: true, status: true, lastError: true },
    });
    const by = new Map(states.map((s) => [s.id, s]));
    expect(by.get(ab1.id)).toMatchObject({ status: "FAILED", lastError: "recovery_attempts_exhausted" });
    expect(by.get(ab2.id)).toMatchObject({ status: "FAILED", lastError: "recovery_attempts_exhausted" });
    // The eligible run behind them was reached in the SAME tick (before: 0).
    expect(r1.strandedReEnqueued).toBeGreaterThanOrEqual(1);
    expect(by.get(eligible.id)?.status).toBe("PENDING");
  }, 120_000);

  // ---------------------------------------------------------------------------
  describe("media intelligence runs", () => {
    let server: Server;
    let respond: "503" | "ok" = "503";
    const saved: Record<string, string | undefined> = {};

    beforeAll(async () => {
      server = createServer((req, res) => {
        req.resume();
        if (respond === "503") {
          res.writeHead(503).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, partsProcessed: 0, recordsCreated: 0, extractedTextChars: 0 }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as { port: number }).port;
      for (const k of ["INTERNAL_API_URL", "INTERNAL_SERVICE_TOKEN"]) saved[k] = process.env[k];
      process.env.INTERNAL_API_URL = `http://127.0.0.1:${port}`;
      process.env.INTERNAL_SERVICE_TOKEN = `rem3-synthetic-${TAG}`;
    });
    afterAll(async () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await new Promise<void>((r) => server.close(() => r()));
    });

    const miJob = (runId: string, attemptsMade = 0) =>
      ({ id: `mi-${runId}-${attemptsMade}`, name: "RunMediaIntelligence", attemptsMade, data: { commandId: runId, traceId: "rem3", schemaVersion: 1 }, opts: { attempts: 3 } }) as never;
    const run = (id: string) =>
      prisma.mediaIntelligenceRun.findUniqueOrThrow({ where: { id }, select: { status: true, attemptCount: true, lastError: true, startedAtUtc: true } });

    it("WORKERS-06: a transient OCR failure hands the claim back, and the retry completes the run", async () => {
      const e = await ev(A().teamId, A().ownerUserId);
      const r = await prisma.mediaIntelligenceRun.create({
        data: { teamId: A().teamId, evidenceId: e.id, kind: "extract_ocr_azure", status: "PENDING" },
        select: { id: true },
      });
      respond = "503";
      await expect(worker.mi.processMediaIntelligenceJob(miJob(r.id, 0))).rejects.toThrow(/internal_extract_http_503/);
      // Before: PROCESSING under a live lease, so the BullMQ retry was refused.
      expect(await run(r.id)).toMatchObject({ status: "PENDING", attemptCount: 1, startedAtUtc: null });
      expect((await run(r.id)).lastError).toMatch(/^transient:/);
      respond = "ok";
      await worker.mi.processMediaIntelligenceJob(miJob(r.id, 1));
      expect(await run(r.id)).toMatchObject({ status: "COMPLETED", attemptCount: 2 });
    }, 120_000);

    it("WORKERS-06: only the current claim may hand a run back; a finished run stays a replay no-op", async () => {
      const e = await ev(A().teamId, A().ownerUserId);
      const r = await prisma.mediaIntelligenceRun.create({
        data: { teamId: A().teamId, evidenceId: e.id, kind: "compute_perceptual_hashes", status: "PENDING" },
        select: { id: true },
      });
      const claim = await tracker.markRunProcessing(r.id, A().teamId, prisma as never);
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      // A stale fence, and the right fence from the wrong workspace, release nothing.
      expect((await tracker.releaseRunForRetry(r.id, A().teamId, "late", prisma as never, claim.fence - 1)).ok).toBe(false);
      expect((await tracker.releaseRunForRetry(r.id, B().teamId, "forged", prisma as never, claim.fence)).ok).toBe(false);
      expect((await run(r.id)).status).toBe("PROCESSING");
      expect((await tracker.releaseRunForRetry(r.id, A().teamId, "blip", prisma as never, claim.fence)).ok).toBe(true);
      expect((await run(r.id)).status).toBe("PENDING");
      // A structurally refused run (FAILED by a refusal) is still not re-run.
      const done = await prisma.mediaIntelligenceRun.create({
        data: { teamId: A().teamId, evidenceId: e.id, kind: "compute_perceptual_hashes", status: "FAILED", attemptCount: 1, lastError: "evidence_unavailable" },
        select: { id: true },
      });
      await worker.mi.processMediaIntelligenceJob(miJob(done.id));
      expect(await run(done.id)).toMatchObject({ status: "FAILED", attemptCount: 1 });
    }, 120_000);

    it("WORKERS-07: a Personal NULL-team record's run passes the gate; foreign records are still refused", async () => {
      const nullTeam = await ev(null, P().userId);
      const ok = await prisma.mediaIntelligenceRun.create({
        data: { teamId: P().teamId, evidenceId: nullTeam.id, kind: "compute_perceptual_hashes", status: "PENDING" },
        select: { id: true },
      });
      await worker.mi.processMediaIntelligenceJob(miJob(ok.id));
      // Before: FAILED evidence_unavailable. The record has no image parts, so
      // the handler completes with nothing to hash.
      expect(await run(ok.id)).toMatchObject({ status: "COMPLETED", attemptCount: 1 });

      // Negative: another owner's NULL-team record bound to this Personal Space.
      const otherOwner = await ev(null, A().ownerUserId);
      const wrongOwner = await prisma.mediaIntelligenceRun.create({
        data: { teamId: P().teamId, evidenceId: otherOwner.id, kind: "compute_perceptual_hashes", status: "PENDING" },
        select: { id: true },
      });
      await worker.mi.processMediaIntelligenceJob(miJob(wrongOwner.id));
      expect(await run(wrongOwner.id)).toMatchObject({ status: "FAILED", lastError: "evidence_unavailable" });

      // Negative: a run of team A naming team B's record.
      const theirs = await ev(B().teamId, B().ownerUserId);
      const forged = await prisma.mediaIntelligenceRun.create({
        data: { teamId: A().teamId, evidenceId: theirs.id, kind: "compute_perceptual_hashes", status: "PENDING" },
        select: { id: true },
      });
      await worker.mi.processMediaIntelligenceJob(miJob(forged.id));
      expect(await run(forged.id)).toMatchObject({ status: "FAILED", lastError: "evidence_unavailable" });
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  it("WORKERS-08: two concurrent anchors in one workspace embed and charge each chunk once", async () => {
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId: A().teamId },
      create: { teamId: A().teamId, aiEnabled: true, semanticSearchEnabled: true, embeddingsAllowed: true } as never,
      update: { aiEnabled: true, semanticSearchEnabled: true, embeddingsAllowed: true } as never,
    });
    const e = await ev(A().teamId, A().ownerUserId);
    const theirs = await ev(B().teamId, B().ownerUserId);
    const ids: string[] = [];
    for (let i = 0; i < 41; i += 1) {
      ids.push(
        (await prisma.evidenceSemanticChunk.create({
          data: { evidenceId: e.id, teamId: A().teamId, chunkIndex: i, chunkText: `rem3 chunk ${i} alpha beta ${TAG}` },
          select: { id: true },
        })).id,
      );
    }
    const victimChunk = await prisma.evidenceSemanticChunk.create({
      data: { evidenceId: theirs.id, teamId: B().teamId, chunkIndex: 0, chunkText: `rem3 victim ${TAG}` },
      select: { id: true },
    });
    const usage = async () =>
      (await prisma.semanticUsageDaily.findMany({ where: { workspaceId: A().teamId }, select: { chunksEmbedded: true } }))
        .reduce((n, r) => n + Number(r.chunksEmbedded), 0);
    const before = await usage();
    const job = (id: string) =>
      ({ id: `embed-${id}`, name: "EmbedSemanticChunks", attemptsMade: 0, data: { commandId: id, traceId: "rem3", schemaVersion: 1 }, opts: { attempts: 3 } }) as never;
    const settled = await Promise.allSettled([
      worker.embed.processMiEmbedJob(job(ids[0]!)),
      worker.embed.processMiEmbedJob(job(ids[1]!)),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    const embedded = (await prisma.$queryRawUnsafe(
      `select count(*)::int as n from evidence_semantic_chunks where evidence_id = $1::uuid and embedding_vector is not null`,
      e.id,
    )) as Array<{ n: number }>;
    expect(embedded[0]?.n).toBe(41);
    // Before: 82 (each chunk charged by both jobs).
    expect((await usage()) - before).toBe(41);
    // A replay finds nothing owed and charges nothing.
    await worker.embed.processMiEmbedJob(job(ids[2]!));
    expect((await usage()) - before).toBe(41);
    const victim = (await prisma.$queryRawUnsafe(
      `select (embedding_vector is not null) as v from evidence_semantic_chunks where id = $1::uuid`,
      victimChunk.id,
    )) as Array<{ v: boolean }>;
    expect(victim[0]?.v).toBe(false);
  }, 180_000);

  // ---------------------------------------------------------------------------
  describe("redaction derivatives", () => {
    async function seed(teamId: string, ownerUserId: string, evidenceExtra: Record<string, unknown>, derivative: Record<string, unknown>) {
      const key = `rem3/${TAG}/${randomUUID()}.png`;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: PNG, ContentType: "image/png" }));
      const e = await ev(teamId, ownerUserId, { storageBucket: BUCKET, storageKey: key, mimeType: "image/png", ...evidenceExtra });
      const project = await prisma.redactionProject.create({
        data: { teamId, evidenceId: e.id, createdByUserId: ownerUserId, artifactKind: "IMAGE" } as never,
        select: { id: true },
      });
      const version = await prisma.redactionVersion.create({
        data: { projectId: project.id, teamId, versionOrdinal: 1, state: "APPROVED", authoredByUserId: ownerUserId, approvedAtUtc: new Date() } as never,
        select: { id: true },
      });
      await prisma.redactionRegion.create({
        data: { versionId: version.id, teamId, kind: "RECT", method: "BLACKOUT", authoredByUserId: ownerUserId, geometry: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } } as never,
      });
      const d = await prisma.redactionDerivative.create({
        data: { versionId: version.id, teamId, kind: "IMAGE", ...derivative } as never,
        select: { id: true },
      });
      return { evidenceId: e.id, versionId: version.id, derivativeId: d.id };
    }
    const state = (id: string) =>
      prisma.redactionDerivative.findUniqueOrThrow({ where: { id }, select: { state: true, failureReason: true, storageKey: true, renderStartedAt: true } });

    it("WORKERS-05: after a takeover the superseded worker can neither release nor fail the live render", async () => {
      const a = await seed(A().teamId, A().ownerUserId, {}, { state: "RENDERING", renderStartedAt: new Date(Date.now() - 21 * 60_000) });
      const staleToken = (await state(a.derivativeId)).renderStartedAt!;
      const takeover = await worker.writer.claimDerivativeForRender(a.derivativeId);
      expect(takeover.claimed).toBe(true);
      if (!takeover.claimed) return;
      // The stale worker's release (before: true, row back to QUEUED).
      expect(await worker.writer.releaseDerivativeClaim(a.derivativeId, staleToken)).toBe(false);
      // So a third claim cannot start a second concurrent render.
      expect(await worker.writer.claimDerivativeForRender(a.derivativeId)).toEqual({ claimed: false, reason: "not_queued" });
      // The stale worker's failure (before: ok, FAILED).
      expect(
        await worker.writer.markDerivativeFailedWorker({ derivativeId: a.derivativeId, teamId: A().teamId, failureReason: "late", claimedAt: staleToken }),
      ).toEqual({ ok: false, reason: "stale_transition" });
      expect((await state(a.derivativeId)).state).toBe("RENDERING");
      // Cross-tenant forged failure is refused.
      const b = await seed(B().teamId, B().ownerUserId, {}, { state: "QUEUED" });
      expect(
        await worker.writer.markDerivativeFailedWorker({ derivativeId: b.derivativeId, teamId: A().teamId, failureReason: "forged" }),
      ).toEqual({ ok: false, reason: "not_found" });
      expect((await state(b.derivativeId)).state).toBe("QUEUED");
      // The current holder can.
      expect(
        (await worker.writer.markDerivativeFailedWorker({ derivativeId: a.derivativeId, teamId: A().teamId, failureReason: "real", claimedAt: takeover.claimedAt })).ok,
      ).toBe(true);
      expect((await state(a.derivativeId)).state).toBe("FAILED");
    }, 120_000);

    it("WORKERS-11: no derivative is rendered for a TRASHED or DESTROYED record; an ACTIVE one renders", async () => {
      const job = (id: string) =>
        ({ id: `rd-${id}`, name: "RenderRedactionDerivative", attemptsMade: 0, data: { commandId: id, traceId: "rem3", schemaVersion: 1 } }) as never;
      const active = await seed(A().teamId, A().ownerUserId, { status: "SIGNED" }, { state: "QUEUED" });
      const destroyed = await seed(A().teamId, A().ownerUserId, { status: "SIGNED", lifecycleState: "DESTROYED", destroyedAtUtc: new Date(), deletedAt: days(60) }, { state: "QUEUED" });
      const trashed = await seed(A().teamId, A().ownerUserId, { status: "SIGNED", lifecycleState: "TRASHED", deletedAt: new Date() }, { state: "QUEUED" });
      for (const d of [active, destroyed, trashed]) await worker.redaction.processRedactionDerivativeJob(job(d.derivativeId));
      expect((await state(active.derivativeId)).state).toBe("READY");
      expect(await state(destroyed.derivativeId)).toMatchObject({ state: "FAILED", failureReason: "evidence_ineligible:evidence_destroyed", storageKey: null });
      expect(await state(trashed.derivativeId)).toMatchObject({ state: "FAILED", failureReason: "evidence_ineligible:evidence_trashed", storageKey: null });
      // No redactions/ object was written for either out-of-service record.
      const listed = await worker.storage.listObjects({ bucket: BUCKET, prefix: `redactions/${A().teamId}/`, maxKeys: 100 });
      const keys = JSON.stringify(listed);
      expect(keys).toContain(active.versionId);
      expect(keys).not.toContain(destroyed.versionId);
      expect(keys).not.toContain(trashed.versionId);
    }, 180_000);
  });

  // ---------------------------------------------------------------------------
  describe("immutable storage drift", () => {
    it("WORKERS-02: a drift incident from the worker emitter blocks the package gate", async () => {
      const e = await ev(A().teamId, A().ownerUserId);
      const control = await ev(A().teamId, A().ownerUserId);
      const fingerprint = `rem3-drift:${e.id}`;
      await worker.incidents.recordWorkerIncident({
        sourceId: "storage.immutable_drift",
        teamId: A().teamId,
        category: "GOVERNANCE",
        severity: "HIGH",
        fingerprint,
        title: "rem3 drift",
        safeSummary: "rem3 drift",
        relatedEvidenceId: e.id,
      } as never);
      const row = await prisma.operationalIncident.findFirstOrThrow({
        where: { relatedEvidenceId: e.id, sourceId: "storage.immutable_drift" },
        select: { id: true, runbookSlug: true },
      });
      expect(row.runbookSlug).toBe("immutable-drift");
      const denied = await worker.gate.assertPackageEligibleOrDeny({ teamId: A().teamId, evidenceId: e.id });
      expect(denied).toMatchObject({ allowed: false, outcome: "BLOCKED_BY_IMMUTABLE_DRIFT" });
      // The record without an incident is not blocked by drift.
      const other = await worker.gate.assertPackageEligibleOrDeny({ teamId: A().teamId, evidenceId: control.id });
      expect(other.outcome).not.toBe("BLOCKED_BY_IMMUTABLE_DRIFT");
      await prisma.operationalIncident.update({ where: { id: row.id }, data: { status: "RESOLVED" } as never });
    }, 120_000);

    it("WORKERS-02: successive runs walk the population instead of re-checking the lowest id", async () => {
      const a1 = await ev(A().teamId, A().ownerUserId, { retentionUntilUtc: days(-3650) });
      const a2 = await ev(A().teamId, A().ownerUserId, { retentionUntilUtc: days(-3650) });
      const victim = await ev(B().teamId, B().ownerUserId, { retentionUntilUtc: days(-3650) });
      const probe = async () => ({ available: false as const, reason: "rem3_probe" });
      const checked: string[] = [];
      const population = await prisma.evidence.count({
        where: { teamId: A().teamId, deletedAt: null, OR: [{ retentionUntilUtc: { not: null } }, { retentionPolicyVersionId: { not: null } }, { storageObjectLockRetainUntilUtc: { not: null } }, { legalHolds: { some: { status: "ACTIVE" } } }] },
      });
      for (let i = 0; i < population + 1; i += 1) {
        const before = new Date();
        await worker.immutable.runImmutableStorageReconciliation({ teamId: A().teamId, batchSize: 1, trigger: "rem3", probeStorage: probe });
        const row = await prisma.immutableStorageCheck.findFirstOrThrow({
          where: { teamId: A().teamId, checkedAtUtc: { gte: before } },
          select: { evidenceId: true },
        });
        checked.push(row.evidenceId);
      }
      // Every candidate was reached within one pass of the population (before:
      // the same lowest id every time), and the walk wrapped to the start.
      expect(checked).toContain(a1.id);
      expect(checked).toContain(a2.id);
      expect(new Set(checked.slice(0, population)).size).toBe(population);
      expect(checked[population]).toBe(checked[0]);
      expect(await prisma.immutableStorageCheck.count({ where: { evidenceId: victim.id } })).toBe(0);
    }, 300_000);

    it("WORKERS-02: the default probe reads the sealed version's lock, and drift is the store disagreeing with the recorded lock", async () => {
      const saved = process.env.S3_OBJECT_LOCK_ENABLED;
      process.env.S3_OBJECT_LOCK_ENABLED = "true";
      try {
        const until = new Date(Date.now() + 2 * 86_400_000);
        const put = async (locked: boolean) => {
          const key = `rem3/${TAG}/${randomUUID()}.bin`;
          const res = await s3.send(
            new PutObjectCommand({
              Bucket: LOCK_BUCKET,
              Key: key,
              Body: Buffer.from(`rem3 ${key}`),
              ...(locked ? { ObjectLockMode: "GOVERNANCE" as const, ObjectLockRetainUntilDate: until } : {}),
            }),
          );
          return { key, versionId: res.VersionId ?? null };
        };
        const lockedObj = await put(true);
        const unlockedObj = await put(false);
        const recorded = { storageObjectLockMode: "GOVERNANCE", storageObjectLockRetainUntilUtc: until };
        const intact = await ev(A().teamId, A().ownerUserId, { storageBucket: LOCK_BUCKET, storageKey: lockedObj.key, storageVersionId: lockedObj.versionId, ...recorded });
        // An application legal hold on an intact record is NOT drift: the
        // product never mirrors holds into native S3 holds.
        await prisma.evidenceLegalHold.create({
          data: { teamId: A().teamId, scope: "EVIDENCE", evidenceId: intact.id, status: "ACTIVE", title: "rem3 hold", placedByUserId: A().ownerUserId } as never,
        });
        const lost = await ev(A().teamId, A().ownerUserId, { storageBucket: LOCK_BUCKET, storageKey: unlockedObj.key, storageVersionId: unlockedObj.versionId, ...recorded });
        await worker.immutable.runImmutableStorageReconciliation({ teamId: A().teamId, batchSize: 500, trigger: "rem3" });
        const outcome = async (id: string) =>
          (await prisma.immutableStorageCheck.findFirstOrThrow({ where: { evidenceId: id }, orderBy: { checkedAtUtc: "desc" }, select: { outcome: true, storageRetainUntilUtc: true } }));
        expect((await outcome(intact.id)).outcome).toBe("OK");
        expect((await outcome(intact.id)).storageRetainUntilUtc?.getTime()).toBe(until.getTime());
        expect((await outcome(lost.id)).outcome).toBe("MISSING_LOCK");
        // The drift reaches the package gate end to end.
        expect(await worker.gate.assertPackageEligibleOrDeny({ teamId: A().teamId, evidenceId: lost.id })).toMatchObject({
          allowed: false,
          outcome: "BLOCKED_BY_IMMUTABLE_DRIFT",
        });
        expect((await worker.gate.assertPackageEligibleOrDeny({ teamId: A().teamId, evidenceId: intact.id })).outcome).not.toBe(
          "BLOCKED_BY_IMMUTABLE_DRIFT",
        );
      } finally {
        if (saved === undefined) delete process.env.S3_OBJECT_LOCK_ENABLED;
        else process.env.S3_OBJECT_LOCK_ENABLED = saved;
      }
    }, 180_000);
  });

  // ---------------------------------------------------------------------------
  it("WORKERS-04: the tier cost projection counts only COMPLETED transitions", async () => {
    const e = await ev(A().teamId, A().ownerUserId, { sizeBytes: 1_000_000n });
    const tierOf = async () => {
      const buckets = await archive.projectArchiveCostsByTier({ prisma: prisma as never, teamId: A().teamId });
      return { hot: buckets.HOT.evidenceCount, warm: buckets.WARM.evidenceCount };
    };
    const base = await tierOf();
    await prisma.archiveTierTransition.create({
      data: { teamId: A().teamId, evidenceId: e.id, fromTier: "HOT", toTier: "WARM", state: "FAILED", failureReason: "tag_failed" },
    });
    await prisma.archiveTierTransition.create({
      data: { teamId: A().teamId, evidenceId: e.id, fromTier: "HOT", toTier: "WARM", state: "PENDING", reason: "AUTO_TRANSITION_PENDING", transitionedAtUtc: new Date(Date.now() + 1000) },
    });
    // Before: the record moved to WARM although no copy happened.
    expect(await tierOf()).toEqual(base);
    await prisma.archiveTierTransition.create({
      data: { teamId: A().teamId, evidenceId: e.id, fromTier: "HOT", toTier: "WARM", state: "COMPLETED", transitionedAtUtc: new Date(Date.now() + 2000) },
    });
    expect(await tierOf()).toEqual({ hot: base.hot - 1, warm: base.warm + 1 });
    const listed = await archive.listArchiveTransitions({ prisma: prisma as never, teamId: A().teamId, evidenceId: e.id });
    expect(listed.map((t) => t.state).sort()).toEqual(["COMPLETED", "FAILED", "PENDING"]);
  }, 120_000);
});
