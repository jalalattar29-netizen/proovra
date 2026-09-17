/**
 * Defect closure — identity residuals (D54, D55, D57, D60), proven through the
 * real routes (`harness.app.inject`) against a disposable PostgreSQL 16 +
 * Redis.
 *
 *   D54  POST /v1/identity/members/:id/capabilities cannot hand out a
 *        permission the granting administrator does not hold.
 *   D55  POST /v1/identity/mfa/recovery-requests/:id/verify-email (anonymous)
 *        answers a real id with a wrong token exactly as a missing id.
 *   D57  PATCH / DELETE / set-default of an evidence saved view: creator or
 *        workspace OWNER/ADMIN for a team view, ACTIVE membership required,
 *        personal views only by their creator; outsiders read 404.
 *   D60  /v1/security/* and /v1/reliability/*: a member who is not OWNER/ADMIN
 *        gets the canonical 403 (byte-identical to the primitive's); an
 *        outsider keeps the concealed 404.
 *
 * Every step-up is a real authenticator ceremony (`/v1/identity-security/
 * step-up/start` + `/check`); the step ledger is reset between ceremonies.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Json = Record<string, unknown>;

describe("identity residual defects (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let jwt: typeof import("../src/services/jwt.js");

  const secrets = new Map<string, Buffer>();
  const createdUserIds: string[] = [];

  const call = (opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token?: string;
    payload?: unknown;
    challengeId?: string;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.challengeId ? { "x-proovra-step-up-challenge-id": opts.challengeId } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });
  const json = (res: { body: string }) => JSON.parse(res.body) as Json;
  /** The body with its per-request correlation id removed. */
  const shape = (res: { body: string }) => res.body.replace(/"requestId":"[0-9a-f-]{36}"/g, '"requestId":"<id>"');

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

  async function freshCode(userId: string): Promise<string> {
    await prisma.mfaFactor.updateMany({
      where: { userId, kind: "TOTP", status: "ACTIVE" },
      data: { lastUsedAt: null },
    });
    return totp.computeTotpCode(secrets.get(userId)!, totp.timeStep(Math.floor(Date.now() / 1000)));
  }

  /** The StepUpModal ceremony; returns the approved challenge id. */
  async function approvedChallenge(input: {
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
    const challengeId = (json(started).challenge as { id: string }).id;
    const checked = await call({
      method: "POST",
      url: "/v1/identity-security/step-up/check",
      token: input.token,
      payload: { teamId: input.teamId, challengeId, code: await freshCode(input.userId) },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    return challengeId;
  }

  const mint = (userId: string, email: string) =>
    jwt.signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );

  /** A further ACTIVE member of workspace A with the given DB role. */
  async function extraMember(label: string, role: "MEMBER" | "VIEWER") {
    const email = `dir-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: {
        email,
        firstName: "DIR",
        lastName: label,
        provider: "EMAIL",
        providerUserId: email,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "dir-fixture",
      })),
    });
    const { teamId } = harness.fixtures.teamA;
    const membership = await prisma.teamMember.create({
      data: { teamId, userId: user.id, role, status: "ACTIVE" },
      select: { id: true },
    });
    return { userId: user.id, token: mint(user.id, email), memberRowId: membership.id };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    jwt = await import("../src/services/jwt.js");
    const { teamA } = harness.fixtures;
    await seedTotp(teamA.adminUserId);
    await prisma.user.update({ where: { id: teamA.adminUserId }, data: { currentWorkspaceId: teamA.teamId } });
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const users = { in: createdUserIds };
      const teamIds = [harness.fixtures.teamA.teamId, harness.fixtures.teamB.teamId];
      await prisma.evidenceSavedView.deleteMany({ where: { teamId: { in: teamIds } } }).catch(() => undefined);
      await prisma.evidenceSavedView.deleteMany({ where: { ownerUserId: users } }).catch(() => undefined);
      await prisma.memberCapabilityGrant.deleteMany({ where: { teamId: { in: teamIds } } }).catch(() => undefined);
      await prisma.mfaRecoveryRequest.deleteMany({ where: { teamId: { in: teamIds } } }).catch(() => undefined);
      await prisma.mfaFactor
        .deleteMany({ where: { userId: { in: [...createdUserIds, harness.fixtures.teamA.adminUserId] } } })
        .catch(() => undefined);
      await prisma.teamMember.deleteMany({ where: { userId: users } }).catch(() => undefined);
      await prisma.userLegalAcceptance.deleteMany({ where: { userId: users } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: users } }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  // ===========================================================================
  // D54
  // ===========================================================================

  it("D54 — an admin cannot grant a capability the admin does not hold; one the admin holds is granted", async () => {
    const { adminToken, adminUserId, teamId } = harness.fixtures.teamA;
    const subject = await extraMember("d54", "MEMBER");
    const url = `/v1/identity/members/${subject.memberRowId}/capabilities`;
    const stepUp = () =>
      approvedChallenge({
        token: adminToken,
        userId: adminUserId,
        teamId,
        purpose: "CAPABILITY_GRANT",
        resourceKind: "team_member",
        resourceId: subject.memberRowId,
      });

    // ADMIN's role does not include billing.manage.
    const refused = await call({
      method: "POST",
      url,
      token: adminToken,
      payload: { teamId, permission: "billing.manage", reason: "DIR cover" },
      challengeId: await stepUp(),
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(json(refused)).toEqual({ error: { code: "grantor_lacks_permission" } });
    expect(
      await prisma.memberCapabilityGrant.count({
        where: { teamMemberId: subject.memberRowId, permission: "billing.manage" },
      }),
    ).toBe(0);

    const granted = await call({
      method: "POST",
      url,
      token: adminToken,
      payload: { teamId, permission: "identity.member.invite", reason: "DIR cover" },
      challengeId: await stepUp(),
    });
    expect(granted.statusCode, granted.body).toBe(200);
    expect(
      await prisma.memberCapabilityGrant.count({
        where: { teamMemberId: subject.memberRowId, permission: "identity.member.invite", revokedAtUtc: null },
      }),
    ).toBe(1);
  });

  // ===========================================================================
  // D55
  // ===========================================================================

  it("D55 — anonymous verify-email answers a real request with a wrong token exactly as a missing request", async () => {
    const { viewerToken, teamId } = harness.fixtures.teamA;
    const created = await call({
      method: "POST",
      url: "/v1/identity/mfa-admin/recovery-requests",
      token: viewerToken,
      payload: { teamId, reason: "Phone was lost on a site visit" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const requestId = (json(created).request as { id: string }).id;
    const before = await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(before.status).toBe("EMAIL_VERIFICATION_PENDING");

    const verify = (id: string) =>
      call({
        method: "POST",
        url: `/v1/identity/mfa/recovery-requests/${id}/verify-email`,
        payload: { token: "x".repeat(32) },
      });
    const missing = await verify(randomUUID());
    const real = await verify(requestId);
    expect(missing.statusCode).toBe(404);
    expect(real.statusCode).toBe(404);
    expect(real.body).toBe(missing.body);
    expect(json(real)).toEqual({ error: "request_not_found" });

    // A request that is no longer pending must not be told apart either.
    await prisma.mfaRecoveryRequest.update({
      where: { id: requestId },
      data: { status: "PENDING_ADMIN_REVIEW" },
    });
    const moved = await verify(requestId);
    expect(moved.statusCode).toBe(404);
    expect(moved.body).toBe(missing.body);

    // Nothing moved on the real request beyond the status set above.
    const after = await prisma.mfaRecoveryRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(after.emailVerificationTokenHash).toBe(before.emailVerificationTokenHash);
  });

  // ===========================================================================
  // D57
  // ===========================================================================

  describe("D57 — evidence saved view mutations", () => {
    const filters = {
      search: "",
      scope: "active",
      status: "all",
      type: "all",
      review: "all",
      exportReadiness: "all",
      caseAssignment: "all",
      retention: "all",
      sort: "newest",
      tsaStatus: "all",
      otsStatus: "all",
      publicVerifyState: "all",
      verificationStatus: "all",
    };
    type Mutation = "patch" | "delete" | "default";
    const MUTATIONS: Mutation[] = ["patch", "delete", "default"];

    async function makeView(token: string, teamId: string | null): Promise<string> {
      const res = await call({
        method: "POST",
        url: "/v1/evidence/saved-views",
        token,
        payload: {
          name: `DIR view ${randomUUID().slice(0, 6)}`,
          description: null,
          isDefault: false,
          teamId,
          scope: "active",
          sortKey: "newest",
          filters,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (json(res).savedView as { id: string }).id;
    }

    const mutate = (m: Mutation, id: string, token: string) =>
      m === "patch"
        ? call({ method: "PATCH", url: `/v1/evidence/saved-views/${id}`, token, payload: { name: "Renamed by DIR" } })
        : m === "delete"
          ? call({ method: "DELETE", url: `/v1/evidence/saved-views/${id}`, token })
          : call({ method: "POST", url: `/v1/evidence/saved-views/${id}/default`, token });

    async function unchanged(id: string, snapshot: { name: string; isDefault: boolean; updatedAt: Date }) {
      const row = await prisma.evidenceSavedView.findUnique({ where: { id } });
      expect(row, "view must still exist").not.toBeNull();
      expect(row!.name).toBe(snapshot.name);
      expect(row!.isDefault).toBe(snapshot.isDefault);
      expect(row!.updatedAt.getTime()).toBe(snapshot.updatedAt.getTime());
    }

    function applied(m: Mutation, id: string) {
      return prisma.evidenceSavedView.findUnique({ where: { id } }).then((row) => {
        if (m === "delete") expect(row).toBeNull();
        else if (m === "patch") expect(row!.name).toBe("Renamed by DIR");
        else expect(row!.isDefault).toBe(true);
      });
    }

    it("the creator and a workspace admin may change a team view; another member and a viewer are refused 403", async () => {
      const { teamId, adminToken, viewerToken } = harness.fixtures.teamA;
      const creator = await extraMember("d57-creator", "MEMBER");
      const other = await extraMember("d57-other", "MEMBER");
      for (const m of MUTATIONS) {
        for (const [label, token] of [
          ["other member", other.token],
          ["viewer", viewerToken],
        ] as const) {
          const id = await makeView(creator.token, teamId);
          const snap = await prisma.evidenceSavedView.findUniqueOrThrow({ where: { id } });
          const res = await mutate(m, id, token);
          expect(res.statusCode, `${m} by ${label}: ${res.body}`).toBe(403);
          await unchanged(id, snap);
        }
        for (const [label, token] of [
          ["creator", creator.token],
          ["admin", adminToken],
        ] as const) {
          const id = await makeView(creator.token, teamId);
          const res = await mutate(m, id, token);
          expect(res.statusCode, `${m} by ${label}: ${res.body}`).toBe(200);
          await applied(m, id);
        }
      }
    });

    it("a suspended member (the creator included) and another tenant read the view as missing (404)", async () => {
      const { teamId } = harness.fixtures.teamA;
      const creator = await extraMember("d57-susp-creator", "MEMBER");
      const bystander = await extraMember("d57-susp-other", "MEMBER");
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) ids.push(await makeView(creator.token, teamId));
      await prisma.teamMember.update({ where: { id: creator.memberRowId }, data: { status: "SUSPENDED" } });
      await prisma.teamMember.update({ where: { id: bystander.memberRowId }, data: { status: "SUSPENDED" } });

      let k = 0;
      for (const m of MUTATIONS) {
        const missing = await mutate(m, randomUUID(), harness.fixtures.teamA.memberToken);
        expect(missing.statusCode, m).toBe(404);
        for (const [label, token] of [
          ["suspended creator", creator.token],
          ["suspended member", bystander.token],
          ["other tenant owner", harness.fixtures.teamB.ownerToken],
        ] as const) {
          const id = ids[k % ids.length]!;
          k += 1;
          const snap = await prisma.evidenceSavedView.findUniqueOrThrow({ where: { id } });
          const res = await mutate(m, id, token);
          expect(res.statusCode, `${m} by ${label}: ${res.body}`).toBe(404);
          expect(shape(res), `${m} by ${label}`).toBe(shape(missing));
          await unchanged(id, snap);
        }
      }
    });

    it("a personal view is changed only by its creator; anyone else reads it as missing (404)", async () => {
      const { teamA, teamB } = harness.fixtures;
      const owner = await extraMember("d57-personal", "MEMBER");
      for (const m of MUTATIONS) {
        const missing = await mutate(m, randomUUID(), teamA.adminToken);
        for (const [label, token] of [
          ["workspace admin", teamA.adminToken],
          ["workspace owner", teamA.ownerToken],
          ["other tenant owner", teamB.ownerToken],
        ] as const) {
          const id = await makeView(owner.token, null);
          const snap = await prisma.evidenceSavedView.findUniqueOrThrow({ where: { id } });
          const res = await mutate(m, id, token);
          expect(res.statusCode, `${m} by ${label}: ${res.body}`).toBe(404);
          expect(shape(res), `${m} by ${label}`).toBe(shape(missing));
          await unchanged(id, snap);
        }
        const id = await makeView(owner.token, null);
        const res = await mutate(m, id, owner.token);
        expect(res.statusCode, `${m} by creator: ${res.body}`).toBe(200);
        await applied(m, id);
      }
    });
  });

  // ===========================================================================
  // D60
  // ===========================================================================

  it("D60 — security and reliability answer a non-admin member 403 byte-identical to the primitive, an outsider 404, an admin 200", async () => {
    const { viewerToken, memberToken, memberUserId, teamId, ownerToken } = harness.fixtures.teamA;
    // The canonical primitive's refusal of a member without the capability:
    // VIEWER does not hold identity.access_review.action.
    const primitive = await call({
      method: "POST",
      url: `/v1/identity/mfa-admin/factors/${teamId}/${memberUserId}/${randomUUID()}/revoke`,
      token: viewerToken,
      payload: { reason: "Lost device" },
    });
    expect(primitive.statusCode).toBe(403);
    expect(json(primitive)).toEqual({ error: { code: "permission_denied", reason: "permission_not_granted" } });

    const legs: Array<{ method: "GET" | "POST"; url: string; payload?: unknown }> = [
      { method: "GET", url: `/v1/security/summary?teamId=${teamId}` },
      { method: "GET", url: `/v1/security/scans?teamId=${teamId}` },
      { method: "GET", url: `/v1/security/events?teamId=${teamId}` },
      { method: "GET", url: `/v1/reliability/summary?teamId=${teamId}` },
      { method: "GET", url: `/v1/reliability/upload-sessions?teamId=${teamId}` },
      {
        method: "POST",
        url: `/v1/reliability/upload-sessions/${randomUUID()}/mark-abandoned`,
        payload: { teamId },
      },
    ];
    for (const leg of legs) {
      for (const [label, token] of [
        ["viewer", viewerToken],
        ["member", memberToken],
      ] as const) {
        const res = await call({ ...leg, token });
        expect(res.statusCode, `${leg.url} ${label}: ${res.body}`).toBe(403);
        expect(res.body, `${leg.url} ${label}`).toBe(primitive.body);
      }
      const outsider = await call({ ...leg, token: harness.fixtures.teamB.ownerToken });
      expect(outsider.statusCode, `${leg.url} outsider`).toBe(404);
      expect(json(outsider)).toEqual({ error: { code: "not_found" } });
    }
    for (const leg of legs.filter((l) => l.method === "GET")) {
      const owner = await call({ ...leg, token: ownerToken });
      expect(owner.statusCode, `${leg.url} owner: ${owner.body}`).toBe(200);
    }
  });
});
