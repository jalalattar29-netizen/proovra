/**
 * ET-TSA-01 / ET-TSA-03 / ET-TSA-06 — what finalization PERSISTS, through the
 * real web capture routes and the real `completeEvidence`, against live
 * PostgreSQL 16 and a locally minted RFC 3161 authority over loopback HTTP.
 *
 * Doubled: the object store (in-process) and the evidence signer (a
 * deterministic test signer). The timestamp service is NOT doubled.
 *
 * On a40ca76f a forged token finalized STAMPED, tsa_message_imprint was the
 * digest we sent (never the token's), and no failure code was stored.
 */
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { startLocalTsa, type LocalTsa } from "./support/local-tsa-authority.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://tsa-test-store.invalid/${encodeURIComponent(id(p))}`,
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
        signatureBase64: Buffer.from(`tsa-test-signature:${hex}`).toString("base64"),
        keyId: "tsa-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

process.env.S3_BUCKET = "tsa-finalize-test-bucket";

const TSA_ENV = ["TSA_ENABLED", "TSA_URL", "TSA_USERNAME", "TSA_PASSWORD", "TSA_PROVIDER", "TSA_TRUST_BUNDLE_PATH"] as const;

describe("TSA validation facts persisted at finalize (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let tsa: LocalTsa;
  let originalBilling: Record<string, unknown> | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    });
    originalBilling = team as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: harness.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
    tsa = await startLocalTsa();
    for (const k of TSA_ENV) savedEnv[k] = process.env[k];
    Object.assign(process.env, {
      TSA_ENABLED: "true",
      TSA_URL: tsa.url,
      TSA_USERNAME: "local-user",
      TSA_PASSWORD: "local-secret",
      TSA_PROVIDER: "LOCAL_TEST_TSA",
      TSA_TRUST_BUNDLE_PATH: tsa.trustBundlePath,
    });
  }, 600_000);

  afterAll(async () => {
    for (const k of TSA_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (harness && originalBilling) {
      await prisma.team
        .update({ where: { id: harness.fixtures.teamA.teamId }, data: originalBilling as never })
        .catch(() => undefined);
    }
    await tsa?.dispose();
    await harness?.cleanup();
  }, 120_000);

  const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
    harness.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  async function finalize() {
    const token = harness.fixtures.teamA.ownerToken;
    const created = await call("POST", "/v1/evidence", token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
      teamId: harness.fixtures.teamA.teamId,
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, token, {
      partIndex: 0,
      mimeType: "image/jpeg",
      originalFileName: "photo.jpg",
    });
    const u = part.json().upload;
    objects.set(`${u.bucket}/${u.key}`, Buffer.from(`tsa-part-${randomBytes(6).toString("hex")}`));
    const done = await call("POST", `/v1/evidence/${id}/complete`, token, {});
    expect(done.statusCode, done.body).toBe(200);
    return prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: {
        fileSha256: true,
        tsaStatus: true,
        tsaValidatedAtUtc: true,
        tsaSignerCertSha256: true,
        tsaPolicyOid: true,
        tsaFailureCode: true,
        tsaMessageImprint: true,
        tsaInputDigestHex: true,
        tsaTokenBase64: true,
      },
    });
  }

  it("a trusted token finalizes STAMPED with its validation facts and the token's own imprint", async () => {
    tsa.mode = "trusted";
    const ev = await finalize();
    expect(ev.tsaStatus).toBe("STAMPED");
    expect(ev.tsaValidatedAtUtc).toBeInstanceOf(Date);
    expect(ev.tsaSignerCertSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.tsaPolicyOid).toBeTruthy();
    expect(ev.tsaFailureCode).toBeNull();
    expect(ev.tsaInputDigestHex).toBe(ev.fileSha256);
    expect(ev.tsaMessageImprint).toBe(ev.fileSha256);
  }, 120_000);

  it("a FORGED token finalizes FAILED with its code, never STAMPED; the reply is kept", async () => {
    tsa.mode = "forged";
    const ev = await finalize();
    expect(ev.tsaStatus).toBe("FAILED");
    expect(ev.tsaFailureCode).toBe("tsa_token_untrusted");
    expect(ev.tsaValidatedAtUtc).toBeNull();
    expect((ev.tsaTokenBase64 ?? "").length).toBeGreaterThan(100);
  }, 120_000);

  it("ET-TSA-03/06: a token for another digest keeps the TOKEN's imprint beside the request digest, coded as a mismatch", async () => {
    tsa.mode = "wrong_imprint";
    const ev = await finalize();
    expect(ev.tsaStatus).toBe("FAILED");
    expect(ev.tsaFailureCode).toBe("tsa_message_imprint_mismatch");
    expect(ev.tsaInputDigestHex).toBe(ev.fileSha256);
    expect(ev.tsaMessageImprint).toBe("ab".repeat(32));
  }, 120_000);
});
