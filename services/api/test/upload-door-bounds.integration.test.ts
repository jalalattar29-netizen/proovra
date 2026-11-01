/**
 * INGEST-001, 002, 004, 005, OPS-021 — limits apply where the bytes arrive.
 * Live PostgreSQL 16, real MinIO: a signed URL really is refused by the store.
 *
 * A presigned URL signed no size, part URLs could be replayed with other bytes,
 * every PUT carried an eight-year lock before any seal, the only real ceiling
 * fired after the full transfer, and a bridge failure was reported as success.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const b64 = (b: Buffer) => createHash("sha256").update(b).digest("base64");
const MiB = 1024 * 1024;

describe("the upload door (live PostgreSQL 16, MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const A = () => h.fixtures.teamA;
  const auth = () => ({ authorization: `Bearer ${A().ownerToken}` });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  beforeEach(() => {
    delete process.env.MAX_EVIDENCE_SIZE_MB;
    delete process.env.MAX_UPLOAD_FILE_SIZE_BYTES;
  });
  afterAll(async () => {
    delete process.env.MAX_EVIDENCE_SIZE_MB;
    await h?.cleanup();
  });

  async function record(): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: { title: "door", type: "DOCUMENT", status: "CREATED", teamId: A().teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId } as never,
      select: { id: true },
    });
    return row.id;
  }
  const part = (id: string, payload: Record<string, unknown>) =>
    h.app.inject({ method: "POST", url: `/v1/evidence/${id}/parts`, headers: auth(), payload: { partIndex: 0, mimeType: "text/plain", ...payload } as never });
  const put = (url: string, body: Buffer, headers: Record<string, string> = {}) =>
    fetch(url, { method: "PUT", body: new Uint8Array(body), headers: { "content-type": "text/plain", ...headers } });

  it("OPS-021: one effective limit, and the status page states it", async () => {
    const { getUploadSizeLimits } = await import("../src/services/reliability/upload-limits.service.js");
    process.env.MAX_UPLOAD_FILE_SIZE_BYTES = String(50 * 1024 * MiB);
    process.env.MAX_EVIDENCE_SIZE_MB = "1024";
    expect(getUploadSizeLimits().maxUploadFileSizeBytes, "a larger setting cannot promise what the seal refuses").toBe(1024 * MiB);
    process.env.MAX_UPLOAD_FILE_SIZE_BYTES = String(10 * MiB);
    expect(getUploadSizeLimits().maxUploadFileSizeBytes, "a lower setting is honoured").toBe(10 * MiB);
  });

  it("INGEST-002: a declared size over the limit is refused before a byte moves, at one below, exact and one above", async () => {
    process.env.MAX_EVIDENCE_SIZE_MB = "1";
    const id = await record();
    const body = { checksumSha256Base64: b64(Buffer.from("x")) };
    expect((await part(id, { ...body, sizeBytes: MiB + 1 })).statusCode).toBe(413);
    const over = await part(id, { ...body, sizeBytes: MiB + 1 });
    expect(over.json().code).toBe("EVIDENCE_TOO_LARGE");
    expect(await prisma.evidencePart.count({ where: { evidenceId: id } })).toBe(0);
    expect((await part(id, { ...body, sizeBytes: MiB })).statusCode).toBe(201);
    const other = await record();
    expect((await part(other, { ...body, sizeBytes: MiB - 1 })).statusCode).toBe(201);
  });

  it("INGEST-001: the store itself refuses another length and other bytes; the declared file is accepted", async () => {
    const id = await record();
    const bytes = randomBytes(2048);
    const res = await part(id, { checksumSha256Base64: b64(bytes), sizeBytes: bytes.length });
    expect(res.statusCode, res.body).toBe(201);
    const url = res.json().upload.putUrl as string;
    const checksum = { "x-amz-checksum-sha256": b64(bytes) };

    const longer = await put(url, Buffer.concat([bytes, Buffer.from("more")]), checksum);
    expect(longer.ok, "a longer body").toBe(false);
    const tampered = Buffer.from(bytes);
    tampered[0] = tampered[0]! ^ 0xff;
    const other = await put(url, tampered, checksum);
    expect(other.ok, "other bytes of the same length").toBe(false);
    const good = await put(url, bytes, checksum);
    expect(good.ok, await good.text()).toBe(true);
  });

  it("INGEST-001: an in-flight object carries no lock, so an abandoned upload can be removed", async () => {
    const { presignPutObject } = await import("../src/storage.js");
    process.env.S3_OBJECT_LOCK_ENABLED = "true";
    process.env.S3_OBJECT_LOCK_MODE = "COMPLIANCE";
    try {
      const url = await presignPutObject({ bucket: process.env.S3_BUCKET!, key: `door/${randomUUID()}`, contentType: "text/plain" });
      expect(url).not.toMatch(/object-lock/i);
    } finally {
      delete process.env.S3_OBJECT_LOCK_ENABLED;
      delete process.env.S3_OBJECT_LOCK_MODE;
    }
  });

  it("INGEST-004: the record bound holds on the writer itself, for every door", async () => {
    const { writeEvidencePart } = await import("../src/services/evidence/evidence-part-writer.service.js");
    const id = await record();
    const write = (partIndex: number, maxPartCount?: number) =>
      writeEvidencePart({
        evidenceId: id,
        principal: { kind: "OWNER", userId: A().ownerUserId },
        partIndex,
        onExistingIndex: "REFUSE",
        maxPartCount,
        data: { storageBucket: "b", storageKey: `k/${partIndex}`, mimeType: "text/plain" } as never,
      } as never);
    await expect(write(200)).rejects.toMatchObject({ code: "PART_COUNT_EXCEEDED" });
    await expect(write(199)).resolves.toMatchObject({ created: true });
    await expect(write(198, 1)).rejects.toMatchObject({ code: "PART_COUNT_EXCEEDED" });
  });
});
