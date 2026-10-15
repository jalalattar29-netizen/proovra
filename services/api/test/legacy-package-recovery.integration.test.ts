/**
 * LEGACY REPORT / PACKAGE RECOVERY — the 2026-10-13 production incident,
 * reproduced on disposable loopback infrastructure and closed.
 *
 * Production (dd440009, 9d82157f, 7eddb7d6 — never touched here): a REPORTED,
 * OTS-ANCHORED record with reports v1–v7 (legacy: pdfSha256 null, a stored
 * trust decision written before the canonical OTS state), packages v1–v2
 * (legacy: reportVersion/packageSha256 null) and no package for v7. The
 * recovery command enqueued package recovery; every attempt failed
 *
 *   PACKAGE_INCONSISTENT: OTS_STATE
 *   manifest otsState=ANCHORED but the matrix states anchoring UNAVAILABLE
 *
 * surfaced as VERIFICATION_PACKAGE_INCOMPLETE_PREPARE, went to the DLQ, and
 * the request stayed FAILED_RETRYABLE.
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers), Redis (BullMQ — the recovery
 * writer enqueues, the job is read back from Redis and run by the real
 * processor), MinIO object storage (every report and package byte, HEAD
 * checksums included), the canonical recovery writer and CLI, the package
 * builder and its consistency gate, the reconciler, the dead-letter reader.
 * WHAT IS DOUBLED: the Chromium PDF renderer (deterministic fixture bytes) and
 * the rendered-PDF text check that only makes sense for a real render; and one
 * failure seam in front of the real package builder.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { otsColumnsFor, otsProofForDigest, pendingOtsProofFor } from "./helpers/ots-proof-bytes.js";
import { readZipEntries } from "./point5/_zip-entries.js";

const seam = vi.hoisted(() => ({
  /** Fail the next N package builds with a retryable, coded error. */
  retryableBuildFailures: 0,
  /** Fail the next N package builds with the real consistency refusal. */
  inconsistentBuildFailures: 0,
  renderCount: 0,
}));

vi.mock("../../worker/src/verification-package.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    createVerificationPackage: (...a: unknown[]) => Promise<unknown>;
    PackageInconsistentError: new (f: Array<{ check: string; detail: string }>) => Error;
  };
  return {
    ...actual,
    createVerificationPackage: async (...args: unknown[]) => {
      if (seam.retryableBuildFailures > 0) {
        seam.retryableBuildFailures -= 1;
        throw Object.assign(new Error("ACC_PACKAGE_BUILD_FAILED"), { code: "ACC_PACKAGE_BUILD_FAILED" });
      }
      if (seam.inconsistentBuildFailures > 0) {
        seam.inconsistentBuildFailures -= 1;
        throw new actual.PackageInconsistentError([
          { check: "OTS_STATE", detail: "manifest otsState=ANCHORED but the matrix states anchoring UNAVAILABLE" },
        ]);
      }
      return actual.createVerificationPackage(...args);
    },
  };
});

vi.mock("../../worker/src/report-v2/build-report-pdf.js", () => {
  const render = () => {
    seam.renderCount += 1;
    return Buffer.from(`%PDF-1.7 legacy-recovery fixture render #${seam.renderCount} ${randomUUID()}\n`);
  };
  return {
    buildReportPdfV2: async () => render(),
    buildReportPdfV2WithSignatureOutcome: async () => ({
      status: "UNSIGNED_OPT_OUT" as const,
      pdf: render(),
      warning: "PDF signing is not exercised by this case.",
    }),
  };
});

vi.mock("../../worker/src/output-verification.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../worker/src/output-verification.js")>();
  return { ...actual, assertRenderedReport: async () => undefined };
});

