/**
 * AUD-42 (2026-10-20) — THE TSA ROUND-TRIP IS NOT MADE UNDER THE WORKSPACE
 * CAPACITY LOCK. Live PostgreSQL 16, the real routes and the real
 * completeEvidence. Doubled: the object store, the signer, and the timestamp
 * authority (slow: 2.5 s per call).
 *
 * The completion takes the workspace capacity lock (a transaction-scoped
 * advisory lock, held until commit) and then made the RFC 3161 network call,
 * so every other finalize in the workspace waited behind this record's
 * timestamp authority: two finalizes ran one after the other. The signature
 * and the timestamp are now obtained before the capacity lock is taken; the
 * capacity check itself still serializes (ET-SEC-28 is unchanged).
 */
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());
const tsa = vi.hoisted(() => ({ windows: [] as Array<{ start: number; end: number }> }));

vi.mock("../../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) => `https://cap-test-store.invalid/${encodeURIComponent(id(p))}`,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
        versionId: "v1",
        contentType: "image/jpeg",
        etag: null,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
    deleteObjectVersions: async (p: { bucket: string; key: string }) => {
      const had = objects.delete(id(p));
      return { deleted: had, deletedVersions: had ? 1 : 0, retainedVersions: 0, deleteMarkerOnly: false, failed: 0 };
    },
  };
});

vi.mock("../../src/signing/signer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEvidenceSigner: () => ({
      signFingerprintHex: async (hex: string) => ({
        signatureBase64: Buffer.from(`cap-test-signature:${hex}`).toString("base64"),
        keyId: "cap-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

// A slow authority: what a real network round-trip under load looks like.
vi.mock("../../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createEvidenceTimestamp: async () => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 2500));
      tsa.windows.push({ start, end: Date.now() });
      return null;
    },
  };
});

process.env.S3_BUCKET = "aud42-finalize-test-bucket";

describe("AUD-42: the timestamp authority is called outside the workspace capacity lock (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: h.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    });
    originalBilling = team as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 180_000);

  afterAll(async () => {
    if (h && originalBilling) {
      await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    await h?.cleanup();
  }, 120_000);

  const call = (method: "POST", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  async function uploaded(bytes: number): Promise<string> {
    const token = h.fixtures.teamA.ownerToken;
    const created = await call("POST", "/v1/evidence", token, { type: "PHOTO", mimeType: "image/jpeg", teamId: h.fixtures.teamA.teamId });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, token, { partIndex: 0, mimeType: "image/jpeg", originalFileName: "p.jpg" });
    const u = part.json().upload;
    objects.set(`${u.bucket}/${u.key}`, randomBytes(bytes));
    return id;
  }

  it("two finalizes in one workspace obtain their timestamps concurrently, and both seal", async () => {
    const A = h.fixtures.teamA;
    const a = await uploaded(10);
    const b = await uploaded(10);
    tsa.windows.length = 0;
    const [ra, rb] = await Promise.all([
      call("POST", `/v1/evidence/${a}/complete`, A.ownerToken, {}),
      call("POST", `/v1/evidence/${b}/complete`, A.ownerToken, {}),
    ]);
    expect([ra.statusCode, rb.statusCode], `${ra.body} | ${rb.body}`).toEqual([200, 200]);
    expect(tsa.windows).toHaveLength(2);
    const [w1, w2] = [...tsa.windows].sort((x, y) => x.start - y.start);
    // The second authority call began before the first ended: the two
    // round-trips overlapped; neither waited behind the other record's lock.
    expect(w2!.start, JSON.stringify(tsa.windows)).toBeLessThan(w1!.end);
    for (const id of [a, b]) {
      const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { status: true } });
      expect(row.status).toBe("SIGNED");
    }
  }, 120_000);
});
