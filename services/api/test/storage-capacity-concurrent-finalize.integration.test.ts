/**
 * ET-SEC-28 — two finalizes in one workspace cannot both pass the storage
 * limit. Live PostgreSQL 16, the real routes and the real completeEvidence.
 * Doubled: the object store (in-process) and the evidence signer.
 *
 * On a40ca76f the completion's storage check ran before any capacity lock (the
 * per-evidence lock does not serialize DIFFERENT records), so two concurrent
 * finalizes that each fit alone both passed and the workspace ended over its
 * limit.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../src/storage.js", async (importOriginal) => {
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
    deleteObject: async (p: { bucket: string; key: string }) => {
      objects.delete(id(p));
    },
  };
});

vi.mock("../src/signing/signer.js", async (importOriginal) => {
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

process.env.S3_BUCKET = "cap-finalize-test-bucket";

describe("storage capacity under concurrent finalize (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let originalBilling: Record<string, unknown> | null = null;
  let paddingId: string | null = null;
  const savedTsa = process.env.TSA_ENABLED;

  beforeAll(async () => {
    process.env.TSA_ENABLED = "false";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
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
    if (savedTsa === undefined) delete process.env.TSA_ENABLED;
    else process.env.TSA_ENABLED = savedTsa;
    if (paddingId) await prisma.evidence.delete({ where: { id: paddingId } }).catch(() => undefined);
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

  it("of two finalizes that each fit alone but not together, exactly one is refused STORAGE_LIMIT_REACHED", async () => {
    const A = h.fixtures.teamA;
    const a = await uploaded(10);
    const b = await uploaded(10);

    const { resolveEnforcementScopeForRequester } = await import("../src/services/billing-enforcement.service.js");
    const { getWorkspaceUsage } = await import("../src/services/workspace-usage.service.js");
    const scope = await resolveEnforcementScopeForRequester({ ownerUserId: A.ownerUserId, teamId: A.teamId });
    const usage = await getWorkspaceUsage(scope);
    // Leave exactly 15 bytes of headroom: either 10-byte record fits, both do not.
    const padding = usage.storageBytesLimit - usage.storageBytesUsed - 15n;
    expect(padding).toBeGreaterThan(0n);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    paddingId = (
      await prisma.evidence.create({
        data: { title: `pad ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId, sizeBytes: padding } as never,
        select: { id: true },
      })
    ).id;

    const [ra, rb] = await Promise.all([
      call("POST", `/v1/evidence/${a}/complete`, A.ownerToken, {}),
      call("POST", `/v1/evidence/${b}/complete`, A.ownerToken, {}),
    ]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes, `${ra.body} | ${rb.body}`).toEqual([200, 409]);
    const refused = ra.statusCode === 409 ? ra : rb;
    expect(refused.body).toContain("STORAGE_LIMIT_REACHED");

    const after = await getWorkspaceUsage(scope);
    expect(after.storageBytesUsed <= after.storageBytesLimit).toBe(true);
  }, 120_000);
});
