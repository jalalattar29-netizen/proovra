/**
 * THE BYTE-RELEASE AUTHORITY (2026-09-29, audit M2 + the legal-hold rule) —
 * live PostgreSQL 16, real HTTP.
 *
 * Every route that hands out ORIGINAL bytes (a presigned GET of the original
 * object) or a report/package download answers the same gate:
 *
 *   * a record with NO workspace row is released to its Personal OWNER only —
 *     a case collaborator who may read it may not take it, and an unrelated
 *     user cannot even see it;
 *   * a workspace record: ACTIVE membership + workspace policy; a former
 *     (revoked) member gets the anti-enumeration 404;
 *   * export eligibility applies to the ORIGINAL too: a legal hold of ANY
 *     scope (evidence, case, workspace) and a trashed record release nothing
 *     — not /original, not the /parts urls, not the report, not the public
 *     Verify page's original links — and releasing the hold restores it.
 *
 * A hidden UI control is not what is tested: each assertion is on the route's
 * own status and on whether a presigned URL is present in the response.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("byte-release authority (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const keyId = `bra-fixture-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bucket = process.env.S3_BUCKET ?? "fixture-bucket";

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);

  afterEach(() => {
    delete process.env.PUBLIC_VERIFY_CONTENT_MODE;
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  /** A signed record with an original, one part and report v1. */
  async function record(input: { teamId: string | null; ownerUserId: string }) {
    const organizationId = input.teamId
      ? (await prisma.team.findUniqueOrThrow({ where: { id: input.teamId }, select: { organizationId: true } })).organizationId
      : null;
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const row = await prisma.evidence.create({
      data: {
        title: "byte-release fixture",
        type: "PHOTO",
        status: "REPORTED",
        teamId: input.teamId,
        organizationId,
        ownerUserId: input.ownerUserId,
      } as never,
      select: { id: true },
    });
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
        mimeType: "image/png",
        storageBucket: bucket,
        storageKey: `evidence/${row.id}/original.png`,
        sizeBytes: 10n,
        latestReportVersion: 1,
      } as never,
    });
    await prisma.evidencePart.create({
      data: {
        evidenceId: row.id,
        partIndex: 0,
        storageBucket: bucket,
        storageKey: `evidence/${row.id}/parts/000-original.png`,
        mimeType: "image/png",
        sizeBytes: 10n,
        sha256: fileSha256,
      } as never,
    });
    await prisma.report.create({
      data: { evidenceId: row.id, version: 1, storageBucket: bucket, storageKey: `reports/${row.id}/v1.pdf`, generatedAtUtc: new Date() },
    });
    return row.id;
  }

  const get = (url: string, token?: string) =>
    h.app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

  /** Status + whether a presigned URL came back, for each byte route. */
  async function bytes(id: string, token: string) {
    const original = await get(`/v1/evidence/${id}/original`, token);
    const parts = await get(`/v1/evidence/${id}/parts`, token);
    const report = await get(`/v1/evidence/${id}/report/latest`, token);
    const partsBody = parts.statusCode === 200 ? parts.json() : null;
    return {
      original: original.statusCode,
      originalCode: original.statusCode === 403 ? original.json().code : null,
      originalUrl: original.statusCode === 200 ? Boolean(original.json().url) : false,
      parts: parts.statusCode,
      partUrls: partsBody ? (partsBody.parts as Array<{ url: string | null }>).filter((p) => p.url).length : 0,
      partsBlocked: partsBody?.originalDownloadBlockedByPolicy ?? null,
      report: report.statusCode,
      reportCode: report.statusCode === 403 ? report.json().code : null,
      // Past the gate the route HEADs the stored PDF; the fixture has no
      // object, so a released report answers 410 report_artifact_missing.
      reportGatePassed: report.statusCode === 410 && report.json().code === "report_artifact_missing",
    };
  }

  async function hold(input: { teamId: string; evidenceId?: string; caseId?: string; scope: "EVIDENCE" | "CASE" | "WORKSPACE"; by: string }) {
    return prisma.evidenceLegalHold.create({
      data: {
        teamId: input.teamId,
        scope: input.scope,
        evidenceId: input.evidenceId ?? null,
        caseId: input.caseId ?? null,
        title: "byte-release hold",
        placedByUserId: input.by,
      } as never,
      select: { id: true },
    });
  }
  const release = (id: string) =>
    prisma.evidenceLegalHold.update({ where: { id }, data: { status: "RELEASED", releasedAtUtc: new Date() } as never });

  // ---- M2: a record with no workspace row ------------------------------------

  it("Personal NULL-team record: the owner gets the bytes", async () => {
    const { personal } = h.fixtures;
    const id = await record({ teamId: null, ownerUserId: personal.userId });
    const b = await bytes(id, personal.token);
    expect(b).toMatchObject({ original: 200, originalUrl: true, parts: 200, partUrls: 1, partsBlocked: false, reportGatePassed: true });
  });

  it("Personal NULL-team record: an unrelated user sees nothing (404) and gets no URL", async () => {
    const { personal, teamB } = h.fixtures;
    const id = await record({ teamId: null, ownerUserId: personal.userId });
    const b = await bytes(id, teamB.ownerToken);
    expect(b).toMatchObject({ original: 404, originalUrl: false, parts: 404, partUrls: 0, report: 404 });
  });

  it("Personal NULL-team record: a CaseAccess row grants nothing — the collaborator is refused like any outsider", async () => {
    const { personal, teamA } = h.fixtures;
    const id = await record({ teamId: null, ownerUserId: personal.userId });
    // A personal case of the owner, shared with one outside user.
    const c = await prisma.case.create({
      data: { name: `bra-${randomUUID().slice(0, 8)}`, ownerUserId: personal.userId } as never,
      select: { id: true },
    });
    await prisma.caseAccess.create({ data: { caseId: c.id, userId: teamA.memberUserId } });
    await prisma.caseEvidenceLink.create({ data: { caseId: c.id, evidenceId: id } as never });

    // ET-SEC-04 (Invariant D): a CaseAccess row is not membership. A personal
    // record belongs to its owner alone; the collaborator reads nothing and
    // takes nothing — the same anti-enumeration answer as an outsider.
    const b = await bytes(id, teamA.memberToken);
    expect(b).toMatchObject({ original: 404, parts: 404, report: 404, partUrls: 0 });
    const outsider = await bytes(id, teamA.viewerToken);
    expect(outsider).toMatchObject({ original: 404, parts: 404, report: 404, partUrls: 0 });
  });

  // ---- M2: a workspace record ------------------------------------------------

  it("workspace record: an ACTIVE member gets the bytes; a revoked former member gets 404", async () => {
    const { teamA } = h.fixtures;
    const id = await record({ teamId: teamA.teamId, ownerUserId: teamA.ownerUserId });
    expect(await bytes(id, teamA.memberToken)).toMatchObject({ original: 200, originalUrl: true, partUrls: 1, reportGatePassed: true });

    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: teamA.teamId, userId: teamA.memberUserId } },
      data: { status: "REVOKED" } as never,
    });
    try {
      expect(await bytes(id, teamA.memberToken)).toMatchObject({ original: 404, originalUrl: false, parts: 404, report: 404 });
    } finally {
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: teamA.teamId, userId: teamA.memberUserId } },
        data: { status: "ACTIVE" } as never,
      });
    }
  });

  // ---- The legal-hold rule: no bytes leave custody, for ANY hold scope --------

  for (const scope of ["EVIDENCE", "CASE", "WORKSPACE"] as const) {
    it(`a ${scope}-scope legal hold withholds the original, its parts and the report; release restores them`, async () => {
      const { teamA } = h.fixtures;
      const id = await record({ teamId: teamA.teamId, ownerUserId: teamA.ownerUserId });
      let caseId: string | undefined;
      if (scope === "CASE") {
        caseId = (
          await prisma.case.create({
            data: { name: `bra-hold-${randomUUID().slice(0, 8)}`, teamId: teamA.teamId, ownerUserId: teamA.ownerUserId } as never,
            select: { id: true },
          })
        ).id;
        await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId: id } as never });
      }
      const placed = await hold({
        teamId: teamA.teamId,
        scope,
        evidenceId: scope === "EVIDENCE" ? id : undefined,
        caseId,
        by: teamA.ownerUserId,
      });
      try {
        const held = await bytes(id, teamA.ownerToken);
        expect(held).toMatchObject({
          original: 403,
          originalCode: "BLOCKED_BY_HOLD",
          originalUrl: false,
          parts: 200,
          partUrls: 0,
          partsBlocked: true,
          report: 403,
          reportCode: "BLOCKED_BY_HOLD",
        });
        // The refused download is on the record's custody chain.
        const refusals = await prisma.custodyEvent.count({
          where: { evidenceId: id, eventType: "EXPORT_BLOCKED_BY_POLICY" },
        });
        expect(refusals).toBeGreaterThanOrEqual(2);
      } finally {
        await release(placed.id);
      }
      expect(await bytes(id, teamA.ownerToken)).toMatchObject({ original: 200, originalUrl: true, partUrls: 1, reportGatePassed: true });
    });
  }

  it("a hold on a Personal NULL-team record (recorded in the owner's personal workspace) withholds the owner's bytes", async () => {
    const { personal } = h.fixtures;
    const id = await record({ teamId: null, ownerUserId: personal.userId });
    const placed = await hold({ teamId: personal.teamId, scope: "EVIDENCE", evidenceId: id, by: personal.userId });
    try {
      expect(await bytes(id, personal.token)).toMatchObject({
        original: 403,
        originalCode: "BLOCKED_BY_HOLD",
        partUrls: 0,
        report: 403,
      });
    } finally {
      await release(placed.id);
    }
    expect(await bytes(id, personal.token)).toMatchObject({ original: 200, partUrls: 1, reportGatePassed: true });
  });

  it("a trashed record releases no original bytes", async () => {
    const { teamA } = h.fixtures;
    const id = await record({ teamId: teamA.teamId, ownerUserId: teamA.ownerUserId });
    await prisma.evidence.update({ where: { id }, data: { lifecycleState: "TRASHED" } as never });
    const b = await bytes(id, teamA.ownerToken);
    expect(b).toMatchObject({ original: 403, originalCode: "BLOCKED_BY_LIFECYCLE", partUrls: 0, report: 403 });
  });

  it("public Verify under full_access links no original while a hold is active", async () => {
    const { teamA } = h.fixtures;
    const id = await record({ teamId: teamA.teamId, ownerUserId: teamA.ownerUserId });
    await prisma.evidence.update({ where: { id }, data: { status: "SIGNED" } as never });
    process.env.PUBLIC_VERIFY_CONTENT_MODE = "full_access";
    const viewUrls = (body: unknown): string[] =>
      JSON.stringify(body).match(/"viewUrl":("[^"]*"|null)/g)?.map((m) => m.slice(10)) ?? [];

    const before = await get(`/public/verify/${id}`);
    expect(before.statusCode, before.body).toBe(200);
    expect(viewUrls(before.json()).some((u) => u !== "null"), "full_access links the original").toBe(true);

    const placed = await hold({ teamId: teamA.teamId, scope: "EVIDENCE", evidenceId: id, by: teamA.ownerUserId });
    try {
      const during = await get(`/public/verify/${id}`);
      expect(during.statusCode).toBe(200);
      expect(viewUrls(during.json()).every((u) => u === "null"), "no original URL under a hold").toBe(true);
    } finally {
      await release(placed.id);
    }
  }, 120_000);

  it("the export-eligibility probe answers a Personal NULL-team record for the owner's workspace as the gate decides it", async () => {
    const { personal } = h.fixtures;
    const id = await record({ teamId: null, ownerUserId: personal.userId });
    const probe = () =>
      get(`/v1/governance/export-eligibility?teamId=${personal.teamId}&evidenceId=${id}`, personal.token);
    const open = await probe();
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json().outcome).toBe("ALLOWED");
    const placed = await hold({ teamId: personal.teamId, scope: "EVIDENCE", evidenceId: id, by: personal.userId });
    try {
      expect((await probe()).json().outcome).toBe("BLOCKED_BY_HOLD");
    } finally {
      await release(placed.id);
    }
  });
});
