/**
 * F-04 (Free-user audit of 4d9b78963, closed 2026-11-15) — THE SIGNATURE AND
 * THE RFC 3161 TOKEN ARE OBTAINED OUTSIDE THE COMPLETION TRANSACTION.
 *
 * Live PostgreSQL 16, the real `completeEvidence` (and the real
 * POST /v1/evidence/:id/complete route where the actor matters), the real
 * signing boundary (local PEM key registered by the harness). Doubled
 * ("simulated"): the object store (an in-memory VERSIONED store at the storage
 * module boundary) and the timestamp authority (a scripted
 * `createEvidenceTimestamp`; no provider is contacted).
 *
 * Before F-04 the completion transaction (120 s budget) held a pooled
 * connection and the record lock across the signer and up to three 20 s TSA
 * subprocesses. Now a short transaction prepares the seal (every check, the
 * digests, the fingerprint) and rolls back, the signature and token are
 * obtained with no connection held, and a second short transaction re-runs
 * every check under the record + capacity locks and persists only when the
 * attested fingerprint, digest and object versions are still exactly current.
 *
 * The connection-hold numbers printed by the measurement case are LOCAL,
 * MOCKED-PROVIDER measurements (scripted 1.5 s authority), not production
 * figures.
 */
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Obj = { version: number; bytes: Map<string, Buffer> };
const store = vi.hoisted(() => ({ objects: new Map<string, Obj>() }));

type TsaCall = { digestHex: string; inputKind: string | null };
const tsa = vi.hoisted(() => ({
  calls: [] as Array<{ digestHex: string; inputKind: string | null }>,
  delayMs: 0,
  /** Runs inside the authority call, after the delay: lets a test move state mid-flight. */
  during: null as null | ((call: { digestHex: string; inputKind: string | null }, n: number) => Promise<void> | void),
  outcome: "STAMPED" as "STAMPED" | "OUTAGE" | "THROW",
}));

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) => `https://f04-test-store.invalid/${encodeURIComponent(id(p))}`,
    headObject: async (p: { bucket: string; key: string; versionId?: string | null }) => {
      const o = store.objects.get(id(p));
      if (!o) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      const v = p.versionId ?? `v${o.version}`;
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
      return Readable.from([o.bytes.get(p.versionId ?? `v${o.version}`)!]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createEvidenceTimestamp: async (p: { digestHex: string; inputKind?: string | null }) => {
      const call: TsaCall = { digestHex: p.digestHex, inputKind: p.inputKind ?? null };
      tsa.calls.push(call);
      if (tsa.delayMs > 0) await new Promise((r) => setTimeout(r, tsa.delayMs));
      if (tsa.during) await tsa.during(call, tsa.calls.length);
      if (tsa.outcome === "THROW") throw new Error("SIMULATED_ATTESTATION_CRASH");
      const base = {
        provider: "SIMULATED_TSA",
        url: "https://simulated-tsa.invalid/",
        requestDigestHex: p.digestHex,
        hashAlgorithm: "sha256",
        warnings: [],
        durationMs: tsa.delayMs,
      };
      if (tsa.outcome === "OUTAGE") {
        return {
          ...base,
          serialNumber: null,
          genTimeUtc: null,
          tokenBase64: "",
          messageImprint: null,
          status: "FAILED",
          failureReason: "Trusted timestamp request failed because the timestamp provider could not be reached.",
          failureCode: "tsa_provider_unreachable",
          validatedAtUtc: null,
          signerCertSha256: null,
          policyOid: null,
        };
      }
      return {
        ...base,
        serialNumber: `sim-${tsa.calls.length}`,
        genTimeUtc: new Date(),
        // The token names the digest it was minted for, so a test can tell
        // which attempt's token was persisted.
        tokenBase64: Buffer.from(`simulated-token:${p.digestHex}`).toString("base64"),
        messageImprint: p.digestHex,
        status: "STAMPED",
        failureReason: null,
        failureCode: null,
        validatedAtUtc: new Date(),
        signerCertSha256: "ab".repeat(32),
        policyOid: "1.3.6.1.4.1.4146.2.3",
        validationEvidence: null,
      };
    },
  };
});

