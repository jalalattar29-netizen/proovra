/**
 * THE RETENTION CONTRACT THROUGH THE REAL PIPELINE (owner decision 2026-10-15)
 * — S3 Object Lock COMPLIANCE, 2920 days, executed.
 *
 * WHAT IS REAL: PostgreSQL 16; a MinIO bucket created WITH Object Lock;
 * finalization over HTTP; the REAL worker report processor (reports AND
 * verification packages), driven by the canonical request authority for every
 * way a later artifact is born: a routine regeneration, an OTS-triggered
 * updated report, and a package recovery. Production's settings are used
 * verbatim: S3_OBJECT_LOCK_MODE=COMPLIANCE, S3_OBJECT_LOCK_RETAIN_DAYS=2920.
 * WHAT IS DOUBLED: the PDF renderer (its bytes are not the subject), the
 * rendered-report assertion, and the RFC 3161 authority.
 *
 * Proven: the seal is COMPLIANCE for 2920 days; a finalization retry does not
 * move it; every later report and package is locked TO the record's horizon in
 * COMPLIANCE (no ratchet, whatever triggered it); an authorized contractual
 * extension moves the horizon explicitly; a record whose horizon has ended
 * refuses a new artifact instead of inventing one.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const LOCK_BUCKET = process.env.P7_LOCK_BUCKET ?? "point7-lock-bucket";
const setLockEnv = () => {
  process.env.S3_BUCKET = LOCK_BUCKET;
  process.env.S3_OBJECT_LOCK_ENABLED = "true";
  process.env.S3_OBJECT_LOCK_MODE = "COMPLIANCE";
  process.env.S3_OBJECT_LOCK_RETAIN_DAYS = "2920";
};
setLockEnv();

vi.mock("../../worker/src/report-v2/build-report-pdf.js", () => {
  const render = () => Buffer.from(`%PDF-1.7 compliance-retention fixture ${randomUUID()}\n`);
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
vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const DAY = 24 * 60 * 60 * 1000;

describe("COMPLIANCE 2920-day retention through the real report/package pipeline (Postgres + Redis + MinIO Object Lock)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let processor: typeof import("../../worker/src/processor.js");
  let reportQueue: import("bullmq").Queue;
  let clearRates: () => Promise<unknown>;
  let s3: S3Client;
  let id = "";
  let seal: Date;

  beforeAll(async () => {
    setLockEnv();
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import("../../worker/src/processor.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    const { Queue } = await import("bullmq");
    const { default: IORedis } = await import("ioredis");
    reportQueue = new Queue("report", { connection: new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }) });
    await reportQueue.obliterate({ force: true });
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
    });
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
  }, 600_000);

  beforeEach(async () => {
    setLockEnv();
    await clearRates();
  });

  afterAll(async () => {
    await reportQueue?.obliterate({ force: true }).catch(() => undefined);
    await reportQueue?.close();
    await h?.cleanup();
  }, 120_000);

  const A = () => h.fixtures.teamA;
  const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const head = (key: string, versionId?: string | null) =>
    s3.send(new HeadObjectCommand({ Bucket: LOCK_BUCKET, Key: key, ...(versionId ? { VersionId: versionId } : {}) }));

  async function runReportJobs(evidenceId: string): Promise<void> {
    for (let i = 0; i < 8; i++) {
      const requests = await prisma.reportGenerationRequest.findMany({
        where: { evidenceId, state: { in: ["QUEUED", "FAILED_RETRYABLE"] } },
        select: { id: true },
      });
      if (requests.length === 0) return;
      for (const r of requests) {
        const job = await reportQueue.getJob(`report-${r.id}`);
        if (!job) continue;
        (job as { attemptsMade: number }).attemptsMade = 0;
        await processor.processGenerateReport(job as never);
      }
    }
  }

  /** Every report and package object of the record, as STORAGE reports them. */
  async function artifactLocks(evidenceId: string) {
    const [reports, packages] = await Promise.all([
      prisma.report.findMany({ where: { evidenceId }, orderBy: { version: "asc" }, select: { version: true, storageKey: true } }),
      prisma.verificationPackage.findMany({ where: { evidenceId }, orderBy: { version: "asc" }, select: { version: true, storageKey: true } }),
    ]);
    const read = async (kind: string, rows: Array<{ version: number; storageKey: string | null }>) =>
      Promise.all(
        rows.filter((r) => r.storageKey).map(async (r) => {
          const hd = await head(r.storageKey!);
          return { kind, version: r.version, mode: hd.ObjectLockMode, until: hd.ObjectLockRetainUntilDate?.toISOString() };
        }),
      );
    return [...(await read("report", reports)), ...(await read("package", packages))];
  }

  async function regenerate(purpose: string) {
    const writer = await import("../src/services/reports/report-generation-authority.service.js");
    const made = (await writer.requestReportGeneration({
      evidenceId: id,
      purpose,
      artifactType: "REPORT",
      forceRegenerate: true,
      requestedByMachineId: `compliance-retention-${purpose}`,
    } as never)) as { requestId?: string };
    expect(made.requestId, purpose).toBeTruthy();
    await runReportJobs(id);
  }

  it("SEAL: finalization locks the original COMPLIANCE for 2920 days (UTC day count); a finalization retry does not move it", async () => {
    const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "DOCUMENT", mimeType: "text/plain", teamId: A().teamId });
    expect(created.statusCode, created.body).toBe(201);
    id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, A().ownerToken, { partIndex: 0, mimeType: "text/plain", originalFileName: "compliance.txt" });
    expect(part.statusCode, part.body).toBe(201);
    const put = await fetch(part.json().upload.putUrl as string, {
      method: "PUT",
      body: Buffer.from(`compliance-retention ${id} ${randomBytes(8).toString("hex")}`),
      headers: { "content-type": "text/plain" },
    });
    expect(put.status).toBe(200);
    const before = Date.now();
    const done = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(done.statusCode, done.body).toBe(200);

    const p = await prisma.evidencePart.findFirstOrThrow({ where: { evidenceId: id }, select: { storageKey: true, storageVersionId: true } });
    const sealed = await head(p.storageKey, p.storageVersionId);
    expect(sealed.ObjectLockMode).toBe("COMPLIANCE");
    seal = sealed.ObjectLockRetainUntilDate!;
    expect(seal.getTime()).toBeGreaterThanOrEqual(before + 2920 * DAY - 1000);
    expect(seal.getTime()).toBeLessThan(Date.now() + 2920 * DAY + 1000);
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { storageObjectLockMode: true, storageObjectLockRetainUntilUtc: true } });
    expect(row.storageObjectLockMode).toBe("COMPLIANCE");

    // Retry: same seal, to the millisecond, in storage and in the row.
    const retry = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(retry.statusCode, retry.body).toBe(200);
    expect((await head(p.storageKey, p.storageVersionId)).ObjectLockRetainUntilDate?.toISOString()).toBe(seal.toISOString());
    const after = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { storageObjectLockRetainUntilUtc: true } });
    expect(after.storageObjectLockRetainUntilUtc?.toISOString()).toBe(row.storageObjectLockRetainUntilUtc?.toISOString());
  }, 300_000);

  it("NO RATCHET: report v1 + package, a routine regeneration and an OTS-triggered updated report are all locked TO the seal, COMPLIANCE", async () => {
    await runReportJobs(id);
    await regenerate("operator_regenerate");
    await regenerate("ots_upgrade_completed");
    const locks = await artifactLocks(id);
    expect(locks.filter((l) => l.kind === "report").length).toBeGreaterThanOrEqual(3);
    expect(locks.filter((l) => l.kind === "package").length).toBeGreaterThanOrEqual(1);
    for (const l of locks) {
      expect(l, `${l.kind} v${l.version}`).toMatchObject({ mode: "COMPLIANCE", until: seal.toISOString() });
    }
  }, 600_000);

  it("PACKAGE RECOVERY is locked TO the seal as well — recovery never adds 2920 days", async () => {
    const latest = await prisma.report.findFirstOrThrow({ where: { evidenceId: id }, orderBy: { version: "desc" }, select: { version: true } });
    // The latest report's package is lost (its row, not its locked object).
    await prisma.verificationPackage.deleteMany({ where: { evidenceId: id, version: latest.version } });
    const { requestOutputRecovery } = await import("../src/services/reports/output-recovery.service.js");
    const res = (await requestOutputRecovery({
      evidenceId: id,
      actorUserId: A().ownerUserId,
      purpose: "package_recovery",
      regenerateReason: "compliance-retention package recovery",
      targetOutput: "verificationPackage",
      packageForReportVersion: latest.version,
    } as never)) as { ok?: boolean; requestId?: string };
    expect(res).toBeTruthy();
    await runReportJobs(id);
    const recovered = await prisma.verificationPackage.findFirstOrThrow({ where: { evidenceId: id, version: latest.version }, select: { storageKey: true } });
    const hd = await head(recovered.storageKey!);
    expect(hd.ObjectLockMode).toBe("COMPLIANCE");
    expect(hd.ObjectLockRetainUntilDate?.toISOString()).toBe(seal.toISOString());
  }, 600_000);

  it("an AUTHORIZED contractual extension moves the horizon explicitly: the next artifact carries it; nothing earlier is shortened", async () => {
    const extended = new Date(seal.getTime() + 400 * DAY);
    await prisma.evidence.update({ where: { id }, data: { retentionUntilUtc: extended } });
    await regenerate("operator_regenerate");
    const locks = await artifactLocks(id);
    const newest = locks.filter((l) => l.kind === "report").at(-1)!;
    expect(newest).toMatchObject({ mode: "COMPLIANCE", until: extended.toISOString() });
    for (const l of locks.filter((x) => x !== newest && x.kind === "report")) expect(l.until).toBe(seal.toISOString());
  }, 600_000);

  it("a record whose horizon has ENDED refuses a new artifact — never an invented horizon", async () => {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        type: "DOCUMENT",
        status: "REPORTED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        signedAtUtc: new Date(Date.now() - 2921 * DAY),
        createdAt: new Date(Date.now() - 2921 * DAY),
        storageObjectLockMode: "COMPLIANCE",
        storageObjectLockRetainUntilUtc: new Date(Date.now() - DAY),
      } as never,
      select: { id: true },
    });
    const { artifactLockFor } = await import("../../worker/src/object-retention.js");
    await expect(artifactLockFor(ev.id)).rejects.toMatchObject({ code: "RETENTION_HORIZON_ENDED" });
    // ...and a configuration without a mode refuses an artifact too (no default mode).
    delete process.env.S3_OBJECT_LOCK_MODE;
    await expect(artifactLockFor(id)).rejects.toMatchObject({ code: "OBJECT_LOCK_CONFIGURATION_INCOMPLETE" });
    setLockEnv();
  }, 120_000);
});
