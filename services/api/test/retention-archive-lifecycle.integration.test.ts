/**
 * TRASH → RETENTION ARCHIVE → PURGE (owner decision 2026-10-14) — executed proof.
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers); a MinIO bucket created WITH
 * OBJECT LOCK (so every object is versioned and retention is real S3 Object
 * Lock GOVERNANCE retain-until metadata); finalization over HTTP applying the
 * deployment's retention to the stored version; the version-aware storage port
 * and the ONE destruction executor; the worker's trash-grace reconciler and
 * archive-restore sweep; the custody chain; the storage accounting authority;
 * the anonymous verification route. Time is CONTROLLED by passing `now` to the
 * reconciler and the executor; retain-until dates are the storage's own.
 * WHAT IS DOUBLED: the RFC 3161 authority; one storage port that fails a
 * listing (to prove fail-closed).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

// The Object-Lock bucket (created with ObjectLockEnabledForBucket). Set before
// anything reads the environment: the storage modules read it per call.
const LOCK_BUCKET = process.env.P7_LOCK_BUCKET ?? "point7-lock-bucket";
process.env.S3_BUCKET = LOCK_BUCKET;
process.env.S3_OBJECT_LOCK_ENABLED = "true";
process.env.S3_OBJECT_LOCK_MODE = "GOVERNANCE";
process.env.S3_OBJECT_LOCK_RETAIN_DAYS = "365";

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const DAY = 24 * 60 * 60 * 1000;

describe("Trash → Retention Archive → Purge on real Object Lock (Postgres + MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");
  let reconciler: typeof import("../../worker/src/governance/trash-grace-reconciler.js");
  let restoreSweep: typeof import("../../worker/src/governance/archive-restore.js");
  let usage: (typeof import("../src/services/workspace-usage.service.js"))["getWorkspaceUsage"];
  let resolveScope: (typeof import("../src/services/billing-enforcement.service.js"))["resolveEnforcementScopeForRequester"];
  let clearRates: () => Promise<unknown>;
  let s3: S3Client;
  const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = [];
  let port: import("@proovra/shared-runtime").EvidenceDestructionStoragePort;
  let archivedFromHttp = "";

  beforeAll(async () => {
    // The safe test environment is (re)applied by a setup hook; this suite's
    // bucket and Object Lock configuration are set after it and BEFORE the
    // server boots, because the evidence routes bind their bucket at load.
    process.env.S3_BUCKET = LOCK_BUCKET;
    process.env.S3_OBJECT_LOCK_ENABLED = "true";
    process.env.S3_OBJECT_LOCK_MODE = "GOVERNANCE";
    process.env.S3_OBJECT_LOCK_RETAIN_DAYS = "365";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    reconciler = await import("../../worker/src/governance/trash-grace-reconciler.js");
    restoreSweep = await import("../../worker/src/governance/archive-restore.js");
    ({ getWorkspaceUsage: usage } = await import("../src/services/workspace-usage.service.js"));
    ({ resolveEnforcementScopeForRequester: resolveScope } = await import("../src/services/billing-enforcement.service.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
    });
    // Every command the canonical port sends is recorded: no Governance bypass, ever.
    const recordingClient = {
      send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sentCommands.push({ name: command.constructor.name, input: command.input });
        return s3.send(command as never);
      },
    };
    port = runtime.createVersionAwareDestructionPort({
      client: recordingClient as never,
      ListObjectVersionsCommand: ListObjectVersionsCommand as never,
      HeadObjectCommand: HeadObjectCommand as never,
      DeleteObjectCommand: DeleteObjectCommand as never,
    });
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
  }, 600_000);

  beforeEach(async () => {
    // Re-applied per test: the safe environment is restored before each one.
    process.env.S3_BUCKET = LOCK_BUCKET;
    process.env.S3_OBJECT_LOCK_ENABLED = "true";
    process.env.S3_OBJECT_LOCK_MODE = "GOVERNANCE";
    process.env.S3_OBJECT_LOCK_RETAIN_DAYS = "365";
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 120_000);

  const A = () => h.fixtures.teamA;
  const call = (method: "GET" | "POST" | "DELETE", url: string, token: string | null, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  /** Where a finalized record's original bytes are: its part (records finalize through parts). */
  async function originalLocation(id: string): Promise<{ key: string; versionId: string | null; partId: string | null }> {
    const part = await prisma.evidencePart.findFirst({ where: { evidenceId: id }, orderBy: { partIndex: "asc" }, select: { id: true, storageKey: true, storageVersionId: true } });
    if (part) return { key: part.storageKey, versionId: part.storageVersionId ?? null, partId: part.id };
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { storageKey: true, storageVersionId: true } });
    return { key: ev.storageKey!, versionId: ev.storageVersionId ?? null, partId: null };
  }

  /** A record finalized over HTTP: bytes in the lock bucket, 365-day GOVERNANCE retention applied by finalization. */
  async function finalizedRecord(): Promise<{ id: string; sha256: string }> {
    const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "DOCUMENT", mimeType: "text/plain", teamId: A().teamId });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, A().ownerToken, { partIndex: 0, mimeType: "text/plain", originalFileName: "lifecycle.txt" });
    expect(part.statusCode, part.body).toBe(201);
    const bytes = Buffer.from(`retention-archive ${id} ${randomBytes(8).toString("hex")}`);
    const put = await fetch(part.json().upload.putUrl as string, { method: "PUT", body: bytes, headers: { "content-type": "text/plain" } });
    expect(put.status, await put.text()).toBe(200);
    const done = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(done.statusCode, done.body).toBe(200);
    return { id, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  /** Put an object with an EXPLICIT retain-until (or none). */
  async function putObject(key: string, retainUntil: Date | null): Promise<string> {
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: LOCK_BUCKET,
        Key: key,
        Body: Buffer.from(`fixture ${key} ${randomUUID()}`),
        ContentType: "text/plain",
        ...(retainUntil ? { ObjectLockMode: "GOVERNANCE", ObjectLockRetainUntilDate: retainUntil } : {}),
      }),
    );
    return res.VersionId!;
  }

  /** A TRASHED record whose own objects carry the retain-until dates given. */
  async function trashedFixture(opts: { originalRetainUntil: Date | null; reportRetainUntil?: Date | null }) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        type: "DOCUMENT",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        signedAtUtc: new Date(),
        sizeBytes: BigInt(64),
      } as never,
      select: { id: true },
    });
    const key = `evidence/${ev.id}/original.txt`;
    const versionId = await putObject(key, opts.originalRetainUntil);
    await prisma.evidence.update({
      where: { id: ev.id },
      data: {
        storageBucket: LOCK_BUCKET,
        storageKey: key,
        storageVersionId: versionId,
        storageObjectLockMode: opts.originalRetainUntil ? "GOVERNANCE" : null,
        storageObjectLockRetainUntilUtc: opts.originalRetainUntil,
        lifecycleState: "TRASHED",
        deletedAt: new Date(),
        deleteScheduledForUtc: new Date(Date.now() + 90 * DAY),
      },
    });
    if (opts.reportRetainUntil !== undefined) {
      const rkey = `reports/${ev.id}/v1.pdf`;
      await putObject(rkey, opts.reportRetainUntil);
      await prisma.report.create({
        data: {
          evidenceId: ev.id,
          version: 1,
          storageBucket: LOCK_BUCKET,
          storageKey: rkey,
          generatedAtUtc: new Date(),
          storageObjectLockMode: opts.reportRetainUntil ? "GOVERNANCE" : null,
          storageObjectLockRetainUntilUtc: opts.reportRetainUntil,
        } as never,
      });
    }
    return ev.id;
  }

  const afterTrash = () => new Date(Date.now() + 91 * DAY);
  const reconcile = (now: Date, storage = port) =>
    reconciler.runTrashGraceReconciliation({ now, teamId: A().teamId, storage, objectLockExpected: true, trigger: "test" });
  const row = (id: string) =>
    prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: {
        lifecycleState: true,
        retentionArchivedAtUtc: true,
        latestRequiredRetainUntilUtc: true,
        purgeEligibleAtUtc: true,
        retentionBarrierState: true,
        destroyedAtUtc: true,
        verificationRef: true,
      },
    });

  it("ACTIVE → TRASH → (day 91, 365-day storage retention) → RETENTION ARCHIVE, with the storage date as the earliest purge", async () => {
    const { id } = await finalizedRecord();
    archivedFromHttp = id;
    const loc = await originalLocation(id);
    const head = await s3.send(new HeadObjectCommand({ Bucket: LOCK_BUCKET, Key: loc.key, ...(loc.versionId ? { VersionId: loc.versionId } : {}) }));
    expect(head.ObjectLockMode).toBe("GOVERNANCE");
    const retainUntil = head.ObjectLockRetainUntilDate!;
    expect(retainUntil.getTime()).toBeGreaterThan(Date.now() + 300 * DAY);

    expect((await call("DELETE", `/v1/evidence/${id}`, A().ownerToken)).statusCode).toBe(200);
    // Day 89: still in Trash.
    await reconcile(new Date(Date.now() + 89 * DAY));
    expect((await row(id)).lifecycleState).toBe("TRASHED");
    // Day 91: the Trash ended, storage retention remains → archive (nothing deleted).
    const run = await reconcile(afterTrash());
    expect(run.candidates.find((c) => c.evidenceId === id)).toMatchObject({ disposition: "RETENTION_ARCHIVED", retentionBarrier: "OBJECT_RETENTION", storageRetentionTruth: "VERIFIED" });
    const r = await row(id);
    expect(r.lifecycleState).toBe("RETENTION_ARCHIVED");
    expect(r.retentionBarrierState).toBe("OBJECT_RETENTION");
    expect(Math.abs(r.latestRequiredRetainUntilUtc!.getTime() - retainUntil.getTime())).toBeLessThan(2000);
    expect(Math.abs(r.purgeEligibleAtUtc!.getTime() - retainUntil.getTime())).toBeLessThan(2000);
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "RETENTION_ARCHIVED" } })).toBe(1);
    // Never "deleted": every version is still in storage.
    expect((await port.listObjectVersions({ bucket: LOCK_BUCKET, key: loc.key })).filter((v) => !v.isDeleteMarker).length).toBe(1);

    // Hidden from the library and Trash; listed in Archived evidence for OWNER/ADMIN only.
    const trashList = await call("GET", `/v1/evidence?scope=trash&teamId=${A().teamId}`, A().ownerToken);
    expect(JSON.stringify(trashList.json())).not.toContain(id);
    const archive = await call("GET", "/v1/evidence/retention-archive", A().ownerToken);
    expect(archive.statusCode).toBe(200);
    const item = archive.json().items.find((i: { id: string }) => i.id === id);
    expect(item).toMatchObject({ reason: "RETENTION", retentionBarrier: "OBJECT_RETENTION", restore: { available: true, inProgress: false }, legalHold: false });
    const memberView = await call("GET", "/v1/evidence/retention-archive", A().memberToken);
    expect(memberView.json().items.find((i: { id: string }) => i.id === id)).toBeUndefined();

    // Archived retained bytes are classified, not counted as active storage.
    const scope = await resolveScope({ ownerUserId: A().ownerUserId, teamId: A().teamId });
    const u = await usage(scope);
    expect(u.retainedArchiveStorageBytes).toBeGreaterThan(0n);
  }, 300_000);

  it("ARCHIVE RESTORE: verified against storage, deduplicated, resumable, same identity, no slot and no new artifact", async () => {
    const id = archivedFromHttp;
    expect((await row(id)).lifecycleState).toBe("RETENTION_ARCHIVED");
    const reportsBefore = await prisma.report.count({ where: { evidenceId: id } });

    // Permissions: MEMBER and VIEWER cannot request it; OWNER/ADMIN can.
    for (const token of [A().memberToken, A().viewerToken]) {
      expect((await call("POST", `/v1/evidence/${id}/archive-restore`, token, {})).statusCode).toBe(403);
    }
    // Concurrent clicks deduplicate to ONE request.
    const clicks = await Promise.all([
      call("POST", `/v1/evidence/${id}/archive-restore`, A().ownerToken, { clientRequestKey: "click-one-aaaa" }),
      call("POST", `/v1/evidence/${id}/archive-restore`, A().adminToken, { clientRequestKey: "click-two-bbbb" }),
    ]);
    expect(clicks.every((c) => c.statusCode === 202 || c.statusCode === 200)).toBe(true);
    const requests = await prisma.evidenceArchiveRestoreRequest.findMany({ where: { evidenceId: id } });
    expect(requests).toHaveLength(1);

    // A crashed worker left it RUNNING with a lapsed lease: the sweep resumes it.
    await prisma.evidenceArchiveRestoreRequest.update({
      where: { id: requests[0]!.id },
      data: { status: "RUNNING", startedAtUtc: new Date(Date.now() - 3_600_000), leaseUntilUtc: new Date(Date.now() - 60_000), attemptCount: 1 },
    });
    const outcomes = await restoreSweep.processArchiveRestoreRequests({});
    expect(outcomes.find((o) => o.evidenceId === id)).toMatchObject({ outcome: "COMPLETED" });
    const r = await row(id);
    expect(r.lifecycleState).toBe("ACTIVE");
    expect(r.retentionArchivedAtUtc).toBeNull();
    const events = (await prisma.custodyEvent.findMany({ where: { evidenceId: id }, select: { eventType: true } })).map((e) => e.eventType);
    expect(events).toEqual(expect.arrayContaining(["ARCHIVE_RESTORE_REQUESTED", "ARCHIVE_RESTORE_VERIFIED", "ARCHIVE_RESTORE_COMPLETED"]));
    expect(await prisma.report.count({ where: { evidenceId: id } })).toBe(reportsBefore);
    expect(await prisma.evidenceIntegrityCheck.count({ where: { evidenceId: id, trigger: "RECOVERY", outcome: "VERIFIED" } })).toBeGreaterThanOrEqual(1);
    // Restored to the same identity: still verifiable, still the same record.
    const custody = await prisma.custodyEvent.findMany({ where: { evidenceId: id }, orderBy: { sequence: "asc" }, select: { sequence: true, eventType: true, atUtc: true, payload: true, prevEventHash: true, eventHash: true } });
    expect(runtime.evaluateCustodyChain({ evidenceId: id, records: custody.map((c) => ({ ...c, eventType: String(c.eventType) })) }).valid).toBe(true);
  }, 300_000);

  it("a missing stored version fails closed: the record stays archived, nothing partial, an actionable condition", async () => {
    const { id } = await finalizedRecord();
    expect((await call("DELETE", `/v1/evidence/${id}`, A().ownerToken)).statusCode).toBe(200);
    await reconcile(afterTrash());
    expect((await row(id)).lifecycleState).toBe("RETENTION_ARCHIVED");
    // The recorded signed version no longer resolves in storage.
    const loc = await originalLocation(id);
    if (loc.partId) await prisma.evidencePart.update({ where: { id: loc.partId }, data: { storageVersionId: "missing-version-id" } });
    else await prisma.evidence.update({ where: { id }, data: { storageVersionId: "missing-version-id" } });
    expect((await call("POST", `/v1/evidence/${id}/archive-restore`, A().ownerToken, {})).statusCode).toBe(202);
    const outcomes = await restoreSweep.processArchiveRestoreRequests({});
    const mine = outcomes.find((o) => o.evidenceId === id);
    expect(mine && mine.outcome).not.toBe("COMPLETED");
    for (let i = 0; i < 3 && (await prisma.evidenceArchiveRestoreRequest.findFirstOrThrow({ where: { evidenceId: id } })).status !== "FAILED"; i++) {
      await restoreSweep.processArchiveRestoreRequests({});
    }
    const req = await prisma.evidenceArchiveRestoreRequest.findFirstOrThrow({ where: { evidenceId: id } });
    expect(req.status).toBe("FAILED");
    expect(["OBJECT_VERSION_MISSING", "STORAGE_UNAVAILABLE"]).toContain(req.failureCode);
    expect((await row(id)).lifecycleState).toBe("RETENTION_ARCHIVED");
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "ARCHIVE_RESTORE_FAILED" } })).toBe(1);
    expect(await prisma.operationalIncident.count({ where: { sourceId: "governance.archive_restore_failed", relatedEvidenceId: id } as never })).toBe(1);
  }, 300_000);

  it("the LATEST required retain-until governs: a later report object extends the boundary", async () => {
    const soon = new Date(Date.now() + 5_000);
    const late = new Date(Date.now() + 400 * DAY);
    const id = await trashedFixture({ originalRetainUntil: soon, reportRetainUntil: late });
    await new Promise((r) => setTimeout(r, 6_000));
    await reconcile(afterTrash());
    const r = await row(id);
    expect(r.lifecycleState).toBe("RETENTION_ARCHIVED");
    expect(Math.abs(r.latestRequiredRetainUntilUtc!.getTime() - late.getTime())).toBeLessThan(2000);
    expect(Math.abs(r.purgeEligibleAtUtc!.getTime() - late.getTime())).toBeLessThan(2000);
  }, 300_000);

  it("missing retention metadata and a failed listing fail CLOSED — archived, never purged", async () => {
    const noRetention = await trashedFixture({ originalRetainUntil: null });
    await reconcile(afterTrash());
    expect(await row(noRetention)).toMatchObject({ lifecycleState: "RETENTION_ARCHIVED", retentionBarrierState: "METADATA_MISSING" });
    expect(await prisma.operationalIncident.count({ where: { sourceId: "governance.retention_unverified", relatedEvidenceId: noRetention } as never })).toBe(1);
    const blocked = await runtime.executeEvidenceDestruction(prisma as never, { evidenceId: noRetention, trigger: "manual", legalHold: false, objectLockExpected: true, now: new Date(Date.now() + 2000 * DAY) }, port);
    expect(blocked).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "RETENTION_METADATA_UNVERIFIED" });
    expect((await row(noRetention)).lifecycleState).toBe("RETENTION_ARCHIVED");

    const failingPort = { ...port, listObjectVersions: async () => { throw new Error("listing failed"); } };
    const unlisted = await trashedFixture({ originalRetainUntil: new Date(Date.now() + 3_000) });
    await new Promise((r) => setTimeout(r, 4_000));
    await reconcile(afterTrash(), failingPort as never);
    expect(await row(unlisted)).toMatchObject({ lifecycleState: "RETENTION_ARCHIVED", retentionBarrierState: "STORAGE_UNAVAILABLE" });
    const refused = await runtime.executeEvidenceDestruction(prisma as never, { evidenceId: unlisted, trigger: "manual", legalHold: false, objectLockExpected: true, now: new Date(Date.now() + 2000 * DAY) }, failingPort as never);
    expect(refused.ok).toBe(false);
    expect((await row(unlisted)).destroyedAtUtc).toBeNull();
  }, 300_000);

  it("a legal hold keeps the record archived and blocks purge even after retention ends", async () => {
    const id = await trashedFixture({ originalRetainUntil: new Date(Date.now() + 3_000) });
    await prisma.evidenceLegalHold.create({
      data: { teamId: A().teamId, evidenceId: id, status: "ACTIVE", title: "Litigation hold", reason: "litigation", placedByUserId: A().ownerUserId } as never,
    });
    await new Promise((r) => setTimeout(r, 4_000));
    await reconcile(afterTrash());
    expect(await row(id)).toMatchObject({ lifecycleState: "RETENTION_ARCHIVED", retentionBarrierState: "LEGAL_HOLD" });
    const res = await runtime.executeEvidenceDestruction(prisma as never, { evidenceId: id, trigger: "manual", legalHold: false, objectLockExpected: true, now: new Date(Date.now() + 2000 * DAY) }, port);
    expect(res).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "LEGAL_HOLD_ACTIVE" });
  }, 300_000);

  it("retention ended + no hold at day 91 → purge-eligible (not archived); final purge deletes every version WITHOUT any Governance bypass, and the page becomes PURGED", async () => {
    const id = await trashedFixture({ originalRetainUntil: new Date(Date.now() + 3_000) });
    await prisma.evidence.update({ where: { id }, data: { verificationRef: runtime.generateVerificationRef(), verificationRefIssuedAtUtc: new Date() } });
    await new Promise((r) => setTimeout(r, 4_000));
    const run = await reconcile(afterTrash());
    const cand = run.candidates.find((c) => c.evidenceId === id)!;
    // No barrier remains: it is NOT archived. This workspace's policy may also
    // require an approved destruction review before the purge runs.
    expect(cand.disposition).toMatch(/^(ELIGIBLE_|APPROVAL_)/);
    expect(cand.retentionBarrier).toBeNull();
    expect((await row(id)).lifecycleState).toBe("TRASHED");

    sentCommands.length = 0;
    const done = await runtime.executeEvidenceDestruction(prisma as never, { evidenceId: id, trigger: "trash_grace_reconciler", legalHold: false, objectLockExpected: true, now: afterTrash() }, port);
    expect(done).toMatchObject({ ok: true, outcome: "DESTROYED" });
    expect(sentCommands.some((c) => "BypassGovernanceRetention" in c.input)).toBe(false);
    expect(sentCommands.filter((c) => c.name === "DeleteObjectCommand").every((c) => typeof c.input.VersionId === "string")).toBe(true);
    const key = `evidence/${id}/original.txt`;
    expect((await port.listObjectVersions({ bucket: LOCK_BUCKET, key })).filter((v) => !v.isDeleteMarker)).toHaveLength(0);
    const r = await row(id);
    expect(r.lifecycleState).toBe("DESTROYED");
    const page = await call("GET", `/public/verify/${r.verificationRef}`, null);
    expect(page.statusCode).toBe(410);
    expect(page.json().code).toBe("VERIFICATION_RECORD_PURGED");
  }, 300_000);

  it("the API never purges a Governance-locked version early, even if asked directly", async () => {
    const id = await trashedFixture({ originalRetainUntil: new Date(Date.now() + 400 * DAY) });
    const res = await runtime.executeEvidenceDestruction(prisma as never, { evidenceId: id, trigger: "manual", legalHold: false, objectLockExpected: true, now: new Date(Date.now() + 91 * DAY) }, port);
    expect(res).toMatchObject({ ok: false, outcome: "BLOCKED", reason: "OBJECT_LOCK_RETENTION_ACTIVE" });
    expect((await port.listObjectVersions({ bucket: LOCK_BUCKET, key: `evidence/${id}/original.txt` })).filter((v) => !v.isDeleteMarker)).toHaveLength(1);
  }, 120_000);
});
