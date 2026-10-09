// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS TRUTH CLOSURE — report failure truth (live PostgreSQL + a real
 * MinIO object store + the worker's own failure bridge).
 *
 *   OPS-004  a report-failure condition stays OPEN while a newer attempt is
 *            FAILED_TERMINAL or PROCESSING with stage NULL (the shape every
 *            uncommitted attempt has); a versioned condition closes only when
 *            THAT version exists.
 *   OPS-028  a report row whose stored object is missing is not recovery.
 *   OPS-015  the worker's failure for a Personal record stored with team_id
 *            NULL lands in its owner's Personal Space, visible to the owner.
 *   OPS-016  raw error text (bucket names, ARNs) never becomes the condition's
 *            identity or its summary.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootOps,
  makeUser,
  personalSpace,
  seedEvidence,
  seedIncident,
  sweep,
  type Ctx,
} from "./operations-truth-fixtures.js";

describe("Operations truth closure — report failure truth (live PG16, MinIO, worker bridge)", () => {
  let c: Ctx;
  let s3: import("@aws-sdk/client-s3").S3Client;
  let Put: typeof import("@aws-sdk/client-s3").PutObjectCommand;
  const BUCKET = process.env.S3_BUCKET ?? "point7-local-bucket";

  beforeAll(async () => {
    c = await bootOps();
    const sdk = await import("@aws-sdk/client-s3");
    Put = sdk.PutObjectCommand;
    s3 = new sdk.S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
    });
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  /** A committed report row; `stored` decides whether its object exists. */
  async function report(evidenceId: string, version: number, stored: boolean) {
    const bytes = Buffer.from(`%PDF ops-truth ${evidenceId} v${version}`);
    const key = `ops-truth/${evidenceId}/report-v${version}-${randomUUID().slice(0, 6)}.pdf`;
    if (stored) await s3.send(new Put({ Bucket: BUCKET, Key: key, Body: bytes }));
    const row = await c.prisma.report.create({
      data: {
        evidenceId,
        version,
        storageBucket: BUCKET,
        storageKey: key,
        sizeBytes: BigInt(bytes.length),
        pdfSha256: createHash("sha256").update(bytes).digest("hex"),
        generatedAtUtc: new Date(),
      },
    });
    await c.prisma.evidence.update({ where: { id: evidenceId }, data: { latestReportVersion: version } });
    return { row, key, bytes };
  }
  async function request(teamId: string, evidenceId: string, state: string) {
    return c.prisma.reportGenerationRequest.create({
      data: { teamId, evidenceId, artifactType: "REPORT", state, stage: null, idempotencyKey: `ops-truth:${randomUUID()}` },
    });
  }
  const status = async (id: string) => (await c.prisma.operationalIncident.findUnique({ where: { id } }))?.status;

  it("OPS-004 a newer FAILED_TERMINAL or PROCESSING attempt (stage NULL) keeps a legacy report condition open", async () => {
    const a = c.h.fixtures.teamA;
    for (const state of ["FAILED_TERMINAL", "PROCESSING"]) {
      const ev = await seedEvidence(c, a.teamId, a.ownerUserId);
      await report(ev.id, 1, true);
      await new Promise((r) => setTimeout(r, 5));
      await request(a.teamId, ev.id, state);
      const cond = await seedIncident(c, a.teamId, {
        sourceId: "pipeline.report_generation_failed",
        category: "REPORT",
        fingerprint: `REPORT:${ev.id}:RENDER_FAILED`,
        relatedEvidenceId: ev.id,
      });
      await sweep(a.teamId);
      expect(await status(cond.id), state).toBe("OPEN");
    }
  });

  it("OPS-004 a versioned condition closes only when THAT version exists", async () => {
    const a = c.h.fixtures.teamA;
    const ev = await seedEvidence(c, a.teamId, a.ownerUserId);
    await report(ev.id, 1, true);
    const cond = await seedIncident(c, a.teamId, {
      sourceId: "pipeline.report_generation_failed",
      category: "REPORT",
      fingerprint: `REPORT:${ev.id}:v2:RENDER_FAILED`,
      relatedEvidenceId: ev.id,
    });
    await sweep(a.teamId);
    expect(await status(cond.id)).toBe("OPEN");
    await report(ev.id, 2, true);
    await sweep(a.teamId);
    expect(await status(cond.id)).toBe("RESOLVED");
  });

  it("OPS-028 a report row whose object is missing is not recovery; the stored object is", async () => {
    const a = c.h.fixtures.teamA;
    const ev = await seedEvidence(c, a.teamId, a.ownerUserId);
    const r = await report(ev.id, 1, false);
    const cond = await seedIncident(c, a.teamId, {
      sourceId: "pipeline.report_generation_failed",
      category: "REPORT",
      fingerprint: `REPORT:${ev.id}:v1:STORAGE_WRITE_FAILED`,
      relatedEvidenceId: ev.id,
    });
    await sweep(a.teamId);
    expect(await status(cond.id)).toBe("OPEN");
    await s3.send(new Put({ Bucket: BUCKET, Key: r.key, Body: r.bytes }));
    await sweep(a.teamId);
    expect(await status(cond.id)).toBe("RESOLVED");
  });

  it("OPS-015 / OPS-016 the worker bridge scopes a Personal record to its owner and never records raw error text", async () => {
    const u = await makeUser(c, "personal-report", { plan: "PRO" });
    const space = await personalSpace(c, u.id);
    const ev = await seedEvidence(c, null, u.id);
    const { recordReportFailureIncident } = await import("../../worker/src/processor.js");
    const leak = "arn:aws:s3:::tenant-secret-bucket/originals/abc.pdf";
    await recordReportFailureIncident({
      evidenceId: ev.id,
      jobId: "ops-truth-job",
      error: new Error(`S3 PutObject denied for ${leak}`),
      severity: "CRITICAL",
      retriable: false,
    });
    const row = await c.prisma.operationalIncident.findFirst({
      where: { relatedEvidenceId: ev.id, sourceId: "pipeline.report_generation_failed" },
    });
    expect(row).not.toBeNull();
    expect(row!.teamId).toBe(space);
    expect(row!.scope).toBe("WORKSPACE");
    expect(row!.fingerprint).toBe(`REPORT:${ev.id}:v1:UNCLASSIFIED`);
    const events = await c.prisma.operationalIncidentEvent.findMany({ where: { incidentId: row!.id } });
    for (const field of [row!.fingerprint, row!.title, row!.safeSummary, JSON.stringify(events)]) {
      expect(field).not.toContain("arn:aws");
      expect(field).not.toContain("tenant-secret-bucket");
    }
    // Visible to its owner, in their Personal Space.
    const list = await c.inj("GET", `/v1/ops/incidents/${row!.id}?teamId=${space}`, u.token);
    expect(list.statusCode).toBe(200);
    expect(list.json().incident.safeSummary).not.toContain("arn:aws");

    // A coded worker error keeps its closed class.
    const { createWorkerError } = await import("../../worker/src/processor.js");
    const ev2 = await seedEvidence(c, null, u.id);
    await recordReportFailureIncident({
      evidenceId: ev2.id,
      jobId: "ops-truth-job-2",
      error: createWorkerError("EVIDENCE_ORIGINAL_NOT_FOUND", false),
      severity: "CRITICAL",
      retriable: false,
    });
    const coded = await c.prisma.operationalIncident.findFirst({ where: { relatedEvidenceId: ev2.id } });
    expect(coded!.fingerprint).toBe(`REPORT:${ev2.id}:v1:EVIDENCE_ORIGINAL_NOT_FOUND`);
  });
});
