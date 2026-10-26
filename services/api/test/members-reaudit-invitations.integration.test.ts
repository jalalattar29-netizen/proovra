/**
 * MEMBERS RE-AUDIT — PACKAGE D1a: workspace invitations (members audit INV-03,
 * INV-04, INV-05, INV-08).
 *
 * Real routes (and, for the claim race, the real acceptance service on a real
 * PostgreSQL with the conflicting write injected at the exact interleaving
 * point between the lookup and the claim):
 *
 *   - a repeat invitation at a different role is refused, typed, and the
 *     pending invitation is untouched; an undelivered email answers
 *     `emailSent: false` while the invitation still exists;
 *   - a resend is capped at 5 per 24 hours (429 INVITE_RESEND_LIMIT) and each
 *     resend writes an `invite_resent` activity row;
 *   - an expired-but-open invitation is listed as EXPIRED and is not counted
 *     as pending (nor is a revoked one);
 *   - the claim re-checks the token hash and the expiry it was accepted under.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";


type Prisma = import("@prisma/client").PrismaClient;

describe("Members re-audit D1a — workspace invitations (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let invitations: typeof import("../src/services/identity/workspace-invitation.service.js");
  let emailModule: typeof import("../src/services/email.service.js");
  let legalVersions: Record<string, string>;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    ({ signJwt } = await import("../src/services/jwt.js"));
    invitations = await import("../src/services/identity/workspace-invitation.service.js");
    emailModule = await import("../src/services/email.service.js");
    legalVersions = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
    // Invitations are a plan capability; the harness default holds none.
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 900_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const invitee = () => `d1a-inv-${tag()}@invitee.test`;
  const code = (res: { json: () => unknown }) => {
    const b = res.json() as { code?: string; error?: { code?: string } };
    return b.error?.code ?? b.code;
  };

  const invite = (email: string, role: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/teams/${A().teamId}/invites`,
      headers: bearer(A().ownerToken),
      payload: { email, role },
    });

  async function user(email: string) {
    const u = await prisma.user.create({
      data: { email, firstName: "D1a", lastName: "Invitee", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: u.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    const token = signJwt(
      { sub: u.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: u.id, token };
  }

  /** Find a numeric field anywhere in a JSON body. */
  function findNumber(body: unknown, key: string): number | undefined {
    if (!body || typeof body !== "object") return undefined;
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (k === key && typeof v === "number") return v;
      const nested = findNumber(v, key);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  it("INV-03 — a repeat invitation at a DIFFERENT role is refused 409 INVITE_PENDING_WITH_DIFFERENT_ROLE and the pending one is untouched", async () => {
    const email = invitee();
    const first = await invite(email, "MEMBER");
    expect(first.statusCode, first.body).toBe(201);
    const before = await prisma.teamInvite.findFirstOrThrow({ where: { teamId: A().teamId, email } });

    const other = await invite(email, "VIEWER");
    expect(other.statusCode, other.body).toBe(409);
    expect(code(other)).toBe("INVITE_PENDING_WITH_DIFFERENT_ROLE");
    expect((other.json() as { error: unknown }).error).toMatchObject({ state: "MEMBER", nextAction: "REVOKE_AND_REINVITE" });
    const after = await prisma.teamInvite.findFirstOrThrow({ where: { id: before.id } });
    expect(after).toMatchObject({ role: "MEMBER", tokenHash: before.tokenHash, resendCount: before.resendCount });
    expect(await prisma.teamInvite.count({ where: { teamId: A().teamId, email } })).toBe(1);

    // The SAME role is a resend: the token rotates and the response says so.
    const same = await invite(email, "MEMBER");
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json()).toMatchObject({ existing: true });
    expect((await prisma.teamInvite.findFirstOrThrow({ where: { id: before.id } })).tokenHash).not.toBe(before.tokenHash);
  });

  it("INV-03 — when the email cannot be delivered the invitation still exists and the response says emailSent:false", async () => {
    const service = emailModule.getEmailService();
    vi.spyOn(service, "isConfigured").mockReturnValue(true);
    const send = vi.spyOn(service, "sendTeamInvitation").mockRejectedValue(new Error("provider down"));
    const email = invitee();
    const res = await invite(email, "MEMBER");
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ emailSent: false, existing: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await prisma.teamInvite.count({ where: { teamId: A().teamId, email, revokedAt: null, acceptedAt: null } })).toBe(1);

    // ...and a delivered one says emailSent:true.
    send.mockResolvedValue(undefined as never);
    const ok = await invite(invitee(), "MEMBER");
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ emailSent: true });
  });

  it("INV-04 — five resends in 24 hours, each recorded as invite_resent; the sixth is 429 INVITE_RESEND_LIMIT and rotates nothing", async () => {
    const email = invitee();
    expect((await invite(email, "MEMBER")).statusCode).toBe(201);
    const row = await prisma.teamInvite.findFirstOrThrow({ where: { teamId: A().teamId, email } });
    const resend = () =>
      h.app.inject({
        method: "POST",
        url: `/v1/teams/${A().teamId}/invites/${row.id}/resend`,
        headers: bearer(A().adminToken),
      });
    for (let i = 0; i < invitations.MAX_INVITE_RESENDS_PER_24H; i += 1) {
      const r = await resend();
      expect(r.statusCode, r.body).toBe(200);
    }
    const resentRows = await prisma.teamActivity.findMany({
      where: { teamId: A().teamId, eventType: "invite_resent", targetId: row.id },
    });
    expect(resentRows).toHaveLength(5);
    expect(resentRows.every((a) => a.actorUserId === A().adminUserId)).toBe(true);
    const beforeSixth = await prisma.teamInvite.findUniqueOrThrow({ where: { id: row.id } });
    expect(beforeSixth.resendCount).toBe(5);

    const sixth = await resend();
    expect(sixth.statusCode, sixth.body).toBe(429);
    expect(code(sixth)).toBe("INVITE_RESEND_LIMIT");
    const afterSixth = await prisma.teamInvite.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterSixth.tokenHash).toBe(beforeSixth.tokenHash);
    expect(afterSixth.resendCount).toBe(5);
    expect(await prisma.teamActivity.count({ where: { teamId: A().teamId, eventType: "invite_resent", targetId: row.id } })).toBe(5);
  });

  it("INV-05 — an expired-but-open invitation is listed as EXPIRED and is not counted as pending; a revoked one is neither", async () => {
    const detailCount = async () =>
      findNumber((await h.app.inject({ method: "GET", url: `/v1/teams/${A().teamId}`, headers: bearer(A().ownerToken) })).json(), "pendingInviteCount");
    const reviewCount = async () =>
      (
        (await h.app.inject({ method: "GET", url: `/v1/teams/${A().teamId}/access-review`, headers: bearer(A().ownerToken) })).json() as {
          summary: { pendingInvites: number };
          pendingInvites: Array<{ inviteId: string }>;
        }
      );
    const baseDetail = await detailCount();
    const baseReview = (await reviewCount()).summary.pendingInvites;
    expect(baseDetail).toEqual(expect.any(Number));

    const lapsedEmail = invitee();
    const revokedEmail = invitee();
    expect((await invite(lapsedEmail, "MEMBER")).statusCode).toBe(201);
    expect((await invite(revokedEmail, "MEMBER")).statusCode).toBe(201);
    const lapsed = await prisma.teamInvite.findFirstOrThrow({ where: { teamId: A().teamId, email: lapsedEmail } });
    const revoked = await prisma.teamInvite.findFirstOrThrow({ where: { teamId: A().teamId, email: revokedEmail } });
    await prisma.teamInvite.update({ where: { id: lapsed.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const revoke = await h.app.inject({
      method: "DELETE",
      url: `/v1/teams/${A().teamId}/invites/${revoked.id}`,
      headers: bearer(A().ownerToken),
    });
    expect(revoke.statusCode, revoke.body).toBe(200);

    const list = await h.app.inject({ method: "GET", url: `/v1/teams/${A().teamId}/invites`, headers: bearer(A().ownerToken) });
    expect(list.statusCode).toBe(200);
    const listed = (list.json() as { invites: Array<{ id: string; status: string }> }).invites;
    expect(listed.find((i) => i.id === lapsed.id)?.status).toBe("EXPIRED");
    expect(listed.find((i) => i.id === revoked.id)).toBeUndefined();

    // Neither the expired nor the revoked invitation is pending anywhere.
    expect(await detailCount()).toBe(baseDetail);
    const review = await reviewCount();
    expect(review.summary.pendingInvites).toBe(baseReview);
    expect(review.pendingInvites.map((p) => p.inviteId)).not.toContain(lapsed.id);
    expect(review.pendingInvites.map((p) => p.inviteId)).not.toContain(revoked.id);
  });

  describe("INV-08 — the claim re-checks the token and the expiry at claim time", () => {
    /**
     * The real client, except that the FIRST transaction the service opens is
     * preceded by `between` — the write another request makes after this
     * acceptance has looked the invitation up and before it claims it.
     */
    function interleaved(between: () => Promise<unknown>): Prisma {
      let fired = false;
      return new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === "$transaction") {
            return async (...args: unknown[]) => {
              if (!fired) {
                fired = true;
                await between();
              }
              return (target.$transaction as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Prisma;
    }

    async function pendingFor(email: string) {
      return invitations.createWorkspaceInvitation({
        workspaceId: A().teamId,
        email,
        role: "MEMBER",
        invitedByUserId: A().ownerUserId,
      });
    }

    it("an invitation that EXPIRES between lookup and claim is refused and no membership is written", async () => {
      const email = invitee();
      const person = await user(email);
      const created = await pendingFor(email);
      const id = created.invite.id;
      const err = await invitations
        .acceptWorkspaceInvitation(
          { rawToken: created.rawToken, actorUserId: person.id },
          interleaved(() => prisma.teamInvite.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1_000) } })),
        )
        .then(
          () => null,
          (e: { code?: string }) => e.code ?? "unknown",
        );
      expect(err).toBe("INVITE_ALREADY_USED");
      expect(await prisma.teamMember.count({ where: { teamId: A().teamId, userId: person.id } })).toBe(0);
      expect((await prisma.teamInvite.findUniqueOrThrow({ where: { id } })).acceptedAt).toBeNull();
    });

    it("an invitation RESENT (token rotated) between lookup and claim refuses the old token", async () => {
      const email = invitee();
      const person = await user(email);
      const created = await pendingFor(email);
      const id = created.invite.id;
      const err = await invitations
        .acceptWorkspaceInvitation(
          { rawToken: created.rawToken, actorUserId: person.id },
          interleaved(() => invitations.resendWorkspaceInvitation({ workspaceId: A().teamId, inviteId: id })),
        )
        .then(
          () => null,
          (e: { code?: string }) => e.code ?? "unknown",
        );
      expect(err).toBe("INVITE_ALREADY_USED");
      expect(await prisma.teamMember.count({ where: { teamId: A().teamId, userId: person.id } })).toBe(0);
    });

    it("control: with no interleaved write the same acceptance succeeds", async () => {
      const email = invitee();
      const person = await user(email);
      const created = await pendingFor(email);
      const res = await h.app.inject({
        method: "POST",
        url: `/v1/teams/invites/${created.rawToken}/accept`,
        headers: bearer(person.token),
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      expect(
        (await prisma.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: A().teamId, userId: person.id } } })).status,
      ).toBe("ACTIVE");
    });
  });
});
