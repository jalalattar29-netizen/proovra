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
});
