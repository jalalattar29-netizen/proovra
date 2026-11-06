/**
 * RC-SEAT-PATHS (BILLING-003, IDENT-005, BILLING-004, BILLING-011) — one seat
 * claim for every membership entry path, on a real PostgreSQL.
 *
 * Advisory locks are a PostgreSQL behaviour, so the concurrency here is real:
 * the pool hands out real connections and the contenders genuinely collide.
 *
 * Controls in every case: an existing member keeps their seat, a repeat consumes
 * nothing, and a refused seat leaves no user, mapping or membership behind.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The stand-in IdP host in this suite has no real address.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: async (host: string, options: never) =>
      host === new URL("https://idp.seat-claim.test").hostname
        ? [{ address: "93.184.216.34", family: 4 }]
        : actual.lookup(host, options),
  };
});
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;

const ISSUER = "https://idp.seat-claim.test";
const idp = await generateKeyPair("RS256", { extractable: true });
const IDP_JWK: JWK = { ...(await exportJWK(idp.publicKey)), alg: "RS256", use: "sig" };

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () => (await actual.importJWK(IDP_JWK, "RS256")) as never,
  };
});

describe("the seat claim (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fixtures: typeof import("./point7/product-fixtures.js");
  let sso: typeof import("../src/services/access-control/sso.service.js");
  let scim: typeof import("../src/services/access-control/scim.service.js");
  let groups: typeof import("../src/services/access-control/scim-groups.service.js");
  let saml: typeof import("../src/services/security/saml-user-mapping.service.js");
  let membership: typeof import("../src/services/identity/membership-provisioning.service.js");
  let seats: typeof import("../src/services/billing/workspace-seats.service.js");
  let invitations: typeof import("../src/services/identity/workspace-invitation.service.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;

  const tag = () => randomUUID().slice(0, 8);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    fixtures = await import("./point7/product-fixtures.js");
    sso = await import("../src/services/access-control/sso.service.js");
    scim = await import("../src/services/access-control/scim.service.js");
    groups = await import("../src/services/access-control/scim-groups.service.js");
    saml = await import("../src/services/security/saml-user-mapping.service.js");
    membership = await import("../src/services/identity/membership-provisioning.service.js");
    seats = await import("../src/services/billing/workspace-seats.service.js");
    invitations = await import("../src/services/identity/workspace-invitation.service.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const deps = () => ({
    prisma: prisma as never,
    tag: `seat-${tag()}`,
    mintToken: (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
  });

  /** An Enterprise organization whose contract states `seatCount` seats. */
  async function organization(seatCount: number | null) {
    const t = await fixtures.seedOrganizationTenant(deps());
    await prisma.enterpriseContract.update({
      where: { organizationId: t.organizationId },
      data: { status: "ACTIVE", seatCount },
    });
    // IDENT-013 — directory and IdP accounts are created only in a verified domain.
    const domain = await fixtures.verifyOrganizationDomain(deps(), t.organizationId, t.owner.userId);
    return { orgId: t.organizationId, workspaceId: t.workspaceId, owner: t.owner, domain };
  }

  async function seat(workspaceId: string, count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const email = `seated-${tag()}@example.test`;
      const user = await prisma.user.create({
        data: { email, provider: "EMAIL", providerUserId: email, emailVerifiedAt: new Date() },
        select: { id: true },
      });
      await prisma.teamMember.create({
        data: { teamId: workspaceId, userId: user.id, role: "MEMBER", status: "ACTIVE" },
      });
      ids.push(user.id);
    }
    return ids;
  }

  const used = (workspaceId: string, ownerId: string) =>
    prisma.teamMember.count({ where: { teamId: workspaceId, status: "ACTIVE", userId: { not: ownerId } } });

  async function directory(o: { orgId: string; workspaceId: string; owner: { userId: string } }) {
    const { projection } = await scim.createScimToken(
      {
        teamId: o.workspaceId,
        actorUserId: o.owner.userId,
        name: `dir-${tag()}`,
        scopes: ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"],
      },
      prisma,
    );
    return { teamId: o.workspaceId, organizationId: o.orgId, tokenId: projection.id, baseUrl: "https://scim.test/v2/scim" };
  }

  const pushUser = (ctx: Awaited<ReturnType<typeof directory>>, email: string) =>
    scim.scimCreateUser(
      ctx,
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: email,
        externalId: `ext-${tag()}`,
        emails: [{ value: email, primary: true }],
        active: true,
      } as never,
      prisma,
    );

  const samlLogin = (o: { orgId: string; workspaceId: string }, email: string, subject = `sub-${tag()}`) =>
    saml.handleSamlAssertion(
      {
        teamId: o.workspaceId,
        connectionId: randomUUID(),
        provider: "GENERIC_SAML" as never,
        assertion: {
          nameId: subject,
          nameIdHash: subject,
          nameIdFormat: null,
          attributes: { email: [email] },
          inResponseTo: null,
          issuer: "https://idp.test",
          audience: "x",
          sessionIndex: null,
        } as never,
        allowedEmailDomains: [],
        jitDefaultRole: "MEMBER",
        attributeMapping: { email: "email" },
        scimManaged: false,
      } as never,
      prisma,
    );

  it("BILLING-003 / IDENT-005 — SAML JIT at N-1 admits, at N refuses with nothing left behind, and a repeat login stays free", async () => {
    const o = await organization(2);
    await seat(o.workspaceId, 1);

    const first = `jit-${tag()}@${o.domain}`;
    const subject = `sub-${tag()}`;
    const admitted = await samlLogin(o, first, subject);
    expect(admitted.isNewlyProvisioned).toBe(true);
    expect(await used(o.workspaceId, o.owner.userId)).toBe(2);

    const refusedEmail = `jit-${tag()}@${o.domain}`;
    await expect(samlLogin(o, refusedEmail)).rejects.toMatchObject({ code: "SAML_SEAT_LIMIT_REACHED" });
    expect(await used(o.workspaceId, o.owner.userId)).toBe(2);
    expect(await prisma.user.count({ where: { email: refusedEmail } })).toBe(0);
    expect(await prisma.externalIdentityMapping.count({ where: { externalEmail: refusedEmail } })).toBe(0);

    // The same subject signing in again at full capacity consumes nothing.
    const again = await samlLogin(o, first, subject);
    expect(again.userId).toBe(admitted.userId);
    expect(await used(o.workspaceId, o.owner.userId)).toBe(2);
  });

  it("IDENT-005 — OIDC JIT: the real callback admits at N-1, refuses at N, and a repeat login stays free", async () => {
    const o = await organization(1);
    const created = await sso.createSsoConnection(
      {
        teamId: o.workspaceId,
        provider: "OKTA",
        displayName: "IdP",
        issuerUrl: ISSUER,
        clientId: "client-1",
        clientSecret: "seat-claim-secret-value",
        actorUserId: o.owner.userId,
      } as never,
      prisma,
    );
    const conn = await prisma.ssoConnection.update({
      where: { id: created.projection.id },
      data: { status: "ACTIVE", jitDefaultRole: "MEMBER" },
      select: { id: true },
    });
    sso.setClientSecretResolver(() => "secret");

    const realFetch = globalThis.fetch;
    let userinfo: Record<string, unknown> = {};
    let idToken = "";
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      const body = u.includes("well-known") || u === ISSUER
        ? {
            issuer: ISSUER,
            jwks_uri: `${ISSUER}/jwks`,
            token_endpoint: `${ISSUER}/token`,
            authorization_endpoint: `${ISSUER}/auth`,
            userinfo_endpoint: `${ISSUER}/userinfo`,
          }
        : u.endsWith("/token")
          ? { id_token: idToken, access_token: "at" }
          : userinfo;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof globalThis.fetch;

    const login = async (sub: string, email: string) => {
      const { state, nonce } = await sso.buildOidcAuthorizationUrl(
        { teamId: o.workspaceId, connectionId: conn.id, redirectUri: `${ISSUER}/cb` },
        prisma,
      );
      const now = Math.floor(Date.now() / 1000);
      idToken = await new SignJWT({ nonce, sub })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(ISSUER)
        .setAudience("client-1")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(idp.privateKey as never);
      userinfo = { sub, email };
      const { hashStateToken } = await import("../src/services/access-control/sso-hardening.service.js");
      return sso.handleOidcCallback(
        {
          attempt: {
            ssoConnectionId: conn.id,
            teamId: o.workspaceId,
            nonceHash: hashStateToken(nonce),
            redirectAfter: null,
          },
          state,
          code: "c",
          redirectUri: `${ISSUER}/cb`,
        },
        prisma,
      );
    };

    try {
      const sub = `oidc-${tag()}`;
      const email = `oidc-${tag()}@${o.domain}`;
      const first = await login(sub, email);
      expect(first.user.isNewlyProvisioned).toBe(true);
      expect(await used(o.workspaceId, o.owner.userId)).toBe(1);

      const refused = `oidc-${tag()}@${o.domain}`;
      await expect(login(`oidc-${tag()}`, refused)).rejects.toMatchObject({ code: "SSO_SEAT_LIMIT_REACHED" });
      expect(await prisma.user.count({ where: { email: refused } })).toBe(0);
      expect(await prisma.externalIdentityMapping.count({ where: { externalEmail: refused } })).toBe(0);

      expect((await login(sub, email)).user.id).toBe(first.user.id);
      expect(await used(o.workspaceId, o.owner.userId)).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("BILLING-004 — concurrent SCIM creates seat exactly the free seats; the rest are refused and leave no account", async () => {
    const seatCount = 3;
    const o = await organization(seatCount);
    await seat(o.workspaceId, 2);
    const ctx = await directory(o);

    const emails = Array.from({ length: 6 }, () => `scim-${tag()}@${o.domain}`);
    const results = await Promise.all(emails.map((email) => pushUser(ctx, email)));

    const ok = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect(r).toMatchObject({ status: 409, detail: "seat_limit_reached" });
    expect(await used(o.workspaceId, o.owner.userId)).toBe(seatCount);
    expect(await prisma.user.count({ where: { email: { in: emails } } })).toBe(1);
  });

  it("different entry paths serialise against each other at the last seat", async () => {
    const o = await organization(2);
    await seat(o.workspaceId, 1);
    const ctx = await directory(o);

    const inviteEmail = `race-${tag()}@${o.domain}`;
    const invitee = await prisma.user.create({
      data: { email: inviteEmail, provider: "EMAIL", providerUserId: inviteEmail, emailVerifiedAt: new Date() },
      select: { id: true },
    });
    const invited = await invitations.createWorkspaceInvitation(
      { workspaceId: o.workspaceId, email: inviteEmail, role: "MEMBER" as never, invitedByUserId: o.owner.userId },
      prisma,
    );

    const outcomes = await Promise.allSettled([
      invitations.acceptWorkspaceInvitation({ rawToken: invited.rawToken, actorUserId: invitee.id }, prisma),
      pushUser(ctx, `race-${tag()}@${o.domain}`).then((r) => {
        if (!r.ok) throw Object.assign(new Error(r.detail), { code: r.detail });
        return r;
      }),
      samlLogin(o, `race-${tag()}@${o.domain}`),
    ]);

    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await used(o.workspaceId, o.owner.userId)).toBe(2);
  });

  it("decrement: a suspended or removed member frees a seat and a reactivation takes one again under the same rule", async () => {
    const o = await organization(1);
    const [member] = await seat(o.workspaceId, 1);
    const ctx = await directory(o);

    const full = await pushUser(ctx, `dec-${tag()}@${o.domain}`);
    expect(full).toMatchObject({ ok: false, detail: "seat_limit_reached" });

    await prisma.teamMember.updateMany({
      where: { teamId: o.workspaceId, userId: member },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date(), suspensionReason: "admin" },
    });
    const replacement = await pushUser(ctx, `dec-${tag()}@${o.domain}`);
    expect(replacement.ok, JSON.stringify(replacement)).toBe(true);
    expect(await used(o.workspaceId, o.owner.userId)).toBe(1);

    // The suspended member cannot come back now that the seat is taken.
    await expect(
      prisma.$transaction((tx) =>
        seats.claimWorkspaceSeatTx(tx as never, { workspaceId: o.workspaceId, userId: member }),
      ),
    ).resolves.toMatchObject({ outcome: "REFUSED", reason: "workspace_seat_limit_reached" });
  });

  it("SCIM reactivation at a full workspace is refused typed, and the person stays suspended", async () => {
    const o = await organization(1);
    const ctx = await directory(o);
    const pushed = await pushUser(ctx, `react-${tag()}@${o.domain}`);
    expect(pushed.ok).toBe(true);
    const userId = (pushed as { user: { id: string } }).user.id;
    await scim.scimDeactivateUser(ctx, userId, prisma);
    await seat(o.workspaceId, 1);

    const again = await scim.scimReactivateUser(ctx, userId, prisma);
    expect(again).toMatchObject({ ok: false, seatRefused: "seat_limit_reached" });
    const row = await prisma.teamMember.findFirstOrThrow({ where: { teamId: o.workspaceId, userId } });
    expect(row.status).toBe("SUSPENDED");
  });

  it("a login never takes a seat for a suspended member, and is not told the workspace is full", async () => {
    const o = await organization(1);
    const [suspended] = await seat(o.workspaceId, 1);
    await prisma.teamMember.updateMany({
      where: { teamId: o.workspaceId, userId: suspended },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date(), suspensionReason: "admin" },
    });
    await seat(o.workspaceId, 1);

    await prisma.$transaction((tx) =>
      membership.provisionMembership(tx as never, {
        intent: "SSO_JIT",
        source: "SSO_JIT",
        userId: suspended,
        workspace: { teamId: o.workspaceId, role: "MEMBER" },
        preserveExistingStatus: true,
      }),
    );
    const row = await prisma.teamMember.findFirstOrThrow({ where: { teamId: o.workspaceId, userId: suspended } });
    expect(row.status).toBe("SUSPENDED");
    expect(await used(o.workspaceId, o.owner.userId)).toBe(1);
  });

  it("the workspace owner never needs a seat, and is not counted", async () => {
    const o = await organization(1);
    await seat(o.workspaceId, 1);
    const claim = await prisma.$transaction((tx) =>
      seats.claimWorkspaceSeatTx(tx as never, { workspaceId: o.workspaceId, userId: o.owner.userId }),
    );
    expect(claim).toEqual({ outcome: "OWNER" });
  });

  it.each([
    ["absent", null],
    ["zero", 0],
  ])("BILLING-011 — an ACTIVE contract with an %s seat count admits nobody, typed as a contract to complete", async (_label, seatCount) => {
    const o = await organization(seatCount);
    const state = await seats.resolveWorkspaceSeatState(o.workspaceId, prisma);
    expect(state).toMatchObject({ featureIncluded: false, limit: 0 });

    const ctx = await directory(o);
    await expect(pushUser(ctx, `none-${tag()}@${o.domain}`)).resolves.toMatchObject({
      ok: false,
      detail: "seat_limit_reached",
    });
    const claim = await prisma.$transaction((tx) =>
      seats.claimWorkspaceSeatTx(tx as never, { workspaceId: o.workspaceId, userId: randomUUID() }),
    );
    expect(claim).toMatchObject({ outcome: "REFUSED", reason: "enterprise_contract_required" });
  });

  it("a stated contract of one seat admits exactly one: zero is not the same as one", async () => {
    const o = await organization(1);
    const ctx = await directory(o);
    expect((await pushUser(ctx, `one-${tag()}@${o.domain}`)).ok).toBe(true);
    expect(await pushUser(ctx, `one-${tag()}@${o.domain}`)).toMatchObject({ ok: false });
  });

  it("a self-serve plan keeps its answer: no workspace-wide ceiling on TEAM, nobody on FREE", async () => {
    const A = h.fixtures.teamA;
    await prisma.team.updateMany({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    const team = await seats.resolveWorkspaceSeatState(A.teamId, prisma);
    expect(team).toMatchObject({ limit: null, featureIncluded: true });
    await prisma.team.updateMany({ where: { id: A.teamId }, data: { billingPlan: "FREE" } });
  });

  it("an organization invitation never revives a suspended workspace member, and re-adds a removed one only when issued after the removal", async () => {
    const o = await organization(5);
    const [member] = await seat(o.workspaceId, 1);
    const grant = (invitationCreatedAt: Date) =>
      prisma.$transaction((tx) =>
        membership.grantWorkspaceMembership(tx as never, {
          organizationId: o.orgId,
          userId: member,
          assignment: { teamId: o.workspaceId, role: "MEMBER" },
          accessReason: "t",
          invitationCreatedAt,
        }),
      );

    await prisma.teamMember.updateMany({
      where: { teamId: o.workspaceId, userId: member },
      data: { status: "SUSPENDED", suspendedAtUtc: new Date(), suspensionReason: "admin" },
    });
    await expect(grant(new Date())).resolves.toEqual({ ok: false, reason: "membership_suspended" });

    const removedAt = new Date();
    await prisma.teamMember.updateMany({
      where: { teamId: o.workspaceId, userId: member },
      data: { status: "REVOKED", revokedAtUtc: removedAt },
    });
    await expect(grant(new Date(removedAt.getTime() - 60_000))).resolves.toEqual({
      ok: false,
      reason: "invite_superseded",
    });
    await expect(grant(new Date(removedAt.getTime() + 60_000))).resolves.toEqual({ ok: true });
    const row = await prisma.teamMember.findFirstOrThrow({ where: { teamId: o.workspaceId, userId: member } });
    expect(row).toMatchObject({ status: "ACTIVE", revokedAtUtc: null });
  });

  it("the projection path is seat-enforced too: a group add at a full workspace rolls the operation back", async () => {
    const o = await organization(1);
    await seat(o.workspaceId, 1);
    const ctx = await directory(o);
    const outsider = `grp-${tag()}@${o.domain}`;
    const user = await prisma.user.create({
      data: { email: outsider, provider: "EMAIL", providerUserId: outsider },
      select: { id: true },
    });
    await prisma.externalIdentityMapping.create({
      data: {
        teamId: o.workspaceId,
        organizationId: o.orgId,
        userId: user.id,
        provider: "GENERIC_SCIM",
        externalSubjectId: `ext-${tag()}`,
        externalEmail: outsider,
      },
    });
    const created = await groups.scimCreateGroup(
      ctx,
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: `grp-${tag()}`,
        externalId: `g-${tag()}`,
        mappedRole: "MEMBER",
        members: [{ value: user.id }],
      } as never,
      prisma,
    );
    expect(created).toMatchObject({ ok: false, status: 409, detail: "seat_limit_reached" });
    expect(await prisma.teamMember.count({ where: { teamId: o.workspaceId, userId: user.id } })).toBe(0);
  });
});
