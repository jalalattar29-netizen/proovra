/**
 * INGEST-003, 007, 008, 011 and CRYPTO-009 — what a seal does, and what happens
 * when part of it fails. Live PostgreSQL 16, real MinIO objects.
 */
import { randomBytes } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("sealing and its recovery (live PostgreSQL 16, MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let s3: (typeof import("../src/storage.js"))["s3"];
  const A = () => h.fixtures.teamA;
  const bucket = () => process.env.S3_BUCKET as string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ s3 } = await import("../src/storage.js"));
  }, 180_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await h?.cleanup();
  });

  async function record(files: Array<{ body: Buffer; mime: string }>, over: Record<string, unknown> = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { title: "seal", type: "DOCUMENT", status: "UPLOADING", teamId: A().teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId, mimeType: files[0]!.mime, ...over } as never,
      select: { id: true },
    });
    for (const [partIndex, f] of files.entries()) {
      const key = `evidence/${ev.id}/parts/${partIndex}`;
      await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: f.body, ContentType: f.mime }));
      await prisma.evidencePart.create({
        data: { evidenceId: ev.id, partIndex, storageBucket: bucket(), storageKey: key, mimeType: f.mime, originalFileName: `f${partIndex}.bin` } as never,
      });
    }
    return ev.id;
  }
  const complete = (id: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/complete`,
      headers: { authorization: `Bearer ${A().ownerToken}`, "content-type": "application/json" },
      payload: {} as never,
    });

  it("INGEST-007: a file whose bytes differ from its declared type seals, and the chain says so", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
    const id = await record([{ body: png, mime: "application/pdf" }]);
    const res = await complete(id);
    expect(res.statusCode, res.body).toBeLessThan(300);
    await vi.waitFor(async () => {
      const row = await prisma.custodyEvent.findFirst({
        where: { evidenceId: id, eventType: "TECHNICAL_VERIFICATION_CHECKED", payload: { path: ["source"], equals: "DECLARED_TYPE_CHECK" } },
        select: { payload: true },
      });
      expect(row?.payload).toMatchObject({ outcome: "BYTES_DIFFER_FROM_DECLARED_TYPE", files: [{ partIndex: 0, declaredMime: "application/pdf" }] });
    });
  });

  it("INGEST-007: an executable declared as an image is on the chain, with what was found", async () => {
    const pe = Buffer.concat([Buffer.from("MZ"), randomBytes(62)]);
    const id = await record([{ body: pe, mime: "image/png" }]);
    const res = await complete(id);
    expect(res.statusCode, res.body).toBeLessThan(300);
    await vi.waitFor(async () => {
      const row = await prisma.custodyEvent.findFirst({
        where: { evidenceId: id, eventType: "TECHNICAL_VERIFICATION_CHECKED", payload: { path: ["source"], equals: "DECLARED_TYPE_CHECK" } },
        select: { payload: true },
      });
      expect(row?.payload).toMatchObject({
        outcome: "BYTES_DIFFER_FROM_DECLARED_TYPE",
        files: [{ partIndex: 0, declaredMime: "image/png", reason: "executable_or_dangerous_type", executableBytes: true }],
      });
    });
  });

  it("positive control: a file that is what it declares leaves no such row", async () => {
    const id = await record([{ body: Buffer.from("plain words"), mime: "text/plain" }]);
    expect((await complete(id)).statusCode).toBeLessThan(300);
    expect(
      await prisma.custodyEvent.count({ where: { evidenceId: id, payload: { path: ["source"], equals: "DECLARED_TYPE_CHECK" } } }),
    ).toBe(0);
  });

  it("CRYPTO-009: a workspace over its storage is refused before any signer or timestamp is spent", async () => {
    const billing = await import("../src/services/billing-enforcement.service.js");
    const signing = await import("../src/signing/signer.js");
    const refused = Object.assign(new Error("STORAGE_LIMIT_REACHED"), { statusCode: 402 });
    vi.spyOn(billing, "assertWorkspaceAllowsStorageGrowth").mockRejectedValue(refused);
    const signFingerprintHex = vi.fn(async () => {
      throw new Error("a signer was spent");
    });
    vi.spyOn(signing, "getEvidenceSigner").mockReturnValue({ signFingerprintHex } as never);
    const id = await record([{ body: Buffer.from("over quota"), mime: "text/plain" }]);
    const res = await complete(id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).not.toBe("SIGNED");
    expect(signFingerprintHex).not.toHaveBeenCalled();
  });
});
