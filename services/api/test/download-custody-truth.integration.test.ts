/**
 * EVID-006 and EVID-008 — the custody chain states what happened. Live
 * PostgreSQL 16, real MinIO objects, real HTTP.
 *
 * A report, package or original is served by a presigned URL, so the API sees a
 * link issued and never the bytes move. Those moments were written as
 * *_DOWNLOADED, opening the Library wrote them for a record nobody touched, and
 * the case export wrote REPORT_DOWNLOADED before a byte left and then hung.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { readZipEntries } from "./helpers/read-zip.js";

const MiB = 1024 * 1024;

describe("download custody truth (live PostgreSQL 16, MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let s3: (typeof import("../src/storage.js"))["s3"];
  const A = () => h.fixtures.teamA;
  const bucket = () => process.env.S3_BUCKET as string;
  const bearer = () => ({ authorization: `Bearer ${A().ownerToken}` });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ s3 } = await import("../src/storage.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function recordWithReport(size: number) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: "custody truth",
        type: "DOCUMENT",
        status: "REPORTED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        signedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    const key = `reports/${row.id}/v1.pdf`;
    await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: randomBytes(size) }));
    await prisma.report.create({
      data: { evidenceId: row.id, version: 1, storageBucket: bucket(), storageKey: key, generatedAtUtc: new Date(), sizeBytes: BigInt(size) },
    });
    return { id: row.id, key };
  }
  async function caseWith(...ids: string[]) {
    const c = await prisma.case.create({
      data: { name: `Export ${randomUUID().slice(0, 6)}`, teamId: A().teamId, ownerUserId: A().ownerUserId },
      select: { id: true },
    });
    for (const evidenceId of ids) await prisma.caseEvidenceLink.create({ data: { caseId: c.id, evidenceId } as never });
    return c.id;
  }
  const count = (evidenceId: string, eventType: string) =>
    prisma.custodyEvent.count({ where: { evidenceId, eventType: eventType as never } });

  it("a case export of 5 MiB of reports completes, and custody follows delivery", async () => {
    const a = await recordWithReport(3 * MiB);
    const b = await recordWithReport(3 * MiB);
    const caseId = await caseWith(a.id, b.id);
    const res = await h.app.inject({ method: "GET", url: `/v1/cases/${caseId}/export`, headers: bearer() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.rawPayload.length).toBeGreaterThan(5 * MiB);
    await vi.waitFor(async () => {
      expect(await count(a.id, "REPORT_DOWNLOADED")).toBe(1);
      expect(await count(b.id, "REPORT_DOWNLOADED")).toBe(1);
    });
  }, 60_000);

  it("a report whose object is gone is withheld by name, and only delivered reports are recorded", async () => {
    const good = await recordWithReport(1024);
    const gone = await recordWithReport(1024);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: gone.key }));
    const caseId = await caseWith(good.id, gone.id);
    const res = await h.app.inject({ method: "GET", url: `/v1/cases/${caseId}/export`, headers: bearer() });
    expect(res.statusCode).toBe(200);
    expect(readZipEntries(res.rawPayload).get("manifest.json")!.toString("utf8")).toContain("report_artifact_missing");
    await vi.waitFor(async () => expect(await count(good.id, "REPORT_DOWNLOADED")).toBe(1));
    expect(await count(gone.id, "REPORT_DOWNLOADED")).toBe(0);
  }, 60_000);

  it("issuing a report URL records a link, never a download", async () => {
    const { id } = await recordWithReport(2048);
    const res = await h.app.inject({ method: "GET", url: `/v1/evidence/${id}/report/latest`, headers: bearer() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().url).toContain("reports/");
    expect(await count(id, "REPORT_DOWNLOADED")).toBe(0);
    const rows = await prisma.custodyEvent.findMany({ where: { evidenceId: id, eventType: "DOWNLOAD_AUTHORIZED" as never } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ artifact: "report", reportVersion: 1, accessMode: "authenticated_download_url_issued" });
  });

  it("the status read behind the Library inspector leaves the chain untouched", async () => {
    const { id } = await recordWithReport(2048);
    const before = await prisma.custodyEvent.count({ where: { evidenceId: id } });
    const res = await h.app.inject({ method: "GET", url: `/v1/evidence/${id}/artifacts/status`, headers: bearer() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().report).toMatchObject({ available: true, version: 1 });
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id } })).toBe(before);
  });
});
