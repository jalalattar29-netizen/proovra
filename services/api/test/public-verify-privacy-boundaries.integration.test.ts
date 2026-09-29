/**
 * PRIVACY AND TRUTH BOUNDARIES ON THE BYTE- AND VERIFY-SERVING ROUTES
 * (2026-09-29, audit H3, M1, M4, M6 + cache headers). Real HTTP, live
 * PostgreSQL, genuinely signed records.
 *
 *   H3  under preview_only (the public Verify default) no item carries a
 *       presigned URL to the ORIGINAL bytes; full_access still does.
 *   M1  /v1/evidence/:id/parts withholds original URLs when the workspace
 *       policy refuses original download, and says why.
 *   M4  a soft-deleted record answers 404; a record in a restricted case is
 *       served the BASIC tier only.
 *   M6  the custody verdict walks the whole chain: a tampered link beyond the
 *       first 500 is caught.
 *   no-store on every public Verify answer, not only 200.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("verify / byte-serving privacy boundaries (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];
  const keyId = `priv-fixture-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    // A paid workspace, so RICH is otherwise available.
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 180_000);

  afterEach(() => {
    delete process.env.PUBLIC_VERIFY_CONTENT_MODE;
  });

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await h?.cleanup();
  });

  async function signedRecord() {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const row = await prisma.evidence.create({
      data: { title: "privacy fixture", type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
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
        mimeType: "image/png",
        storageBucket: process.env.S3_BUCKET ?? "fixture-bucket",
        storageKey: `evidence/${row.id}/original.png`,
        sizeBytes: 10n,
      } as never,
    });
    await prisma.evidencePart.create({
      data: {
        evidenceId: row.id,
        partIndex: 0,
        storageBucket: process.env.S3_BUCKET ?? "fixture-bucket",
        storageKey: `evidence/${row.id}/parts/000-original.png`,
        mimeType: "image/png",
        sizeBytes: 10n,
        sha256: fileSha256,
      } as never,
    });
    return row.id;
  }

  const verify = (id: string) => h.app.inject({ method: "GET", url: `/public/verify/${id}` });
  const viewUrls = (body: unknown): unknown[] =>
    JSON.stringify(body).match(/"viewUrl":("[^"]*"|null)/g)?.map((m) => m.slice(10)) ?? [];

  it("H3: under preview_only no item carries a presigned URL to the original; full_access does", async () => {
    const id = await signedRecord();
    const preview = await verify(id);
    expect(preview.statusCode, preview.body).toBe(200);
    const pBody = preview.json();
    // A paid workspace: the RICH tier, where content items exist.
    expect(pBody.tier).toBe("RICH");
    if (pBody.tier === "RICH") {
      expect(viewUrls(pBody).every((u) => u === "null"), "no original URL under preview_only").toBe(true);
      process.env.PUBLIC_VERIFY_CONTENT_MODE = "full_access";
      const full = (await verify(id)).json();
      expect(viewUrls(full).some((u) => u !== "null"), "full_access still links the original").toBe(true);
    } else {
      // A BASIC answer carries no content at all.
      expect(viewUrls(pBody)).toEqual([]);
    }
  });

  it("M4: a record in a restricted case is served BASIC only; the same record unrestricted is not forced to BASIC", async () => {
    const id = await signedRecord();
    const before = (await verify(id)).json().tier;
    const c = await prisma.case.create({
      data: { name: `restricted ${randomUUID().slice(0, 6)}`, teamId: h.fixtures.teamA.teamId, ownerUserId: h.fixtures.teamA.ownerUserId } as never,
      select: { id: true },
    });
    await prisma.caseAccess.create({ data: { caseId: c.id, userId: h.fixtures.teamA.adminUserId } });
    await prisma.caseEvidenceLink.create({ data: { caseId: c.id, evidenceId: id } as never });
    const after = await verify(id);
    expect(after.statusCode).toBe(200);
    expect(after.json().tier).toBe("BASIC");
    expect(after.json().basicVerification.original.state).toBe("verified");
    expect(["BASIC", "RICH"]).toContain(before);
  });

  it("M4: a soft-deleted record answers 404, and every non-200 answer is no-store", async () => {
    const id = await signedRecord();
    await prisma.evidence.update({ where: { id }, data: { deletedAt: new Date() } });
    const res = await verify(id);
    expect(res.statusCode).toBe(404);
    expect(String(res.headers["cache-control"])).toContain("no-store");
    const missing = await verify(randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(String(missing.headers["cache-control"])).toContain("no-store");
  });

  it("M6: a tampered custody link beyond the first 500 fails the chain", async () => {
    const id = await signedRecord();
    const { appendCustodyEvent } = await import("../src/services/custody-events.service.js");
    for (let i = 0; i < 510; i++) {
      await appendCustodyEvent({ evidenceId: id, eventType: "EVIDENCE_VIEWED" as never, payload: { i } as never });
    }
    const clean = (await verify(id)).json();
    expect(clean.basicVerification.original.checks.custodyChainValid).toBe(true);
    const target = await prisma.custodyEvent.findFirstOrThrow({ where: { evidenceId: id }, orderBy: { sequence: "desc" }, skip: 5, select: { id: true } });
    await prisma.custodyEvent.update({ where: { id: target.id }, data: { payload: { tampered: true } as never } });
    const tampered = (await verify(id)).json();
    expect(tampered.basicVerification.original.checks.custodyChainValid).toBe(false);
    expect(tampered.basicVerification.original.state).toBe("failed");
  }, 120_000);

  it("M1: /parts carries no original URL when the workspace refuses original download, and says why", async () => {
    const id = await signedRecord();
    const { teamId } = h.fixtures.teamA;
    const parts = () =>
      h.app.inject({ method: "GET", url: `/v1/evidence/${id}/parts`, headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` } });
    const allowed = (await parts()).json();
    expect(allowed.originalDownloadBlockedByPolicy).toBe(false);
    expect(allowed.parts[0].url).toBeTruthy();

    const existing = await prisma.workspaceGovernancePolicy.findFirst({ where: { teamId }, select: { id: true } });
    if (existing) {
      await prisma.workspaceGovernancePolicy.update({ where: { id: existing.id }, data: { allowOriginalDownload: false } });
    } else {
      await prisma.workspaceGovernancePolicy.create({ data: { teamId, allowOriginalDownload: false } as never });
    }
    try {
      const blocked = (await parts()).json();
      expect(blocked.originalDownloadBlockedByPolicy).toBe(true);
      expect(blocked.parts[0].url).toBeNull();
      expect(blocked.parts[0].previewUrl).toBeNull();
      expect(blocked.parts[0].sha256).toBeTruthy(); // metadata stays
    } finally {
      await prisma.workspaceGovernancePolicy.updateMany({ where: { teamId }, data: { allowOriginalDownload: true } });
    }
  });
});
