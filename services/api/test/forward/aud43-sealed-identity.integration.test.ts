/**
 * AUD-43 (2026-10-20) — the sealed identity of a record is set once. Live
 * PostgreSQL 16 with every migration applied: once finalization has written a
 * digest, fingerprint, signature, key identity or signed storage version, no
 * UPDATE may change or clear it; writing a column that is still NULL (the seal
 * itself) stays allowed, and every other column stays writable.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

const SEALED: Array<[string, unknown, unknown]> = [
  ["fileSha256", "aa".repeat(32), "bb".repeat(32)],
  ["fingerprintHash", "cc".repeat(32), "dd".repeat(32)],
  ["fingerprintCanonicalJson", "{\"a\":1}", "{\"a\":2}"],
  ["signatureBase64", "c2ln", "b3RoZXI="],
  ["signedAtUtc", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-02T00:00:00Z")],
  ["signingKeyId", "key-a", "key-b"],
  ["signingKeyVersion", 1, 2],
  ["signingKeySha256", "ee".repeat(32), "ff".repeat(32)],
  ["multipartManifestSha256", "12".repeat(32), "34".repeat(32)],
  ["hashSemantics", "SINGLE_FILE_SHA256", "MULTIPART_COMPOSITE"],
  ["storageVersionId", "v-1", "v-2"],
];

describe("AUD-43 sealed identity set once (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function record(): Promise<string> {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { title: `aud43-${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "CREATED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    return ev.id;
  }

  for (const [column, first, second] of SEALED) {
    it(`${column}: NULL -> value is the seal; value -> other and value -> NULL are refused`, async () => {
      const id = await record();
      await prisma.evidence.update({ where: { id }, data: { [column]: first } as never });
      await expect(prisma.evidence.update({ where: { id }, data: { [column]: second } as never })).rejects.toThrow(/sealed identity is permanent/);
      await expect(prisma.evidence.update({ where: { id }, data: { [column]: null } as never })).rejects.toThrow(/sealed identity is permanent/);
      // Writing the same value again is not a change.
      await prisma.evidence.update({ where: { id }, data: { [column]: first } as never });
      const row = (await prisma.evidence.findUniqueOrThrow({ where: { id } })) as unknown as Record<string, unknown>;
      expect(row[column] instanceof Date ? (row[column] as Date).toISOString() : row[column]).toEqual(first instanceof Date ? first.toISOString() : first);
    });
  }

  it("every other column stays writable on a sealed record", async () => {
    const id = await record();
    await prisma.evidence.update({ where: { id }, data: { fileSha256: "aa".repeat(32), signatureBase64: "c2ln" } as never });
    await prisma.evidence.update({ where: { id }, data: { title: "renamed", status: "SIGNED" } as never });
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { title: true } })).title).toBe("renamed");
  });
});
