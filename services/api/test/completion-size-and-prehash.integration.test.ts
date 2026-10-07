/**
 * ET-ACQ-04 — completion refuses an oversize upload before reading a byte, and
 * hashes outside the interactive transaction without ever sealing a digest
 * of bytes other than the version it records. Live PostgreSQL 16; the object
 * store is an in-memory VERSIONED double at the storage module boundary (the
 * pattern of intake-part-retry.integration.test.ts) that counts every GET.
 *
 * On a40ca76f every part was downloaded and hashed (inside the 120 s
 * transaction) before the total was compared with MAX_EVIDENCE_SIZE, so an
 * oversize upload was read in full to be refused.
 */
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Obj = { version: number; bytes: Map<string, Buffer> };
const store = vi.hoisted(() => ({
  objects: new Map<string, Obj>(),
  gets: [] as string[],
  /** Called after every GET: lets a test replace an object between reads. */
  afterGet: null as null | ((id: string) => void),
}));

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    headObject: async (p: { bucket: string; key: string }) => {
      const o = store.objects.get(id(p));
      if (!o) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      const v = `v${o.version}`;
      return {
        sizeBytes: o.bytes.get(v)!.length,
        versionId: v,
        contentType: "image/jpeg",
        etag: `"${v}"`,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string; versionId?: string | null }) => {
      const o = store.objects.get(id(p));
      if (!o) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      const v = p.versionId ?? `v${o.version}`;
      store.gets.push(`${id(p)}@${v}`);
      const b = o.bytes.get(v)!;
      store.afterGet?.(id(p));
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
  };
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("completion size gate and pre-hash (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let completeEvidence: (typeof import("../src/services/evidence-complete.service.js"))["completeEvidence"];
  const created: string[] = [];
  const maxBefore = process.env.MAX_EVIDENCE_SIZE_MB;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ completeEvidence } = await import("../src/services/evidence-complete.service.js"));
  }, 180_000);

  afterEach(() => {
    store.gets.length = 0;
    store.afterGet = null;
    if (maxBefore === undefined) delete process.env.MAX_EVIDENCE_SIZE_MB;
    else process.env.MAX_EVIDENCE_SIZE_MB = maxBefore;
  });

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await h?.cleanup();
  });

  /** A record with `sizes.length` uploaded parts of the given sizes. */
  async function uploaded(sizes: number[]): Promise<{ id: string; ownerUserId: string; keys: string[] }> {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: {
        title: "Size gate fixture",
        type: "PHOTO",
        status: "CREATED",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
      } as never,
      select: { id: true },
    });
    created.push(id);
    const keys: string[] = [];
    for (const [i, size] of sizes.entries()) {
      const key = `evidence/${id}/parts/${i}-${randomUUID()}`;
      keys.push(`evidence-test/${key}`);
      store.objects.set(`evidence-test/${key}`, { version: 1, bytes: new Map([["v1", Buffer.alloc(size, 65 + i)]]) });
      await prisma.evidencePart.create({
        data: { evidenceId: id, partIndex: i, storageBucket: "evidence-test", storageKey: key, mimeType: "image/jpeg" } as never,
      });
    }
    return { id, ownerUserId: A.ownerUserId, keys };
  }

  it("an oversize multipart upload is refused 413 without a single GET, and nothing is sealed", async () => {
    process.env.MAX_EVIDENCE_SIZE_MB = "1";
    const ev = await uploaded([600 * 1024, 600 * 1024]);

    await expect(completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId })).rejects.toMatchObject({
      message: "EVIDENCE_TOO_LARGE",
      statusCode: 413,
    });
    expect(store.gets).toEqual([]);
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { status: true, fileSha256: true } });
    expect(row).toEqual({ status: "CREATED", fileSha256: null });
  });

  it("an upload within the limit completes, each part read exactly once (hashed before the transaction)", async () => {
    const ev = await uploaded([4096, 8192]);

    const result = await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(result.status).toBe("SIGNED");
    expect(store.gets.sort()).toEqual(ev.keys.map((k) => `${k}@v1`).sort());
    const parts = await prisma.evidencePart.findMany({ where: { evidenceId: ev.id }, orderBy: { partIndex: "asc" }, select: { sha256: true, storageVersionId: true } });
    expect(parts).toEqual([
      { sha256: sha(Buffer.alloc(4096, 65)), storageVersionId: "v1" },
      { sha256: sha(Buffer.alloc(8192, 66)), storageVersionId: "v1" },
    ]);
    // UC-TRUST-003 — the sealed record is bound to the REGISTERED key it was
    // self-verified with (SPKI SHA-256).
    const sealed = await prisma.evidence.findUniqueOrThrow({
      where: { id: ev.id },
      select: { signingKeyId: true, signingKeyVersion: true, signingKeySha256: true },
    });
    const key = await prisma.signingKey.findUniqueOrThrow({
      where: { keyId_version_purpose: { keyId: sealed.signingKeyId!, version: sealed.signingKeyVersion!, purpose: "EVIDENCE_SIGNATURE" } },
    });
    const { publicKeySpkiSha256 } = await import("../src/signing/key-registry.js");
    expect(sealed.signingKeySha256).toBe(publicKeySpkiSha256(key.publicKeyPem));
  });

  it("a part replaced after it was pre-hashed is re-read at the version the transaction records", async () => {
    const ev = await uploaded([1024]);
    const replaced = Buffer.alloc(2048, 90);
    store.afterGet = (objectId) => {
      // The first (pre-transaction) read is followed by a new upload.
      const o = store.objects.get(objectId)!;
      if (o.version === 1) {
        o.version = 2;
        o.bytes.set("v2", replaced);
      }
    };

    await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(store.gets).toEqual([`${ev.keys[0]}@v1`, `${ev.keys[0]}@v2`]);
    const part = await prisma.evidencePart.findFirstOrThrow({ where: { evidenceId: ev.id }, select: { sha256: true, storageVersionId: true } });
    expect(part).toEqual({ sha256: sha(replaced), storageVersionId: "v2" });
  });
});
