/**
 * Matrix review NEW-RG-25-4 (RG-25, DEC-14 "storage internals are not general
 * DTO fields"; PRO-C1-12) — the evidence detail and every evidence response
 * built by `toSafeEvidence` carried the original's storage bucket and object
 * key to any record reader, although the parts route already strips them.
 * Real route registration against a live PostgreSQL.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

describe("NEW-RG-25-4 — no storage coordinates in the evidence DTO (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    // The application graph reads DATABASE_URL at import time; the harness sets it at boot.
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("GET /v1/evidence/:id returns no bucket or object key (members and the owner alike)", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const bucket = `rg25-bucket-${randomUUID().slice(0, 8)}`;
    const key = `evidence/${randomUUID()}/original.jpg`;
    const ev = await prisma.evidence.create({
      data: {
        title: "rg25 record",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        storageBucket: bucket,
        storageKey: key,
      } as never,
      select: { id: true },
    });
    for (const token of [A.ownerToken, A.adminToken, A.memberToken]) {
      const res = await h.app.inject({
        method: "GET",
        url: `/v1/evidence/${ev.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { evidence?: Record<string, unknown> };
      expect(body.evidence?.id).toBe(ev.id);
      expect(body.evidence).not.toHaveProperty("storageBucket");
      expect(body.evidence).not.toHaveProperty("storageKey");
      // No field anywhere in the response carries them. (A presigned view URL
      // necessarily names its object; it is a short-lived capability, not a
      // DTO field, and is decided by the content-access policy.)
      expect(fieldsHolding(body, [bucket, key])).toEqual([]);
    }
  });

  /** Paths of every JSON field whose value IS the bucket or key (not a URL embedding it). */
  function fieldsHolding(value: unknown, needles: string[], path = "$"): string[] {
    if (typeof value === "string") return needles.includes(value) ? [path] : [];
    if (Array.isArray(value)) return value.flatMap((v, i) => fieldsHolding(v, needles, `${path}[${i}]`));
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
        /^storage(Bucket|Key)$/.test(k) ? [`${path}.${k}`] : fieldsHolding(v, needles, `${path}.${k}`),
      );
    }
    return [];
  }

  it("the field walker sees a bucket field (the assertion is not vacuous)", () => {
    expect(fieldsHolding({ a: [{ storageBucket: "x" }] }, ["y"])).toEqual(["$.a[0].storageBucket"]);
    expect(fieldsHolding({ a: { b: "y" } }, ["y"])).toEqual(["$.a.b"]);
  });
});
