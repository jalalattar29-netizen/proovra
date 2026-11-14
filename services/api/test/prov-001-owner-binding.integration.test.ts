/**
 * PROV-001 / PROV-021 — first ownership of a customer organization, on real
 * routes and a real PostgreSQL.
 *
 * The audit's chain: a stranger registers a customer's address with their own
 * password, the operator provisions that customer, and the real person clicks
 * the verification email they were sent. The stranger's password then signs in
 * as ORG_OWNER. Each link of that chain is tested here, with the legitimate
 * registrant and the legitimate owner as positive controls.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("PROV-001 — first owner binding (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let provisioning: typeof import("../src/services/enterprise-provisioning.service.js");
  let emailService: ReturnType<typeof import("../src/services/email.service.js")["getEmailService"]>;
  let hashInviteToken: typeof import("../src/routes/organizations.routes.js")["hashInviteToken"];
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legalVersions: Record<string, string>;
  const mailbox = new Map<string, string>();

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    provisioning = await import("../src/services/enterprise-provisioning.service.js");
    ({ hashInviteToken } = await import("../src/routes/organizations.routes.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    legalVersions = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
    const emailModule = await import("../src/services/email.service.js");
    emailService = emailModule.getEmailService();
  }, 900_000);

  afterEach(() => {
    vi.restoreAllMocks();
    mailbox.clear();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const STRONG = "Attacker-Chosen-1234";
  // Sign-in routes are rate limited per address; each call here is its own visitor.
  let visitor = 0;
  const ip = () => `10.${(visitor >> 8) & 255}.${visitor++ & 255}.7`;

  function recordMail() {
    vi.spyOn(emailService, "sendEmailVerificationEmail").mockImplementation(async (to: string, url: string) => {
      mailbox.set(`verify:${to}`, new URL(url).searchParams.get("token") as string);
      // F-06 — the dispatcher reads the transport outcome; the stub accepts.
      return { kind: "acknowledged", providerMessageId: null, httpStatus: 200 } as const;
    });
    vi.spyOn(emailService, "sendPasswordResetEmail").mockImplementation(async (to: string, url: string) => {
      mailbox.set(`reset:${to}`, new URL(url).searchParams.get("token") as string);
      return undefined as never;
    });
  }

  const register = (email: string, password = STRONG) =>
    h.app.inject({ method: "POST", url: "/v1/auth/email/register", remoteAddress: ip(), payload: { email, password } });
  const login = (email: string, password: string) =>
    h.app.inject({ method: "POST", url: "/v1/auth/email/login", remoteAddress: ip(), payload: { email, password } });
  const verify = (token: string, password?: string) =>
    h.app.inject({ method: "POST", url: "/v1/auth/email/verify", remoteAddress: ip(), payload: { token, ...(password ? { password } : {}) } });

  async function acceptLegal(userId: string) {
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
  }

  async function resetPassword(email: string, newPassword: string) {
    const requested = await h.app.inject({ method: "POST", url: "/v1/auth/password-reset/request", remoteAddress: ip(), payload: { email } });
    expect(requested.statusCode, requested.body).toBe(200);
    const token = mailbox.get(`reset:${email}`) as string;
    expect(token).toEqual(expect.any(String));
    const confirmed = await h.app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/confirm",
      payload: { token, newPassword },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    // A reset ends every token issued up to its own second, so the next sign-in
    // has to be a later one.
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }

  async function provision(ownerEmail: string) {
    const operator = await prisma.user.create({
      data: { email: `operator-${tag()}@test.proovra.local`, provider: "EMAIL", providerUserId: `operator-${tag()}` },
      select: { id: true },
    });
    return provisioning.provisionEnterpriseCustomerIdempotent(
      {
        organizationName: `Customer ${tag()}`,
        ownerEmail,
        seats: 5,
        actorUserId: operator.id,
        idempotencyKey: `prov-001-${randomUUID()}`,
      },
      prisma,
    );
  }

  const inviteUrl = (result: unknown) => {
    const token = (result as { ownerInviteToken: string }).ownerInviteToken;
    return `/v1/org-invites/${token}/accept`;
  };

  it("provisioning binds nothing to a pre-registered address: only an invitation exists", async () => {
    recordMail();
    const email = `pre-${tag()}@customer.test`;
    expect((await register(email)).statusCode).toBe(201);
    const stranger = await prisma.user.findFirstOrThrow({ where: { email } });

    const { result } = await provision(email);
    const organizationId = (result as { organizationId: string }).organizationId;

    expect(result).toMatchObject({ provisioned: false, pendingOwner: true });
    expect(await prisma.organizationMembership.count({ where: { organizationId } })).toBe(0);
    expect(await prisma.team.count({ where: { organizationId } })).toBe(0);
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).toMatchObject({
      billingOwnerUserId: null,
    });
    expect(await prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({
      status: "PENDING_ACTIVATION",
      contractOwnerUserId: null,
    });
    expect(await prisma.organizationInvite.count({ where: { organizationId, email, role: "ORG_OWNER" } })).toBe(1);
    expect(
      await prisma.organizationMembership.count({
        where: { userId: stranger.id, organization: { kind: "CUSTOMER" } },
      }),
    ).toBe(0);
  });

  it("an EXISTING verified account is invited too, and duplicates on the address decide nothing", async () => {
    recordMail();
    const email = `dup-${tag()}@customer.test`;
    expect((await register(email)).statusCode).toBe(201);
    const google = await prisma.user.create({
      data: { email, provider: "GOOGLE", providerUserId: `g-${tag()}`, emailVerifiedAt: new Date() },
      select: { id: true },
    });
    await acceptLegal(google.id);

    const { result } = await provision(email);
    const organizationId = (result as { organizationId: string }).organizationId;
    expect(await prisma.organizationMembership.count({ where: { organizationId } })).toBe(0);

    const token = signJwt(
      { sub: google.id, provider: "GOOGLE", email, authMethod: "SOCIAL_OAUTH", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    const accepted = await h.app.inject({ method: "POST", url: inviteUrl(result), headers: bearer(token) });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const row = await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId } });
    expect(row).toMatchObject({ userId: google.id, role: "ORG_OWNER", status: "ACTIVE" });
    // PROV-004 — an existing account lands in the organization as a new one does.
    const workspace = await prisma.team.findFirstOrThrow({ where: { organizationId } });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: google.id } });
    expect(after.currentWorkspaceId).toBe(workspace.id);
  });

  it("the mailbox owner's click cannot activate the stranger's password; the link survives a refused attempt", async () => {
    recordMail();
    const email = `click-${tag()}@customer.test`;
    expect((await register(email)).statusCode).toBe(201);
    const link = mailbox.get(`verify:${email}`) as string;

    const noPassword = await verify(link);
    expect(noPassword.statusCode, noPassword.body).toBe(403);
    expect(noPassword.json()).toMatchObject({ error: { code: "EMAIL_VERIFICATION_PASSWORD_REQUIRED" } });
    const wrong = await verify(link, "Some-Other-Password-1");
    expect(wrong.statusCode, wrong.body).toBe(403);
    expect(wrong.json()).toMatchObject({ error: { code: "EMAIL_VERIFICATION_PASSWORD_INCORRECT" } });

    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.credentialProvenAtUtc).toBeNull();
    expect(await prisma.authenticatedSession.count({ where: { userId: user.id } })).toBe(0);
    const tokenRow = await prisma.emailVerificationToken.findFirstOrThrow({
      where: { tokenHash: createHash("sha256").update(link).digest("hex") },
    });
    expect(tokenRow.usedAt).toBeNull();

    // The stranger cannot sign in either, with the right password.
    const attacker = await login(email, STRONG);
    expect(attacker.statusCode, attacker.body).toBe(403);
    expect(attacker.json()).toMatchObject({ error: { code: "EMAIL_NOT_VERIFIED" } });
  });

  it("positive control: the registrant, holding both halves, verifies and signs in", async () => {
    recordMail();
    const email = `ok-${tag()}@customer.test`;
    expect((await register(email)).statusCode).toBe(201);
    const res = await verify(mailbox.get(`verify:${email}`) as string, STRONG);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ token: expect.any(String) });
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.credentialProvenAtUtc).not.toBeNull();
    expect((await login(email, STRONG)).statusCode).toBe(200);
  });

  it("the real owner takes the account back by reset, and the stranger's password ends there", async () => {
    recordMail();
    const email = `back-${tag()}@customer.test`;
    expect((await register(email)).statusCode).toBe(201);
    const staleLink = mailbox.get(`verify:${email}`) as string;
    const { result } = await provision(email);

    const NEW_PASSWORD = "Real-Owner-Password-1";
    await resetPassword(email, NEW_PASSWORD);

    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.credentialProvenAtUtc).not.toBeNull();
    expect((await login(email, STRONG)).statusCode).toBe(401);
    expect((await verify(staleLink, NEW_PASSWORD)).statusCode).toBe(400);

    await acceptLegal(user.id);
    const session = await login(email, NEW_PASSWORD);
    expect(session.statusCode, session.body).toBe(200);
    const accepted = await h.app.inject({
      method: "POST",
      url: inviteUrl(result),
      headers: bearer((session.json() as { token: string }).token),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const organizationId = (result as { organizationId: string }).organizationId;
    const workspace = await prisma.team.findFirstOrThrow({ where: { organizationId } });
    expect(workspace).toMatchObject({ ownerUserId: user.id, billingOwnerUserId: user.id, billingPlan: "ENTERPRISE" });
    expect(await prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({
      status: "ACTIVE",
      activationState: "ACTIVATED",
      contractOwnerUserId: user.id,
    });
    // PROV-004 — the owner lands in the new organization, not their Personal space.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.currentWorkspaceId).toBe(workspace.id);
    // PROV-023 — the first owner's workspace membership has provenance.
    const member = await prisma.teamMember.findFirstOrThrow({ where: { teamId: workspace.id, userId: user.id } });
    expect(member.role).toBe("OWNER");
    expect(
      await prisma.membershipGrant.count({ where: { teamMemberId: member.id, source: "ENTERPRISE_BOOTSTRAP" } }),
    ).toBe(1);
  });

  it("a password verified before this repair cannot take ownership until it is proven, and the old session dies", async () => {
    recordMail();
    const email = `legacy-${tag()}@customer.test`;
    expect((await register(email)).statusCode).toBe(201);
    // The state an account verified by a bare click was left in.
    await prisma.user.updateMany({ where: { email }, data: { emailVerifiedAt: new Date() } });
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    await acceptLegal(user.id);
    const strangerSession = await login(email, STRONG);
    expect(strangerSession.statusCode, strangerSession.body).toBe(200);
    const strangerToken = (strangerSession.json() as { token: string }).token;

    const { result } = await provision(email);
    const organizationId = (result as { organizationId: string }).organizationId;

    const refused = await h.app.inject({ method: "POST", url: inviteUrl(result), headers: bearer(strangerToken) });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: "ACCOUNT_PASSWORD_PROOF_REQUIRED" } });
    expect(await prisma.organizationMembership.count({ where: { organizationId } })).toBe(0);
    const invite = await prisma.organizationInvite.findFirstOrThrow({ where: { organizationId } });
    expect(invite.acceptedAt).toBeNull();
    const rejection = await prisma.organizationAuditEvent.findFirstOrThrow({
      where: { organizationId, eventType: "ORG_INVITE_ACCEPT_REJECTED" },
    });
    expect((rejection.metadata as { reason: string }).reason).toBe("credential_proof_required");

    const NEW_PASSWORD = "Real-Owner-Password-2";
    await resetPassword(email, NEW_PASSWORD);
    const dead = await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(strangerToken) });
    expect(dead.statusCode).toBe(401);

    const session = await login(email, NEW_PASSWORD);
    const accepted = await h.app.inject({
      method: "POST",
      url: inviteUrl(result),
      headers: bearer((session.json() as { token: string }).token),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await prisma.organizationMembership.count({ where: { organizationId, userId: user.id, status: "ACTIVE" } })).toBe(1);
  });

  it("accepting ownership ends the account's other sessions and keeps the accepting one", async () => {
    recordMail();
    const email = `sessions-${tag()}@customer.test`;
    expect((await register(email)).statusCode).toBe(201);
    expect((await verify(mailbox.get(`verify:${email}`) as string, STRONG)).statusCode).toBe(200);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    await acceptLegal(user.id);
    const other = (await login(email, STRONG)).json() as { token: string };
    const current = (await login(email, STRONG)).json() as { token: string };

    const { result } = await provision(email);
    const accepted = await h.app.inject({ method: "POST", url: inviteUrl(result), headers: bearer(current.token) });
    expect(accepted.statusCode, accepted.body).toBe(200);

    expect((await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(other.token) })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(current.token) })).statusCode).toBe(200);
    // The accepting session stays usable after the retry too.
    const replay = await h.app.inject({ method: "POST", url: inviteUrl(result), headers: bearer(current.token) });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ idempotentReplay: true });
  });

  it("PROV-021 — an account with no address, or an unproven one, accepts nothing", async () => {
    const invited = `bind-${tag()}@customer.test`;
    const { result } = await provision(invited);
    const organizationId = (result as { organizationId: string }).organizationId;

    const noEmail = await prisma.user.create({
      data: { provider: "EMAIL", providerUserId: `noemail-${tag()}` },
      select: { id: true },
    });
    const asserted = await prisma.user.create({
      data: { email: invited, provider: "EMAIL", providerUserId: `sso-${tag()}` },
      select: { id: true },
    });
    for (const u of [noEmail, asserted]) await acceptLegal(u.id);
    const tokenFor = (id: string) =>
      signJwt(
        { sub: id, provider: "EMAIL", authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      );

    const mismatch = await h.app.inject({ method: "POST", url: inviteUrl(result), headers: bearer(tokenFor(noEmail.id)) });
    expect(mismatch.statusCode, mismatch.body).toBe(403);
    const unverified = await h.app.inject({ method: "POST", url: inviteUrl(result), headers: bearer(tokenFor(asserted.id)) });
    expect(unverified.statusCode, unverified.body).toBe(403);
    expect(unverified.json()).toMatchObject({ error: { code: "EMAIL_NOT_VERIFIED" } });
    expect(await prisma.organizationMembership.count({ where: { organizationId } })).toBe(0);

    // The token never resolved a different invitation.
    const token = (result as { ownerInviteToken: string }).ownerInviteToken;
    const invite = await prisma.organizationInvite.findFirstOrThrow({ where: { organizationId } });
    expect(invite.tokenHash).toBe(hashInviteToken(token));
    expect(invite.acceptedAt).toBeNull();
  });

  it("a workspace invitation also refuses an unproven address", async () => {
    const A = h.fixtures.teamA;
    await prisma.team.updateMany({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    const { createWorkspaceInvitation, acceptWorkspaceInvitation } = await import(
      "../src/services/identity/workspace-invitation.service.js"
    );
    const email = `ws-${tag()}@customer.test`;
    const created = await createWorkspaceInvitation(
      { workspaceId: A.teamId, email, role: "MEMBER" as never, invitedByUserId: A.ownerUserId },
      prisma,
    );
    const asserted = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: `sso-${tag()}` },
      select: { id: true },
    });
    await expect(
      acceptWorkspaceInvitation({ rawToken: created.rawToken, actorUserId: asserted.id }, prisma),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(await prisma.teamMember.count({ where: { teamId: A.teamId, userId: asserted.id } })).toBe(0);

    await prisma.user.update({ where: { id: asserted.id }, data: { emailVerifiedAt: new Date() } });
    await expect(
      acceptWorkspaceInvitation({ rawToken: created.rawToken, actorUserId: asserted.id }, prisma),
    ).resolves.toMatchObject({ workspaceId: A.teamId, alreadyMember: false });
  });
});
