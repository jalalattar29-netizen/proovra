/**
 * EVIDENCE-LIFECYCLE REMEDIATION — six P0 evidence-lifecycle defects,
 * asserted as the CORRECT behaviour. Live PostgreSQL 16, real HTTP through
 * the product harness; no object store is needed (the byte paths under test are decided in the DB).
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
// ET-PKG-07 — a record's id is not a public link: requests go through a share
// link (the record is published and the link minted on first use).
import { shareLinkFor } from "./helpers/verify-share.js";

describe("evidence lifecycle P0 invariants (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const keyId = `p0-fixture-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function signedTeamRecord(ownerUserId: string, extra: Record<string, unknown> = {}) {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const row = await prisma.evidence.create({
      data: { title: "p0 fixture", type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId },
      select: { id: true },
    });
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = createHash("sha256").update(canonical).digest("hex");
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256, fingerprintCanonicalJson: canonical, fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId, signingKeyVersion: 1, signedAtUtc: new Date(),
        mimeType: "image/png", storageBucket: "fixture-bucket", storageKey: `evidence/${row.id}/original.png`, sizeBytes: 10n,
        ...extra,
      } as never,
    });
    await prisma.evidencePart.create({
      data: { evidenceId: row.id, partIndex: 0, storageBucket: "fixture-bucket", storageKey: `evidence/${row.id}/parts/000-original.png`, mimeType: "image/png", sizeBytes: 10n, sha256: fileSha256, uploadedAtUtc: new Date() } as never,
    });
    return { id: row.id, teamId };
  }

  describe("ET-UPL-01 — no byte write into another member's sealed record", () => {
    it("a same-team MEMBER cannot open an upload session on the OWNER's SIGNED record", async () => {
      const A = h.fixtures.teamA;
      const ev = await signedTeamRecord(A.ownerUserId);
      const res = await h.app.inject({
        method: "POST", url: "/v1/uploads/sessions", headers: auth(A.memberToken),
        payload: { teamId: A.teamId, evidenceId: ev.id, expectedPartCount: 1, targetPartIndex: 9999, originalFileName: "x.png", expectedMimeType: "image/png" },
      });
      expect([404, 409]).toContain(res.statusCode);
      expect(await prisma.evidencePart.count({ where: { evidenceId: ev.id } })).toBe(1);
    });

    it("even the OWNER cannot open an upload session once the record is SIGNED", async () => {
      const A = h.fixtures.teamA;
      const ev = await signedTeamRecord(A.ownerUserId);
      const res = await h.app.inject({
        method: "POST", url: "/v1/uploads/sessions", headers: auth(A.ownerToken),
        payload: { teamId: A.teamId, evidenceId: ev.id, expectedPartCount: 1, targetPartIndex: 9999, originalFileName: "x.png", expectedMimeType: "image/png" },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("ET-CUS-01 — public Verify never discloses internal custody payloads", () => {
    it("legal-hold title, internal release note and actor ids never reach the anonymous answer", async () => {
      const { placeCanonicalLegalHold, releaseCanonicalLegalHold } = await import("../src/services/governance/legal-hold.service.js");
      const A = h.fixtures.teamA;
      const ev = await signedTeamRecord(A.ownerUserId);
      const TITLE = `CONFIDENTIAL-MATTER-${randomUUID().slice(0, 6)}`;
      const NOTE = `INTERNAL-ONLY-NOTE-${randomUUID().slice(0, 6)}`;
      const hold = await placeCanonicalLegalHold({ teamId: A.teamId, scope: "EVIDENCE", evidenceId: ev.id, actorUserId: A.ownerUserId, title: TITLE });
      await releaseCanonicalLegalHold({ teamId: A.teamId, holdId: hold.id, actorUserId: A.ownerUserId, releaseNote: NOTE });
      const res = await h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, ev.id)}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(TITLE);
      expect(res.body).not.toContain(NOTE);
      expect(res.body).not.toContain(A.ownerUserId);
      expect(res.body).not.toContain(hold.id);
    });
  });

  describe("ET-SEC-01 — an active legal hold stops destruction whatever the caller believed", () => {
    it("the executor re-reads holds inside its claim and refuses", async () => {
      const A = h.fixtures.teamA;
      const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
      const past = new Date(Date.now() - 40 * 86_400_000);
      const ev = await prisma.evidence.create({
        data: {
          title: "trashed", type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId,
          lifecycleState: "TRASHED", deletedAt: past, deleteScheduledForUtc: new Date(Date.now() - 86_400_000),
          storageBucket: "fixture-bucket", storageKey: `evidence/${randomUUID()}/original.png`,
        } as never,
        select: { id: true },
      });
      const { placeCanonicalLegalHold } = await import("../src/services/governance/legal-hold.service.js");
      await placeCanonicalLegalHold({ teamId: A.teamId, scope: "EVIDENCE", evidenceId: ev.id, actorUserId: A.ownerUserId, title: "placed after planning" });
      const { executeEvidenceDestruction } = await import("@proovra/shared-runtime");
      const deleted: string[] = [];
      const storage = {
        async listObjectVersions({ key }: { bucket: string; key: string }) {
          return deleted.includes(key) ? [] : [{ versionId: "v1", isDeleteMarker: false, isLatest: true, retainUntil: null, lockMode: null, legalHold: false }];
        },
        async listKeysUnderPrefix() { return []; },
        async deleteObjectVersion({ key }: { bucket: string; key: string; versionId: string }) { deleted.push(key); return { ok: true }; },
      };
      // The orchestrator gathered its facts before the hold existed.
      const result = await executeEvidenceDestruction(prisma as never, { evidenceId: ev.id, trigger: "destruction_review", legalHold: false }, storage as never);
      expect(result.outcome).not.toBe("DESTROYED");
      expect(deleted).toEqual([]);
      const after = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { destroyedAtUtc: true, lifecycleState: true } });
      expect(after.destroyedAtUtc).toBeNull();
      expect(after.lifecycleState).toBe("TRASHED");
    });
  });

  describe("ET-SEC-02 — case linkage never changes ownership", () => {
    it("detaching the last case leaves Evidence.teamId and workspace access unchanged", async () => {
      const A = h.fixtures.teamA;
      const c = await prisma.case.findUniqueOrThrow({ where: { id: A.caseId }, select: { id: true, ownerUserId: true } });
      const tokenFor = (u: string) => (u === A.ownerUserId ? A.ownerToken : u === A.adminUserId ? A.adminToken : A.memberToken);
      const ev = await signedTeamRecord(c.ownerUserId);
      const attach = await h.app.inject({ method: "POST", url: `/v1/cases/${c.id}/evidence`, headers: auth(tokenFor(c.ownerUserId)), payload: { evidenceId: ev.id } });
      expect(attach.statusCode).toBe(200);
      const detach = await h.app.inject({ method: "DELETE", url: `/v1/cases/${c.id}/evidence/${ev.id}`, headers: auth(tokenFor(c.ownerUserId)) });
      expect(detach.statusCode).toBe(200);
      const row = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id }, select: { teamId: true } });
      expect(row.teamId).toBe(A.teamId);
      const admin = await h.app.inject({ method: "GET", url: `/v1/evidence/${ev.id}`, headers: auth(A.adminToken) });
      expect(admin.statusCode).toBe(200);
    });
  });

  describe("ET-SEC-09 — a personal case cannot link another user's personal record", () => {
    it("link refused without disclosing existence; the record stays unreadable", async () => {
      const victimUserId = h.fixtures.personal.userId;
      const attacker = { userId: h.fixtures.teamB.memberUserId, token: h.fixtures.teamB.memberToken };
      const victimEv = await prisma.evidence.create({
        data: { title: `victim ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: null, ownerUserId: victimUserId } as never,
        select: { id: true },
      });
      // Legacy shape: a case with no workspace owned by the attacker.
      const legacyCase = await prisma.case.create({
        data: { name: `legacy ${randomUUID().slice(0, 6)}`, teamId: null, ownerUserId: attacker.userId } as never,
        select: { id: true },
      });
      const link = await h.app.inject({ method: "POST", url: `/v1/cases/${legacyCase.id}/evidence-links`, headers: auth(attacker.token), payload: { evidenceId: victimEv.id } });
      expect(link.statusCode).toBe(404);
      expect(await prisma.caseEvidenceLink.count({ where: { caseId: legacyCase.id } })).toBe(0);
      const read = await h.app.inject({ method: "GET", url: `/v1/evidence/${victimEv.id}`, headers: auth(attacker.token) });
      expect(read.statusCode).toBe(404);
    });
  });

  describe("ET-SEC-10 — the Verify headline never claims verified when a live check fails", () => {
    it("a stored 'passed' snapshot does not override a failing live signature check", async () => {
      const A = h.fixtures.teamA;
      const ev = await signedTeamRecord(A.ownerUserId, { verificationStatus: "RECORDED_INTEGRITY_VERIFIED" });
      const before = (await h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, ev.id)}` })).json();
      const findDecision = (o: unknown): unknown => {
        if (!o || typeof o !== "object") return null;
        const r = o as Record<string, unknown>;
        if (Array.isArray(r.signals)) return r;
        for (const v of Object.values(r)) { const f = findDecision(v); if (f) return f; }
        return null;
      };
      await prisma.report.create({
        data: { evidenceId: ev.id, version: 1, storageBucket: "fixture-bucket", storageKey: `reports/${ev.id}/v1.pdf`, generatedAtUtc: new Date(), trustDecisionSnapshot: findDecision(before) as never } as never,
      });
      await prisma.evidence.update({ where: { id: ev.id }, data: { signatureBase64: sign(null, Buffer.from("00".repeat(32), "hex"), privateKey).toString("base64") } as never });
      const res = await h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, ev.id)}` });
      const body = res.body;
      expect(body).toContain('"signatureValid":false');
      expect(body).not.toMatch(/Core Integrity Verified/);
    });
  });
});
