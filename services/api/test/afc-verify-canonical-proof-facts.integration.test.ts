/**
 * Independent forward audit closure — F-29 (2026-10-21).
 *
 * Rich Public Verify and the owner's preservation matrix re-derived three proof
 * facts from raw columns instead of the canonical resolvers:
 *   - "a trusted timestamp is available" from a list of raw words (an
 *     unvalidated STAMPED / GRANTED token read as available);
 *   - "the token's digest matches the file" for a token that was asked to
 *     certify the PACKAGE digest (a spurious mismatch);
 *   - "the OpenTimestamps proof commits to this record" from two stored
 *     columns, never the proof bytes the OTS resolver reads.
 *
 * Over real HTTP against live PostgreSQL 16, with genuinely signed records.
 * Expected values are literals, never re-derived through the helpers.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { shareLinkFor } from "./helpers/verify-share.js";
import { otsProofForDigest } from "./helpers/ots-proof-bytes.js";

const PACKAGE_DIGEST = "c".repeat(64);
const OTHER_DIGEST = "d".repeat(64);

describe("F-29 — Verify states the canonical proof facts (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];
  const keyId = `afc29-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    // A paid workspace, so the RICH tier (integrity proof, timestamping block) is served.
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

  async function signedRecord(over: Record<string, unknown>) {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const row = await prisma.evidence.create({
      data: { title: "F-29 fixture", type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    });
    created.push(row.id);
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = createHash("sha256").update(canonical).digest("hex");
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
        tsaStatus: "STAMPED",
        tsaTokenBase64: Buffer.from("fixture-token").toString("base64"),
        tsaGenTimeUtc: new Date(),
        tsaInputDigestHex: fileSha256,
        tsaMessageImprint: fileSha256,
        tsaValidatedAtUtc: new Date(),
        ...over,
      } as never,
    });
    return { id: row.id, fileSha256, fingerprintHash };
  }

  async function publicVerify(id: string) {
    const res = await h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, id)}` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      tier: string;
      integrityProof?: { overallIntegrity: boolean; otsHashMatches: boolean | null };
      storageAndTimestamping?: {
        tsa: { timestampAvailable: boolean; digestMatchesFileHash: boolean | null; digestMatchesTimestampInput: boolean | null };
      };
    };
    expect(body.tier).toBe("RICH");
    return body;
  }

  async function ownerMatrix(id: string) {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${id}/review-workspace`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { preservationMatrix: { tsa: { timestampAvailable: boolean } } }).preservationMatrix;
  }

  it("a STAMPED token that was never validated is not \"a trusted timestamp is available\" (public and owner)", async () => {
    const { id } = await signedRecord({ tsaValidatedAtUtc: null });
    const body = await publicVerify(id);
    expect(body.storageAndTimestamping!.tsa.timestampAvailable).toBe(false);
    expect(body.storageAndTimestamping!.tsa.digestMatchesFileHash).toBeNull();
    expect((await ownerMatrix(id)).tsa.timestampAvailable).toBe(false);
  });

  it("a GRANTED token with no validation is not available either — the raw word is not the status", async () => {
    const { id } = await signedRecord({ tsaStatus: "GRANTED", tsaValidatedAtUtc: null });
    const body = await publicVerify(id);
    expect(body.storageAndTimestamping!.tsa.timestampAvailable).toBe(false);
    expect((await ownerMatrix(id)).tsa.timestampAvailable).toBe(false);
  });

  it("a validated token over the record's file digest is available and matches the file", async () => {
    const { id } = await signedRecord({});
    const body = await publicVerify(id);
    expect(body.storageAndTimestamping!.tsa.timestampAvailable).toBe(true);
    expect(body.storageAndTimestamping!.tsa.digestMatchesFileHash).toBe(true);
    expect((await ownerMatrix(id)).tsa.timestampAvailable).toBe(true);
  });

  it("a validated token over the PACKAGE digest is never a file-digest mismatch", async () => {
    const { id } = await signedRecord({
      tsaInputKind: "CANONICAL_PACKAGE_SHA256",
      tsaInputDigestHex: PACKAGE_DIGEST,
      tsaMessageImprint: PACKAGE_DIGEST,
    });
    const body = await publicVerify(id);
    expect(body.storageAndTimestamping!.tsa.timestampAvailable).toBe(true);
    expect(body.storageAndTimestamping!.tsa.digestMatchesTimestampInput).toBe(true);
    expect(body.storageAndTimestamping!.tsa.digestMatchesFileHash).toBeNull();
  });

  it("an OTS proof that commits to ANOTHER digest is a mismatch, although the stored digest column equals the fingerprint", async () => {
    const seed = await signedRecord({});
    await prisma.evidence.update({
      where: { id: seed.id },
      data: { otsHash: seed.fingerprintHash, otsStatus: "PENDING", otsProofBase64: otsProofForDigest(OTHER_DIGEST) } as never,
    });
    const body = await publicVerify(seed.id);
    expect(body.integrityProof!.otsHashMatches).toBe(false);
    expect(body.integrityProof!.overallIntegrity).toBe(false);
  });

  it("an OTS proof that commits to the record's fingerprint matches", async () => {
    const seed = await signedRecord({});
    await prisma.evidence.update({
      where: { id: seed.id },
      data: { otsHash: seed.fingerprintHash, otsStatus: "PENDING", otsProofBase64: otsProofForDigest(seed.fingerprintHash) } as never,
    });
    const body = await publicVerify(seed.id);
    expect(body.integrityProof!.otsHashMatches).toBe(true);
  });

  it("a submitted OTS digest with no proof yet claims no match", async () => {
    const seed = await signedRecord({});
    await prisma.evidence.update({ where: { id: seed.id }, data: { otsHash: seed.fingerprintHash, otsStatus: "PENDING" } as never });
    const body = await publicVerify(seed.id);
    expect(body.integrityProof!.otsHashMatches).toBeNull();
  });
});