process.env.S3_BUCKET = "f04-completion-test-bucket";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const SEAL_EVENTS = ["UPLOAD_COMPLETED", "SIGNATURE_APPLIED", "TIMESTAMP_APPLIED", "TIMESTAMP_FAILED", "EVIDENCE_COMPLETED"] as const;

describe("F-04: completion obtains signature + RFC 3161 token outside its transaction (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let completeEvidence: (typeof import("../src/services/evidence-complete.service.js"))["completeEvidence"];
  let releaseEvidenceReservationTx: (typeof import("@proovra/shared-runtime"))["releaseEvidenceReservationTx"];
  let assertSignatureVerifiesWithRegisteredKey: (typeof import("../src/signing/key-registry.js"))["assertSignatureVerifiesWithRegisteredKey"];
  const created: string[] = [];
  let originalBilling: Record<string, unknown> | null = null;

  /** Wall-clock duration of every completion transaction ($transaction with the 120 s budget). */
  const holds: number[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ completeEvidence } = await import("../src/services/evidence-complete.service.js"));
    ({ releaseEvidenceReservationTx } = await import("@proovra/shared-runtime"));
    ({ assertSignatureVerifiesWithRegisteredKey } = await import("../src/signing/key-registry.js"));
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: h.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    });
    originalBilling = team as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
    const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementation(((arg: unknown, opts?: { timeout?: number }) => {
      if (typeof arg === "function" && opts?.timeout === 120_000) {
        const t0 = performance.now();
        return original(arg, opts).finally(() => holds.push(performance.now() - t0));
      }
      return original(arg, opts);
    }) as never);
  }, 180_000);

  afterEach(async () => {
    tsa.calls.length = 0;
    tsa.delayMs = 0;
    tsa.during = null;
    tsa.outcome = "STAMPED";
    holds.length = 0;
    await prisma.teamMember
      .updateMany({ where: { teamId: h.fixtures.teamA.teamId, userId: h.fixtures.teamA.memberUserId }, data: { status: "ACTIVE" } })
      .catch(() => undefined);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (created.length) {
      await prisma?.evidence.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } }).catch(() => undefined);
    }
    if (h && originalBilling) {
      await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    await h?.cleanup();
  }, 120_000);

  /** A team record with one uploaded part (written directly; the service entry is what is under test). */
  async function uploaded(size = 2048, fill = 70): Promise<{ id: string; ownerUserId: string; objectId: string }> {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: { title: "F-04 fixture", type: "PHOTO", status: "CREATED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    created.push(id);
    const key = `evidence/${id}/parts/0-${randomUUID()}`;
    store.objects.set(`f04-bucket/${key}`, { version: 1, bytes: new Map([["v1", Buffer.alloc(size, fill)]]) });
    await prisma.evidencePart.create({
      data: { evidenceId: id, partIndex: 0, storageBucket: "f04-bucket", storageKey: key, mimeType: "image/jpeg" } as never,
    });
    return { id, ownerUserId: A.ownerUserId, objectId: `f04-bucket/${key}` };
  }

  const call = (url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  /** A record created and uploaded through the real routes by `token`. */
  async function uploadedViaRoutes(token: string): Promise<{ id: string; bytes: Buffer }> {
    const createdRes = await call("/v1/evidence", token, { type: "PHOTO", mimeType: "image/jpeg", teamId: h.fixtures.teamA.teamId });
    expect(createdRes.statusCode, createdRes.body).toBeLessThan(300);
    const id = createdRes.json().id as string;
    created.push(id);
    const bytes = Buffer.from(`f04-route-part-${randomUUID()}`);
    const part = await call(`/v1/evidence/${id}/parts`, token, { partIndex: 0, mimeType: "image/jpeg", originalFileName: "p.jpg", sizeBytes: bytes.length });
    expect(part.statusCode, part.body).toBeLessThan(300);
    const u = part.json().upload;
    store.objects.set(`${u.bucket}/${u.key}`, { version: 1, bytes: new Map([["v1", bytes]]) });
    return { id, bytes };
  }

  async function sealEvents(evidenceId: string): Promise<string[]> {
    const rows = await prisma.custodyEvent.findMany({
      where: { evidenceId, eventType: { in: [...SEAL_EVENTS] as never } },
      orderBy: { sequence: "asc" },
      select: { eventType: true },
    });
    return rows.map((r) => r.eventType);
  }

  async function nothingSealed(evidenceId: string) {
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { status: true, fileSha256: true, signatureBase64: true, tsaTokenBase64: true, fingerprintHash: true },
    });
    expect(row.status).not.toBe("SIGNED");
    expect(row).toMatchObject({ fileSha256: null, signatureBase64: null, tsaTokenBase64: null, fingerprintHash: null });
    expect(await sealEvents(evidenceId)).toEqual([]);
    const parts = await prisma.evidencePart.findMany({ where: { evidenceId }, select: { sha256: true } });
    expect(parts.every((p) => p.sha256 === null)).toBe(true);
  }

  it("happy path through the route: one seal with the same custody order, signature and TSA columns", async () => {
    const { id, bytes } = await uploadedViaRoutes(h.fixtures.teamA.ownerToken);
    const done = await call(`/v1/evidence/${id}/complete`, h.fixtures.teamA.ownerToken, {});
    expect(done.statusCode, done.body).toBe(200);
    expect(tsa.calls).toEqual([{ digestHex: sha(bytes), inputKind: "FILE_SHA256" }]);
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: {
        status: true, fileSha256: true, fingerprintHash: true, fingerprintCanonicalJson: true, signatureBase64: true,
        signingKeyId: true, signingKeySha256: true, tsaStatus: true, tsaTokenBase64: true, tsaInputDigestHex: true,
        tsaInputKind: true, tsaMessageImprint: true, tsaSerialNumber: true, uploadedAtUtc: true, signedAtUtc: true,
      },
    });
    expect(row.status).toBe("SIGNED");
    expect(row.fileSha256).toBe(sha(bytes));
    expect(row.fingerprintHash).toBe(sha(Buffer.from(row.fingerprintCanonicalJson!, "utf8")));
    expect(JSON.parse(row.fingerprintCanonicalJson!).uploadedAtUtc).toBe(row.uploadedAtUtc!.toISOString());
    expect(row.signedAtUtc!.getTime()).toBe(row.uploadedAtUtc!.getTime());
    expect(row.signatureBase64).toBeTruthy();
    expect(row.signingKeySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row).toMatchObject({
      tsaStatus: "STAMPED",
      tsaTokenBase64: Buffer.from(`simulated-token:${sha(bytes)}`).toString("base64"),
      tsaInputDigestHex: sha(bytes),
      tsaInputKind: "FILE_SHA256",
      tsaMessageImprint: sha(bytes),
      tsaSerialNumber: "sim-1",
    });
    expect(await sealEvents(id)).toEqual(["UPLOAD_COMPLETED", "SIGNATURE_APPLIED", "TIMESTAMP_APPLIED", "EVIDENCE_COMPLETED"]);
    expect(done.json().tsaOutcome).toMatchObject({ tsaStatus: "STAMPED", tsaTokenPresent: true });
  }, 120_000);

  it("a slow authority (1.5 s, simulated) does not hold the completion's connection: each transaction stays short", async () => {
    const ev = await uploaded();
    tsa.delayMs = 1500;
    const t0 = performance.now();
    const result = await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    const total = performance.now() - t0;
    expect(result.status).toBe("SIGNED");
    // LOCAL, MOCKED-PROVIDER measurement (printed for the remediation report).
    // eslint-disable-next-line no-console
    console.info(JSON.stringify({ f04Measurement: { tsaDelayMs: 1500, completionTotalMs: Math.round(total), transactionHoldsMs: holds.map(Math.round), maxHoldMs: Math.round(Math.max(...holds)) } }));
    expect(holds.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...holds)).toBeLessThan(1000);
    expect(total).toBeGreaterThanOrEqual(1500);
  }, 120_000);

  it("an object replaced while the token was obtained: that attempt persists nothing; the fresh attempt seals the current bytes", async () => {
    const ev = await uploaded(1024, 71);
    const original = Buffer.alloc(1024, 71);
    const replaced = Buffer.alloc(1536, 72);
    tsa.during = (_c, n) => {
      if (n !== 1) return;
      const o = store.objects.get(ev.objectId)!;
      o.version = 2;
      o.bytes.set("v2", replaced);
    };
    const result = await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(result.status).toBe("SIGNED");
    expect(tsa.calls.map((c) => c.digestHex)).toEqual([sha(original), sha(replaced)]);
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { fileSha256: true, tsaTokenBase64: true, tsaInputDigestHex: true } });
    expect(row).toEqual({
      fileSha256: sha(replaced),
      tsaInputDigestHex: sha(replaced),
      tsaTokenBase64: Buffer.from(`simulated-token:${sha(replaced)}`).toString("base64"),
    });
    const part = await prisma.evidencePart.findFirstOrThrow({ where: { evidenceId: ev.id }, select: { sha256: true, storageVersionId: true } });
    expect(part).toEqual({ sha256: sha(replaced), storageVersionId: "v2" });
    expect(await sealEvents(ev.id)).toEqual(["UPLOAD_COMPLETED", "SIGNATURE_APPLIED", "TIMESTAMP_APPLIED", "EVIDENCE_COMPLETED"]);
    const payloads = await prisma.custodyEvent.findMany({ where: { evidenceId: ev.id }, select: { payload: true } });
    expect(JSON.stringify(payloads)).not.toContain(sha(original));
  }, 120_000);

  it("a signed record fact changed while the token was obtained: the stale signature is discarded and the seal signs what it persists", async () => {
    const ev = await uploaded(1024, 80);
    tsa.during = async (_c, n) => {
      if (n === 1) await prisma.evidence.update({ where: { id: ev.id }, data: { deviceTimeIso: "2026-11-15T01:02:03.000Z" } });
    };
    const result = await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(result.status).toBe("SIGNED");
    expect(tsa.calls).toHaveLength(2);
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: ev.id },
      select: { fingerprintCanonicalJson: true, fingerprintHash: true, signatureBase64: true, signingKeyId: true, signingKeyVersion: true },
    });
    expect(JSON.parse(row.fingerprintCanonicalJson!).deviceTimeIso).toBe("2026-11-15T01:02:03.000Z");
    expect(row.fingerprintHash).toBe(sha(Buffer.from(row.fingerprintCanonicalJson!, "utf8")));
    await expect(
      assertSignatureVerifiesWithRegisteredKey(prisma as never, {
        keyId: row.signingKeyId!,
        version: row.signingKeyVersion!,
        purpose: "EVIDENCE_SIGNATURE",
        messageHex: row.fingerprintHash!,
        signatureBase64: row.signatureBase64!,
        selfPublicKeyPem: null,
      }),
    ).resolves.toBeTruthy();
    expect(await sealEvents(ev.id)).toEqual(["UPLOAD_COMPLETED", "SIGNATURE_APPLIED", "TIMESTAMP_APPLIED", "EVIDENCE_COMPLETED"]);
  }, 120_000);

  it("an object that keeps moving under every attempt is refused 409 and nothing is persisted", async () => {
    const ev = await uploaded(1024, 73);
    tsa.during = (_c, n) => {
      const o = store.objects.get(ev.objectId)!;
      o.version = n + 1;
      o.bytes.set(`v${n + 1}`, Buffer.alloc(1024 + n, 74 + n));
    };
    await expect(completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId })).rejects.toMatchObject({
      statusCode: 409,
      code: "EVIDENCE_COMPLETION_INPUTS_CHANGED",
    });
    expect(tsa.calls).toHaveLength(2);
    await nothingSealed(ev.id);
  }, 120_000);

  it("concurrent duplicate completes: one seal, the other is the idempotent duplicate, one token spent", async () => {
    const ev = await uploaded(4096, 75);
    tsa.delayMs = 400;
    const [a, b] = await Promise.all([
      completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId }),
      completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId }),
    ]);
    expect([a.alreadyFinalized === true, b.alreadyFinalized === true].sort()).toEqual([false, true]);
    expect(a.signatureBase64).toBe(b.signatureBase64);
    expect(tsa.calls).toHaveLength(1);
    expect(await sealEvents(ev.id)).toEqual(["UPLOAD_COMPLETED", "SIGNATURE_APPLIED", "TIMESTAMP_APPLIED", "EVIDENCE_COMPLETED"]);
  }, 120_000);

  it("a stale completion (another process sealed the record while this attempt obtained its token) persists nothing of its own", async () => {
    const ev = await uploaded(2048, 76);
    tsa.during = async () => {
      // The winner, simulated: another API process committed the seal.
      await prisma.evidence.update({ where: { id: ev.id }, data: { status: "SIGNED", signatureBase64: "d2lubmVy", fileSha256: "f".repeat(64) } });
    };
    const result = await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(result.alreadyFinalized).toBe(true);
    expect(result.signatureBase64).toBe("d2lubmVy");
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { tsaTokenBase64: true, fileSha256: true } });
    expect(row).toEqual({ tsaTokenBase64: null, fileSha256: "f".repeat(64) });
    expect(await sealEvents(ev.id)).toEqual([]);
  }, 120_000);

  it("a reservation released while the token was obtained is refused and nothing is sealed", async () => {
    const ev = await uploaded(2048, 77);
    tsa.during = async () => {
      // Bounded: before F-04 the release waited on the completion's record lock.
      await Promise.race([
        prisma.$transaction((tx) =>
          releaseEvidenceReservationTx(tx as never, { evidenceId: ev.id, reason: "CAPTURE_SESSION_DISCARDED", now: new Date() }),
        ),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    };
    await expect(completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId })).rejects.toMatchObject({ statusCode: 404 });
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { deletedAt: true } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    await nothingSealed(ev.id);
  }, 120_000);

  it("permission revoked while the token was obtained: the route refuses (404) and nothing is sealed", async () => {
    const A = h.fixtures.teamA;
    const { id } = await uploadedViaRoutes(A.memberToken);
    tsa.during = async () => {
      await prisma.teamMember.updateMany({ where: { teamId: A.teamId, userId: A.memberUserId }, data: { status: "SUSPENDED" } });
    };
    const done = await call(`/v1/evidence/${id}/complete`, A.memberToken, {});
    expect(done.statusCode, done.body).toBe(404);
    expect(tsa.calls).toHaveLength(1);
    await nothingSealed(id);
  }, 120_000);

  it("a provider outage keeps the current rule: the record seals with TSA FAILED, no token, TIMESTAMP_FAILED in custody", async () => {
    const ev = await uploaded(2048, 78);
    tsa.outcome = "OUTAGE";
    const result = await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(result.status).toBe("SIGNED");
    expect(result.tsaOutcome).toMatchObject({ tsaStatus: "FAILED", tsaFailureCode: "tsa_provider_unreachable", tsaTokenPresent: false });
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { tsaStatus: true, tsaFailureCode: true, tsaTokenBase64: true, tsaInputDigestHex: true, fileSha256: true } });
    expect(row).toMatchObject({ tsaStatus: "FAILED", tsaFailureCode: "tsa_provider_unreachable", tsaTokenBase64: "" });
    expect(row.tsaInputDigestHex).toBe(row.fileSha256);
    expect(await sealEvents(ev.id)).toEqual(["UPLOAD_COMPLETED", "SIGNATURE_APPLIED", "TIMESTAMP_FAILED", "EVIDENCE_COMPLETED"]);
  }, 120_000);

  it("a crash between the phases persists nothing; the retry completes exactly once", async () => {
    const ev = await uploaded(2048, 79);
    tsa.outcome = "THROW";
    await expect(completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId })).rejects.toThrow("SIMULATED_ATTESTATION_CRASH");
    await nothingSealed(ev.id);
    tsa.outcome = "STAMPED";
    const result = await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(result.status).toBe("SIGNED");
    const again = await completeEvidence({ evidenceId: ev.id, ownerUserId: ev.ownerUserId });
    expect(again.alreadyFinalized).toBe(true);
    expect(tsa.calls).toHaveLength(2);
    expect(await sealEvents(ev.id)).toEqual(["UPLOAD_COMPLETED", "SIGNATURE_APPLIED", "TIMESTAMP_APPLIED", "EVIDENCE_COMPLETED"]);
  }, 120_000);
});
