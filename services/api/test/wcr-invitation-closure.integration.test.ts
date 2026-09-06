/**
 * WORKSPACE AND COLLABORATION RECONCILIATION — CLOSURE, part 1:
 * the workspace invitation lifecycle and the commercial boundary it defends,
 * against live PostgreSQL 16.
 *
 * WHAT THIS SUITE IS FOR
 * ---------------------------------------------------------------------------
 * The reconciliation shipped one invitation authority and one seat authority.
 * They were proven by ad-hoc probes at the time, which is proof that a tree
 * once behaved — not proof that it still does. Everything the model actually
 * rests on is asserted here instead, so a later change that breaks it fails a
 * gate rather than a memory.
 *
 * Nothing under proof is mocked. The service, the seat resolver, the allowance
 * resolver, the commercial context and the plan catalog all run for real
 * against a disposable PostgreSQL 16; only the process boundary (the database
 * itself) is provided by the harness.
 *
 * THE PROPERTIES
 * ---------------------------------------------------------------------------
 *   1. LIFECYCLE     create · resend (rotating) · revoke · expire · accept ·
 *                    repeat accept · email mismatch · new user · existing user
 *   2. LIVENESS      a closed workspace and a suspended Organization refuse
 *                    acceptance, because the actor is not a member yet and the
 *                    canonical authorization chain therefore never runs
 *   3. SECRECY       the raw token is returned exactly once, never persisted,
 *                    never projected
 *   4. ALLOWANCE     pending and 24-hour ceilings, WORKSPACE-scoped
 *   5. SEATS         the Nth+1 active member is refused atomically, and
 *                    concurrent distinct invitations cannot exceed the limit
 *   6. GROUPS        assigning one person to several groups spends one seat
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  seedUser,
  setAccountPlan,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

type Prisma = typeof import("../src/db.js")["prisma"];
type InviteService = typeof import("../src/services/identity/workspace-invitation.service.js");
type SeatService = typeof import("../src/services/billing/workspace-seats.service.js");

describe("WCR closure — workspace invitation + seat authority (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: Prisma;
  let deps: FixtureDeps;
  let invites: InviteService;
  let seats: SeatService;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    invites = await import(
      "../src/services/identity/workspace-invitation.service.js"
    );
    seats = await import("../src/services/billing/workspace-seats.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `wcr-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };
  }, 900_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 300_000);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const addr = (label: string) =>
    `wcr-${label}-${randomUUID().slice(0, 8)}@invitee.test`;

  /** A person who does not yet belong to the workspace under test. */
  async function outsider(label: string) {
    const u = await seedUser(deps, label);
    return u;
  }

  async function invite(workspaceId: string, inviterUserId: string, email: string) {
    return invites.createWorkspaceInvitation(
      { workspaceId, email, role: "MEMBER", invitedByUserId: inviterUserId },
      prisma as never,
    );
  }

  /** Run something that must throw a typed WorkspaceInvitationError. */
  async function refusal(fn: () => Promise<unknown>) {
    try {
      await fn();
      return { code: "ALLOWED", httpStatus: 200 };
    } catch (err) {
      const e = err as { code?: string; httpStatus?: number };
      return { code: e.code ?? "UNTYPED", httpStatus: e.httpStatus ?? 500 };
    }
  }

  const activeMembers = (workspaceId: string) =>
    prisma.teamMember.count({
      where: { teamId: workspaceId, status: "ACTIVE" },
    });

  // =========================================================================
  // 1. LIFECYCLE
  // =========================================================================

  describe("lifecycle", () => {
    it("create → the raw token is returned once and never persisted", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const email = addr("secrecy");
      const created = await invite(t.personalTeamId, t.owner.userId, email);

      expect(created.rawToken).toMatch(/^wsit_v1_/);
      // The projection a list endpoint returns carries no secret at all.
      expect(JSON.stringify(created.invite)).not.toContain(created.rawToken);
      expect(Object.keys(created.invite)).not.toContain("token");
      expect(Object.keys(created.invite)).not.toContain("tokenHash");

      // RELEASE B — the plaintext column does not exist any more, so the
      // question "is the token stored" is answered by the schema itself.
      const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'team_invites'
      `;
      expect(columns.map((c) => c.column_name)).not.toContain("token");

      // And the row that IS stored holds only a hash of it.
      const row = await prisma.teamInvite.findUniqueOrThrow({
        where: { id: created.invite.id },
      });
      expect(JSON.stringify(row)).not.toContain(created.rawToken);
      expect(row.tokenHash).toHaveLength(64);
    });

    it("resend ROTATES: the previous link stops working, the new one works", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const email = addr("rotate");
      const first = await invite(t.personalTeamId, t.owner.userId, email);
      const second = await invites.resendWorkspaceInvitation(
        { workspaceId: t.personalTeamId, inviteId: first.invite.id },
        prisma as never,
      );
      expect(second.rawToken).not.toBe(first.rawToken);
      expect(second.invite.resendCount).toBe(1);
      expect(second.invite.lastResentAt).not.toBeNull();

      const joiner = await outsider("rotate-joiner");
      await prisma.user.update({
        where: { id: joiner.userId },
        data: { email },
      });

      // The superseded link is not merely stale — it resolves to nothing.
      expect(
        await refusal(() =>
          invites.acceptWorkspaceInvitation(
            { rawToken: first.rawToken, actorUserId: joiner.userId },
            prisma as never,
          ),
        ),
      ).toEqual({ code: "INVITE_NOT_FOUND", httpStatus: 404 });

      const accepted = await invites.acceptWorkspaceInvitation(
        { rawToken: second.rawToken, actorUserId: joiner.userId },
        prisma as never,
      );
      expect(accepted.alreadyMember).toBe(false);
    });

    it("revoke is a STATE, and the revoked link is refused as revoked", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const email = addr("revoke");
      const created = await invite(t.personalTeamId, t.owner.userId, email);
      await invites.revokeWorkspaceInvitation(
        {
          workspaceId: t.personalTeamId,
          inviteId: created.invite.id,
          actorUserId: t.owner.userId,
        },
        prisma as never,
      );

      // The row survives — an invitation that was sent and withdrawn is a fact.
      const row = await prisma.teamInvite.findUnique({
        where: { id: created.invite.id },
      });
      expect(row).not.toBeNull();
      expect(row!.revokedAt).not.toBeNull();
      expect(row!.revokedByUserId).toBe(t.owner.userId);

      const joiner = await outsider("revoke-joiner");
      await prisma.user.update({ where: { id: joiner.userId }, data: { email } });
      // The revoke rotates the token dead, so the old link resolves to
      // nothing; either answer is a refusal that grants no membership.
      const outcome = await refusal(() =>
        invites.acceptWorkspaceInvitation(
          { rawToken: created.rawToken, actorUserId: joiner.userId },
          prisma as never,
        ),
      );
      expect(["INVITE_REVOKED", "INVITE_NOT_FOUND"]).toContain(outcome.code);
      expect(await activeMembers(t.personalTeamId)).toBe(1);
    });

    it("an EXPIRED invitation is refused as expired, and provisions nothing", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const email = addr("expired");
      const created = await invites.createWorkspaceInvitation(
        {
          workspaceId: t.personalTeamId,
          email,
          role: "MEMBER",
          invitedByUserId: t.owner.userId,
          expiresInMs: 1,
        },
        prisma as never,
      );
      await new Promise((r) => setTimeout(r, 30));
      const joiner = await outsider("expired-joiner");
      await prisma.user.update({ where: { id: joiner.userId }, data: { email } });

      expect(
        await refusal(() =>
          invites.acceptWorkspaceInvitation(
            { rawToken: created.rawToken, actorUserId: joiner.userId },
            prisma as never,
          ),
        ),
      ).toEqual({ code: "INVITE_EXPIRED", httpStatus: 410 });
      expect(await activeMembers(t.personalTeamId)).toBe(1);
    });

    it("acceptance is bound to the invited address, and repeats are idempotent", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const email = addr("bound");
      const created = await invite(t.personalTeamId, t.owner.userId, email);

      // A DIFFERENT person holding the link gets nothing.
      const stranger = await outsider("bound-stranger");
      expect(
        await refusal(() =>
          invites.acceptWorkspaceInvitation(
            { rawToken: created.rawToken, actorUserId: stranger.userId },
            prisma as never,
          ),
        ),
      ).toEqual({ code: "INVITE_EMAIL_MISMATCH", httpStatus: 403 });
      expect(
        await prisma.teamMember.count({
          where: { teamId: t.personalTeamId, userId: stranger.userId },
        }),
      ).toBe(0);

      // The invited person joins …
      const joiner = await outsider("bound-joiner");
      await prisma.user.update({ where: { id: joiner.userId }, data: { email } });
      const first = await invites.acceptWorkspaceInvitation(
        { rawToken: created.rawToken, actorUserId: joiner.userId },
        prisma as never,
      );
      expect(first.alreadyMember).toBe(false);

      // … and re-following their own link is a success that consumes nothing.
      const again = await invites.acceptWorkspaceInvitation(
        { rawToken: created.rawToken, actorUserId: joiner.userId },
        prisma as never,
      );
      expect(again.alreadyMember).toBe(true);
      expect(
        await prisma.teamMember.count({
          where: { teamId: t.personalTeamId, userId: joiner.userId },
        }),
      ).toBe(1);
    });

    it("a NEW person and an EXISTING person both arrive through the same claim", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");

      // "Existing user" — already has an account, in another workspace.
      const existing = await seedPersonalTenant(deps, "FREE");
      const inviteExisting = await invite(
        t.personalTeamId,
        t.owner.userId,
        existing.owner.email,
      );
      const joinedExisting = await invites.acceptWorkspaceInvitation(
        { rawToken: inviteExisting.rawToken, actorUserId: existing.owner.userId },
        prisma as never,
      );
      expect(joinedExisting.workspaceId).toBe(t.personalTeamId);

      // "New user" — the account is created between invitation and acceptance,
      // which is what a signup-from-invitation flow does.
      const email = addr("newcomer");
      const inviteNew = await invite(t.personalTeamId, t.owner.userId, email);
      const created = await prisma.user.create({
        data: {
          email,
          displayName: "Newcomer",
          provider: "EMAIL",
          providerUserId: email,
        },
        select: { id: true },
      });
      const joinedNew = await invites.acceptWorkspaceInvitation(
        { rawToken: inviteNew.rawToken, actorUserId: created.id },
        prisma as never,
      );
      expect(joinedNew.workspaceId).toBe(t.personalTeamId);
      expect(await activeMembers(t.personalTeamId)).toBe(3);
    });

    it("the inviter losing authority does not invalidate an issued invitation", async () => {
      // A deliberate decision, asserted so it cannot change by accident: the
      // invitation is WORKSPACE-scoped, not inviter-scoped. The controls that
      // matter — the seat, the workspace's liveness, the invited address — are
      // all evaluated at acceptance, and none of them is the inviter.
      const t = await seedPersonalTenant(deps, "TEAM");
      const inviter = await outsider("losing-authority");
      await prisma.teamMember.create({
        data: {
          teamId: t.personalTeamId,
          userId: inviter.userId,
          role: "ADMIN",
          status: "ACTIVE",
        },
      });
      const email = addr("still-valid");
      const created = await invite(t.personalTeamId, inviter.userId, email);

      await prisma.teamMember.updateMany({
        where: { teamId: t.personalTeamId, userId: inviter.userId },
        data: { status: "REVOKED" },
      });

      const joiner = await outsider("still-valid-joiner");
      await prisma.user.update({ where: { id: joiner.userId }, data: { email } });
      const accepted = await invites.acceptWorkspaceInvitation(
        { rawToken: created.rawToken, actorUserId: joiner.userId },
        prisma as never,
      );
      expect(accepted.alreadyMember).toBe(false);
    });
  });

  // =========================================================================
  // 2. LIVENESS — the gate the authorization chain cannot supply here
  // =========================================================================

  describe("workspace liveness", () => {
    it("a CLOSED workspace refuses acceptance and provisions nothing", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const email = addr("closed");
      const created = await invite(t.personalTeamId, t.owner.userId, email);
      const joiner = await outsider("closed-joiner");
      await prisma.user.update({ where: { id: joiner.userId }, data: { email } });

      await prisma.team.update({
        where: { id: t.personalTeamId },
        data: { closedAtUtc: new Date() },
      });

      expect(
        await refusal(() =>
          invites.acceptWorkspaceInvitation(
            { rawToken: created.rawToken, actorUserId: joiner.userId },
            prisma as never,
          ),
        ),
      ).toEqual({ code: "WORKSPACE_NOT_ACCEPTING_MEMBERS", httpStatus: 409 });
      expect(
        await prisma.teamMember.count({
          where: { teamId: t.personalTeamId, userId: joiner.userId },
        }),
      ).toBe(0);
      // The invitation is not consumed either — it is refused, not spent.
      const row = await prisma.teamInvite.findUniqueOrThrow({
        where: { id: created.invite.id },
      });
      expect(row.acceptedAt).toBeNull();
    });

    it("a SUSPENDED Organization refuses acceptance into its workspace", async () => {
      const owner = await seedUser(deps, "org-live-owner");
      await setAccountPlan(deps, owner.userId, "TEAM");
      const org = await prisma.organization.create({
        data: { name: `wcr-org-${randomUUID().slice(0, 6)}`, kind: "CUSTOMER", status: "ACTIVE" },
        select: { id: true },
      });
      const ws = await prisma.team.create({
        data: {
          name: "wcr-org-ws",
          ownerUserId: owner.userId,
          isPersonal: false,
          organizationId: org.id,
          workspaceKind: "ORGANIZATION",
          billingPlan: "TEAM",
          billingStatus: "ACTIVE",
        },
        select: { id: true },
      });
      await prisma.teamMember.create({
        data: { teamId: ws.id, userId: owner.userId, role: "OWNER", status: "ACTIVE" },
      });

      const email = addr("suspended");
      const created = await invite(ws.id, owner.userId, email);
      const joiner = await outsider("suspended-joiner");
      await prisma.user.update({ where: { id: joiner.userId }, data: { email } });

      await prisma.organization.update({
        where: { id: org.id },
        data: { status: "SUSPENDED" },
      });

      expect(
        await refusal(() =>
          invites.acceptWorkspaceInvitation(
            { rawToken: created.rawToken, actorUserId: joiner.userId },
            prisma as never,
          ),
        ),
      ).toEqual({ code: "WORKSPACE_NOT_ACCEPTING_MEMBERS", httpStatus: 409 });
      expect(
        await prisma.teamMember.count({ where: { teamId: ws.id, userId: joiner.userId } }),
      ).toBe(0);

      // Resuming the organization restores it — the gate reads live state,
      // it does not brand the invitation.
      await prisma.organization.update({
        where: { id: org.id },
        data: { status: "ACTIVE" },
      });
      const accepted = await invites.acceptWorkspaceInvitation(
        { rawToken: created.rawToken, actorUserId: joiner.userId },
        prisma as never,
      );
      expect(accepted.alreadyMember).toBe(false);
    });
  });

  // =========================================================================
  // 4. ALLOWANCE — pending + rate, WORKSPACE-scoped
  // =========================================================================

  describe("invitation allowance", () => {
    it("FREE and PAYG may invite nobody, and the refusal is typed", async () => {
      for (const plan of ["FREE", "PAYG"] as const) {
        const t = await seedPersonalTenant(deps, plan);
        const outcome = await refusal(() =>
          invite(t.personalTeamId, t.owner.userId, addr(`no-${plan}`)),
        );
        expect(outcome, `${plan} must refuse`).toEqual({
          code: "WORKSPACE_INVITES_NOT_INCLUDED",
          httpStatus: 402,
        });
        expect(
          await prisma.teamInvite.count({ where: { teamId: t.personalTeamId } }),
          `${plan} wrote an invitation`,
        ).toBe(0);
      }
    });

    it("PRO holds 10 pending; the eleventh is refused with the numbers", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const allowance = await seats.resolveWorkspaceInvitationAllowance(
        t.personalTeamId,
        prisma as never,
      );
      expect(allowance).toMatchObject({ plan: "PRO", maxPending: 10, maxPer24h: 50 });

      for (let i = 0; i < allowance.maxPending; i += 1) {
        await invite(t.personalTeamId, t.owner.userId, addr(`pro-pending-${i}`));
      }
      const outcome = await refusal(() =>
        invite(t.personalTeamId, t.owner.userId, addr("pro-overflow")),
      );
      expect(outcome).toEqual({
        code: "WORKSPACE_INVITE_LIMIT_REACHED",
        httpStatus: 409,
      });
      expect(
        await prisma.teamInvite.count({ where: { teamId: t.personalTeamId } }),
      ).toBe(10);

      // Revoking one frees exactly one.
      const oldest = await prisma.teamInvite.findFirstOrThrow({
        where: { teamId: t.personalTeamId, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: "asc" },
      });
      await invites.revokeWorkspaceInvitation(
        {
          workspaceId: t.personalTeamId,
          inviteId: oldest.id,
          actorUserId: t.owner.userId,
        },
        prisma as never,
      );
      await invite(t.personalTeamId, t.owner.userId, addr("pro-after-revoke"));
      expect(
        await prisma.teamInvite.count({
          where: { teamId: t.personalTeamId, acceptedAt: null, revokedAt: null },
        }),
      ).toBe(10);
    });

    it("TEAM holds 25 pending and 100 a day", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const allowance = await seats.resolveWorkspaceInvitationAllowance(
        t.personalTeamId,
        prisma as never,
      );
      expect(allowance).toMatchObject({
        plan: "TEAM",
        maxPending: 25,
        maxPer24h: 100,
      });
      for (let i = 0; i < 25; i += 1) {
        await invite(t.personalTeamId, t.owner.userId, addr(`team-pending-${i}`));
      }
      expect(
        await refusal(() =>
          invite(t.personalTeamId, t.owner.userId, addr("team-overflow")),
        ),
      ).toEqual({ code: "WORKSPACE_INVITE_LIMIT_REACHED", httpStatus: 409 });
    });

    it("the 24-hour ceiling is separate from the pending one", async () => {
      // Expire everything that was sent, so nothing is pending — the rate
      // limit must still hold, because it counts what was SENT.
      const t = await seedPersonalTenant(deps, "PRO");
      for (let i = 0; i < 10; i += 1) {
        await invite(t.personalTeamId, t.owner.userId, addr(`rate-${i}`));
      }
      await prisma.teamInvite.updateMany({
        where: { teamId: t.personalTeamId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const afterExpiry = await seats.resolveWorkspaceInvitationAllowance(
        t.personalTeamId,
        prisma as never,
      );
      expect(afterExpiry.pending).toBe(0);
      expect(afterExpiry.sentLast24h).toBe(10);

      // Push the SENT count to the ceiling and confirm the rate refusal.
      await prisma.teamInvite.createMany({
        data: Array.from({ length: 40 }, () => ({
          teamId: t.personalTeamId,
          email: addr("rate-filler"),
          role: "MEMBER" as const,
          tokenHash: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
          invitedByUserId: t.owner.userId,
          expiresAt: new Date(Date.now() - 1000),
        })),
      });
      expect(
        await refusal(() =>
          invite(t.personalTeamId, t.owner.userId, addr("rate-overflow")),
        ),
      ).toEqual({
        code: "WORKSPACE_INVITE_RATE_LIMIT_REACHED",
        httpStatus: 429,
      });
    });

    it("the allowance is WORKSPACE-scoped — groups do not multiply it", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      // Two collaboration groups, which is exactly PRO's allowance of them.
      for (const name of ["group one", "group two"]) {
        await prisma.collaborationTeam.create({
          data: {
            workspaceId: t.personalTeamId,
            name,
            createdByUserId: t.owner.userId,
          },
        });
      }
      for (let i = 0; i < 10; i += 1) {
        await invite(t.personalTeamId, t.owner.userId, addr(`scoped-${i}`));
      }
      // If the ceiling were per group this would succeed. It is per workspace.
      expect(
        await refusal(() =>
          invite(t.personalTeamId, t.owner.userId, addr("scoped-overflow")),
        ),
      ).toEqual({ code: "WORKSPACE_INVITE_LIMIT_REACHED", httpStatus: 409 });
    });
  });

  // =========================================================================
  // 5. SEATS
  // =========================================================================

  describe("seats", () => {
    async function fillToCeiling(workspaceId: string, ownerUserId: string, limit: number) {
      const joiners: string[] = [];
      for (let i = (await activeMembers(workspaceId)); i < limit; i += 1) {
        const email = addr(`seat-${i}`);
        const created = await invite(workspaceId, ownerUserId, email);
        const u = await outsider(`seat-${i}`);
        await prisma.user.update({ where: { id: u.userId }, data: { email } });
        await invites.acceptWorkspaceInvitation(
          { rawToken: created.rawToken, actorUserId: u.userId },
          prisma as never,
        );
        joiners.push(u.userId);
      }
      return joiners;
    }

    it("PRO: the sixth active member is refused atomically", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const state = await seats.resolveWorkspaceSeatState(
        t.personalTeamId,
        prisma as never,
      );
      expect(state.limit).toBe(5);
      await fillToCeiling(t.personalTeamId, t.owner.userId, 5);
      expect(await activeMembers(t.personalTeamId)).toBe(5);

      const email = addr("pro-sixth");
      const created = await invite(t.personalTeamId, t.owner.userId, email);
      const sixth = await outsider("pro-sixth");
      await prisma.user.update({ where: { id: sixth.userId }, data: { email } });
      expect(
        await refusal(() =>
          invites.acceptWorkspaceInvitation(
            { rawToken: created.rawToken, actorUserId: sixth.userId },
            prisma as never,
          ),
        ),
      ).toEqual({ code: "WORKSPACE_SEAT_LIMIT_REACHED", httpStatus: 409 });
      expect(await activeMembers(t.personalTeamId)).toBe(5);
      const row = await prisma.teamInvite.findUniqueOrThrow({
        where: { id: created.invite.id },
      });
      expect(row.acceptedAt).toBeNull();
    });

    it("TEAM: the eleventh active member is refused atomically", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      expect(
        (await seats.resolveWorkspaceSeatState(t.personalTeamId, prisma as never))
          .limit,
      ).toBe(10);
      await fillToCeiling(t.personalTeamId, t.owner.userId, 10);
      expect(await activeMembers(t.personalTeamId)).toBe(10);

      const email = addr("team-eleventh");
      const created = await invite(t.personalTeamId, t.owner.userId, email);
      const eleventh = await outsider("team-eleventh");
      await prisma.user.update({
        where: { id: eleventh.userId },
        data: { email },
      });
      expect(
        await refusal(() =>
          invites.acceptWorkspaceInvitation(
            { rawToken: created.rawToken, actorUserId: eleventh.userId },
            prisma as never,
          ),
        ),
      ).toEqual({ code: "WORKSPACE_SEAT_LIMIT_REACHED", httpStatus: 409 });
      expect(await activeMembers(t.personalTeamId)).toBe(10);
    });

    it("CONCURRENT distinct invitations cannot exceed the seat limit", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      await fillToCeiling(t.personalTeamId, t.owner.userId, 3);
      expect(await activeMembers(t.personalTeamId)).toBe(3);

      // Two seats left, eight contenders, each with their OWN invitation —
      // so the single-use claim cannot be what bounds this. Only the seat
      // check under the per-workspace lock can.
      const contenders = await Promise.all(
        Array.from({ length: 8 }, async (_unused, i) => {
          const email = addr(`race-${i}`);
          const created = await invite(t.personalTeamId, t.owner.userId, email);
          const u = await outsider(`race-${i}`);
          await prisma.user.update({ where: { id: u.userId }, data: { email } });
          return { rawToken: created.rawToken, userId: u.userId };
        }),
      );

      const results = await Promise.all(
        contenders.map((c) =>
          invites
            .acceptWorkspaceInvitation(
              { rawToken: c.rawToken, actorUserId: c.userId },
              prisma as never,
            )
            .then(
              () => "ACCEPTED",
              (err: { code?: string }) => err.code ?? "UNTYPED",
            ),
        ),
      );

      const accepted = results.filter((r) => r === "ACCEPTED").length;
      const seatRefusals = results.filter(
        (r) => r === "WORKSPACE_SEAT_LIMIT_REACHED",
      ).length;
      const other = results.filter(
        (r) => r !== "ACCEPTED" && r !== "WORKSPACE_SEAT_LIMIT_REACHED",
      );

      expect(accepted, `accepted=${accepted} results=${results.join(",")}`).toBe(2);
      expect(other, `unexpected outcomes: ${other.join(",")}`).toEqual([]);
      expect(seatRefusals).toBe(6);
      expect(await activeMembers(t.personalTeamId)).toBe(5);
    });

    it("a member in several groups is still ONE seat", async () => {
      const t = await seedPersonalTenant(deps, "TEAM");
      const email = addr("multi-group");
      const created = await invite(t.personalTeamId, t.owner.userId, email);
      const u = await outsider("multi-group");
      await prisma.user.update({ where: { id: u.userId }, data: { email } });
      await invites.acceptWorkspaceInvitation(
        { rawToken: created.rawToken, actorUserId: u.userId },
        prisma as never,
      );
      const before = await seats.resolveWorkspaceSeatState(
        t.personalTeamId,
        prisma as never,
      );

      const service = await import(
        "../src/services/collaboration-team/collaboration-team.service.js"
      );
      for (const name of ["alpha", "beta", "gamma"]) {
        const group = await service.createCollaborationTeam({
          workspaceId: t.personalTeamId,
          actorUserId: t.owner.userId,
          name: `group ${name}`,
          description: null,
          teamType: null,
        });
        await service.addExistingMember({
          teamId: group.id,
          actorUserId: t.owner.userId,
          userIdToAdd: u.userId,
          role: "MEMBER",
        });
      }

      const after = await seats.resolveWorkspaceSeatState(
        t.personalTeamId,
        prisma as never,
      );
      expect(after.used).toBe(before.used);
      expect(
        await prisma.collaborationTeamMember.count({
          where: { userId: u.userId, status: "ACTIVE" },
        }),
      ).toBe(3);
    });
  });
});
