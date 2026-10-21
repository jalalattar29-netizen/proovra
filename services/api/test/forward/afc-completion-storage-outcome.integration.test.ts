/**
 * Independent forward audit closure — F-18. Concurrent duplicate completions of
 * one record must record ONE canonical storage-protection outcome: never two
 * STORAGE_PROTECTION_UNAVAILABLE events, never two EVIDENCE_LOCKED events, and
 * never "unavailable" after "locked". Live PostgreSQL 16 and the real
 * /v1/evidence routes; the object store is an in-memory double whose retention
 * and HEAD calls are slowed to widen the post-commit window the race lives in.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());
const lockMode = vi.hoisted(() => ({ value: null as null | "COMPLIANCE" }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock("../../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) => `http://127.0.0.1:59000/${p.bucket}/${p.key}?presigned=${randomUUID()}`,
    headObject: async (p: { bucket: string; key: string }) => {
      await sleep(40);
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
        versionId: "v1",
        contentType: "image/jpeg",
        etag: null,
        metadata: null,
        objectLockMode: lockMode.value,
        objectLockRetainUntilDate: lockMode.value ? new Date(Date.now() + 86_400_000) : null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => {
      await sleep(120);
      return lockMode.value
        ? { applied: true, confirmed: true, mode: lockMode.value, retainUntil: new Date(Date.now() + 86_400_000) }
        : { applied: false, reason: "test_store" };
    },
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
  };
});

describe("F-18 — one storage-protection outcome under concurrent completion (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];

  beforeAll(async () => {
    process.env.TSA_ENABLED = "false";
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    for (const t of [h.fixtures.teamA, h.fixtures.teamB]) {
      await prisma.team.update({ where: { id: t.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    }
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  // One workspace per case: the per-user completion rate limit is per minute.
  let team: IntegrationHarness["fixtures"]["teamA"];
  const call = (method: "POST", url: string, payload: unknown) =>
    h.app.inject({ method, url, headers: { authorization: `Bearer ${team.ownerToken}` }, payload: payload as never });

  async function stagedRecord() {
    const created = await call("POST", "/v1/evidence", { type: "PHOTO", mimeType: "image/jpeg", teamId: team.teamId });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, { partIndex: 0, mimeType: "image/jpeg", originalFileName: "photo.jpg" });
    expect(part.statusCode, part.body).toBe(201);
    const u = part.json().upload;
    objects.set(`${u.bucket}/${u.key}`, Buffer.from(`web-part-${randomBytes(6).toString("hex")}`));
    return id;
  }

  async function outcomes(id: string) {
    const rows = await prisma.custodyEvent.findMany({
      where: { evidenceId: id, eventType: { in: ["EVIDENCE_LOCKED", "STORAGE_PROTECTION_UNAVAILABLE"] } },
      orderBy: { sequence: "asc" },
      select: { eventType: true },
    });
    return rows.map((r) => r.eventType);
  }

  for (const mode of [null, "COMPLIANCE"] as const) {
    it(`F-18: four concurrent completes record one outcome (object lock ${mode ?? "unavailable"})`, async () => {
      lockMode.value = mode;
      team = mode ? h.fixtures.teamB : h.fixtures.teamA;
      for (let round = 0; round < 2; round += 1) {
        const id = await stagedRecord();
        const results = await Promise.all(Array.from({ length: 4 }, () => call("POST", `/v1/evidence/${id}/complete`, {})));
        for (const r of results) expect(r.statusCode, r.body).toBe(200);
        // Let every post-commit step settle.
        await sleep(600);
        const seen = await outcomes(id);
        expect(seen, `round ${round}: ${seen.join(",")}`).toEqual([mode ? "EVIDENCE_LOCKED" : "STORAGE_PROTECTION_UNAVAILABLE"]);
      }
    }, 120_000);
  }
});
