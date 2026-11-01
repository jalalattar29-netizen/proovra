/**
 * REPORT-001 — reviewer links and public disclosure answer to workspace
 * governance. Real routes, real PostgreSQL, real step-up ceremony.
 *
 * A reviewer link used to be decided by `evidence.publish_verify` plus a
 * step-up, so a member could hand an anonymous holder the original bytes that
 * `GET /original` refused them, in a workspace whose policy forbids it. An old
 * link kept doing so after the policy changed, and rotate and renew reissued
 * the grant with no step-up.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("share governance (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let clearRates: () => Promise<unknown>;
  let generateVerificationRef: () => string;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  const keyId = `shgov-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let ipCounter = 10;
  const nextIp = () => `198.51.101.${(ipCounter = ipCounter >= 250 ? 10 : ipCounter + 1)}`;

  beforeAll(async () => {
    process.env.PUBLIC_VERIFY_CONTENT_MODE = "full_access";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    ({ generateVerificationRef } = await import("@proovra/shared-runtime"));
    stepUp = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
  }, 180_000);

  beforeEach(async () => {
    await clearRates();
    await prisma.stepUpChallenge.deleteMany({
      where: { initiatedByUserId: { in: [A().ownerUserId, A().memberUserId] } },
    });
  });

  afterEach(async () => {
    await prisma.workspaceGovernancePolicy.deleteMany({ where: { teamId: A().teamId } });
    await prisma.governancePolicy.deleteMany({ where: { teamId: A().teamId } }).catch(() => undefined);
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  const A = () => h.fixtures.teamA;

  async function setPolicy(data: Record<string, unknown>) {
    await prisma.workspaceGovernancePolicy.upsert({
      where: { teamId: A().teamId },
      create: { teamId: A().teamId, ...data } as never,
      update: data as never,
    });
  }

  async function signedRecord(): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: "share governance private title",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        signedAtUtc: new Date(),
        mimeType: "image/png",
        sizeBytes: BigInt(10),
        storageBucket: "bucket",
        storageKey: `shgov/${randomUUID()}/image.png`,
      } as never,
      select: { id: true },
    });
    const fileSha256 = sha(randomUUID());
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
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
        verificationRef: generateVerificationRef(),
        verificationRefIssuedAtUtc: new Date(),
      } as never,
    });
    return row.id;
  }

  const api = (
    method: "GET" | "POST" | "PUT",
    url: string,
    token: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json" } : {}), ...headers },
      ...(payload ? { payload: payload as never } : {}),
    });
  const verify = (segment: string) =>
    h.app.inject({ method: "GET", url: `/public/verify/${segment}`, remoteAddress: nextIp() });

  const stepUpFor = (id: string, who: { token: string; userId: string }) =>
    stepUp.approvedHeader({
      token: who.token,
      userId: who.userId,
      teamId: A().teamId,
      purpose: "PUBLIC_VERIFY_PUBLISH",
      resourceKind: "evidence",
      resourceId: id,
    });
  const owner = () => ({ token: A().ownerToken, userId: A().ownerUserId });
  const member = () => ({ token: A().memberToken, userId: A().memberUserId });

  async function createOriginalLink(id: string, who = owner()) {
    const res = await api(
      "POST",
      `/v1/evidence/${id}/verify-links`,
      who.token,
      { audience: "Expert", expiresInDays: 7, allowOriginalDownload: true },
      await stepUpFor(id, who),
    );
    return res;
  }

  const blockedRows = (id: string) =>
    prisma.custodyEvent.findMany({
      where: { evidenceId: id, eventType: "EXPORT_BLOCKED_BY_POLICY" },
      select: { payload: true },
    });
  const links = (id: string) => prisma.verificationShareToken.count({ where: { evidenceId: id, purpose: "OWNER_SHARE" } });

  // Positive control: everything below is refused by policy, not by the path.
  it("with the policy open, a stepped-up owner grants originals and the anonymous answer carries the release", async () => {
    const id = await signedRecord();
    const created = await createOriginalLink(id);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().link.allowOriginalDownload).toBe(true);
    const page = await verify(created.json().token);
    expect(page.statusCode, page.body).toBe(200);
    const body = page.json();
    expect(body.disclosure).toMatchObject({ mode: "CONTENT_PREVIEW", source: "REVIEWER_SHARE", originalDownload: true });
    expect(body.evidenceContent.items.some((i: { viewUrl?: string | null }) => typeof i.viewUrl === "string")).toBe(true);
    // REPORT-010 — the page does not say originals are never published here.
    expect(JSON.stringify(body.canonicalVerification.limitations)).not.toContain("does not publish the original");
    expect(JSON.stringify(body.canonicalVerification.limitations)).toContain("original");
  });

  it("allowOriginalDownload=false refuses the grant by any member, before any challenge is spent, with a custody refusal", async () => {
    const id = await signedRecord();
    await setPolicy({ allowOriginalDownload: false });
    const refused = await api("POST", `/v1/evidence/${id}/verify-links`, A().memberToken, {
      audience: "Expert",
      expiresInDays: 7,
      allowOriginalDownload: true,
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().code).toBe("ORIGINAL_DOWNLOAD_BLOCKED_BY_POLICY");
    expect(await links(id)).toBe(0);
    const rows = await blockedRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ action: "share_link_create", reason: "original_download_disabled_by_policy" });
    // The same member may still share without originals: the policy names originals.
    const plain = await api("POST", `/v1/evidence/${id}/verify-links`, A().memberToken, { audience: "Peer", expiresInDays: 7 });
    expect(plain.statusCode, plain.body).toBe(201);
  });

  it("an existing link stops releasing originals when the policy turns off, and truthfully stops saying it does", async () => {
    const id = await signedRecord();
    const created = await createOriginalLink(id);
    expect(created.statusCode, created.body).toBe(201);
    const token = created.json().token as string;
    await setPolicy({ allowOriginalDownload: false });
    const page = await verify(token);
    expect(page.statusCode, page.body).toBe(200);
    const body = page.json();
    expect(body.disclosure).toMatchObject({ mode: "CONTENT_PREVIEW", originalDownload: false });
    expect(page.body).not.toContain("X-Amz-Signature");
    expect(body.evidenceContent.items.every((i: { viewUrl?: string | null }) => i.viewUrl === null)).toBe(true);
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "VERIFY_VIEWED", payload: { path: ["artifact"], equals: "original" } } })).toBe(0);
    // Policy restored: the link's grant was never rewritten, so it answers again.
    await setPolicy({ allowOriginalDownload: true });
    expect((await verify(token)).json().disclosure.originalDownload).toBe(true);
  });

  it("an existing link whose creator no longer holds the capability stops releasing originals", async () => {
    const id = await signedRecord();
    const created = await createOriginalLink(id, member());
    expect(created.statusCode, created.body).toBe(201);
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: A().teamId, userId: A().memberUserId } },
      data: { role: "VIEWER" },
    });
    try {
      const body = (await verify(created.json().token)).json();
      expect(body.disclosure.originalDownload).toBe(false);
    } finally {
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: A().teamId, userId: A().memberUserId } },
        data: { role: "MEMBER" },
      });
    }
  });

  it("rotate and renew of an original-granting link demand a step-up and obey the policy; a plain link needs neither", async () => {
    const id = await signedRecord();
    const created = await createOriginalLink(id);
    const linkId = created.json().link.id as string;

    const noRotate = await api("POST", `/v1/evidence/${id}/verify-links/${linkId}/rotate`, A().memberToken);
    expect(noRotate.statusCode, noRotate.body).toBe(401);
    expect(noRotate.json().error.code).toBe("STEP_UP_REQUIRED");
    const noRenew = await api("POST", `/v1/evidence/${id}/verify-links/${linkId}/renew`, A().memberToken, { days: 7 });
    expect(noRenew.statusCode, noRenew.body).toBe(401);
    // Nothing changed: the old token still answers.
    expect((await verify(created.json().token)).statusCode).toBe(200);

    await setPolicy({ allowOriginalDownload: false });
    const blocked = await api("POST", `/v1/evidence/${id}/verify-links/${linkId}/rotate`, A().ownerToken);
    expect(blocked.statusCode, blocked.body).toBe(403);
    expect(blocked.json().code).toBe("ORIGINAL_DOWNLOAD_BLOCKED_BY_POLICY");
    await setPolicy({ allowOriginalDownload: true });

    const withStep = await api(
      "POST",
      `/v1/evidence/${id}/verify-links/${linkId}/renew`,
      A().ownerToken,
      { days: 7 },
      await stepUpFor(id, owner()),
    );
    expect(withStep.statusCode, withStep.body).toBe(200);
    const rotated = await api(
      "POST",
      `/v1/evidence/${id}/verify-links/${linkId}/rotate`,
      A().ownerToken,
      undefined,
      await stepUpFor(id, owner()),
    );
    expect(rotated.statusCode, rotated.body).toBe(201);
    expect((await verify(created.json().token)).statusCode).toBe(410);

    const plain = await api("POST", `/v1/evidence/${id}/verify-links`, A().ownerToken, { audience: "Peer", expiresInDays: 7 });
    expect(plain.statusCode).toBe(201);
    const plainRotate = await api("POST", `/v1/evidence/${id}/verify-links/${plain.json().link.id}/rotate`, A().memberToken);
    expect(plainRotate.statusCode, plainRotate.body).toBe(201);
  });

  it("allowPublicVerify=false blocks new links, renewal and widening; an existing page keeps answering", async () => {
    const id = await signedRecord();
    const before = await api("POST", `/v1/evidence/${id}/verify-links`, A().ownerToken, { audience: "Peer", expiresInDays: 7 });
    expect(before.statusCode, before.body).toBe(201);
    await setPolicy({ allowPublicVerify: false });

    const create = await api("POST", `/v1/evidence/${id}/verify-links`, A().ownerToken, { audience: "Another", expiresInDays: 7 });
    expect(create.statusCode, create.body).toBe(403);
    expect(create.json().code).toBe("PUBLIC_VERIFY_BLOCKED_BY_POLICY");
    const renew = await api("POST", `/v1/evidence/${id}/verify-links/${before.json().link.id}/renew`, A().ownerToken, { days: 7 });
    expect(renew.statusCode, renew.body).toBe(403);

    const widen = await api("PUT", `/v1/evidence/${id}/verification-disclosure`, A().ownerToken, {
      mode: "CONTENT_PREVIEW",
      showRecordedLocation: false,
      expectedVersion: 0,
    });
    expect(widen.statusCode, widen.body).toBe(403);
    expect(widen.json().code).toBe("PUBLIC_VERIFY_BLOCKED_BY_POLICY");
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { verificationDisclosureMode: true, verificationRef: true } });
    expect(row.verificationDisclosureMode).toBe("VERIFICATION_ONLY");

    // UI promise: "does not unpublish existing pages". pvr_ stays by the 2026-10-14 decision.
    expect((await verify(before.json().token)).statusCode).toBe(200);
    expect((await verify(row.verificationRef!)).statusCode).toBe(200);
  });

  it("requireReviewBeforePublicVerify and requirePublicationApproval both need the recorded approval", async () => {
    const id = await signedRecord();
    for (const data of [{ requireReviewBeforePublicVerify: true }, { requirePublicationApproval: true }]) {
      await setPolicy({ requireReviewBeforePublicVerify: false, requirePublicationApproval: false, ...data });
      const refused = await api("POST", `/v1/evidence/${id}/verify-links`, A().ownerToken, { audience: "Peer", expiresInDays: 7 });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().code).toBe("PUBLIC_VERIFY_BLOCKED_BY_POLICY");
    }
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { teamId: true } });
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId: id, teamId: row.teamId!, workspaceType: "TEAM", status: "APPROVED_INTERNAL" } as never,
    });
    const allowed = await api("POST", `/v1/evidence/${id}/verify-links`, A().ownerToken, { audience: "Peer", expiresInDays: 7 });
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  it("a verification policy that blocks public exposure refuses new links and narrows an existing content page at read", async () => {
    const id = await signedRecord();
    const before = await api("POST", `/v1/evidence/${id}/verify-links`, A().ownerToken, { audience: "Peer", expiresInDays: 7 });
    expect(before.statusCode, before.body).toBe(201);
    expect((await verify(before.json().token)).json().disclosure.mode).toBe("CONTENT_PREVIEW");
    const policy = await prisma.governancePolicy.create({
      data: {
        teamId: A().teamId,
        kind: "VERIFICATION",
        name: "No public exposure",
        slug: `no-public-exposure-${randomUUID().slice(0, 8)}`,
        summary: "Blocks public exposure",
        state: "ACTIVE",
        enforcementMode: "BLOCK",
        rule: { blockedPublicExposure: true },
        createdByUserId: A().ownerUserId,
      } as never,
      select: { id: true },
    });
    await prisma.governancePolicyAssignment.create({
      data: {
        policyId: policy.id,
        teamId: A().teamId,
        scope: "WORKSPACE",
        scopeKind: "WORKSPACE",
        scopeTargetId: A().teamId,
        assignedByUserId: A().ownerUserId,
      } as never,
    });

    const refused = await api("POST", `/v1/evidence/${id}/verify-links`, A().ownerToken, { audience: "Another", expiresInDays: 7 });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().code).toBe("VERIFICATION_POLICY_BLOCKED");
    const page = await verify(before.json().token);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().disclosure).toMatchObject({ mode: "VERIFICATION_ONLY", originalDownload: false });
  });

  it("a restricted-role member cannot rotate a grant they could not have issued", async () => {
    const id = await signedRecord();
    const created = await createOriginalLink(id);
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: A().teamId, userId: A().viewerUserId } },
      data: { role: "VIEWER" },
    });
    // A VIEWER holds neither capability: the record-access authority answers first.
    const res = await api("POST", `/v1/evidence/${id}/verify-links/${created.json().link.id}/rotate`, A().viewerToken);
    expect(res.statusCode).toBe(403);
    expect((await verify(created.json().token)).statusCode).toBe(200);
  });
});
