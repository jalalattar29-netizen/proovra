/**
 * RUNTIME PROBE RT-UPL — audit-only. Disposable loopback PostgreSQL 16 + a
 * disposable loopback MinIO (P7_HOST_S3_PORT), real Fastify inject, real S3
 * multipart through the presigned URL the API issues.
 *
 * UPL-01 (= STATEMACHINE-01 = SEC-08): a same-team MEMBER (evidence.create) who
 * does not own a SIGNED record can append an EvidencePart to it through the
 * resumable upload-session bridge. The consequence for the next report run is
 * computed with the worker's own composite rule (processor.ts:2367):
 *   fileSha256 = hashes.length === 1 ? hashes[0] : sha256(hashes.join("|"))
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../../../../../../../services/api/test/integration-harness.js";

const RESULTS = path.resolve(__dirname, "..", "..", "results");
const record = (name: string, data: unknown) => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
};
const API = "../../../../../../../services/api";
const apiRequire = createRequire(path.resolve(__dirname, API, "package.json"));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("RT-UPL (audit probe)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../../../../../../services/api/src/db.js"))["prisma"];

  beforeAll(async () => {
    const endpoint = process.env.S3_ENDPOINT ?? "";
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error(`S3_ENDPOINT must be loopback, got ${endpoint}`);
    const { S3Client, CreateBucketCommand, HeadBucketCommand } = apiRequire("@aws-sdk/client-s3");
    const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! } });
    try { await s3.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET })); } catch { await s3.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET })); }
    const { bootIntegrationHarness } = await import(`${API}/test/integration-harness.js`);
    h = await bootIntegrationHarness();
    ({ prisma } = await import(`${API}/src/db.js`));
  }, 300_000);
  afterAll(async () => { await h?.cleanup(); });

  it("UPL-01: a non-owner member appends a part to a SIGNED record", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const original = Buffer.from(`original bytes ${randomUUID()}`);
    const originalSha = sha(original);
    const ev = await prisma.evidence.create({
      data: { title: "ET sealed record", type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId, fileSha256: originalSha, signedAtUtc: new Date(), lockedAt: null } as never,
      select: { id: true },
    });
    await prisma.evidencePart.create({
      data: { evidenceId: ev.id, partIndex: 0, storageBucket: process.env.S3_BUCKET!, storageKey: `evidence/${ev.id}/parts/000-original.png`, mimeType: "image/png", sizeBytes: BigInt(original.length), sha256: originalSha, uploadedAtUtc: new Date() } as never,
    });
    const partsBefore = await prisma.evidencePart.count({ where: { evidenceId: ev.id } });

    const auth = { authorization: `Bearer ${A.memberToken}` };
    const steps: Record<string, unknown> = {};
    const create = await h.app.inject({ method: "POST", url: "/v1/uploads/sessions", headers: auth, payload: { teamId: A.teamId, evidenceId: ev.id, expectedPartCount: 1, targetPartIndex: 9999, originalFileName: "injected.png", expectedMimeType: "image/png" } });
    steps.createSession = create.statusCode;
    const sessionId = create.json()?.session?.id ?? create.json()?.id ?? create.json()?.sessionId;
    const init = await h.app.inject({ method: "POST", url: `/v1/uploads/sessions/${sessionId}/multipart/initiate`, headers: auth, payload: { teamId: A.teamId, contentType: "image/png" } });
    steps.initiate = init.statusCode;
    let presign = await h.app.inject({ method: "POST", url: `/v1/uploads/sessions/${sessionId}/parts/1/presign`, headers: auth, payload: { teamId: A.teamId } });
    let partIndex = 1;
    if (presign.statusCode !== 200) {
      partIndex = 0;
      presign = await h.app.inject({ method: "POST", url: `/v1/uploads/sessions/${sessionId}/parts/0/presign`, headers: auth, payload: { teamId: A.teamId } });
    }
    steps.presign = presign.statusCode;
    const injected = Buffer.from(`attacker bytes ${randomUUID()}`);
    const put = await fetch(presign.json().uploadUrl, { method: "PUT", body: injected });
    steps.put = put.status;
    const etag = put.headers.get("etag") ?? "";
    const uploaded = await h.app.inject({ method: "POST", url: `/v1/uploads/sessions/${sessionId}/parts/${partIndex}/uploaded`, headers: auth, payload: { teamId: A.teamId, partEtag: etag.replace(/"/g, ""), partSizeBytes: injected.length } });
    steps.markUploaded = uploaded.statusCode;
    const complete = await h.app.inject({ method: "POST", url: `/v1/uploads/sessions/${sessionId}/multipart/complete`, headers: auth, payload: { teamId: A.teamId, verifyHash: true } });
    steps.multipartComplete = complete.statusCode;

    const partsAfter = await prisma.evidencePart.findMany({ where: { evidenceId: ev.id }, orderBy: { partIndex: "asc" }, select: { partIndex: true, sha256: true, uploadedAtUtc: true, originalFileName: true } });
    const status = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { status: true, fileSha256: true } });
    const hashes = partsAfter.map((p) => p.sha256 ?? "");
    const workerComposite = hashes.length === 1 ? hashes[0] : sha(hashes.join("|"));
    const out = {
      probe: "RT-UPL/UPL-01",
      actor: "teamA MEMBER (not the evidence owner)",
      evidenceStatus: status.status,
      steps,
      responses: { create: create.body.slice(0, 200), complete: complete.body.slice(0, 200) },
      partsBefore,
      partsAfter: partsAfter.map((p) => ({ partIndex: p.partIndex, originalFileName: p.originalFileName, uploadedAtUtcNull: p.uploadedAtUtc === null, sha256: p.sha256 })),
      injectedBytesSha256: sha(injected),
      workerCompositeAfterInjection: workerComposite,
      storedFileSha256: status.fileSha256,
      nextReportRunWouldRejectIntegrity: workerComposite !== status.fileSha256,
    };
    record("rt-upl-01", out);
    expect(partsBefore).toBe(1);
  });
});
