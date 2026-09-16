/**
 * BATCH K5 (part B) — runtime proof for the external-review, evidence-exchange
 * and organization mutations the UI sweep could not drive to their success
 * branch.
 *
 * Proven three ways against a disposable PostgreSQL 16: the authorized SUCCESS
 * branch (consumer payload, exact row re-read), the AUDIT record where the route
 * writes one, and an EXPECTED REFUSAL with no durable effect.
 *
 * Step-up is satisfied exactly as `step-up-totp-org-boundary.integration.test.ts`
 * does: a verified authenticator factor, then the real
 * `/v1/identity-security/step-up/start` + `/check` routes, with the challenge
 * bound to the same purpose/resource the route demands. No provider is ever
 * contacted: step-up is TOTP, and invitation email goes to the recording
 * transport installed by `test/setup/safe-environment.ts`.
 *
 * Payload sources:
 *   - apps/web/app/(app)/review/external/page.tsx      (bulk invitations)
 *   - apps/web/app/(app)/exchange/page.tsx              (sign-url, deliveries)
 *   - apps/web/app/(app)/organizations/…                (domains, invites, members)
 *   - the route zod schemas for the operator-only POSTs with no web consumer
 *
 * Fire-and-forget sinks (`safeEmitSecurityEvent`, and the bulk-batch tenant
 * audit) are read with `expect.poll` — a bounded wait for a write already
 * dispatched, never a retry of the action.
 *
 * Session-destroying action (org member removal revokes the target's sessions)
 * runs LAST, against a disposable persona.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];

type GrantRow = {
  id: string;
  team_id: string;
  scope_kind: string;
  evidence_id: string | null;
  state: string;
  invited_by_user_id: string;
  reviewer_email: string;
};

describe("K5-B — external review, exchange, organizations (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let orgA: string;
  const secrets = new Map<string, Buffer>();
  const disposableUsers: string[] = [];

  const call = (opts: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    token?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  const tag = () => randomUUID().slice(0, 8);
  const inTwoDays = () => new Date(Date.now() + 2 * 24 * 3_600_000).toISOString();

  async function seedTotp(userId: string): Promise<void> {
    const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
    const secret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(secret);
    const now = new Date();
    await prisma.mfaFactor.create({
      data: {
        userId,
        kind: "TOTP",
        status: "ACTIVE",
        label: "Authenticator",
        secretCiphertext: Buffer.from(sealed.ciphertext),
        secretIv: Buffer.from(sealed.iv),
        secretAuthTag: Buffer.from(sealed.authTag),
        secretKekId: sealed.kekId,
        verifiedAtUtc: now,
        enrolledAt: now,
      },
    });
    secrets.set(userId, secret);
  }

  /**
   * One real step-up round trip through the product routes.
   *
   * WCC-NEW-008 accepts each authenticator time step ONCE (factor.lastUsedAt).
   * This suite performs more step-ups per actor than a 30-second window holds,
   * so before each round the factor is put back in the state "the last code
   * this authenticator produced was accepted earlier" (lastUsedAt = null),
   * exactly as if the next window had arrived. The replay guard itself is
   * untouched and is still exercised below (a consumed challenge is refused).
   */
  async function stepUp(input: {
    token: string;
    userId: string;
    teamId: string;
    purpose: string;
    resourceKind?: string;
    resourceId?: string;
  }): Promise<string> {
    const started = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/start",
      token: input.token,
      payload: {
        teamId: input.teamId,
        purpose: input.purpose,
        ...(input.resourceKind ? { resourceKind: input.resourceKind } : {}),
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const challengeId = (started.json() as { challenge: { id: string } }).challenge.id;
    await prisma.mfaFactor.updateMany({
      where: { userId: input.userId, kind: "TOTP" },
      data: { lastUsedAt: null },
    });
    const code = totp.computeTotpCode(
      secrets.get(input.userId)!,
      totp.timeStep(Math.floor(Date.now() / 1000)),
    );
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token: input.token,
      payload: { teamId: input.teamId, challengeId, code },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }
  const STEP = "x-proovra-step-up-challenge-id";

  async function disposableUser(label: string): Promise<{ id: string; email: string; token: string }> {
    const { signJwt } = await import("../src/services/jwt.js");
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `k5-${label}-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "K5", lastName: label, provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    disposableUsers.push(user.id);
    const token = signJwt(
      {
        sub: user.id,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
      },
      process.env.AUTH_JWT_SECRET!,
      3600,
    );
    return { id: user.id, email, token };
  }

  const pointAt = (userId: string, teamId: string) =>
    prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: teamId } });

  const grantRows = (teamId: string, email: string) =>
    prisma.$queryRawUnsafe<GrantRow[]>(
      `SELECT "id", "team_id", "scope_kind", "evidence_id", "state",
              "invited_by_user_id", "reviewer_email"
         FROM "external_review_grants"
        WHERE "team_id" = $1::uuid AND "reviewer_email" = $2`,
      teamId,
      email,
    );

  const tenantAudit = (action: string, resourceId: string) =>
    expect.poll(
      () =>
        prisma.adminAuditLog.findFirst({
          where: { action, resourceId, outcome: "success" },
          orderBy: { createdAt: "desc" },
          select: { userId: true, workspaceId: true, outcome: true, resourceType: true, metadata: true },
        }),
      { timeout: 10_000, interval: 25 },
    );

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    const { teamA, teamB } = h.fixtures;
    orgA = (
      await prisma.team.findUniqueOrThrow({
        where: { id: teamA.teamId },
        select: { organizationId: true },
      })
    ).organizationId;

    // Organization A is an activated Enterprise customer: verified domains
    // (ssoScim) and External Review are both included. B is on TEAM, which
    // includes External Review too.
    await prisma.team.update({
      where: { id: teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    await prisma.team.update({
      where: { id: teamB.teamId },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });
    const { upsertEnterpriseContract } = await import(
      "../src/services/organization/enterprise-contract.service.js"
    );
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 50,
    });
    await prisma.organizationMembership.create({
      data: { organizationId: orgA, userId: teamA.memberUserId, role: "ORG_MEMBER" },
    });

    for (const userId of [teamA.ownerUserId, teamA.adminUserId, teamB.ownerUserId]) {
      await seedTotp(userId);
    }
    for (const f of [teamA, teamB]) {
      for (const userId of [f.ownerUserId, f.adminUserId, f.memberUserId, f.viewerUserId]) {
        await pointAt(userId, f.teamId);
      }
    }
  }, 900_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.organizationDomain.deleteMany({ where: { organizationId: orgA } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: disposableUsers } } }).catch(() => undefined);
    }
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // External review
  // ===========================================================================

  describe("external review", () => {
    it("POST /v1/external-review/invitations — owner issues an EVIDENCE-scoped invitation under step-up; a MEMBER is refused NOT_PERMITTED", async () => {
      const a = h.fixtures.teamA;
      const email = `k5-reviewer-${tag()}@outside.test`;
      const body = {
        reviewerEmail: email,
        reviewerDisplayName: "K5 Reviewer",
        organization: "Outside Counsel LLP",
        role: "EXTERNAL_REVIEWER",
        watermarkPolicy: "ALWAYS",
        mfaRequired: false,
        scope: { kind: "EVIDENCE", evidenceId: a.evidenceId },
        expiresAtUtc: inTwoDays(),
      };

      const member = await call({
        method: "POST",
        url: "/v1/external-review/invitations",
        token: a.memberToken,
        payload: body,
      });
      expect(member.statusCode).toBe(403);
      expect(member.json()).toEqual({ denial: "NOT_PERMITTED" });

      const noStepUp = await call({
        method: "POST",
        url: "/v1/external-review/invitations",
        token: a.ownerToken,
        payload: body,
      });
      expect(noStepUp.statusCode).toBe(401);
      expect((noStepUp.json() as { error: { code: string } }).error.code).toBe("STEP_UP_REQUIRED");
      expect(await grantRows(a.teamId, email)).toHaveLength(0);

      const challengeId = await stepUp({
        token: a.ownerToken,
        userId: a.ownerUserId,
        teamId: a.teamId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant",
        resourceId: a.evidenceId,
      });
      const res = await call({
        method: "POST",
        url: "/v1/external-review/invitations",
        token: a.ownerToken,
        payload: body,
        headers: { [STEP]: challengeId },
      });
      expect(res.statusCode, res.body).toBe(201);
      const out = res.json() as { grantId: string; role: string; rawToken: string };
      expect(out.role).toBe("EXTERNAL_REVIEWER");
      expect(out.rawToken).toMatch(/^[a-f0-9]{64}$/);

      const [grant] = await grantRows(a.teamId, email);
      expect(grant).toMatchObject({
        id: out.grantId,
        scope_kind: "EVIDENCE",
        evidence_id: a.evidenceId,
        state: "INVITED",
        invited_by_user_id: a.ownerUserId,
      });
      const assignment = await prisma.externalReviewerRoleAssignment.findUniqueOrThrow({
        where: { id: out.grantId },
      });
      expect(assignment).toMatchObject({
        teamId: a.teamId,
        role: "EXTERNAL_REVIEWER",
        inviteEmail: email,
        grantedByUserId: a.ownerUserId,
      });
      const activity = await prisma.externalReviewActivity.findFirstOrThrow({
        where: { grantId: out.grantId, code: "GRANT_ISSUED" },
      });
      expect(activity.teamId).toBe(a.teamId);
      await expect
        .poll(
          () =>
            prisma.securityEvent.findFirst({
              where: {
                teamId: a.teamId,
                eventType: "external_review_invited",
                details: { path: ["grantId"], equals: out.grantId },
              },
              select: { details: true },
            }),
          { timeout: 10_000, interval: 25 },
        )
        .toMatchObject({ details: { actorUserId: a.ownerUserId, scopeKind: "EVIDENCE" } });

      // The challenge is single-use.
      const replay = await call({
        method: "POST",
        url: "/v1/external-review/invitations",
        token: a.ownerToken,
        payload: { ...body, reviewerEmail: `replay-${email}` },
        headers: { [STEP]: challengeId },
      });
      expect(replay.statusCode).toBe(401);
      expect(await grantRows(a.teamId, `replay-${email}`)).toHaveLength(0);
    });

    it("POST /v1/external-review/invitations — a grant cannot be scoped to ANOTHER tenant's evidence", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const email = `k5-crosstenant-${tag()}@outside.test`;
      const challengeId = await stepUp({
        token: a.ownerToken,
        userId: a.ownerUserId,
        teamId: a.teamId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant",
        resourceId: b.evidenceId,
      });
      const res = await call({
        method: "POST",
        url: "/v1/external-review/invitations",
        token: a.ownerToken,
        payload: {
          reviewerEmail: email,
          role: "EXTERNAL_REVIEWER",
          scope: { kind: "EVIDENCE", evidenceId: b.evidenceId },
          expiresAtUtc: inTwoDays(),
        },
        headers: { [STEP]: challengeId },
      });
      // Refused before any row is written, with the same bounded denial a
      // missing scope target receives (nothing about tenant B is revealed).
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({ denial: "POLICY_REJECTED" });
      expect(await grantRows(a.teamId, email)).toHaveLength(0);
      expect(await prisma.externalReviewerRoleAssignment.count({ where: { inviteEmail: email } })).toBe(0);
    });

    it("POST /v1/external-review/invitations/bulk — an ADMIN bulk-issues under step-up (emails recorded, tenant audit); a MEMBER is refused", async () => {
      const a = h.fixtures.teamA;
      const e1 = `k5-bulk-1-${tag()}@outside.test`;
      const e2 = `k5-bulk-2-${tag()}@outside.test`;
      const body = {
        expiresAtUtc: inTwoDays(),
        defaultRole: "EXTERNAL_REVIEWER",
        defaultWatermarkPolicy: "ALWAYS",
        defaultMfaRequired: false,
        defaultScope: { kind: "EVIDENCE", evidenceId: a.evidenceId },
        rows: [
          { inviteEmail: e1, displayName: "Bulk One", organization: "Outside LLP" },
          { inviteEmail: e2, displayName: "Bulk Two" },
          { inviteEmail: e1 },
        ],
      };

      const member = await call({
        method: "POST",
        url: "/v1/external-review/invitations/bulk",
        token: a.memberToken,
        payload: body,
      });
      expect(member.statusCode).toBe(403);
      expect(member.json()).toEqual({ denial: "NOT_PERMITTED" });
      expect(await grantRows(a.teamId, e1)).toHaveLength(0);

      const challengeId = await stepUp({
        token: a.adminToken,
        userId: a.adminUserId,
        teamId: a.teamId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant_bulk",
      });
      const res = await call({
        method: "POST",
        url: "/v1/external-review/invitations/bulk",
        token: a.adminToken,
        payload: body,
        headers: { [STEP]: challengeId },
      });
      expect(res.statusCode, res.body).toBe(201);
      const out = res.json() as {
        bulkBatchId: string;
        rows: Array<{ inviteEmail: string; outcome: string; grantId: string | null }>;
        summary: Record<string, number>;
      };
      expect(out.summary).toMatchObject({ INVITED: 2, DUPLICATE: 1, FAILED: 0 });
      expect(JSON.stringify(out)).not.toMatch(/[a-f0-9]{64}/);
      for (const email of [e1, e2]) {
        const [grant] = await grantRows(a.teamId, email);
        expect(grant).toMatchObject({
          scope_kind: "EVIDENCE",
          evidence_id: a.evidenceId,
          state: "INVITED",
          invited_by_user_id: a.adminUserId,
        });
      }
      await tenantAudit("external_review.invitations.bulk_issued", out.bulkBatchId).toMatchObject({
        userId: a.adminUserId,
        workspaceId: a.teamId,
        resourceType: "external_review_bulk_batch",
      });
    });

    it("POST /v1/external-review/invitations/bulk — the web console payload (defaultScope PACKAGE, no packageId) is refused per row with POLICY_DENIED and writes no grant", async () => {
      const a = h.fixtures.teamA;
      const email = `k5-bulk-ui-${tag()}@outside.test`;
      const challengeId = await stepUp({
        token: a.adminToken,
        userId: a.adminUserId,
        teamId: a.teamId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant_bulk",
      });
      // Byte-for-byte the body BulkInvitePanel.onIssueBulk sends
      // (apps/web/app/(app)/review/external/page.tsx). It names a PACKAGE scope
      // with no package id, which the grant service can never satisfy — so the
      // product console cannot invite anyone. Reported to the lead; the API
      // contract itself is proven satisfiable by the test above.
      const res = await call({
        method: "POST",
        url: "/v1/external-review/invitations/bulk",
        token: a.adminToken,
        payload: {
          expiresAtUtc: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
          defaultRole: "EXTERNAL_REVIEWER",
          defaultWatermarkPolicy: "ALWAYS",
          defaultMfaRequired: false,
          defaultScope: { kind: "PACKAGE" },
          rows: [{ inviteEmail: email, displayName: undefined, organization: undefined }],
          defaultAuthMethod: "TOKEN",
          defaultAllowedDomains: [],
        },
        headers: { [STEP]: challengeId },
      });
      expect(res.statusCode, res.body).toBe(201);
      const out = res.json() as { rows: Array<{ outcome: string; denial: string | null }> };
      expect(out.rows).toEqual([
        expect.objectContaining({ outcome: "POLICY_DENIED", denial: "POLICY_REJECTED", grantId: null }),
      ]);
      expect(await grantRows(a.teamId, email)).toHaveLength(0);
    });

    it("POST /v1/external-review/grants — owner issues a grant under step-up; a MEMBER and a foreign owner are refused", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const email = `k5-grant-${tag()}@outside.test`;
      const body = {
        teamId: a.teamId,
        scopeKind: "EVIDENCE",
        evidenceId: a.evidenceId,
        reviewerEmail: email,
        reviewerDisplayName: "K5 Grant Reviewer",
        expiresAtUtc: inTwoDays(),
        allowOriginalDownload: false,
        allowPackageDownload: true,
        safeNote: "Please review the attached evidence.",
      };

      const member = await call({ method: "POST", url: "/v1/external-review/grants", token: a.memberToken, payload: body });
      expect(member.statusCode).toBe(403);
      expect(member.json()).toEqual({
        error: { code: "permission_denied", reason: "permission_not_granted" },
      });
      const foreign = await call({ method: "POST", url: "/v1/external-review/grants", token: b.ownerToken, payload: body });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      expect(await grantRows(a.teamId, email)).toHaveLength(0);

      const challengeId = await stepUp({
        token: a.ownerToken,
        userId: a.ownerUserId,
        teamId: a.teamId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant",
        resourceId: a.evidenceId,
      });
      const res = await call({
        method: "POST",
        url: "/v1/external-review/grants",
        token: a.ownerToken,
        payload: body,
        headers: { [STEP]: challengeId },
      });
      expect(res.statusCode, res.body).toBe(201);
      const out = res.json() as { grant: { id: string; state: string; safeNote: string }; rawToken: string };
      expect(out.grant).toMatchObject({ state: "INVITED", safeNote: body.safeNote });
      const [grant] = await grantRows(a.teamId, email);
      expect(grant).toMatchObject({
        id: out.grant.id,
        evidence_id: a.evidenceId,
        state: "INVITED",
        invited_by_user_id: a.ownerUserId,
      });
      await expect
        .poll(
          () =>
            prisma.securityEvent.findFirst({
              where: {
                teamId: a.teamId,
                eventType: "external_review_invited",
                details: { path: ["grantId"], equals: out.grant.id },
              },
              select: { details: true },
            }),
          { timeout: 10_000, interval: 25 },
        )
        .toMatchObject({ details: { actorUserId: a.ownerUserId } });

      // Same defect class as the invitation route: a foreign scope target.
      const crossEmail = `k5-grant-cross-${tag()}@outside.test`;
      const crossChallenge = await stepUp({
        token: a.ownerToken,
        userId: a.ownerUserId,
        teamId: a.teamId,
        purpose: "EXTERNAL_REVIEW_GRANT_ISSUE",
        resourceKind: "external_review_grant",
        resourceId: b.caseId,
      });
      const cross = await call({
        method: "POST",
        url: "/v1/external-review/grants",
        token: a.ownerToken,
        payload: { ...body, scopeKind: "CASE", evidenceId: null, caseId: b.caseId, reviewerEmail: crossEmail },
        headers: { [STEP]: crossChallenge },
      });
      expect(cross.statusCode, cross.body).toBe(400);
      expect(cross.json()).toEqual({ error: { code: "grant_issue_denied", reason: "invalid_scope" } });
      expect(await grantRows(a.teamId, crossEmail)).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Evidence exchange
  // ===========================================================================

  describe("evidence exchange", () => {
    async function readyPackage(teamId: string, createdByUserId: string, evidenceId: string) {
      return prisma.evidenceExchangePackage.create({
        data: {
          teamId,
          kind: "EVIDENCE",
          state: "READY",
          evidenceIds: [evidenceId],
          packageSha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
          packageSizeBytes: BigInt(2048),
          storageKey: `exchange/${teamId}/${randomUUID()}.zip`,
          readyAtUtc: new Date(),
          createdByUserId,
        },
      });
    }

    it("POST /v1/exchange/packages/:id/sign-url — owner mints a link under package-bound step-up; a VIEWER and a foreign workspace are refused", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const pkg = await readyPackage(a.teamId, a.ownerUserId, a.evidenceId);
      const url = `/v1/exchange/packages/${pkg.id}/sign-url`;

      const viewer = await call({ method: "POST", url, token: a.viewerToken });
      expect(viewer.statusCode).toBe(403);
      expect((viewer.json() as { error: { code: string } }).error.code).toBe("permission_denied");

      const foreignChallenge = await stepUp({
        token: b.ownerToken,
        userId: b.ownerUserId,
        teamId: b.teamId,
        purpose: "PACKAGE_EXPORT_HIGH_RISK",
        resourceKind: "evidence_exchange_package",
        resourceId: pkg.id,
      });
      const foreign = await call({ method: "POST", url, token: b.ownerToken, headers: { [STEP]: foreignChallenge } });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ denial: "PACKAGE_NOT_FOUND" });
      expect(
        (await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id: pkg.id } })).signedUrl,
      ).toBeNull();

      const challengeId = await stepUp({
        token: a.ownerToken,
        userId: a.ownerUserId,
        teamId: a.teamId,
        purpose: "PACKAGE_EXPORT_HIGH_RISK",
        resourceKind: "evidence_exchange_package",
        resourceId: pkg.id,
      });
      const res = await call({ method: "POST", url, token: a.ownerToken, headers: { [STEP]: challengeId } });
      expect(res.statusCode, res.body).toBe(200);
      const out = res.json() as { signedUrl: string; expiresAtUtc: string };
      const row = await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(row.signedUrl).toBe(out.signedUrl);
      expect(row.signedUrl).toContain(pkg.id);
      expect(row.signedUrlExpiresAtUtc?.toISOString()).toBe(out.expiresAtUtc);
    });

    it("POST /v1/exchange/packages/:id/deliveries — owner records a recipient (package DELIVERED); a VIEWER and a foreign workspace are refused", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const pkg = await readyPackage(a.teamId, a.ownerUserId, a.evidenceId);
      const url = `/v1/exchange/packages/${pkg.id}/deliveries`;
      const body = { recipientEmail: "counsel@recipient.test", recipientOrgSlug: "recipient-llp" };

      const viewer = await call({ method: "POST", url, token: a.viewerToken, payload: body });
      expect(viewer.statusCode).toBe(403);

      const foreignChallenge = await stepUp({
        token: b.ownerToken,
        userId: b.ownerUserId,
        teamId: b.teamId,
        purpose: "PACKAGE_EXPORT_HIGH_RISK",
        resourceKind: "evidence_exchange_package",
        resourceId: pkg.id,
      });
      const foreign = await call({
        method: "POST",
        url,
        token: b.ownerToken,
        payload: body,
        headers: { [STEP]: foreignChallenge },
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ denial: "NOT_FOUND" });
      expect(await prisma.evidenceExchangePackageDelivery.count({ where: { packageId: pkg.id } })).toBe(0);

      const challengeId = await stepUp({
        token: a.ownerToken,
        userId: a.ownerUserId,
        teamId: a.teamId,
        purpose: "PACKAGE_EXPORT_HIGH_RISK",
        resourceKind: "evidence_exchange_package",
        resourceId: pkg.id,
      });
      const res = await call({ method: "POST", url, token: a.ownerToken, payload: body, headers: { [STEP]: challengeId } });
      expect(res.statusCode, res.body).toBe(201);
      const deliveryId = (res.json() as { deliveryId: string }).deliveryId;
      const delivery = await prisma.evidenceExchangePackageDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
      expect(delivery).toMatchObject({
        packageId: pkg.id,
        teamId: a.teamId,
        recipientEmail: "counsel@recipient.test",
        recipientOrgSlug: "recipient-llp",
        channel: "SIGNED_URL",
      });
      const after = await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(after.state).toBe("DELIVERED");
      expect(after.deliveredAtUtc).toBeInstanceOf(Date);
    });
  });

  // ===========================================================================
  // Organizations
  // ===========================================================================

  describe("organizations", () => {
    it("DELETE /v1/orgs/:orgId/domains/:id — owner removes a domain under step-up (org audit); an ORG_MEMBER and an outsider are refused", async () => {
      const a = h.fixtures.teamA;
      const domain = await prisma.organizationDomain.create({
        data: {
          organizationId: orgA,
          domain: `k5-${tag()}.test`,
          verificationToken: randomBytes(16).toString("hex"),
          createdByUserId: a.ownerUserId,
        },
      });
      const url = `/v1/orgs/${orgA}/domains/${domain.id}`;

      const member = await call({ method: "DELETE", url, token: a.memberToken });
      expect(member.statusCode).toBe(403);
      expect(member.json()).toEqual({ error: { code: "forbidden" } });
      const outsider = await call({ method: "DELETE", url, token: h.fixtures.teamB.ownerToken });
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json()).toEqual({ error: { code: "not_found" } });
      expect(await prisma.organizationDomain.findUnique({ where: { id: domain.id } })).not.toBeNull();

      const challengeId = await stepUp({
        token: a.ownerToken,
        userId: a.ownerUserId,
        teamId: a.teamId,
        purpose: "ORG_DOMAIN_REMOVE",
        resourceKind: "organization_domain",
        resourceId: domain.id,
      });
      const res = await call({ method: "DELETE", url, token: a.ownerToken, headers: { [STEP]: challengeId } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true, id: domain.id });
      expect(await prisma.organizationDomain.findUnique({ where: { id: domain.id } })).toBeNull();
      const audit = await prisma.organizationAuditEvent.findFirstOrThrow({
        where: { organizationId: orgA, eventType: "DOMAIN_REMOVED", targetId: domain.id },
      });
      expect(audit).toMatchObject({ actorUserId: a.ownerUserId, targetType: "organization_domain" });
    });

    async function createOrgInvite(email: string): Promise<{ inviteId: string; token: string }> {
      const res = await call({
        method: "POST",
        url: `/v1/orgs/${orgA}/invites`,
        token: h.fixtures.teamA.ownerToken,
        payload: { email, role: "ORG_MEMBER" },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as { inviteId: string; token: string };
    }

    it("POST /v1/org-invites/:token/accept — the invited address accepts (ACTIVE membership, org audit); a different account is refused 403 and audited", async () => {
      const invitee = await disposableUser("invitee");
      const other = await disposableUser("wrong-account");
      const invite = await createOrgInvite(invitee.email);
      const url = `/v1/org-invites/${invite.token}/accept`;

      const wrong = await call({ method: "POST", url, token: other.token });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toEqual({ message: "Invite email does not match your account." });
      expect(
        (await prisma.organizationInvite.findUniqueOrThrow({ where: { id: invite.inviteId } })).acceptedAt,
      ).toBeNull();
      expect(
        await prisma.organizationMembership.count({ where: { organizationId: orgA, userId: other.id } }),
      ).toBe(0);
      const rejected = await prisma.organizationAuditEvent.findFirstOrThrow({
        where: { organizationId: orgA, eventType: "ORG_INVITE_ACCEPT_REJECTED", targetId: invite.inviteId },
      });
      expect(rejected.actorUserId).toBe(other.id);
      expect(rejected.metadata).toMatchObject({ reason: "email_mismatch" });

      const unknown = await call({
        method: "POST",
        url: `/v1/org-invites/${randomBytes(32).toString("hex")}/accept`,
        token: invitee.token,
      });
      expect(unknown.statusCode).toBe(404);

      const res = await call({ method: "POST", url, token: invitee.token });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        invitationAccepted: true,
        organizationId: orgA,
        role: "ORG_MEMBER",
        assignedWorkspaceIds: [],
      });
      const accepted = await prisma.organizationInvite.findUniqueOrThrow({ where: { id: invite.inviteId } });
      expect(accepted.acceptedAt).toBeInstanceOf(Date);
      expect(accepted.acceptedByUserId).toBe(invitee.id);
      const membership = await prisma.organizationMembership.findUniqueOrThrow({
        where: { organization_memberships_org_user_uniq: { organizationId: orgA, userId: invitee.id } },
      });
      expect(membership).toMatchObject({ role: "ORG_MEMBER", status: "ACTIVE" });
      const audit = await prisma.organizationAuditEvent.findFirstOrThrow({
        where: { organizationId: orgA, eventType: "ORG_MEMBER_ACCEPTED", targetId: invite.inviteId },
      });
      expect(audit.actorUserId).toBe(invitee.id);
    });

    it("DELETE /v1/orgs/:id/invites/:inviteId — owner revokes a pending invite (org audit); an ORG_MEMBER and an outsider are refused", async () => {
      const a = h.fixtures.teamA;
      const email = `k5-revoke-${tag()}@invitee.test`;
      const invite = await createOrgInvite(email);
      const url = `/v1/orgs/${orgA}/invites/${invite.inviteId}`;

      const member = await call({ method: "DELETE", url, token: a.memberToken });
      expect(member.statusCode).toBe(403);
      const outsider = await call({ method: "DELETE", url, token: h.fixtures.teamB.ownerToken });
      expect(outsider.statusCode).toBe(404);
      expect(
        (await prisma.organizationInvite.findUniqueOrThrow({ where: { id: invite.inviteId } })).revokedAt,
      ).toBeNull();

      const res = await call({ method: "DELETE", url, token: a.ownerToken });
      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.organizationInvite.findUniqueOrThrow({ where: { id: invite.inviteId } });
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(row.revokedByUserId).toBe(a.ownerUserId);
      const audit = await prisma.organizationAuditEvent.findFirstOrThrow({
        where: { organizationId: orgA, eventType: "ORG_INVITE_REVOKED", targetId: invite.inviteId },
      });
      expect(audit.actorUserId).toBe(a.ownerUserId);

      // The revoked link no longer admits its addressee.
      const dead = await call({ method: "POST", url: `/v1/org-invites/${invite.token}/accept`, token: a.memberToken });
      expect(dead.statusCode).toBe(410);
    });
  });

  // ===========================================================================
  // LAST — session-destroying: org member removal revokes the target's sessions.
  // ===========================================================================

  describe("organization member removal (disposable persona, runs last)", () => {
    it("DELETE /v1/orgs/:id/members/:memberId — owner removes a member (REVOKED org + workspace membership, org audit); an ORG_MEMBER is refused", async () => {
      const a = h.fixtures.teamA;
      const target = await disposableUser("org-removal");
      const membership = await prisma.organizationMembership.create({
        data: { organizationId: orgA, userId: target.id, role: "ORG_MEMBER" },
      });
      await prisma.teamMember.create({
        data: { teamId: a.teamId, userId: target.id, role: "VIEWER", status: "ACTIVE" },
      });
      await pointAt(target.id, a.teamId);
      const url = `/v1/orgs/${orgA}/members/${membership.id}`;

      const member = await call({ method: "DELETE", url, token: a.memberToken });
      expect(member.statusCode).toBe(403);
      const outsider = await call({ method: "DELETE", url, token: h.fixtures.teamB.ownerToken });
      expect(outsider.statusCode).toBe(404);
      expect(
        (await prisma.organizationMembership.findUniqueOrThrow({ where: { id: membership.id } })).status,
      ).toBe("ACTIVE");

      const res = await call({ method: "DELETE", url, token: a.ownerToken });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ membershipId: membership.id, removed: true });
      const after = await prisma.organizationMembership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(after.status).toBe("REVOKED");
      expect(after.revokedByUserId).toBe(a.ownerUserId);
      expect(after.revokedAtUtc).toBeInstanceOf(Date);
      expect(
        (
          await prisma.teamMember.findUniqueOrThrow({
            where: { teamId_userId: { teamId: a.teamId, userId: target.id } },
          })
        ).status,
      ).toBe("REVOKED");
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).currentWorkspaceId,
      ).toBeNull();
      const audit = await prisma.organizationAuditEvent.findFirstOrThrow({
        where: { organizationId: orgA, eventType: "ORG_MEMBER_REMOVED", targetId: membership.id },
      });
      expect(audit.actorUserId).toBe(a.ownerUserId);
      expect(audit.metadata).toMatchObject({ targetUserId: target.id, workspacesDeactivated: 1 });

      // The removed member's session no longer reaches the organization.
      const probe = await call({ method: "GET", url: `/v1/orgs/${orgA}`, token: target.token });
      expect([401, 404]).toContain(probe.statusCode);
    });
  });
});