const FIXTURE_SIGNING_KEY_ID = "legacy-recovery-fixture-key";
const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("legacy report/package recovery (Postgres + Redis + MinIO, real processor)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let processor: typeof import("../../worker/src/processor.js");
  let workerStorage: typeof import("../../worker/src/storage.js");
  let cli: typeof import("../src/scripts/recover-evidence-outputs.js");
  let assessment: typeof import("../src/services/reports/output-recovery-assessment.js");
  let reportQueue: import("bullmq").Queue;
  let dlqQueue: import("bullmq").Queue;
  const created: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import("../../worker/src/processor.js");
    workerStorage = await import("../../worker/src/storage.js");
    cli = await import("../src/scripts/recover-evidence-outputs.js");
    assessment = await import("../src/services/reports/output-recovery-assessment.js");
    const { Queue } = await import("bullmq");
    const { default: IORedis } = await import("ioredis");
    const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    reportQueue = new Queue("report", { connection });
    dlqQueue = new Queue("report-dlq", { connection });
    await reportQueue.obliterate({ force: true });
    await dlqQueue.obliterate({ force: true });

    const { teamId } = harness.fixtures.teamA;
    await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    const owner = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { ownerUserId: true } });
    const ent = await prisma.entitlement.findFirst({ where: { userId: owner.ownerUserId }, select: { id: true } });
    if (ent) await prisma.entitlement.update({ where: { id: ent.id }, data: { plan: "PRO" } });
    else await prisma.entitlement.create({ data: { userId: owner.ownerUserId, plan: "PRO" } });
    await prisma.signingKey.upsert({
      where: { keyId_version_purpose: { keyId: FIXTURE_SIGNING_KEY_ID, version: 1, purpose: "EVIDENCE_SIGNATURE" } },
      create: {
        keyId: FIXTURE_SIGNING_KEY_ID,
        version: 1,
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfixture-local-only-not-a-real-key\n-----END PUBLIC KEY-----\n",
      },
      update: {},
    });
  }, 300_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await reportQueue?.obliterate({ force: true }).catch(() => undefined);
    await dlqQueue?.obliterate({ force: true }).catch(() => undefined);
    await reportQueue?.close();
    await dlqQueue?.close();
    await harness?.cleanup();
  });

  beforeEach(() => {
    seam.retryableBuildFailures = 0;
    seam.inconsistentBuildFailures = 0;
  });

  // ---------------------------------------------------------------- helpers

  async function readObject(bucket: string, key: string): Promise<Buffer | null> {
    try {
      const body = (await workerStorage.getObjectStream({ bucket, key })) as AsyncIterable<Buffer>;
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  /** A SIGNED record in workspace A, its original in MinIO, its OTS proof ANCHORED. */
  async function signedAnchoredEvidence(ots: "ANCHORED" | "PENDING" = "ANCHORED") {
    const { teamId } = harness.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const body = Buffer.from(`legacy recovery original ${randomUUID()}\n`);
    const ev = await prisma.evidence.create({
      data: { title: "Legacy recovery fixture", type: "PHOTO", status: "CREATED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    });
    created.push(ev.id);
    const storageKey = `evidence/${ev.id}/original.txt`;
    await workerStorage.putObjectBuffer({ bucket: process.env.S3_BUCKET!, key: storageKey, body, contentType: "text/plain" });
    const canonical = JSON.stringify({ legacyRecovery: ev.id });
    const digest = sha256Hex(canonical);
    await prisma.evidence.update({
      where: { id: ev.id },
      data: {
        status: "SIGNED",
        signedAtUtc: new Date(),
        signatureBase64: "ZmFrZS1zaWduYXR1cmUtZm9yLXJlY292ZXJ5",
        signingKeyId: FIXTURE_SIGNING_KEY_ID,
        signingKeyVersion: 1,
        fingerprintCanonicalJson: canonical,
        storageBucket: process.env.S3_BUCKET!,
        storageKey,
        mimeType: "text/plain",
        sizeBytes: BigInt(body.length),
        fileSha256: sha256Hex(body),
        ...otsColumnsFor(digest, ots),
      } as never,
    });
    return { evidenceId: ev.id, teamId, ownerUserId: team.ownerUserId, digest };
  }

  /** A durable request row (a historical one, not through the writer). */
  async function rawRequest(ev: { evidenceId: string; teamId: string }, forceRegenerate: boolean): Promise<string> {
    const row = await prisma.reportGenerationRequest.create({
      data: {
        teamId: ev.teamId,
        evidenceId: ev.evidenceId,
        artifactType: "REPORT",
        purpose: forceRegenerate ? "operator_regenerate" : "evidence_completed",
        forceRegenerate,
        requestedByMachineId: "legacy-fixture",
        expectedPolicyVersion: 0,
        idempotencyKey: `LEGACY-FIXTURE:${randomUUID()}`,
        state: "QUEUED",
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  /** The job the writer put in Redis for this request — the real BullMQ job. */
  async function jobFor(requestId: string) {
    const job = await reportQueue.getJob(`report-${requestId}`);
    expect(job, `request ${requestId} must have a job in Redis`).toBeTruthy();
    return job!;
  }

  /** Run the real processor on a job; returns the thrown error or null. */
  async function runJob(job: import("bullmq").Job, attemptsMade?: number): Promise<unknown> {
    if (attemptsMade !== undefined) (job as { attemptsMade: number }).attemptsMade = attemptsMade;
    try {
      await processor.processGenerateReport(job as never);
      return null;
    } catch (err) {
      return err;
    }
  }

  /** Run a historical request directly (fixture building only). */
  async function processFixtureRequest(requestId: string): Promise<unknown> {
    return runJob({
      id: `report-${requestId}`,
      name: "GenerateReportJob",
      attemptsMade: 0,
      data: { commandId: requestId, traceId: "legacy-fixture", schemaVersion: 1 },
      opts: { attempts: 5 },
      queueName: "report",
      discard: () => undefined,
      updateProgress: async () => undefined,
      log: async () => undefined,
    } as never);
  }

  async function primaryPackages(evidenceId: string) {
    return prisma.verificationPackage.findMany({
      where: { evidenceId, state: "PUBLISHED", OR: [{ disclosureProfile: null }, { disclosureProfile: "FULL_FORENSIC" }] } as never,
      orderBy: { version: "asc" },
      select: { id: true, version: true, reportVersion: true, packageSha256: true, reportSha256: true, storageBucket: true, storageKey: true } as never,
    }) as unknown as Promise<Array<{ id: string; version: number; reportVersion: number | null; packageSha256: string | null; reportSha256: string | null; storageBucket: string; storageKey: string }>>;
  }

  async function reportsOf(evidenceId: string) {
    return prisma.report.findMany({
      where: { evidenceId },
      orderBy: { version: "asc" },
      select: { version: true, storageBucket: true, storageKey: true, pdfSha256: true, trustDecisionSnapshot: true, generatedAtUtc: true },
    });
  }

  /**
   * THE INCIDENT SHAPE. Reports v1–v7 issued by the real processor, then
   * rewritten to what pre-2026-10-13 rows look like: v7 has no pdfSha256 and
   * a stored trust decision whose anchoring signal is a legacy `passed` with
   * no canonical state; packages v1–v2 have no reportVersion/packageSha256;
   * v3–v7 never got a package. The OTS proof on the record is ANCHORED.
   */
  async function legacyIncidentRecord() {
    const ev = await signedAnchoredEvidence("ANCHORED");
    // v1 and v2 with their packages.
    expect(await processFixtureRequest(await rawRequest(ev, false))).toBeNull();
    expect(await processFixtureRequest(await rawRequest(ev, true))).toBeNull();
    // v3..v7 whose packages never built (the historical requests were closed).
    for (let v = 3; v <= 7; v += 1) {
      seam.retryableBuildFailures = 1;
      const id = await rawRequest(ev, true);
      await processFixtureRequest(id);
      await prisma.reportGenerationRequest.update({
        where: { id },
        data: { state: "SUCCEEDED", completedAtUtc: new Date(), terminalReasonCode: "generated" },
      });
    }
    const reports = await reportsOf(ev.evidenceId);
    expect(reports.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Legacy rows.
    const v7 = reports.at(-1)!;
    const snapshot = v7.trustDecisionSnapshot as { signals: Array<Record<string, unknown>> } & Record<string, unknown>;
    const legacySignals = snapshot.signals.map((s) => {
      // A legacy signal carries no canonical `state`.
      const rest: Record<string, unknown> = { ...s };
      delete rest.state;
      return s.key === "bitcoin_anchoring" ? { ...rest, status: "passed", summary: "Anchored", detail: "Bitcoin transaction recorded." } : rest;
    });
    await prisma.report.update({
      where: { evidenceId_version: { evidenceId: ev.evidenceId, version: 7 } },
      data: {
        pdfSha256: null,
        trustDecisionSnapshot: { signals: legacySignals, score: 92, verdict: "STRONGLY_VERIFIED" } as never,
        anchorSnapshot: { mode: "ready", transactionId: "ab".repeat(32) } as never,
      } as never,
    });
    await prisma.verificationPackage.updateMany({
      where: { evidenceId: ev.evidenceId, version: { in: [1, 2] } },
      data: { reportVersion: null, packageSha256: null } as never,
    });
    await prisma.evidence.update({ where: { id: ev.evidenceId }, data: { status: "REPORTED" } });
    const before = await primaryPackages(ev.evidenceId);
    expect(before.map((p) => [p.version, p.reportVersion, p.packageSha256])).toEqual([
      [1, null, null],
      [2, null, null],
    ]);
    return { ...ev, v7Key: { bucket: v7.storageBucket, key: v7.storageKey } };
  }

  /** The OTS state every surface states for a record and its newest package. */
  async function otsSurfaces(evidenceId: string, pkg: { storageBucket: string; storageKey: string }) {
    const zip = await readObject(pkg.storageBucket, pkg.storageKey);
    expect(zip, "the package object is in storage").toBeTruthy();
    const entries = readZipEntries(zip!);
    const json = (name: string) => JSON.parse(entries.get(name)!.toString("utf8")) as Record<string, unknown>;
    const matrix = json("trust-decision.json") as { rows: Array<{ key: string; otsState?: string; status: string }> };
    const shared = await import("@proovra/shared");
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: shared.OTS_ANCHORING_RECORD_SELECT });
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/evidence/${evidenceId}/review-workspace`,
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
    });
    const findOts = (node: unknown): { state?: string } | null => {
      if (!node || typeof node !== "object") return null;
      const o = node as Record<string, unknown>;
      if (o.ots && typeof o.ots === "object" && "state" in (o.ots as object)) return o.ots as { state?: string };
      for (const v of Object.values(o)) {
        const hit = findOts(v);
        if (hit) return hit;
      }
      return null;
    };
    return {
      manifest: json("package-manifest.json").otsState,
      matrix: matrix.rows.find((r) => r.key === "ots_anchoring")?.otsState,
      opentimestamps: entries.has("opentimestamps.json") ? json("opentimestamps.json").state : null,
      canonicalRecord: shared.resolveRecordOtsAnchoring(row).state,
      api: res.statusCode === 200 ? findOts(res.json())?.state : `HTTP_${res.statusCode}`,
      entries,
    };
  }

  // ===================================================================== 1 + 2 + 4

  it("INCIDENT: legacy ANCHORED record — recovery builds ONE package paired with report v7, every surface states ANCHORED, the stored hash is derived from the stored bytes, a repeat is a no-op", async () => {
    const ev = await legacyIncidentRecord();
    const reportsBefore = await reportsOf(ev.evidenceId);
    const v7Bytes = (await readObject(ev.v7Key.bucket, ev.v7Key.key))!;
    const renders = seam.renderCount;

    // status and dry run agree: package recovery, nothing written.
    const pre = await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
    expect(pre).toMatchObject({ assessment: "PACKAGE_RECOVERY_REQUIRED", complete: false, latestReport: { version: 7, finding: "VERIFIABLE", pdfSha256: null } });
    const dry = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId });
    expect(dry.results[0]).toMatchObject({ assessment: "PACKAGE_RECOVERY_REQUIRED", action: "request_package_recovery" });
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId, purpose: "package_recovery" } })).toBe(0);

    // apply: the canonical writer creates and enqueues ONE request.
    const applied = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true });
    expect(applied.results[0]).toMatchObject({ action: "request_package_recovery", deduplicated: false, enqueued: true });
    const requestId = applied.results[0]!.requestId!;

    // The real worker processor runs the job read back from Redis.
    expect(await runJob(await jobFor(requestId), 0)).toBeNull();
    const req = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: requestId }, select: { state: true, terminalReasonCode: true } });
    expect(req).toEqual({ state: "SUCCEEDED", terminalReasonCode: "package_built" });

    // One new package version, explicitly paired with report v7; history kept.
    const pkgs = await primaryPackages(ev.evidenceId);
    expect(pkgs.map((p) => [p.version, p.reportVersion])).toEqual([[1, null], [2, null], [7, 7]]);
    const v7pkg = pkgs.at(-1)!;
    expect(v7pkg.packageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v7pkg.packageSha256).toBe(sha256Hex((await readObject(v7pkg.storageBucket, v7pkg.storageKey))!));
    // The legacy null report hash is DERIVED from the stored bytes (verified
    // against the store's checksum and the issuance record), never assumed.
    expect(v7pkg.reportSha256).toBe(sha256Hex(v7Bytes));

    // No report mutated, none re-rendered, none added.
    expect(seam.renderCount).toBe(renders);
    const reportsAfter = await reportsOf(ev.evidenceId);
    expect(reportsAfter.map((r) => [r.version, r.pdfSha256, r.storageKey])).toEqual(reportsBefore.map((r) => [r.version, r.pdfSha256, r.storageKey]));
    expect((await readObject(ev.v7Key.bucket, ev.v7Key.key))!.equals(v7Bytes)).toBe(true);

    // 2 — one truthful OTS state across manifest, matrix, opentimestamps.json,
    // canonical record and the API.
    const s = await otsSurfaces(ev.evidenceId, v7pkg);
    expect({ manifest: s.manifest, matrix: s.matrix, opentimestamps: s.opentimestamps, canonicalRecord: s.canonicalRecord, api: s.api }).toEqual({
      manifest: "ANCHORED",
      matrix: "ANCHORED",
      opentimestamps: "ANCHORED",
      canonicalRecord: "ANCHORED",
      api: "ANCHORED",
    });
    // The package embeds exactly the stored v7 bytes.
    const pdfName = [...s.entries.keys()].find((k) => k.endsWith("proovra-verification-report-v7.pdf"));
    expect(pdfName).toBeTruthy();
    expect(s.entries.get(pdfName!)!.equals(v7Bytes)).toBe(true);

    // complete=true, and a repeat creates nothing.
    const post = await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
    expect(post).toMatchObject({ assessment: "COMPLETE", complete: true });
    expect(await cli.evidenceOutputStatus({ evidenceId: ev.evidenceId, expectComplete: true })).toBe(0);
    const requestsBefore = await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId } });
    const again = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true });
    expect(again.results[0]).toMatchObject({ assessment: "COMPLETE", action: "none" });
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId } })).toBe(requestsBefore);
    expect((await primaryPackages(ev.evidenceId)).length).toBe(3);
  }, 240_000);

  // ===================================================================== production request state

  it("PRODUCTION STATE: the request left FAILED_RETRYABLE by the incident is re-driven AS ITSELF and succeeds", async () => {
    const ev = await legacyIncidentRecord();
    // Exactly what production holds: the recovery request, failed retryably.
    const writer = await import("../src/services/reports/report-generation-authority.service.js");
    const made = await writer.requestReportGeneration({
      evidenceId: ev.evidenceId,
      purpose: "package_recovery",
      artifactType: "VERIFICATION_PACKAGE",
      reportVersion: 7,
      requestedByMachineId: "ops.recover-evidence-outputs",
    });
    expect(made.requested).toBe(true);
    const requestId = (made as { requestId: string }).requestId;
    await (await jobFor(requestId)).remove();
    await prisma.reportGenerationRequest.update({
      where: { id: requestId },
      data: { state: "FAILED_RETRYABLE", terminalReasonCode: "VERIFICATION_PACKAGE_INCOMPLETE_PREPARE", attemptCount: 5 },
    });

    const pre = await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
    expect(pre).toMatchObject({ assessment: "ACTIVE_REQUEST", reason: "REQUEST_FAILED_RETRYABLE" });
    const applied = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true });
    expect(applied.results[0]).toMatchObject({ action: "reenqueue_retryable", requestId, enqueued: true });
    expect(await runJob(await jobFor(requestId), 0)).toBeNull();
    expect((await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: requestId } })).state).toBe("SUCCEEDED");
    expect((await primaryPackages(ev.evidenceId)).map((p) => p.reportVersion)).toEqual([null, null, 7]);
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId, purpose: "package_recovery" } })).toBe(1);
  }, 240_000);

  // ===================================================================== 3

  it("CONTRADICTORY / MALFORMED OTS material is never promoted to ANCHORED", async () => {
    const shared = await import("@proovra/shared");
    // (a) a status that says ANCHORED over a proof that only awaits a calendar:
    // the package states PENDING in manifest AND matrix — consistent, not promoted.
    const pending = await signedAnchoredEvidence("ANCHORED");
    await prisma.evidence.update({
      where: { id: pending.evidenceId },
      data: { otsProofBase64: otsProofForDigest(pending.digest) } as never,
    });
    expect(await processFixtureRequest(await rawRequest(pending, false))).toBeNull();
    const [pkg] = (await primaryPackages(pending.evidenceId)).slice(-1);
    const s = await otsSurfaces(pending.evidenceId, pkg!);
    expect([s.manifest, s.matrix, s.canonicalRecord, s.api]).toEqual(["PENDING", "PENDING", "PENDING", "PENDING"]);

    // (b) an "anchored" proof bound to ANOTHER digest: refused, no package, terminal.
    const foreign = await signedAnchoredEvidence("ANCHORED");
    await prisma.evidence.update({
      where: { id: foreign.evidenceId },
      data: { otsProofBase64: otsProofForDigest(sha256Hex("another record"), { bitcoinHeight: 860_000 }) } as never,
    });
    const foreignRow = await prisma.evidence.findUniqueOrThrow({ where: { id: foreign.evidenceId }, select: shared.OTS_ANCHORING_RECORD_SELECT });
    expect(shared.resolveRecordOtsAnchoring(foreignRow)).toMatchObject({ state: "FAILED", failureCode: "PROOF_HASH_MISMATCH" });
    const foreignId = await rawRequest(foreign, false);
    expect(await processFixtureRequest(foreignId)).toBeTruthy();
    const foreignReq = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: foreignId } });
    expect(foreignReq.state).toBe("FAILED_TERMINAL");
    expect(await primaryPackages(foreign.evidenceId)).toEqual([]);

    // (c) bytes that are not a proof at all, under a status of ANCHORED.
    const malformed = await signedAnchoredEvidence("ANCHORED");
    await prisma.evidence.update({ where: { id: malformed.evidenceId }, data: { otsProofBase64: Buffer.from("not an ots proof").toString("base64") } as never });
    const malformedRow = await prisma.evidence.findUniqueOrThrow({ where: { id: malformed.evidenceId }, select: shared.OTS_ANCHORING_RECORD_SELECT });
    expect(shared.resolveRecordOtsAnchoring(malformedRow).state).toBe("FAILED");
    const malformedId = await rawRequest(malformed, false);
    expect(await processFixtureRequest(malformedId)).toBeTruthy();
    expect((await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: malformedId } })).state).toBe("FAILED_TERMINAL");
    expect(await primaryPackages(malformed.evidenceId)).toEqual([]);

    // (d) the package's matrix now follows the shipped proof, and the gate
    // that refused production stays enabled: a matrix that disagrees with the
    // manifest is still a finding.
    const findings = shared.validatePackageConsistency({
      texts: new Map([
        ["package-manifest.json", JSON.stringify({ packageId: "p", evidenceId: "e", reportVersion: 7, disclosureProfile: "FULL_FORENSIC", evidenceFileSha256: null, otsState: "ANCHORED" })],
        ["trust-decision.json", s.entries.get("trust-decision.json")!.toString("utf8")],
      ]),
      paths: ["package-manifest.json", "trust-decision.json"],
      expect: { packageId: "p", evidenceId: "e", reportVersion: 7, disclosureProfile: "FULL_FORENSIC", evidenceFileSha256: null },
    });
    expect(findings.map((f) => f.check)).toContain("OTS_STATE");
  }, 240_000);

  // ===================================================================== 4 (refusals)

  it("LEGACY HASH: bytes that disagree with the issuance record are refused, never packaged", async () => {
    const ev = await legacyIncidentRecord();
    // Same key, different bytes (MinIO keeps the new upload's checksum, so the
    // store alone would agree with them — the issuance record does not).
    // A legacy row recorded no VersionId, so it names whatever is latest at its
    // key. (A row that recorded one is pinned to its own bytes: on a versioned
    // bucket an overwrite at the key does not alter the recorded version.)
    await prisma.report.update({ where: { evidenceId_version: { evidenceId: ev.evidenceId, version: 7 } }, data: { s3VersionId: null } });
    await workerStorage.putObjectBuffer({ bucket: ev.v7Key.bucket, key: ev.v7Key.key, body: Buffer.from("%PDF-1.7 altered\n"), contentType: "application/pdf" });
    const pre = await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
    expect(pre.assessment).toBe("REFUSED_INTEGRITY_FAILURE");
    const applied = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true });
    expect(applied.results[0]).toMatchObject({ action: "operator_review_required" });
    expect(applied.code).toBe(3);
    // Even a request that reached the worker would refuse the bytes.
    const writer = await import("../src/services/reports/report-generation-authority.service.js");
    const made = (await writer.requestReportGeneration({
      evidenceId: ev.evidenceId, purpose: "package_recovery", artifactType: "VERIFICATION_PACKAGE", reportVersion: 7, requestedByMachineId: "legacy-test",
    })) as { requestId: string };
    expect(await runJob(await jobFor(made.requestId), 0)).toBeTruthy();
    expect(await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: made.requestId }, select: { state: true, terminalReasonCode: true } })).toEqual({
      state: "FAILED_TERMINAL",
      terminalReasonCode: "REPORT_INTEGRITY_MISMATCH",
    });
    expect((await primaryPackages(ev.evidenceId)).map((p) => p.reportVersion)).toEqual([null, null]);
  }, 240_000);

  // ===================================================================== 5

  it("MISSING OBJECT (7eddb7d6 shape): status, dry run and apply never select package recovery; --regenerate issues ONE verified new version", async () => {
    const ev = await legacyIncidentRecord();
    // The actual stored VERSION(S) removed — not a key-only marker over them (AUD-028).
    expect((await workerStorage.deleteObjectVersions({ bucket: ev.v7Key.bucket, key: ev.v7Key.key })).deleted).toBe(true);

    const pre = await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
    expect(pre).toMatchObject({ assessment: "REPORT_REGENERATION_REQUIRED", reason: "REPORT_OBJECT_MISSING", latestReport: { version: 7, finding: "MISSING" }, complete: false });
    expect(await cli.evidenceOutputStatus({ evidenceId: ev.evidenceId, expectComplete: true })).toBe(3);
    const dry = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId });
    expect(dry.results[0]).toMatchObject({ assessment: "REPORT_REGENERATION_REQUIRED", action: "rerun_with_--regenerate_to_issue_a_new_verified_report_version" });
    const apply = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true });
    expect(apply.results[0]!.action).toBe("rerun_with_--regenerate_to_issue_a_new_verified_report_version");
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId, purpose: "package_recovery" } }), "no package recovery is ever enqueued").toBe(0);

    const regen = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true, regenerate: true });
    expect(regen.results[0]).toMatchObject({ action: "request_new_verified_report_version", enqueued: true });
    const again = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true, regenerate: true });
    expect(again.results[0]).toMatchObject({ assessment: "ACTIVE_REQUEST" });
    expect(await runJob(await jobFor(regen.results[0]!.requestId!), 0)).toBeNull();
    const reports = await reportsOf(ev.evidenceId);
    expect(reports.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await primaryPackages(ev.evidenceId)).at(-1)!.reportVersion).toBe(8);
    expect((await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId })).assessment).toBe("COMPLETE");
    const third = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true, regenerate: true });
    expect(third.results[0]).toMatchObject({ assessment: "COMPLETE", action: "none" });
  }, 240_000);

  // ===================================================================== 6 + 7 + 9 + 10

  it("RETRY EXHAUSTION is terminal in the database with the root cause; a corrected recovery supersedes it exactly once; logs and DLQ telemetry tell the truth", async () => {
    const workerLogger = (await import("../../worker/src/logger.js")).logger;
    const lines: Array<{ level: string; msg: string }> = [];
    const spies = (["info", "warn", "error"] as const).map((level) =>
      vi.spyOn(workerLogger, level).mockImplementation(((...args: unknown[]) => {
        const msg = args.find((a) => typeof a === "string");
        if (typeof msg === "string") lines.push({ level, msg });
      }) as never),
    );
    try {
      const ev = await legacyIncidentRecord();
      // This case reads the sink: start it empty (entries of earlier cases are theirs).
      await dlqQueue.obliterate({ force: true });
      lines.length = 0;
      const applied = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true });
      const requestId = applied.results[0]!.requestId!;
      const job = await jobFor(requestId);

      // Attempts 1..4 fail retryably: FAILED_RETRYABLE, each with its root cause.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        seam.retryableBuildFailures = 1;
        expect(await runJob(job, attempt)).toBeTruthy();
        const r = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: requestId } });
        expect([r.state, r.terminalReasonCode]).toEqual(["FAILED_RETRYABLE", "ACC_PACKAGE_BUILD_FAILED"]);
      }
      // 9 — no "completed" for the job while it is failing; one outcome per attempt.
      expect(lines.filter((l) => /GenerateReportJob completed/.test(l.msg))).toEqual([]);
      expect(lines.filter((l) => l.msg === "GenerateReportJob failed (retryable)")).toHaveLength(4);
      expect(lines.filter((l) => /^GenerateReportJob (succeeded|failed)/.test(l.msg))).toHaveLength(4);

      // 6 — the LAST attempt is terminal, with the root code, a DLQ record and the condition.
      lines.length = 0;
      seam.retryableBuildFailures = 1;
      expect(await runJob(job, 4)).toBeTruthy();
      const terminal = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect([terminal.state, terminal.terminalReasonCode]).toEqual(["FAILED_TERMINAL", "ACC_PACKAGE_BUILD_FAILED"]);
      expect(lines.filter((l) => /^GenerateReportJob (succeeded|failed)/.test(l.msg)).map((l) => l.msg)).toEqual(["GenerateReportJob failed (terminal)"]);
      expect(lines.some((l) => /moved to DLQ"?$/.test(l.msg) && !/record written/.test(l.msg))).toBe(false);
      const dlq = (await dlqQueue.getJobs(["waiting"])).filter((j) => (j.data as { requestId?: string }).requestId === requestId);
      expect(dlq.map((j) => j.data)).toEqual([expect.objectContaining({ evidenceId: ev.evidenceId, errorCode: "ACC_PACKAGE_BUILD_FAILED", retriable: true })]);
      const incident = await prisma.operationalIncident.findFirstOrThrow({
        where: { relatedEvidenceId: ev.evidenceId, fingerprint: `PACKAGE:${ev.evidenceId}:v7:RETRY_BUDGET_EXHAUSTED` },
      });
      expect(incident.status).toBe("OPEN");
      // A replayed terminal write changes nothing.
      expect(await runJob(job, 4)).toBeNull();
      expect((await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: requestId } })).state).toBe("FAILED_TERMINAL");

      // 10 — the sink is history, not backlog; its unresolved entry is new.
      const { readDeadLetterSummary } = await import("@proovra/shared-runtime/ops");
      const { snapshotQueueHealth } = await import("../../worker/src/observability.js");
      const read = (q: import("bullmq").Queue) => readDeadLetterSummary(prisma as never, q as never);
      const [sample] = await snapshotQueueHealth([{ name: "report-dlq", queue: dlqQueue as never }], { readDeadLetter: read as never });
      expect(sample).toMatchObject({ role: "DEAD_LETTER", hasBacklog: false, oldestPendingAgeSeconds: null });
      expect(sample!.waiting).toBeGreaterThan(0);
      expect(sample!.deadLetter).toMatchObject({ unresolvedNew: 1, acknowledged: 0, resolved: 0 });
      const { getQueueInventory } = await import("../src/services/operations/queue-inventory.service.js");
      const inv = (await getQueueInventory()).find((q) => q.queueName === "report-dlq")!;
      expect(inv).toMatchObject({ role: "DEAD_LETTER", health: "degraded", stalledCount: 0 });
      // Acknowledging the condition settles the entry (the canonical lifecycle).
      await prisma.operationalIncident.update({ where: { id: incident.id }, data: { status: "ACKNOWLEDGED", acknowledgedAtUtc: new Date() } });
      expect(await read(dlqQueue)).toMatchObject({ unresolvedNew: 0, acknowledged: 1 });
      expect((await getQueueInventory()).find((q) => q.queueName === "report-dlq")!.health).toBe("healthy");

      // 7 — the customer/operator state agrees: terminal, technical, supersedable once.
      const pre = await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
      expect(pre).toMatchObject({ assessment: "TERMINAL_FAILURE_REQUIRES_SUPERSESSION", reason: "ACC_PACKAGE_BUILD_FAILED" });
      const fixed = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true });
      expect(fixed.results[0]).toMatchObject({ action: "supersede_technical_terminal_with_package_recovery", deduplicated: false, enqueued: true });
      const successorId = fixed.results[0]!.requestId!;
      expect(successorId).not.toBe(requestId);
      const successor = await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: successorId } });
      expect(successor.idempotencyKey).toBe(`VERIFICATION_PACKAGE:${ev.evidenceId}:v7:s1`);
      // A second command collapses onto the successor — never :s2.
      const twice = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true });
      expect(twice.results[0]!.assessment).toBe("ACTIVE_REQUEST");
      lines.length = 0;
      expect(await runJob(await jobFor(successorId), 0)).toBeNull();
      expect(lines.filter((l) => /^GenerateReportJob (succeeded|failed)/.test(l.msg)).map((l) => l.msg)).toEqual(["GenerateReportJob succeeded"]);
      expect((await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: successorId } })).state).toBe("SUCCEEDED");
      expect((await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: requestId } })).state, "the failure stays as history").toBe("FAILED_TERMINAL");
      expect((await primaryPackages(ev.evidenceId)).map((p) => p.reportVersion)).toEqual([null, null, 7]);
      expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId, idempotencyKey: { contains: ":s2" } } })).toBe(0);
      // The recovered record resolves its dead-letter entry.
      expect(await read(dlqQueue)).toMatchObject({ unresolvedNew: 0, unresolvedOlder: 0, resolved: 1 });
    } finally {
      for (const s of spies) s.mockRestore();
    }
  }, 300_000);

  it("A PACKAGE CONTRADICTION is terminal on its FIRST attempt with PACKAGE_INCONSISTENT_OTS_STATE — never retried as VERIFICATION_PACKAGE_INCOMPLETE_PREPARE", async () => {
    const ev = await legacyIncidentRecord();
    const applied = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true });
    const requestId = applied.results[0]!.requestId!;
    seam.inconsistentBuildFailures = 1;
    expect(await runJob(await jobFor(requestId), 0)).toBeTruthy();
    expect(await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id: requestId }, select: { state: true, terminalReasonCode: true } })).toEqual({
      state: "FAILED_TERMINAL",
      terminalReasonCode: "PACKAGE_INCONSISTENT_OTS_STATE",
    });
    // One package condition (not a second REPORT one), naming the cause. (The
    // fixture's own historical v7 build failure, ACC_*, is not this run's.)
    const conditions = await prisma.operationalIncident.findMany({
      where: {
        relatedEvidenceId: ev.evidenceId,
        category: { in: ["REPORT", "PACKAGE"] },
        OR: [{ fingerprint: { startsWith: `PACKAGE:${ev.evidenceId}:v7:` } }, { fingerprint: { startsWith: "REPORT:" } }],
        NOT: { fingerprint: { endsWith: ":ACC_PACKAGE_BUILD_FAILED" } },
      },
      select: { fingerprint: true },
    });
    expect(conditions.map((c) => c.fingerprint)).toEqual([`PACKAGE:${ev.evidenceId}:v7:PACKAGE_INCONSISTENT_OTS_STATE`]);
    // After the corrected release: superseded once, built, complete.
    const fixed = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true });
    expect(fixed.results[0]).toMatchObject({ assessment: "TERMINAL_FAILURE_REQUIRES_SUPERSESSION", reason: "PACKAGE_INCONSISTENT_OTS_STATE" });
    expect(await runJob(await jobFor(fixed.results[0]!.requestId!), 0)).toBeNull();
    expect((await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId })).assessment).toBe("COMPLETE");
  }, 240_000);

  // ===================================================================== 8

  it("CONCURRENT recovery commands make ONE request and ONE package; concurrent supersessions make ONE successor", async () => {
    const ev = await legacyIncidentRecord();
    const results = await Promise.all([1, 2, 3, 4].map(() => cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true })));
    const ids = new Set(results.map((r) => r.results[0]!.requestId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.results[0]!.deduplicated === false)).toHaveLength(1);
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId, purpose: "package_recovery" } })).toBe(1);
    const requestId = [...ids][0]!;
    // Two workers delivered the same job at once: one pair.
    const job = await jobFor(requestId);
    await Promise.all([runJob(job, 0), runJob(job, 0)]);
    expect((await primaryPackages(ev.evidenceId)).filter((p) => p.reportVersion === 7)).toHaveLength(1);

    // Concurrent supersessions of one technical terminal.
    const ev2 = await legacyIncidentRecord();
    const first = await cli.recoverEvidenceOutputs({ evidenceId: ev2.evidenceId, apply: true });
    seam.inconsistentBuildFailures = 1;
    await runJob(await jobFor(first.results[0]!.requestId!), 0);
    const supersessions = await Promise.all([1, 2, 3].map(() => cli.recoverEvidenceOutputs({ evidenceId: ev2.evidenceId, apply: true })));
    expect(new Set(supersessions.map((r) => r.results[0]!.requestId)).size).toBe(1);
    expect(
      await prisma.reportGenerationRequest.findMany({ where: { evidenceId: ev2.evidenceId, purpose: "package_recovery" }, select: { idempotencyKey: true }, orderBy: { createdAtUtc: "asc" } }),
    ).toEqual([{ idempotencyKey: `VERIFICATION_PACKAGE:${ev2.evidenceId}:v7` }, { idempotencyKey: `VERIFICATION_PACKAGE:${ev2.evidenceId}:v7:s1` }]);
  }, 300_000);

  // ===================================================================== 11

  it("CURRENT FORMAT: a fresh record's report and packages generate as before, stating one OTS state", async () => {
    const ev = await signedAnchoredEvidence("ANCHORED");
    const id = await rawRequest(ev, false);
    expect(await processFixtureRequest(id)).toBeNull();
    expect((await prisma.reportGenerationRequest.findUniqueOrThrow({ where: { id } })).state).toBe("SUCCEEDED");
    const pkgs = await primaryPackages(ev.evidenceId);
    expect(pkgs.map((p) => p.reportVersion)).toEqual([1]);
    const s = await otsSurfaces(ev.evidenceId, pkgs[0]!);
    expect([s.manifest, s.matrix, s.opentimestamps, s.canonicalRecord, s.api]).toEqual(["ANCHORED", "ANCHORED", "ANCHORED", "ANCHORED", "ANCHORED"]);
    expect((await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId })).assessment).toBe("COMPLETE");

    // And a PENDING record states PENDING everywhere.
    const p = await signedAnchoredEvidence("PENDING");
    expect(await processFixtureRequest(await rawRequest(p, false))).toBeNull();
    const ps = await otsSurfaces(p.evidenceId, (await primaryPackages(p.evidenceId))[0]!);
    expect([ps.manifest, ps.matrix, ps.canonicalRecord, ps.api]).toEqual(["PENDING", "PENDING", "PENDING", "PENDING"]);
    void pendingOtsProofFor;
  }, 240_000);
  // ===================================================================== AUD-011
  //
  // A report/package ROW whose stored object is gone, a store that does not
  // answer, and a store that refuses us are three different facts. Each
  // surface — download route, single-record status, assessment, CLI — states
  // the one that is true, and an entitled caller recovers a missing file by a
  // NEW verified, correctly paired version through the canonical writer.

  async function issuedPair() {
    const ev = await signedAnchoredEvidence("ANCHORED");
    expect(await processFixtureRequest(await rawRequest(ev, false))).toBeNull();
    const [report] = await prisma.report.findMany({
      where: { evidenceId: ev.evidenceId },
      select: { version: true, storageBucket: true, storageKey: true, s3VersionId: true, pdfSha256: true },
    });
    const [pkg] = await primaryPackages(ev.evidenceId);
    expect(report!.version).toBe(1);
    expect(pkg!.reportVersion).toBe(1);
    return { ...ev, report: report!, pkg: pkg! };
  }

  const api = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
    harness.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload: payload as never } : {}) });
  const statusOf = async (evidenceId: string, token = harness.fixtures.teamA.ownerToken) => {
    const res = await api("GET", `/v1/evidence/${evidenceId}/artifacts/status`, token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      outputs: Record<"report" | "verificationPackage", { state: string; availability: string; action: string; operation: string | null; actionUnavailableReason: string | null; version: number | null }>;
      report: { available: boolean };
      verificationPackage: { available: boolean };
    };
  };
  async function removeEveryVersion(bucket: string, key: string) {
    // Delete the actual VERSION(S), not a key-only marker over them (AUD-028).
    const removal = await workerStorage.deleteObjectVersions({ bucket, key });
    expect(removal).toMatchObject({ deleted: true, retainedVersions: 0, failed: 0 });
  }
  /** Route the API's object-store client through another real client for one case. */
  async function withApiStorageClient<T>(client: import("@aws-sdk/client-s3").S3Client, fn: () => Promise<T>): Promise<T> {
    const apiStorage = await import("../src/storage.js");
    const { clearStoredObjectProbeCache } = await import("../src/services/reports/output-recovery.service.js");
    clearStoredObjectProbeCache();
    const spy = vi.spyOn(apiStorage.s3, "send").mockImplementation(((cmd: never) => client.send(cmd)) as never);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
      clearStoredObjectProbeCache();
      client.destroy();
    }
  }
  async function s3ClientFor(endpoint: string, credentials: { accessKeyId: string; secretAccessKey: string }) {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials, maxAttempts: 1 });
  }

  it("AUD-011 MISSING REPORT FILE: status says missing (not available), download is 410 with the recovery permission, a member recovers ONE new verified pair, a repeat returns the SAME request, a viewer cannot", async () => {
    const ev = await issuedPair();
    const { teamA } = harness.fixtures;
    await removeEveryVersion(ev.report.storageBucket, ev.report.storageKey);
    const { clearStoredObjectProbeCache } = await import("../src/services/reports/output-recovery.service.js");
    clearStoredObjectProbeCache();

    // The single-record view HEADs the recorded version: not "available".
    const before = await statusOf(ev.evidenceId);
    expect(before.outputs.report).toMatchObject({ state: "ARTIFACT_MISSING", availability: "MISSING", action: "RECOVER", operation: "NEW_VERSION", version: 1 });
    expect(before.report.available).toBe(false);
    expect(before.outputs.verificationPackage).toMatchObject({ action: "NONE", actionUnavailableReason: "FOLLOWS_REPORT" });

    // The download: 410 (the version is gone), naming whether this caller may recover.
    const dl = await api("GET", `/v1/evidence/${ev.evidenceId}/report/latest`, teamA.ownerToken);
    expect(dl.statusCode).toBe(410);
    expect(dl.json()).toMatchObject({ code: "report_artifact_missing", recoveryPermitted: true });
    const dlVersion = await api("GET", `/v1/evidence/${ev.evidenceId}/reports/1`, teamA.ownerToken);
    expect([dlVersion.statusCode, dlVersion.json().code]).toEqual([410, "report_artifact_missing"]);

    // The assessment agrees.
    const pre = await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
    expect(pre).toMatchObject({ assessment: "REPORT_REGENERATION_REQUIRED", reason: "REPORT_OBJECT_MISSING", latestReport: { version: 1, finding: "MISSING" } });

    // A viewer cannot trigger it; nothing is created.
    const requestsBefore = await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId } });
    const viewer = await api("POST", `/v1/evidence/${ev.evidenceId}/reports/regenerate`, teamA.viewerToken, { intent: "RECOVER" });
    expect([403, 404]).toContain(viewer.statusCode);
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId } })).toBe(requestsBefore);

    // A member recovers: ONE new version through the canonical writer.
    const member = await api("POST", `/v1/evidence/${ev.evidenceId}/reports/regenerate`, teamA.memberToken, { intent: "RECOVER" });
    expect(member.statusCode, member.body).toBe(202);
    expect(member.json()).toMatchObject({ operation: "NEW_VERSION", enqueued: true });
    const requestId = member.json().requestId as string;
    const row = await prisma.reportGenerationRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { forceRegenerate: true, clientRequestKey: true, intent: true, state: true },
    });
    expect(row).toMatchObject({ forceRegenerate: true, clientRequestKey: `recover-missing:${ev.evidenceId}:v1`, intent: "NEW_VERSION", state: "QUEUED" });

    // An admin's repeat while it is in flight returns the SAME request (idempotent, no loop).
    const admin = await api("POST", `/v1/evidence/${ev.evidenceId}/reports/regenerate`, teamA.adminToken, { intent: "RECOVER" });
    expect(admin.statusCode, admin.body).toBe(202);
    expect(admin.json().requestId).toBe(requestId);
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId } })).toBe(requestsBefore + 1);

    // The worker issues v2 and its package, correctly paired; v1 stays as history.
    expect(await runJob(await jobFor(requestId), 0)).toBeNull();
    const reports = await reportsOf(ev.evidenceId);
    expect(reports.map((r) => r.version)).toEqual([1, 2]);
    expect(reports[0]).toMatchObject({ storageKey: ev.report.storageKey, pdfSha256: ev.report.pdfSha256 });
    const pkgs = await primaryPackages(ev.evidenceId);
    expect(pkgs.map((p) => [p.version, p.reportVersion])).toEqual([[1, 1], [2, 2]]);
    const v2Bytes = (await readObject(reports[1]!.storageBucket, reports[1]!.storageKey))!;
    const v2pkg = pkgs.at(-1)!;
    expect(v2pkg.reportSha256).toBe(sha256Hex(v2Bytes));
    const entries = readZipEntries((await readObject(v2pkg.storageBucket, v2pkg.storageKey))!);
    const pdfName = [...entries.keys()].find((k) => k.endsWith("proovra-verification-report-v2.pdf"));
    expect(pdfName && entries.get(pdfName)!.equals(v2Bytes)).toBe(true);

    clearStoredObjectProbeCache();
    const after = await statusOf(ev.evidenceId);
    expect(after.outputs.report).toMatchObject({ state: "READY", availability: "READY", version: 2 });
    expect(after.outputs.verificationPackage).toMatchObject({ state: "READY", version: 2 });
    expect((await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId })).assessment).toBe("COMPLETE");
    // Nothing left to recover; and the old missing version is still refused as gone.
    const third = await api("POST", `/v1/evidence/${ev.evidenceId}/reports/regenerate`, teamA.ownerToken, { intent: "RECOVER" });
    expect(third.json()).toMatchObject({ outcome: "NOTHING_TO_RECOVER" });
    expect((await api("GET", `/v1/evidence/${ev.evidenceId}/reports/1`, teamA.ownerToken)).statusCode).toBe(410);
    expect(await prisma.report.count({ where: { evidenceId: ev.evidenceId } })).toBe(2);
  }, 240_000);

  it("AUD-011 MISSING PACKAGE FILE: assessed as recoverable (not an integrity refusal), recovered as ONE new correctly paired version", async () => {
    const ev = await issuedPair();
    await removeEveryVersion(ev.pkg.storageBucket, ev.pkg.storageKey);
    const { clearStoredObjectProbeCache } = await import("../src/services/reports/output-recovery.service.js");
    clearStoredObjectProbeCache();
    const pre = await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
    expect(pre).toMatchObject({ assessment: "REPORT_REGENERATION_REQUIRED", reason: "PAIRED_PACKAGE_OBJECT_MISSING", pairedPackage: { version: 1, objectExists: false, object: "NOT_FOUND" } });
    const st = await statusOf(ev.evidenceId);
    expect(st.outputs.report).toMatchObject({ state: "READY", action: "NONE" });
    expect(st.outputs.verificationPackage).toMatchObject({ state: "ARTIFACT_MISSING", action: "RECOVER", operation: "NEW_VERSION" });
    expect(st.verificationPackage.available).toBe(false);
    const dl = await api("GET", `/v1/evidence/${ev.evidenceId}/verification-package`, harness.fixtures.teamA.ownerToken);
    expect([dl.statusCode, dl.json().code]).toEqual([410, "verification_package_artifact_missing"]);

    const res = await api("POST", `/v1/evidence/${ev.evidenceId}/reports/regenerate`, harness.fixtures.teamA.ownerToken, { intent: "RECOVER", output: "verificationPackage" });
    expect(res.statusCode, res.body).toBe(202);
    expect(await runJob(await jobFor(res.json().requestId), 0)).toBeNull();
    expect((await primaryPackages(ev.evidenceId)).map((p) => [p.version, p.reportVersion])).toEqual([[1, 1], [2, 2]]);
    clearStoredObjectProbeCache();
    expect((await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId })).assessment).toBe("COMPLETE");
  }, 240_000);

  it("AUD-011 TRANSIENT STORAGE (unreachable endpoint): 503 STORAGE_UNAVAILABLE, never 410, never 'missing'; status keeps the artifact available; nothing requested", async () => {
    const ev = await issuedPair();
    const unreachable = await s3ClientFor("http://127.0.0.1:1", { accessKeyId: "point7-local-minio", secretAccessKey: "point7-local-minio-secret" });
    await withApiStorageClient(unreachable, async () => {
      const dl = await api("GET", `/v1/evidence/${ev.evidenceId}/report/latest`, harness.fixtures.teamA.ownerToken);
      expect(dl.statusCode).toBe(503);
      expect(dl.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE", retryable: true });
      expect(dl.headers["retry-after"]).toBe("5");
      const pkg = await api("GET", `/v1/evidence/${ev.evidenceId}/verification-packages/1`, harness.fixtures.teamA.ownerToken);
      expect([pkg.statusCode, pkg.json().code]).toEqual([503, "STORAGE_UNAVAILABLE"]);
      const st = await statusOf(ev.evidenceId);
      expect(st.outputs.report).toMatchObject({ state: "READY", availability: "READY" });
      expect(st.outputs.verificationPackage).toMatchObject({ state: "READY" });
      const a = await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
      expect(a).toMatchObject({ assessment: "STORAGE_UNAVAILABLE", reason: "REPORT_OBJECT_STORAGE_TRANSIENT_RETRY_STATUS", latestReport: { finding: "UNAVAILABLE" } });
      const before = await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId } });
      const applied = await cli.recoverEvidenceOutputs({ evidenceId: ev.evidenceId, apply: true, regenerate: true });
      expect(applied.results[0]).toMatchObject({ assessment: "STORAGE_UNAVAILABLE", action: "retry_status_storage_unavailable" });
      expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: ev.evidenceId } })).toBe(before);
    });
    // The store answers again: the same record is plainly available.
    const ok = await api("GET", `/v1/evidence/${ev.evidenceId}/report/latest`, harness.fixtures.teamA.ownerToken);
    expect(ok.statusCode, ok.body).toBe(200);
  }, 240_000);

  it("AUD-011 PERMISSION FAILURE (wrong credentials against real MinIO): 503 STORAGE_ACCESS_FAILED alert, never 410, never an integrity refusal", async () => {
    const ev = await issuedPair();
    const wrong = await s3ClientFor(process.env.S3_ENDPOINT!, { accessKeyId: "not-a-real-key", secretAccessKey: "not-a-real-secret-0000" });
    await withApiStorageClient(wrong, async () => {
      const dl = await api("GET", `/v1/evidence/${ev.evidenceId}/report/latest`, harness.fixtures.teamA.ownerToken);
      expect(dl.statusCode).toBe(503);
      expect(dl.json()).toMatchObject({ code: "STORAGE_ACCESS_FAILED", retryable: false });
      const st = await statusOf(ev.evidenceId);
      expect(st.outputs.report).toMatchObject({ state: "READY", availability: "READY" });
      const a = await assessment.assessEvidenceOutputRecovery({ id: ev.evidenceId, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
      expect(a).toMatchObject({ assessment: "STORAGE_UNAVAILABLE", reason: "REPORT_OBJECT_STORAGE_ACCESS_DENIED", latestReport: { finding: "ACCESS_DENIED" } });
      expect(a.assessment).not.toBe("REFUSED_INTEGRITY_FAILURE");
    });
  }, 240_000);
});
