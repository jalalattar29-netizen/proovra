/**
 * BATCH E — step-up factors and the organization identity boundary, proven
 * against live PostgreSQL through the real routes.
 *
 *   PV-STEPUP-001 / PV-OD-011  a verified authenticator app satisfies step-up
 *   WCC-NEW-008                an authenticator code is accepted ONCE — by a
 *                              second challenge, at sign-in, and under a race
 *   PV-ORG-001                 one concealment convention across /v1/orgs/*
 *   PV-OD-012                  verified domains by explicit role; the step-up
 *                              is bound to the ACTOR's workspace and fails
 *                              closed without one
 *   PV-API-001                 the MFA recovery queue answers the family's
 *                              concealed 404
 *   PV-API-002                 the authenticator enrolment body is strict
 *   PV-OD-002                  identity.sso.read / identity.audit.read reach
 *                              the read-only roles
 *   WCC-NEW-009                the current-workspace pointer is revalidated
 *                              before it names a tenant
 *   WCC-NEW-006                billing belongs to the billing role, not to
 *                              whoever shares its precedence rank
 *   WCC-NEW-010                account step-up advertises only a proof the
 *                              account can pass
 *
 * Disposable local PostgreSQL + Redis only — the harness refuses anything else.
 * No provider is contacted: every step-up here is answered with an
 * authenticator code, and no domain is DNS-verified.
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Batch E — step-up factors and the organization boundary (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let totp: typeof import("../src/services/security/mfa-totp.js");
  let verifyActiveTotp: typeof import("../src/services/security/mfa.service.js")["verifyActiveTotp"];
  let orgA: string;
  let orgB: string;

  const secrets = new Map<string, Buffer>();
  const factorIds = new Map<string, string>();
  const createdDomains: string[] = [];

  const call = (opts: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

  async function seedTotp(userId: string): Promise<void> {
    const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
    const secret = totp.generateTotpSecretBytes();
    const sealed = sealSecret(secret);
    const now = new Date();
    const row = await prisma.mfaFactor.create({
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
      select: { id: true },
    });
    secrets.set(userId, secret);
    factorIds.set(userId, row.id);
  }

  /** The code the user's authenticator shows now (+offset steps). */
  const codeFor = (userId: string, offset = 0) =>
    totp.computeTotpCode(
      secrets.get(userId)!,
      totp.timeStep(Math.floor(Date.now() / 1000)) + offset,
    );

  async function orgMember(organizationId: string, userId: string, role: string) {
    await prisma.organizationMembership.upsert({
      where: { organization_memberships_org_user_uniq: { organizationId, userId } },
      create: { organizationId, userId, role: role as never },
      update: { role: role as never },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    totp = await import("../src/services/security/mfa-totp.js");
    ({ verifyActiveTotp } = await import("../src/services/security/mfa.service.js"));

    const { teamA, teamB } = harness.fixtures;
    orgA = (await prisma.team.findUniqueOrThrow({
      where: { id: teamA.teamId },
      select: { organizationId: true },
    })).organizationId;
    orgB = (await prisma.team.findUniqueOrThrow({
      where: { id: teamB.teamId },
      select: { organizationId: true },
    })).organizationId;

    // Organization A is an Enterprise customer (the ssoScim identity features
    // are entitled), built exactly as the billing suites build one.
    await prisma.team.update({
      where: { id: teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    const { upsertEnterpriseContract } = await import(
      "../src/services/organization/enterprise-contract.service.js"
    );
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });

    // Organization roles in A for the domain matrix (the owner is ORG_OWNER).
    await orgMember(orgA, teamA.adminUserId, "ORG_SECURITY_ADMIN");
    await orgMember(orgA, teamA.viewerUserId, "ORG_AUDITOR");
    await orgMember(orgA, teamA.memberUserId, "ORG_MEMBER");
    await orgMember(orgA, teamB.adminUserId, "ORG_BILLING_ADMIN");
    // A security admin of A who belongs to NO workspace of A.
    await orgMember(orgA, teamB.memberUserId, "ORG_SECURITY_ADMIN");

    // Authenticator apps — and NOTHING else — for the step-up actors.
    await seedTotp(teamA.adminUserId);
    await seedTotp(teamA.ownerUserId);
  }, 120_000);

  afterAll(async () => {
    if (prisma && createdDomains.length) {
      await prisma.organizationDomain.deleteMany({ where: { id: { in: createdDomains } } });
    }
    await harness?.cleanup();
  });

  // ===========================================================================
  // PV-STEPUP-001 / WCC-NEW-008
  // ===========================================================================

  describe("step-up with an authenticator app", () => {
    const start = (token: string, body: Record<string, unknown> = {}) =>
      call({
        method: "POST",
        url: "/v1/identity-security/step-up/start",
        token,
        payload: {
          teamId: harness.fixtures.teamA.teamId,
          purpose: "GOVERNANCE_POLICY_UPDATE",
          ...body,
        },
      });
    const check = (token: string, challengeId: string, code: string) =>
      call({
        method: "POST",
        url: "/v1/identity-security/step-up/check",
        token,
        payload: { teamId: harness.fixtures.teamA.teamId, challengeId, code },
      });

    let spentCode = "";

    it("an account holding ONLY an authenticator app can start step-up — nothing is sent", async () => {
      const { adminToken, adminUserId } = harness.fixtures.teamA;
      const res = await start(adminToken);
      expect(res.statusCode).toBe(200);
      const body = json(res);
      expect(body.method).toBe("TOTP");
      expect(body.destinationMask).toBeNull();
      const row = await prisma.stepUpChallenge.findUniqueOrThrow({
        where: { id: (body.challenge as { id: string }).id },
      });
      // Bound to the authenticator factor; no provider attempt exists.
      expect(row.factorId).toBe(factorIds.get(adminUserId));
      expect(row.verificationAttemptId).toBeNull();
      expect(row.status).toBe("PENDING");
    });

    it("a correct code approves; the SAME code cannot approve a second challenge", async () => {
      const { adminToken, adminUserId } = harness.fixtures.teamA;
      const first = json(await start(adminToken));
      const code = codeFor(adminUserId);
      const ok = await check(adminToken, (first.challenge as { id: string }).id, code);
      expect(ok.statusCode).toBe(200);
      expect(json(ok).status).toBe("approved");

      const second = json(await start(adminToken));
      const secondId = (second.challenge as { id: string }).id;
      const replay = await check(adminToken, secondId, code);
      expect(replay.statusCode).toBe(400);
      expect(json(replay)).toEqual({ status: "denied" });
      expect(
        (await prisma.stepUpChallenge.findUniqueOrThrow({ where: { id: secondId } })).status,
      ).toBe("DENIED");
    });

    it("two concurrent submissions of one fresh code: exactly one wins", async () => {
      const { adminToken, adminUserId } = harness.fixtures.teamA;
      const a = json(await start(adminToken));
      const b = json(await start(adminToken));
      // The next step — not yet claimed, and inside the ±1 window.
      spentCode = codeFor(adminUserId, 1);
      const results = await Promise.all([
        check(adminToken, (a.challenge as { id: string }).id, spentCode),
        check(adminToken, (b.challenge as { id: string }).id, spentCode),
      ]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([200, 400]);
    });

    it("a code step-up spent is refused at sign-in", async () => {
      const { adminUserId } = harness.fixtures.teamA;
      const signIn = await verifyActiveTotp({ userId: adminUserId, code: spentCode });
      expect(signIn.ok).toBe(false);
    });

    it("an explicit TOTP channel without an authenticator app is the actionable enrolment denial", async () => {
      const { memberToken } = harness.fixtures.teamA;
      const res = await start(memberToken, { channel: "TOTP" });
      expect(res.statusCode).toBe(403);
      const error = json(res).error as Record<string, unknown>;
      expect(error.code).toBe("STEP_UP_ENROLLMENT_REQUIRED");
      expect(error.acceptedFactors).toEqual(["TOTP", "SMS", "WHATSAPP"]);
      expect(error.remedy).toBe("/settings#security");
      expect(String(error.message)).toMatch(/authenticator app/);
    });

    it("the fifth denial in the window refuses a sixth start (bounded guessing)", async () => {
      const { adminToken, adminUserId, teamId } = harness.fixtures.teamA;
      const factorId = factorIds.get(adminUserId)!;
      const denied = await prisma.stepUpChallenge.count({
        where: { initiatedByUserId: adminUserId, factorId, status: "DENIED" },
      });
      expect(denied).toBeLessThan(5);
      // Below the threshold a start is allowed.
      expect((await start(adminToken)).statusCode).toBe(200);
      await prisma.stepUpChallenge.createMany({
        data: Array.from({ length: 5 - denied }, () => ({
          teamId,
          initiatedByUserId: adminUserId,
          purpose: "GOVERNANCE_POLICY_UPDATE",
          status: "DENIED" as const,
          expiresAtUtc: new Date(Date.now() + 60_000),
          factorId,
          factorGeneration: 1,
        })),
      });
      const refused = await start(adminToken);
      expect(refused.statusCode).toBe(429);
      expect(json(refused)).toEqual({ error: { code: "rate_limited" } });
    });
  });

  // ===========================================================================
  // PV-ORG-001
  // ===========================================================================

  describe("one concealment convention across /v1/orgs/*", () => {
    // The nine endpoints the audit's nine-actor matrix split 6 x 403 / 3 x 404.
    const family = (id: string) => [
      `/v1/orgs/${id}`,
      `/v1/orgs/${id}/members`,
      `/v1/orgs/${id}/workspaces`,
      `/v1/orgs/${id}/invites`,
      `/v1/orgs/${id}/audit-events`,
      `/v1/orgs/${id}/domains`,
      `/v1/orgs/${id}/policies/retention`,
      `/v1/orgs/${id}/billing/rollup`,
      `/v1/orgs/${id}/governance/control-center`,
    ];

    it("a NON-member is told exactly what a caller asking about a missing org is told — on every endpoint", async () => {
      const outsider = harness.fixtures.teamB.ownerToken;
      const missing = randomUUID();
      const bodies = new Set<string>();
      for (const [real, absent] of family(orgA).map((u, i) => [u, family(missing)[i]!] as const)) {
        const a = await call({ method: "GET", url: real, token: outsider });
        const b = await call({ method: "GET", url: absent, token: outsider });
        expect(a.statusCode, real).toBe(404);
        expect(b.statusCode, absent).toBe(404);
        expect(a.body, real).toBe(b.body);
        bodies.add(a.body);
      }
      expect([...bodies]).toEqual(['{"error":{"code":"not_found"}}']);

      // And the other direction the audit observed: organization A's own
      // owner probing organization B is told the same thing on every endpoint.
      const ownerA = harness.fixtures.teamA.ownerToken;
      for (const url of family(orgB)) {
        const res = await call({ method: "GET", url, token: ownerA });
        expect(res.statusCode, url).toBe(404);
        expect(res.body, url).toBe('{"error":{"code":"not_found"}}');
      }
    });

    it("an ACTIVE member without the role is refused with 403 — told the truth, not concealed", async () => {
      const member = harness.fixtures.teamA.memberToken; // ORG_MEMBER in A
      expect((await call({ method: "GET", url: `/v1/orgs/${orgA}`, token: member })).statusCode).toBe(200);
      // Two role-gated reads: domains (explicit read roles) and the governance
      // control center (ORG_AUDITOR+). The retention policy READ is open to
      // every member by design, so it is not a refusal case.
      for (const url of [`/v1/orgs/${orgA}/domains`, `/v1/orgs/${orgA}/governance/control-center`]) {
        const res = await call({ method: "GET", url, token: member });
        expect(res.statusCode, url).toBe(403);
        expect(json(res), url).toEqual({ error: { code: "forbidden" } });
      }
    });
  });

  // ===========================================================================
  // PV-OD-012
  // ===========================================================================

  describe("verified domains by explicit role", () => {
    const DOMAINS = () => `/v1/orgs/${orgA}/domains`;
    const add = async (token: string, domain: string) => {
      const res = await call({ method: "POST", url: DOMAINS(), token, payload: { domain } });
      if (res.statusCode === 201) createdDomains.push((json(res) as { id: string }).id);
      return res;
    };

    it("ORG_BILLING_ADMIN — the security admin's precedence rank — can neither read nor write", async () => {
      const billing = harness.fixtures.teamB.adminToken;
      expect((await call({ method: "GET", url: DOMAINS(), token: billing })).statusCode).toBe(403);
      const res = await add(billing, `billing-${randomUUID().slice(0, 8)}.test`);
      expect(res.statusCode).toBe(403);
      expect(json(res)).toEqual({ error: { code: "forbidden" } });
    });

    it("ORG_AUDITOR reads, read-only, and is refused a write", async () => {
      const auditor = harness.fixtures.teamA.viewerToken;
      const list = await call({ method: "GET", url: DOMAINS(), token: auditor });
      expect(list.statusCode).toBe(200);
      expect(json(list).viewerCanManage).toBe(false);
      expect(json(list).stepUpWorkspaceId).toBeNull();
      expect((await add(auditor, `auditor-${randomUUID().slice(0, 8)}.test`)).statusCode).toBe(403);
    });

    it("ORG_SECURITY_ADMIN manages domains, and a removal demands step-up in the actor's own workspace", async () => {
      const { adminToken, teamId } = harness.fixtures.teamA;
      const list = await call({ method: "GET", url: DOMAINS(), token: adminToken });
      expect(list.statusCode).toBe(200);
      expect(json(list).viewerCanManage).toBe(true);
      expect(json(list).stepUpWorkspaceId).toBe(teamId);

      const added = await add(adminToken, `secadmin-${randomUUID().slice(0, 8)}.test`);
      expect(added.statusCode).toBe(201);
      const id = (json(added) as { id: string }).id;
      const removal = await call({ method: "DELETE", url: `${DOMAINS()}/${id}`, token: adminToken });
      expect(removal.statusCode).toBe(401);
      expect((json(removal).error as { code: string }).code).toBe("STEP_UP_REQUIRED");
      expect(await prisma.organizationDomain.findUnique({ where: { id } })).not.toBeNull();
    });

    it("a security admin with no workspace in the organization is refused — the step-up is never skipped", async () => {
      const noWorkspace = harness.fixtures.teamB.memberToken;
      const added = await add(noWorkspace, `noworkspace-${randomUUID().slice(0, 8)}.test`);
      expect(added.statusCode).toBe(201);
      const id = (json(added) as { id: string }).id;
      const list = await call({ method: "GET", url: DOMAINS(), token: noWorkspace });
      expect(json(list).stepUpWorkspaceId).toBeNull();
      const removal = await call({ method: "DELETE", url: `${DOMAINS()}/${id}`, token: noWorkspace });
      expect(removal.statusCode).toBe(409);
      expect(JSON.stringify(json(removal))).toContain("STEP_UP_WORKSPACE_REQUIRED");
      expect(await prisma.organizationDomain.findUnique({ where: { id } })).not.toBeNull();
    });

    it("the owner removes a domain end to end: authenticator step-up bound to the domain, then an audited removal", async () => {
      const { ownerToken, ownerUserId } = harness.fixtures.teamA;
      const list = json(await call({ method: "GET", url: DOMAINS(), token: ownerToken }));
      const workspaceId = list.stepUpWorkspaceId as string;
      expect(typeof workspaceId).toBe("string");

      const added = await add(ownerToken, `owner-${randomUUID().slice(0, 8)}.test`);
      const id = (json(added) as { id: string }).id;

      const started = await call({
        method: "POST",
        url: "/v1/identity-security/step-up/start",
        token: ownerToken,
        payload: {
          teamId: workspaceId,
          purpose: "ORG_DOMAIN_REMOVE",
          resourceKind: "organization_domain",
          resourceId: id,
        },
      });
      expect(started.statusCode).toBe(200);
      expect(json(started).method).toBe("TOTP");
      const challengeId = (json(started).challenge as { id: string }).id;
      const approved = await call({
        method: "POST",
        url: "/v1/identity-security/step-up/check",
        token: ownerToken,
        payload: { teamId: workspaceId, challengeId, code: codeFor(ownerUserId) },
      });
      expect(approved.statusCode).toBe(200);

      const removed = await call({
        method: "DELETE",
        url: `${DOMAINS()}/${id}`,
        token: ownerToken,
        headers: { "x-proovra-step-up-challenge-id": challengeId },
      });
      expect(removed.statusCode).toBe(200);
      expect(await prisma.organizationDomain.findUnique({ where: { id } })).toBeNull();
      const audit = await prisma.organizationAuditEvent.findFirst({
        where: { organizationId: orgA, eventType: "DOMAIN_REMOVED", targetId: id },
      });
      expect(audit?.actorUserId).toBe(ownerUserId);
    });
  });

  // ===========================================================================
  // PV-API-001 / PV-API-002 / PV-OD-002
  // ===========================================================================

  describe("identity administration surfaces", () => {
    it("the MFA recovery queue refuses a non-admin with the family's concealed 404", async () => {
      const { memberToken, ownerToken, teamId } = harness.fixtures.teamA;
      const url = (t: string) => `/v1/identity/mfa-admin/recovery-requests/${t}`;
      const denied = await call({ method: "GET", url: url(teamId), token: memberToken });
      const missing = await call({ method: "GET", url: url(randomUUID()), token: memberToken });
      expect(denied.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      // Same code for "not an admin here" and "no such workspace" — and the
      // bare-string `{"error":"admin_not_in_team"}` is gone.
      expect((json(denied).error as { code: string }).code).toBe(
        (json(missing).error as { code: string }).code,
      );
      expect(denied.body).not.toContain("admin_not");
      const allowed = await call({ method: "GET", url: url(teamId), token: ownerToken });
      expect(allowed.statusCode).toBe(200);
      expect(Array.isArray(json(allowed).requests)).toBe(true);
    });

    it("the authenticator enrolment body is strict, and a phone kind is pointed at its own route", async () => {
      const { memberToken, memberUserId } = harness.fixtures.teamA;
      const before = await prisma.mfaFactor.count({ where: { userId: memberUserId } });
      const wrongRoute = await call({
        method: "POST",
        url: "/v1/identity/mfa/enroll/start",
        token: memberToken,
        payload: { kind: "SMS" },
      });
      expect(wrongRoute.statusCode).toBe(400);
      expect(wrongRoute.body).toContain("MFA_ENROLL_WRONG_ROUTE");
      const declared = await call({
        method: "POST",
        url: "/v1/identity/mfa/enroll/start",
        token: memberToken,
        payload: { userId: harness.fixtures.teamA.ownerUserId },
      });
      expect(declared.statusCode).toBe(400);
      expect(await prisma.mfaFactor.count({ where: { userId: memberUserId } })).toBe(before);
    });

    it("a read-only VIEWER reads the SSO configuration and the identity audit trail under their own permissions", async () => {
      const { viewerToken, teamId } = harness.fixtures.teamA;
      const providers = await call({
        method: "GET",
        url: `/v1/admin/identity/providers?teamId=${teamId}`,
        token: viewerToken,
      });
      expect(providers.statusCode).toBe(200);
      const timeline = await call({
        method: "GET",
        url: `/v1/admin/identity/timeline?teamId=${teamId}`,
        token: viewerToken,
      });
      expect(timeline.statusCode).toBe(200);
      // A workspace the viewer is not in stays concealed.
      const foreign = await call({
        method: "GET",
        url: `/v1/admin/identity/providers?teamId=${harness.fixtures.teamB.teamId}`,
        token: viewerToken,
      });
      expect(foreign.statusCode).toBe(404);
    });
  });

  // ===========================================================================
  // WCC-NEW-009 / WCC-NEW-006 / WCC-NEW-010 — run LAST: these change a
  // membership and a factor, and restore what they change.
  // ===========================================================================

  describe("the current-workspace pointer is a hint, and billing belongs to billing", () => {
    const CAMPAIGNS = "/v1/governance/access-reviews/campaigns";
    const pointAt = (userId: string, teamId: string) =>
      prisma.user.update({ where: { id: userId }, data: { currentWorkspaceId: teamId } });

    it("WCC-NEW-009 — a pointer at a workspace the caller no longer belongs to, or never did, authorizes nothing", async () => {
      const { teamId, memberUserId, memberToken } = harness.fixtures.teamA;
      await pointAt(memberUserId, teamId);
      const allowed = await call({ method: "GET", url: CAMPAIGNS, token: memberToken });
      expect(allowed.statusCode).toBe(200);
      expect(Array.isArray(json(allowed).campaigns)).toBe(true);

      await prisma.teamMember.update({
        where: { teamId_userId: { teamId, userId: memberUserId } },
        data: { status: "REVOKED" },
      });
      try {
        const revoked = await call({ method: "GET", url: CAMPAIGNS, token: memberToken });
        expect(revoked.statusCode).toBe(403);
        expect(json(revoked)).toEqual({ denial: "WORKSPACE_NOT_FOUND" });
      } finally {
        await prisma.teamMember.update({
          where: { teamId_userId: { teamId, userId: memberUserId } },
          data: { status: "ACTIVE" },
        });
      }

      // A user who never belonged to team A, whose pointer names it anyway.
      const { memberUserId: outsiderId, memberToken: outsiderToken } = harness.fixtures.teamB;
      await pointAt(outsiderId, teamId);
      const outsider = await call({ method: "GET", url: CAMPAIGNS, token: outsiderToken });
      expect(outsider.statusCode).toBe(403);
      expect(json(outsider)).toEqual({ denial: "WORKSPACE_NOT_FOUND" });
    });

    it("WCC-NEW-006 — the security admin (the billing admin's rank) sees neither the billing rollup nor the billing account", async () => {
      const security = harness.fixtures.teamA.adminToken; // ORG_SECURITY_ADMIN in A
      const billing = harness.fixtures.teamB.adminToken; // ORG_BILLING_ADMIN in A
      const rollup = (token: string) =>
        call({ method: "GET", url: `/v1/orgs/${orgA}/billing/rollup`, token });
      const refused = await rollup(security);
      expect(refused.statusCode).toBe(403);
      expect(json(refused)).toEqual({ error: { code: "forbidden" } });
      expect((await rollup(billing)).statusCode).toBe(200);

      const orgAccount = async (token: string) => {
        const res = await call({ method: "GET", url: "/v1/billing/accounts", token });
        expect(res.statusCode).toBe(200);
        const accounts = (json(res).accounts ?? []) as Array<{ type: string; id: string }>;
        return accounts.find((a) => a.type === "ORGANIZATION" && a.id === orgA);
      };
      expect(await orgAccount(security)).toBeUndefined();
      expect(await orgAccount(billing)).toBeDefined();
    });

    it("WCC-NEW-010 — an account whose only factor is a verified phone is not offered the authenticator proof", async () => {
      const { memberUserId, memberToken } = harness.fixtures.teamA;
      const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
      const phone = "+15550100";
      const sealed = sealSecret(Buffer.from(phone, "utf8"));
      const now = new Date();
      const factor = await prisma.mfaFactor.create({
        data: {
          userId: memberUserId,
          kind: "SMS",
          status: "ACTIVE",
          label: "Phone",
          destinationCiphertext: Buffer.from(sealed.ciphertext),
          destinationIv: Buffer.from(sealed.iv),
          destinationAuthTag: Buffer.from(sealed.authTag),
          destinationKekId: sealed.kekId,
          destinationHash: createHash("sha256").update(`${memberUserId}:${phone}`).digest("hex"),
          destinationMask: "•••• 0100",
          verifiedAtUtc: now,
          enrolledAt: now,
        },
        select: { id: true },
      });
      try {
        const res = await call({
          method: "POST",
          url: "/v1/identity/mfa/recovery-codes/regenerate",
          token: memberToken,
          payload: {},
        });
        expect(res.statusCode).toBe(401);
        const error = json(res).error as { code: string; methods: string[] };
        expect(error.code).toBe("STEP_UP_REQUIRED");
        // Only a verified authenticator app can pass the "mfa" proof, so it is
        // not advertised to an account that holds only a phone.
        expect(error.methods).not.toContain("mfa");
      } finally {
        await prisma.mfaFactor.delete({ where: { id: factor.id } });
      }
    });
  });
});
