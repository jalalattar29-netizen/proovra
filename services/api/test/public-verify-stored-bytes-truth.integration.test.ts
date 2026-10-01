/**
 * UC-TRUST-008 / 005 / 001 / 003 — Public Verify states the STORED BYTES
 * honestly, through the real integrity recheck against a REAL object store
 * (the disposable loopback MinIO the harness points S3_* at), live PostgreSQL
 * and real HTTP.
 *
 *   TRUST-008  after the stored original is replaced, a check that passed
 *              days ago is never presented as a current "Verified": the
 *              answer is STALE ("last verified <time>"), a pinned-version
 *              recheck is requested, and that recheck — reading the real
 *              object — records MISMATCH.
 *   TRUST-005  a missing original makes overallIntegrity false and the trust
 *              decision REVIEW_REQUIRED; the Basic verdict is failed.
 *   TRUST-001  bytes AND digest columns rewritten consistently: the columns
 *              disagree with the signed fingerprint, so Verify is not
 *              verified and the recheck (bound to the fingerprint) fails.
 *   TRUST-003  a revoked signing key does not verify as a valid signature.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { shareLinkFor } from "./helpers/verify-share.js";

type Recheck = typeof import("../../worker/src/integrity-recheck.js");
type WorkerStorage = typeof import("../../worker/src/storage.js");

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const HOUR = 3600_000;

describe("Public Verify — stored-bytes truth against a real object store (live PG16, MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let recheck: Recheck;
  let storage: WorkerStorage;
  let readState: (typeof import("@proovra/shared-runtime"))["readStoredBytesIntegrity"];
  const BUCKET = process.env.S3_BUCKET ?? "point7-local-bucket";
  const keyId = `uctrust-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const created: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    recheck = await import("../../worker/src/integrity-recheck.js");
    storage = await import("../../worker/src/storage.js");
    ({ readStoredBytesIntegrity: readState } = await import("@proovra/shared-runtime"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    // A paid workspace, so the RICH tier (trust decision, integrity proof) is served.
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await h?.cleanup();
  });

  /** A genuinely signed single-object record whose original is in MinIO. */
  async function signedRecordInStore(
    over: Record<string, unknown> = {},
    opts: { key?: string; create?: Record<string, unknown> } = {},
  ) {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const bytes = Buffer.from(`genuine-original-${randomUUID()}`);
    const row = await prisma.evidence.create({
      data: {
        title: "stored-bytes truth",
        type: "DOCUMENT",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        ...(opts.create ?? {}),
      } as never,
      select: { id: true },
    });
    created.push(row.id);
    const key = opts.key ?? `evidence/${row.id}/original.bin`;
    const put = await storage.putObjectBuffer({ bucket: BUCKET, key, body: bytes, contentType: "application/octet-stream" });
    const fileSha256 = sha(bytes);
    // The fingerprint in its production shape: the signed digest lives in file.sha256.
    const canonical = JSON.stringify({
      v: 1,
      evidenceId: row.id,
      type: "DOCUMENT",
      file: { multipart: false, bucket: BUCKET, key, sizeBytes: bytes.length, mimeType: "application/octet-stream", sha256: fileSha256, etag: null },
      capturedAtUtc: null,
      deviceTimeIso: null,
      gps: { lat: null, lng: null, accuracyMeters: null },
      uploadedAtUtc: new Date().toISOString(),
    });
    const fingerprintHash = sha(canonical);
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId,
        signingKeyVersion: 1,
        signedAtUtc: new Date(),
        mimeType: "application/octet-stream",
        storageBucket: BUCKET,
        storageKey: key,
        storageVersionId: put?.versionId ?? null,
        sizeBytes: BigInt(bytes.length),
        ...over,
      } as never,
    });
    return { id: row.id, key, bytes, fileSha256 };
  }

  const verify = async (id: string, ip: string) =>
    h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, id)}`, remoteAddress: ip });
  const row = (id: string) => prisma.evidence.findUniqueOrThrow({ where: { id } });

  it("TRUST-008: a fresh pinned-version recheck against MinIO is the only VERIFIED", async () => {
    const ev = await signedRecordInStore();
    const result = await recheck.recheckEvidenceIntegrity({ evidenceId: ev.id, trigger: "PUBLIC_VERIFY", force: true });
    expect(result).toMatchObject({ checked: true, outcome: "VERIFIED" });
    const res = await verify(ev.id, "81.2.70.1");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.basicVerification.storedBytes.checkStatus).toBe("VERIFIED");
    expect(body.basicVerification.verdict.state).toBe("verified");
  });

  it("TRUST-008: original replaced in MinIO after a 3-day-old pass -> STALE (never Verified), then the requested recheck records MISMATCH", async () => {
    const at = new Date(Date.now() - 72 * HOUR);
    const ev = await signedRecordInStore({
      integrityCheckedAtUtc: at,
      integrityVerifiedAtUtc: at,
      integrityCheckOutcome: "VERIFIED",
    });
    // Storage-side substitution (the disposable bucket is not versioned).
    await storage.putObjectBuffer({ bucket: BUCKET, key: ev.key, body: Buffer.from("SUBSTITUTED-BYTES"), contentType: "application/octet-stream" });

    const res = await verify(ev.id, "81.2.70.2");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const stored = body.basicVerification.storedBytes;
    expect(stored.state).toBe("verified_stale");
    expect(stored.checkStatus).toBe("STALE");
    expect(stored.lastVerifiedAtUtc).toBe(at.toISOString());
    expect(body.basicVerification.verdict.state).toBe("recorded_only");
    expect(body.trustDecision.relianceLevel).not.toBe("high");
    expect(body.integrityProof.storedBytesCheck).toBe("STALE");
    // Verify asked for a pinned-version recheck…
    expect((await row(ev.id)).integrityRecheckRequestedAtUtc).not.toBeNull();
    // …which reads the REAL object and records the substitution.
    const result = await recheck.recheckEvidenceIntegrity({ evidenceId: ev.id, trigger: "PUBLIC_VERIFY" });
    expect(result).toMatchObject({ checked: true, outcome: "FAILED", failureCode: "DIGEST_MISMATCH" });
    const after = readState(await row(ev.id));
    expect(after.checkStatus).toBe("MISMATCH");
    // A rejected record is withheld from Public Verify (the Phase A0 hard gate).
    const again = await verify(ev.id, "81.2.70.3");
    expect(again.statusCode).toBe(404);
  });

  it("TRUST-005: the original deleted from MinIO -> overallIntegrity false, trust decision REVIEW_REQUIRED, Basic verdict failed", async () => {
    const ev = await signedRecordInStore();
    await storage.deleteObject({ bucket: BUCKET, key: ev.key });
    const result = await recheck.recheckEvidenceIntegrity({ evidenceId: ev.id, trigger: "SCHEDULED", force: true });
    expect(result).toMatchObject({ checked: true, outcome: "FAILED", failureCode: "OBJECT_VERSION_MISSING" });
    expect((await row(ev.id)).status).toBe("SIGNED");

    const res = await verify(ev.id, "81.2.70.4");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.tier).toBe("RICH");
    expect(body.integrityProof.overallIntegrity).toBe(false);
    expect(body.trustDecision.verdict).toBe("REVIEW_REQUIRED");
    expect(body.basicVerification.original.state).toBe("failed");
    expect(body.basicVerification.verdict.state).toBe("failed");
    expect(body.basicVerification.storedBytes.checkStatus).toBe("UNAVAILABLE");
  });

  it("TRUST-001: bytes and digest columns rewritten consistently -> Verify not verified; the recheck binds to the fingerprint and fails", async () => {
    const ev = await signedRecordInStore();
    const evil = Buffer.from("SUBSTITUTED-CONSISTENTLY");
    await storage.putObjectBuffer({ bucket: BUCKET, key: ev.key, body: evil, contentType: "application/octet-stream" });
    // An insider makes the unsigned column agree with the substituted bytes.
    await prisma.evidence.update({ where: { id: ev.id }, data: { fileSha256: sha(evil) } });

    const res = await verify(ev.id, "81.2.70.5");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.integrityProof.digestColumnsMatchSignedFingerprint).toBe(false);
    expect(body.integrityProof.overallIntegrity).toBe(false);
    expect(body.basicVerification.original.state).toBe("failed");
    expect(body.trustDecision.verdict).toBe("REVIEW_REQUIRED");

    const result = await recheck.recheckEvidenceIntegrity({ evidenceId: ev.id, trigger: "PUBLIC_VERIFY", force: true });
    expect(result).toMatchObject({ checked: true, outcome: "FAILED", failureCode: "DIGEST_MISMATCH" });
    const [check] = await prisma.evidenceIntegrityCheck.findMany({ where: { evidenceId: ev.id }, orderBy: { checkedAtUtc: "desc" }, take: 1 });
    // The expected digest recorded is the SIGNED one, not the rewritten column.
    expect(check!.expectedDigest).toBe(ev.fileSha256);
  });

  it("TRUST-003: a record signed with a key later revoked is not presented as validly signed", async () => {
    const revokedKeyId = `uctrust-rev-${randomUUID().slice(0, 8)}`;
    await prisma.signingKey.create({
      data: {
        keyId: revokedKeyId,
        version: 1,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim(),
        revokedAt: new Date(),
      },
    });
    const ev = await signedRecordInStore({ signingKeyId: revokedKeyId });
    const res = await verify(ev.id, "81.2.70.6");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.integrityProof.signatureValid).toBe(false);
    expect(typeof body.integrityProof.signingKeyRevokedAtUtc).toBe("string");
    expect(body.basicVerification.original.checks.signatureValid).toBe(false);
    expect(body.basicVerification.original.state).toBe("failed");
  });

  it("UC-PROV-003: Public Verify carries the capture-client facts of the sealed manifest, data-minimized (domain, no URL/title)", async () => {
    const ev = await signedRecordInStore(
      {},
      { create: { acquisitionMode: "DIRECT_WEB_CAPTURE_EXTENSION", acquisitionModeSource: "RECORDED_AT_CREATION" } },
    );
    const manifestSha256 = sha("manifest-" + ev.id);
    await prisma.evidencePart.create({
      data: {
        evidenceId: ev.id, partIndex: 1, storageBucket: BUCKET, storageKey: ev.key + ".manifest.json",
        mimeType: "application/json", sizeBytes: 10n, sha256: manifestSha256, artifactClass: "CAPTURE_MANIFEST",
      } as never,
    });
    const facts = {
      schema: "PROOVRA_CAPTURE_MANIFEST_FACTS_V1", kind: "WEB", reportedBy: "CAPTURE_CLIENT", manifestSchemaVersion: "1",
      manifestSha256, manifestPartIndex: 1,
      clientCaptureWindow: { startedAtUtc: "2026-09-30T10:00:00.000Z", endedAtUtc: "2026-09-30T10:00:05.000Z" },
      completeness: "PARTIAL", reportedComplete: false, limitations: ["PAGE_MUTATED_DURING_CAPTURE"],
      client: { kind: "BROWSER_EXTENSION", appVersion: "1.2.3", platform: null, osVersion: null, model: null, browserName: "Chrome", browserVersion: "140" },
      web: { domain: "example.com", sourceUrlPrivate: "https://example.com/private/path", titlePrivate: "Private title", captureMode: "VISIBLE", pageMutatedDuringCapture: true },
      screen: null,
    };
    await prisma.captureTrustEventRecord.create({
      data: {
        teamId: h.fixtures.teamA.teamId, evidenceId: ev.id, code: "CAPTURE_ARTIFACT_RECEIVED", sequence: 1, atUtc: new Date(),
        payload: { stage: "manifest_facts", facts } as never, eventHash: sha("evt-" + ev.id), prevEventHash: null,
      } as never,
    });
    const res = await verify(ev.id, "81.2.70.7");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.captureManifest).toMatchObject({ completeness: "PARTIAL", reportedComplete: false, web: { domain: "example.com", pageMutatedDuringCapture: true } });
    expect(res.body).not.toContain("https://example.com/private/path");
    expect(res.body).not.toContain("Private title");
  });
});
