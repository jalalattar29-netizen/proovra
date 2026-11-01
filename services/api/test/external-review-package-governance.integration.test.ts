/**
 * REPORT-003 and RT-017 â€” external review answers to the same governance as a
 * member inside the workspace. Live PostgreSQL 16, real MinIO object, real HTTP.
 *
 * The reviewer's package release checked only the grant flag, the workspace
 * match and export eligibility, so `allowPackageDownload=false` and a blocking
 * verification policy did not reach a grant holder. A grant's original flag was
 * stored and shown as "Original + package" with no code behind it. A grant from
 * the plain route answered 500 at the portal.
 */
import { createHash, randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("external review package governance (live PostgreSQL 16, MinIO)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let s3: (typeof import("../src/storage.js"))["s3"];
  let issueExternalReviewGrant: (typeof import("../src/services/external-review/external-review-grant.service.js"))["issueExternalReviewGrant"];
  const A = () => h.fixtures.teamA;
  const bucket = () => process.env.S3_BUCKET as string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ s3 } = await import("../src/storage.js"));
    ({ issueExternalReviewGrant } = await import("../src/services/external-review/external-review-grant.service.js"));
  }, 180_000);

  afterEach(async () => {
    await prisma.workspaceGovernancePolicy.deleteMany({ where: { teamId: A().teamId } });
    await prisma.governancePolicyAssignment.deleteMany({ where: { teamId: A().teamId } });
    await prisma.governancePolicy.deleteMany({ where: { teamId: A().teamId } });
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  /** A signed record with a published EXTERNAL_DISCLOSURE package at a real object. */
  async function recordWithPackage(): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: "external review fixture",
        type: "DOCUMENT",
        status: "REPORTED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        signedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    const key = `verification/${row.id}/external.zip`;
    const body = Buffer.from(`package ${randomUUID()}`);
    await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body }));
    await prisma.report.create({
      data: { evidenceId: row.id, version: 1, storageBucket: "b", storageKey: `reports/${row.id}/v1.pdf`, generatedAtUtc: new Date(), sizeBytes: 1_000n },
    });
    await prisma.verificationPackage.create({
      data: {
        evidenceId: row.id,
        version: 1,
        storageBucket: bucket(),
        storageKey: key,
        generatedAtUtc: new Date(),
        sizeBytes: BigInt(body.length),
        reportVersion: 1,
        disclosureProfile: "EXTERNAL_DISCLOSURE",
        packageSha256: createHash("sha256").update(body).digest("hex"),
      } as never,
    });
    return row.id;
  }

  async function grantFor(evidenceId: string, over: Record<string, unknown> = {}) {
    const issued = await issueExternalReviewGrant({
      teamId: A().teamId,
      invitedByUserId: A().ownerUserId,
      scopeKind: "EVIDENCE",
      evidenceId,
      reviewerEmail: `rev-${randomUUID().slice(0, 8)}@test.proovra.local`,
      expiresAtUtc: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
      allowPackageDownload: true,
      ...over,
    } as never);
    if (!issued.ok) throw new Error(`grant refused: ${issued.reason}`);
    return issued;
  }
  const accept = (token: string) => h.app.inject({ method: "POST", url: `/v1/external-review/access/${token}` });
  const pkg = (token: string) => h.app.inject({ method: "GET", url: `/v1/external-review/access/${token}/verification-package` });
  const blocked = (id: string) =>
    prisma.custodyEvent.findMany({ where: { evidenceId: id, eventType: "EXPORT_BLOCKED_BY_POLICY" }, select: { payload: true } });

  it("positive control: an allowed grant gets the package URL and an authorization, not a claimed download", async () => {
    const id = await recordWithPackage();
    const g = await grantFor(id);
    await accept(g.rawToken);
    const res = await pkg(g.rawToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().url).toContain("verification/");
    expect(await blocked(id)).toHaveLength(0);
  });

  it("allowPackageDownload=false stops a grant holder with a policy refusal and a custody record", async () => {
    const id = await recordWithPackage();
    const g = await grantFor(id);
    await accept(g.rawToken);
    await prisma.workspaceGovernancePolicy.create({ data: { teamId: A().teamId, allowPackageDownload: false } as never });
    const res = await pkg(g.rawToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("PACKAGE_BLOCKED_BY_POLICY");
    expect(res.body).not.toContain("X-Amz");
    const rows = await blocked(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ reason: "package_disabled_by_policy", externalReviewGrantId: g.grant.id });
  });

  it("a verification policy that blocks publication stops a grant holder", async () => {
    const id = await recordWithPackage();
    const g = await grantFor(id);
    await accept(g.rawToken);
    const policy = await prisma.governancePolicy.create({
      data: {
        teamId: A().teamId,
        kind: "VERIFICATION",
        name: "Trust references",
        slug: `trust-${randomUUID().slice(0, 8)}`,
        summary: "Requires trust references",
        state: "ACTIVE",
        enforcementMode: "BLOCK",
        rule: { requireTrustReferences: true },
        createdByUserId: A().ownerUserId,
      } as never,
      select: { id: true },
    });
    await prisma.governancePolicyAssignment.create({
      data: { policyId: policy.id, teamId: A().teamId, scope: "WORKSPACE", scopeKind: "WORKSPACE", scopeTargetId: A().teamId, assignedByUserId: A().ownerUserId } as never,
    });
    const res = await pkg(g.rawToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("VERIFICATION_POLICY_BLOCKED");
  });

  it("an inviter who no longer holds the capability cannot keep releasing through a grant", async () => {
    const id = await recordWithPackage();
    const g = await grantFor(id, { invitedByUserId: A().memberUserId });
    await accept(g.rawToken);
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: A().teamId, userId: A().memberUserId } },
      data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) } as never,
    });
    try {
      const res = await pkg(g.rawToken);
      expect(res.statusCode, res.body).toBe(403);
    } finally {
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: A().teamId, userId: A().memberUserId } },
        data: { accessExpiresAtUtc: null } as never,
      });
    }
  });

  it("a request for originals is refused, and a stored flag is never offered to the reviewer", async () => {
    const id = await recordWithPackage();
    const refused = await h.app.inject({
      method: "POST",
      url: "/v1/external-review/grants",
      headers: { authorization: `Bearer ${A().ownerToken}`, "content-type": "application/json" },
      payload: {
        teamId: A().teamId,
        scopeKind: "EVIDENCE",
        evidenceId: id,
        reviewerEmail: "rev@test.proovra.local",
        allowOriginalDownload: true,
      } as never,
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe("external_review_originals_not_released");
    expect(await prisma.externalReviewGrant.count({ where: { evidenceId: id } })).toBe(0);

    // A row written before this fix keeps its history, and promises nothing.
    const legacy = await grantFor(id, { allowOriginalDownload: true });
    const opened = await accept(legacy.rawToken);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json().context.allowOriginalDownload).toBe(false);
  });

  it("RT-017: a grant with no portal invitation answers a typed refusal at the portal, and changes nothing", async () => {
    const id = await recordWithPackage();
    const g = await grantFor(id);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/portal/auth",
      headers: { "content-type": "application/json" },
      payload: { token: g.rawToken } as never,
    });
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json().denial).toBe("TOKEN_INVALID");
    expect((await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: g.grant.id } })).state).toBe("INVITED");
    expect(await prisma.externalReviewActivity.count({ where: { grantId: g.grant.id } })).toBe(0);
  });
});
