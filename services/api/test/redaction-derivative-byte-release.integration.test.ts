/**
 * ET-SEC-26 — a redacted derivative is released through THE byte-release
 * gate. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f GET /v1/redaction/derivatives/:id/download-url presigned the
 * derivative after its own workspace capability check only: no legal-hold,
 * lifecycle or export-eligibility evaluation — the one byte-release path
 * outside evaluateArtifactDownload.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("redacted derivative download goes through the byte-release gate (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const A = h.fixtures.teamA;
    await prisma.user.update({ where: { id: A.ownerUserId }, data: { currentWorkspaceId: A.teamId } });
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  /** A signed record with a READY redacted derivative; returns the derivative id. */
  async function readyDerivative(): Promise<{ evidenceId: string; derivativeId: string }> {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const { id: evidenceId } = await prisma.evidence.create({
      data: { title: "SEC-26 fixture", type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    created.push(evidenceId);
    const { id: projectId } = await prisma.redactionProject.create({
      data: { teamId: A.teamId, evidenceId, artifactKind: "IMAGE", createdByUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    const { id: versionId } = await prisma.redactionVersion.create({
      data: { projectId, teamId: A.teamId, versionOrdinal: 1, authoredByUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    const { id: derivativeId } = await prisma.redactionDerivative.create({
      data: {
        versionId,
        teamId: A.teamId,
        state: "READY",
        kind: "IMAGE",
        storageBucket: "redaction-test",
        storageKey: `redaction/${A.teamId}/${versionId}.png`,
        fileSha256: "a".repeat(64),
        generatedAtUtc: new Date(),
        renderedAtUtc: new Date(),
        contentType: "image/png",
        byteSize: BigInt(1024),
      } as never,
      select: { id: true },
    });
    return { evidenceId, derivativeId };
  }

  const download = (derivativeId: string) =>
    h.app.inject({
      method: "GET",
      url: `/v1/redaction/derivatives/${derivativeId}/download-url`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` },
    });

  it("a derivative of a record under an active legal hold is refused, releases no URL and is recorded on custody", async () => {
    const { evidenceId, derivativeId } = await readyDerivative();
    const A = h.fixtures.teamA;
    await prisma.evidenceLegalHold.create({
      data: {
        teamId: A.teamId,
        evidenceId,
        scope: "EVIDENCE",
        status: "ACTIVE",
        title: "SEC-26 hold",
        reason: "sec-26 test",
        placedByUserId: A.ownerUserId,
      } as never,
    });

    const res = await download(derivativeId);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).not.toContain("downloadUrl");
    const blocked = await prisma.custodyEvent.count({ where: { evidenceId, eventType: "EXPORT_BLOCKED_BY_POLICY" } });
    expect(blocked).toBe(1);
    const derivative = await prisma.redactionDerivative.findUniqueOrThrow({ where: { id: derivativeId }, select: { downloadCount: true } });
    expect(derivative.downloadCount).toBe(0);
  });

  it("a derivative of an unheld record is released (control)", async () => {
    const { derivativeId } = await readyDerivative();
    const res = await download(derivativeId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toHaveProperty("downloadUrl");
  });

  // ---------------------------------------------------------------------------
  // VIEWING IS NOT EXPORTING (release review, 2026-09-30).
  //
  // The gate asked only `evidence.read` for kind "redaction" and relied on the
  // route to have checked the explicit capability. The byte-release authority
  // itself must require it: the first test calls the AUTHORITY directly, the
  // way any second caller would.
  // ---------------------------------------------------------------------------
  describe("the derivative-download capability is required by the authority itself", () => {
    const asUser = async (userId: string) => {
      await prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: h.fixtures.teamA.teamId } });
    };
    const downloadAs = (token: string, derivativeId: string) =>
      h.app.inject({
        method: "GET",
        url: `/v1/redaction/derivatives/${derivativeId}/download-url`,
        headers: { authorization: `Bearer ${token}` },
      });
    const gate = async (userId: string, evidenceId: string) => {
      const { evaluateArtifactDownload } = await import("../src/services/evidence/artifact-download-gate.service.js");
      const { resolveEvidenceRecordAccess } = await import("../src/services/evidence/evidence-record-access.service.js");
      return evaluateArtifactDownload({
        evidenceId,
        actorUserId: userId,
        kind: "redaction",
        readAccess: async (u, e) => {
          const a = await resolveEvidenceRecordAccess({ userId: u, evidenceId: e, permission: "evidence.read" });
          if (!a.allowed) throw Object.assign(new Error("Evidence not found"), { statusCode: 404 });
        },
      });
    };
    const blockedCount = (evidenceId: string) =>
      prisma.custodyEvent.count({ where: { evidenceId, eventType: "EXPORT_BLOCKED_BY_POLICY" } });

    it("the AUTHORITY refuses a read-only member who can open the record — called directly, with no route in front", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId } = await readyDerivative();
      // The viewer CAN read the record…
      const { resolveEvidenceRecordAccess } = await import("../src/services/evidence/evidence-record-access.service.js");
      expect((await resolveEvidenceRecordAccess({ userId: A.viewerUserId, evidenceId, permission: "evidence.read" })).allowed).toBe(true);
      // …and that is not a licence to take the derivative.
      const decision = await gate(A.viewerUserId, evidenceId);
      expect(decision.allowed).toBe(false);
      expect(decision).toMatchObject({
        statusCode: 403,
        body: { code: "DERIVATIVE_DOWNLOAD_NOT_PERMITTED" },
      });
      expect(await blockedCount(evidenceId)).toBe(1);
      // The owner, who holds the capability, is allowed by the same call.
      expect((await gate(A.ownerUserId, evidenceId)).allowed).toBe(true);
    });

    it("viewer and ordinary member are refused over HTTP; nothing is released or counted", async () => {
      const A = h.fixtures.teamA;
      const { derivativeId } = await readyDerivative();
      for (const [userId, token] of [
        [A.viewerUserId, A.viewerToken],
        [A.memberUserId, A.memberToken],
      ] as const) {
        await asUser(userId);
        const res = await downloadAs(token, derivativeId);
        expect(res.statusCode, res.body).toBe(403);
        expect(res.body).not.toContain("downloadUrl");
      }
      const d = await prisma.redactionDerivative.findUniqueOrThrow({ where: { id: derivativeId }, select: { downloadCount: true } });
      expect(d.downloadCount).toBe(0);
    });

    it("a former member — and a member whose role was reduced — loses the download on the next request", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, derivativeId } = await readyDerivative();
      await asUser(A.adminUserId);
      expect((await downloadAs(A.adminToken, derivativeId)).statusCode).toBe(200);

      const where = { teamId_userId: { teamId: A.teamId, userId: A.adminUserId } };
      const before = await prisma.teamMember.findUniqueOrThrow({ where, select: { role: true, status: true } });
      try {
        // The grant is reduced: still an ACTIVE member who can read, no longer one who can export.
        await prisma.teamMember.update({ where, data: { role: "VIEWER" } });
        expect((await downloadAs(A.adminToken, derivativeId)).statusCode).toBe(403);
        expect((await gate(A.adminUserId, evidenceId)).allowed).toBe(false);

        // The membership is revoked: nothing about the workspace is answered.
        await prisma.teamMember.update({ where, data: { role: before.role, status: "REVOKED" } });
        const former = await downloadAs(A.adminToken, derivativeId);
        expect([403, 404]).toContain(former.statusCode);
        expect(former.body).not.toContain("downloadUrl");
        expect((await gate(A.adminUserId, evidenceId)).allowed).toBe(false);
      } finally {
        await prisma.teamMember.update({ where, data: { role: before.role, status: before.status } });
      }
      expect((await downloadAs(A.adminToken, derivativeId)).statusCode).toBe(200);
    });

    it("another workspace's owner cannot reach the derivative, by route or by authority", async () => {
      const B = h.fixtures.teamB;
      const { evidenceId, derivativeId } = await readyDerivative();
      await prisma.user.update({ where: { id: B.ownerUserId }, data: { currentWorkspaceId: B.teamId } });
      const res = await downloadAs(B.ownerToken, derivativeId);
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).not.toContain("downloadUrl");
      const decision = await gate(B.ownerUserId, evidenceId);
      expect(decision.allowed).toBe(false);
    });

    it("the released URL is the derivative's own object, short-lived — never the original", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, derivativeId } = await readyDerivative();
      await prisma.evidence.update({
        where: { id: evidenceId },
        data: { storageBucket: "originals-bucket", storageKey: `originals/${evidenceId}/secret-original.bin` },
      });
      await asUser(A.ownerUserId);
      const res = await downloadAs(A.ownerToken, derivativeId);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { downloadUrl: string; expiresAtUtc: string };
      expect(body.downloadUrl).toContain("/redaction/");
      expect(body.downloadUrl).not.toContain("secret-original");
      expect(body.downloadUrl).not.toContain("originals-bucket");
      const ttlMs = Date.parse(body.expiresAtUtc) - Date.now();
      expect(ttlMs).toBeGreaterThan(0);
      expect(ttlMs).toBeLessThanOrEqual(300_000);
      // The release is audited on the redaction timeline and counted.
      const d = await prisma.redactionDerivative.findUniqueOrThrow({ where: { id: derivativeId }, select: { downloadCount: true } });
      expect(d.downloadCount).toBe(1);
    });
  });
});
