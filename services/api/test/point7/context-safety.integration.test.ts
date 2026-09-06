/**
 * PHASE 12 — POINT 7: the context-safety matrix, against live PostgreSQL 16.
 *
 * These are the cross-plan properties — the ones that hold for FREE and for
 * ENTERPRISE alike, and that break in the same way when they break: a context
 * chosen from local storage rather than from authority, an invitation accepted
 * by the wrong person, a limit that two simultaneous requests both slip past,
 * a foreign id that answers differently from a nonexistent one and thereby
 * confirms it exists.
 *
 * The browser layer owns the half of this matrix that only a browser can
 * observe (stale responses, dirty forms, cache reuse). This file owns the half
 * a browser cannot observe honestly: what the DATABASE says afterwards.
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import {
  fingerprintDelta,
  fingerprintSideEffects,
  seedOrganizationTenant,
  seedOwnedWorkspace,
  seedPersonalTenant,
  seedUser,
  setAccountPlan,
  type FixtureDeps,
} from "./product-fixtures.js";
import { provenScenario, recordScenarioProof } from "./scenario-manifest.js";

const SUITE = "services/api/test/point7/context-safety.integration.test.ts";

/** A syntactically valid id that names nothing. */
const NOWHERE = "00000000-0000-4000-8000-0000000000ff";

describe("POINT 7 — context safety (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let deps: FixtureDeps;

  const inject = (opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
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
        ...(opts.payload ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload ? { payload: opts.payload as never } : {}),
    });

  const context = (token: string) =>
    inject({
      method: "GET",
      url: "/v1/platform/context",
      token,
      headers: { "x-platform-context-version": "3" },
    });

  async function denyWithoutSideEffects(opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
  }) {
    const before = await fingerprintSideEffects(prisma);
    const res = await inject(opts);
    const after = await fingerprintSideEffects(prisma);
    expect(res.statusCode, `${opts.method} ${opts.url} must be denied`).toBeGreaterThanOrEqual(400);
    expect(
      fingerprintDelta(before, after),
      `${opts.method} ${opts.url} denied but mutated durable state`,
    ).toEqual({});
    return res;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { signJwt } = await import("../../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `p7c-${Date.now().toString(36)}`,
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
  });

  afterAll(async () => {
    recordScenarioProof({ suiteRelPath: SUITE, layer: "SERVER" });
    await harness?.cleanup();
  });

  // =========================================================================
  // Login and restoration — the server chooses, storage never does
  // =========================================================================

  describe("context restoration", () => {
    it("p7.ctx.restore.inaccessible_previous_workspace", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const owned = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
      });
      await prisma.user.update({
        where: { id: t.owner.userId },
        data: { currentWorkspaceId: owned.teamId },
      });
      // The workspace becomes inaccessible: the membership is revoked.
      await prisma.teamMember.update({
        where: {
          teamId_userId: { teamId: owned.teamId, userId: t.owner.userId },
        },
        data: { status: "REVOKED" },
      });

      const res = await context(t.owner.token);
      expect(res.statusCode).toBe(200);
      const env = res.json();
      // Whatever it resolves to, it is NOT the workspace the pointer named.
      expect(env.activeSpace.id).not.toBe(owned.teamId);
      // And the stale pointer was healed rather than left to be re-tried.
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: t.owner.userId },
        select: { currentWorkspaceId: true },
      });
      expect(user.currentWorkspaceId).not.toBe(owned.teamId);
      provenScenario("SERVER", "p7.ctx.restore.inaccessible_previous_workspace");
    });

    it("p7.ctx.restore.foreign_tenant_stored_id", async () => {
      // Two unrelated tenants with deliberately similar names, so a name-based
      // confusion would be as available to the code as an id-based one.
      const mine = await seedPersonalTenant(deps, "PRO");
      const theirs = await seedPersonalTenant(deps, "PRO");
      const foreign = await seedOwnedWorkspace(deps, {
        ownerUserId: theirs.owner.userId,
        name: `Acme Investigations ${deps.tag}`,
      });
      await seedOwnedWorkspace(deps, {
        ownerUserId: mine.owner.userId,
        name: `Acme lnvestigations ${deps.tag}`,
      });

      // The pointer is set to a workspace belonging to the OTHER tenant — the
      // exact state a copied local-storage value or a guessed id produces.
      await prisma.user.update({
        where: { id: mine.owner.userId },
        data: { currentWorkspaceId: foreign.teamId },
      });

      const res = await context(mine.owner.token);
      expect(res.statusCode).toBe(200);
      const env = res.json();
      expect(env.activeSpace.id).not.toBe(foreign.teamId);
      expect(
        (env.contextOptions.ownedWorkspaces ?? []).map(
          (w: { workspaceId: string }) => w.workspaceId,
        ),
      ).not.toContain(foreign.teamId);
      // Explicitly asking to switch into it is refused too.
      await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        token: mine.owner.token,
        payload: { workspaceId: foreign.teamId },
      });
      provenScenario("SERVER", "p7.ctx.restore.foreign_tenant_stored_id");
    });

    it("p7.ctx.restore.inactive_membership", async () => {
      const org = await seedOrganizationTenant(deps, { memberCount: 1 });
      const member = org.members[0];
      await setAccountPlan(deps, member.userId, "FREE");
      await prisma.user.update({
        where: { id: member.userId },
        data: { currentWorkspaceId: org.workspaceId },
      });
      await prisma.teamMember.update({
        where: {
          teamId_userId: { teamId: org.workspaceId, userId: member.userId },
        },
        data: { status: "SUSPENDED" },
      });

      const res = await context(member.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().activeSpace.id).not.toBe(org.workspaceId);
      // A suspended member cannot re-enter by asking.
      await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        token: member.token,
        payload: { workspaceId: org.workspaceId },
      });
      provenScenario("SERVER", "p7.ctx.restore.inactive_membership");
    });
  });

  // =========================================================================
  // Invitations — tenant and recipient authority are the server's
  // =========================================================================

  describe("invitations", () => {
    /**
     * Seed a real workspace invitation the acceptance route consumes.
     *
     * The TOKEN is the credential, so the fixture stores what production
     * stores and hands the test the raw value exactly once — the same shape a
     * real emailed link has.
     */
    async function seedWorkspaceInvite(input: {
      teamId: string;
      email: string;
      invitedByUserId: string;
      expiresAt?: Date;
      acceptedAt?: Date | null;
    }): Promise<{ token: string; id: string }> {
      const token = `p7-invite-${randomUUID()}`;
      const row = await prisma.teamInvite.create({
        data: {
          teamId: input.teamId,
          email: input.email.toLowerCase(),
          role: "MEMBER",
          token,
          // `tokenHash` is the authoritative lookup column now; the fixture
          // hashes the same way the service does so a row it creates is
          // resolvable by the real accept path.
          tokenHash: createHash("sha256").update(token).digest("hex"),
          invitedByUserId: input.invitedByUserId,
          expiresAt: input.expiresAt ?? new Date(Date.now() + 86_400_000),
          ...(input.acceptedAt !== undefined
            ? { acceptedAt: input.acceptedAt }
            : {}),
        },
        select: { id: true },
      });
      return { token, id: row.id };
    }

    async function seedInviteHost() {
      const host = await seedPersonalTenant(deps, "TEAM");
      const ws = await seedOwnedWorkspace(deps, {
        ownerUserId: host.owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      return { host, ws };
    }

    it("p7.invite.correct_recipient_accepts", async () => {
      const { host, ws } = await seedInviteHost();
      const recipient = await seedUser(deps, "invite-recipient");
      await setAccountPlan(deps, recipient.userId, "FREE");
      const invite = await seedWorkspaceInvite({
        teamId: ws.teamId,
        email: recipient.email,
        invitedByUserId: host.owner.userId,
      });

      const res = await inject({
        method: "POST",
        url: `/v1/teams/invites/${invite.token}/accept`,
        token: recipient.token,
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      const memberships = await prisma.teamMember.findMany({
        where: { teamId: ws.teamId, userId: recipient.userId },
      });
      // Exactly one membership, ACTIVE, in the workspace the invite named.
      expect(memberships.length).toBe(1);
      expect(memberships[0].status).toBe("ACTIVE");
      provenScenario("SERVER", "p7.invite.correct_recipient_accepts");
    });

    it("p7.invite.wrong_authenticated_user_denied", async () => {
      const { host, ws } = await seedInviteHost();
      const intended = await seedUser(deps, "invite-intended");
      const interloper = await seedUser(deps, "invite-interloper");
      await setAccountPlan(deps, interloper.userId, "FREE");
      const invite = await seedWorkspaceInvite({
        teamId: ws.teamId,
        email: intended.email,
        invitedByUserId: host.owner.userId,
      });

      await denyWithoutSideEffects({
        method: "POST",
        url: `/v1/teams/invites/${invite.token}/accept`,
        token: interloper.token,
      });
      expect(
        await prisma.teamMember.count({
          where: { teamId: ws.teamId, userId: interloper.userId },
        }),
      ).toBe(0);
      // And the invitation is still available to the person it was for.
      const still = await prisma.teamInvite.findUniqueOrThrow({
        where: { id: invite.id },
        select: { acceptedAt: true },
      });
      expect(still.acceptedAt).toBeNull();
      provenScenario("SERVER", "p7.invite.wrong_authenticated_user_denied");
    });

    it("p7.invite.expired_denied", async () => {
      const { host, ws } = await seedInviteHost();
      const recipient = await seedUser(deps, "invite-expired");
      await setAccountPlan(deps, recipient.userId, "FREE");
      const invite = await seedWorkspaceInvite({
        teamId: ws.teamId,
        email: recipient.email,
        invitedByUserId: host.owner.userId,
        expiresAt: new Date(Date.now() - 60_000),
      });
      await denyWithoutSideEffects({
        method: "POST",
        url: `/v1/teams/invites/${invite.token}/accept`,
        token: recipient.token,
      });
      expect(
        await prisma.teamMember.count({
          where: { teamId: ws.teamId, userId: recipient.userId },
        }),
      ).toBe(0);
      provenScenario("SERVER", "p7.invite.expired_denied");
    });

    it("p7.invite.revoked_denied", async () => {
      const { host, ws } = await seedInviteHost();
      const recipient = await seedUser(deps, "invite-revoked");
      await setAccountPlan(deps, recipient.userId, "FREE");
      const invite = await seedWorkspaceInvite({
        teamId: ws.teamId,
        email: recipient.email,
        invitedByUserId: host.owner.userId,
      });

      // Revocation is performed through the REAL admin route, not by writing
      // a flag the fixture invented. `TeamInvite` has no `revokedAt` column —
      // revoking DELETES the row — and a fixture that modelled it as a flag
      // would have been asserting against a state production cannot produce.
      const revoke = await inject({
        method: "DELETE",
        url: `/v1/teams/${ws.teamId}/invites/${invite.id}`,
        token: host.owner.token,
      });
      expect(revoke.statusCode, revoke.body).toBeLessThan(300);

      await denyWithoutSideEffects({
        method: "POST",
        url: `/v1/teams/invites/${invite.token}/accept`,
        token: recipient.token,
      });
      expect(
        await prisma.teamMember.count({
          where: { teamId: ws.teamId, userId: recipient.userId },
        }),
      ).toBe(0);
      provenScenario("SERVER", "p7.invite.revoked_denied");
    });

    it("p7.invite.replay_is_bounded", async () => {
      const { host, ws } = await seedInviteHost();
      const recipient = await seedUser(deps, "invite-replay");
      await setAccountPlan(deps, recipient.userId, "FREE");
      const invite = await seedWorkspaceInvite({
        teamId: ws.teamId,
        email: recipient.email,
        invitedByUserId: host.owner.userId,
      });

      const first = await inject({
        method: "POST",
        url: `/v1/teams/invites/${invite.token}/accept`,
        token: recipient.token,
      });
      expect(first.statusCode).toBeLessThan(300);

      // Replay — whatever the status, it grants NOTHING further.
      const before = await fingerprintSideEffects(prisma);
      await inject({
        method: "POST",
        url: `/v1/teams/invites/${invite.token}/accept`,
        token: recipient.token,
      });
      const after = await fingerprintSideEffects(prisma);
      expect(fingerprintDelta(before, after)).toEqual({});
      expect(
        await prisma.teamMember.count({
          where: { teamId: ws.teamId, userId: recipient.userId },
        }),
      ).toBe(1);
      provenScenario("SERVER", "p7.invite.replay_is_bounded");
    });

    it("p7.invite.cross_tenant_id_denied", async () => {
      const { host: hostA, ws: wsA } = await seedInviteHost();
      const { host: hostB } = await seedInviteHost();
      const recipient = await seedUser(deps, "invite-xtenant");
      await setAccountPlan(deps, recipient.userId, "FREE");
      const inviteA = await seedWorkspaceInvite({
        teamId: wsA.teamId,
        email: recipient.email,
        invitedByUserId: hostA.owner.userId,
      });

      // Tenant B's owner presents tenant A's token while tenant B is their
      // active context. It must be refused, grant nothing, and reveal nothing
      // about tenant A.
      //
      // NOTE ON THE CONCEALMENT PROPERTY, stated rather than assumed: a
      // workspace id is not a secret — it appears in URLs and shared
      // references — so "foreign" and "nonexistent" MUST be indistinguishable
      // there, and Point 7 fixes `GET /v1/teams/:id` to make them so. An
      // invitation TOKEN is the opposite: a 128-character unguessable
      // credential whose possession is the whole authorization. Anyone who can
      // observe the difference already holds the token, so distinguishing
      // "wrong recipient" from "no such invitation" leaks nothing they did not
      // have — and it is the difference that lets a real user understand they
      // are signed in as the wrong account. What must NOT differ is what the
      // response discloses ABOUT the other tenant.
      const foreignAttempt = await denyWithoutSideEffects({
        method: "POST",
        url: `/v1/teams/invites/${inviteA.token}/accept`,
        token: hostB.owner.token,
      });
      await denyWithoutSideEffects({
        method: "POST",
        url: `/v1/teams/invites/p7-invite-${NOWHERE}/accept`,
        token: hostB.owner.token,
      });

      const disclosed = foreignAttempt.body;
      const tenantA = await prisma.team.findUniqueOrThrow({
        where: { id: wsA.teamId },
        select: { name: true, organizationId: true },
      });
      expect(disclosed).not.toContain(wsA.teamId);
      expect(disclosed).not.toContain(tenantA.name);
      expect(disclosed).not.toContain(tenantA.organizationId);
      expect(disclosed).not.toContain(recipient.email);

      expect(
        await prisma.teamMember.count({
          where: { teamId: wsA.teamId, userId: hostB.owner.userId },
        }),
      ).toBe(0);
      provenScenario("SERVER", "p7.invite.cross_tenant_id_denied");
    });
  });

  // =========================================================================
  // Over-limit: additive denial, never destruction; and no concurrent escape
  // =========================================================================

  describe("over-limit", () => {
    // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — both scenarios were
    // RETARGETED from Owned-Workspace creation to Collaboration Teams.
    //
    // Neither scenario is about workspaces. They are the two general
    // properties every capacity limit in the product owes: two requests at the
    // edge cannot both pass, and freeing capacity restores the operation
    // without anything having been destroyed to make room. They were proven
    // through workspace creation only because that was a limit with a route.
    //
    // No plan grants additional workspaces any more, so that limit is gone and
    // the proof moved to one that is live: `maxCollaborationTeamsPerWorkspace`,
    // which is 2 on PRO, enforced per workspace by
    // `assertCanCreateCollaborationTeam` on POST /v1/collaboration-teams.

    it("p7.overlimit.concurrent_edge_cannot_both_pass", async () => {
      // A PRO workspace one slot below its Collaboration Team limit, with TWO
      // creations issued simultaneously. Sequential repetition cannot observe
      // two writers interleaving; this can.
      const t = await seedPersonalTenant(deps, "PRO");
      const limit = 2; // PRO — the canonical per-workspace Collaboration Team cap.
      const workspace = await prisma.team.findFirstOrThrow({
        where: { ownerUserId: t.owner.userId, isPersonal: true },
        select: { id: true },
      });

      for (let i = 0; i < limit - 1; i += 1) {
        const seeded = await inject({
          method: "POST",
          url: "/v1/collaboration-teams",
          token: t.owner.token,
          payload: { name: `p7 race seed ${i} ${deps.tag}` },
        });
        expect(seeded.statusCode, seeded.body).toBeLessThan(300);
      }

      const results = await Promise.all([
        inject({
          method: "POST",
          url: "/v1/collaboration-teams",
          token: t.owner.token,
          payload: { name: `p7 race a ${deps.tag}` },
        }),
        inject({
          method: "POST",
          url: "/v1/collaboration-teams",
          token: t.owner.token,
          payload: { name: `p7 race b ${deps.tag}` },
        }),
      ]);

      const created = await prisma.collaborationTeam.count({
        where: { workspaceId: workspace.id, status: "ACTIVE", archivedAtUtc: null },
      });
      // The observable consequence is what matters: the limit is not exceeded.
      expect(
        created,
        `two concurrent creations produced ${created} teams against a limit of ${limit}`,
      ).toBeLessThanOrEqual(limit);
      expect(results.filter((r) => r.statusCode < 300).length).toBeLessThanOrEqual(1);
      provenScenario("SERVER", "p7.overlimit.concurrent_edge_cannot_both_pass");
    });

    it("p7.overlimit.reducing_usage_restores_operation", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const limit = 2;
      const workspace = await prisma.team.findFirstOrThrow({
        where: { ownerUserId: t.owner.userId, isPersonal: true },
        select: { id: true },
      });

      const seeded: string[] = [];
      for (let i = 0; i < limit; i += 1) {
        const res = await inject({
          method: "POST",
          url: "/v1/collaboration-teams",
          token: t.owner.token,
          payload: { name: `p7 restore ${i} ${deps.tag}` },
        });
        expect(res.statusCode, res.body).toBeLessThan(300);
      }
      const rows = await prisma.collaborationTeam.findMany({
        where: { workspaceId: workspace.id, status: "ACTIVE", archivedAtUtc: null },
        select: { id: true },
      });
      seeded.push(...rows.map((r) => r.id));
      expect(seeded.length).toBe(limit);

      // At the limit — denied.
      await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/collaboration-teams",
        token: t.owner.token,
        payload: { name: `p7 restore blocked ${deps.tag}` },
      });

      // Usage drops (one team is ARCHIVED — a real reduction, and one that
      // deletes nothing: the row and its history stay exactly where they are).
      await prisma.collaborationTeam.update({
        where: { id: seeded[0] },
        data: { status: "ARCHIVED", archivedAtUtc: new Date() },
      });

      const res = await inject({
        method: "POST",
        url: "/v1/collaboration-teams",
        token: t.owner.token,
        payload: { name: `p7 restore allowed ${deps.tag}` },
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      // Nothing was destroyed to make room.
      expect(
        await prisma.collaborationTeam.count({ where: { id: { in: seeded } } }),
      ).toBe(seeded.length);
      provenScenario(
        "SERVER",
        "p7.overlimit.reducing_usage_restores_operation",
      );
    });
  });

  // =========================================================================
  // Cross-tenant ids — no existence leak, no side effect
  // =========================================================================

  describe("cross-tenant ids", () => {
    it("p7.xtenant.foreign_ids_concealed_without_side_effects", async () => {
      const mine = await seedPersonalTenant(deps, "TEAM");
      const theirs = await seedPersonalTenant(deps, "TEAM");
      const theirWs = await seedOwnedWorkspace(deps, {
        ownerUserId: theirs.owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      const theirEvidence = await prisma.evidence.create({
        data: {
          title: "p7 foreign evidence",
          type: "PHOTO",
          status: "CREATED",
          teamId: theirWs.teamId,
          organizationId: theirWs.organizationId,
          ownerUserId: theirs.owner.userId,
        },
        select: { id: true },
      });
      const theirCase = await prisma.case.create({
        data: {
          name: "p7 foreign case",
          teamId: theirWs.teamId,
          ownerUserId: theirs.owner.userId,
        },
        select: { id: true },
      });

      // For each resource family: the FOREIGN id and the NONEXISTENT id must
      // be indistinguishable, and neither may move durable state.
      const probes: Array<{ family: string; foreign: string; url: (id: string) => string }> = [
        { family: "workspace", foreign: theirWs.teamId, url: (id) => `/v1/teams/${id}` },
        { family: "evidence", foreign: theirEvidence.id, url: (id) => `/v1/evidence/${id}` },
        { family: "case", foreign: theirCase.id, url: (id) => `/v1/cases/${id}` },
      ];

      for (const probe of probes) {
        const before = await fingerprintSideEffects(prisma);
        const foreign = await inject({
          method: "GET",
          url: probe.url(probe.foreign),
          token: mine.owner.token,
        });
        const absent = await inject({
          method: "GET",
          url: probe.url(NOWHERE),
          token: mine.owner.token,
        });
        const after = await fingerprintSideEffects(prisma);

        expect(
          foreign.statusCode,
          `${probe.family}: a foreign id must not be readable`,
        ).toBeGreaterThanOrEqual(400);
        expect(
          foreign.statusCode,
          `${probe.family}: a foreign id answers ${foreign.statusCode} and a nonexistent one ${absent.statusCode} — that difference is an existence oracle`,
        ).toBe(absent.statusCode);
        expect(fingerprintDelta(before, after)).toEqual({});
      }

      // The foreign rows are untouched.
      expect(
        await prisma.evidence.count({ where: { id: theirEvidence.id } }),
      ).toBe(1);
      expect(await prisma.case.count({ where: { id: theirCase.id } })).toBe(1);
      provenScenario(
        "SERVER",
        "p7.xtenant.foreign_ids_concealed_without_side_effects",
      );
    });
  });

  // =========================================================================
  // The server-observable halves of the switch/dirty scenarios
  // =========================================================================

  describe("workspace switching (server half)", () => {
    it("p7.ctx.switch.stale_response_not_committed", async () => {
      // The server half: a mutation carrying workspace A's id, issued after
      // the session switched to B, is attributed to A or refused — never
      // silently written into B because B is "the current context".
      const t = await seedPersonalTenant(deps, "TEAM");
      const a = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
        name: `p7-switch-a-${deps.tag}`,
      });
      const b = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
        name: `p7-switch-b-${deps.tag}`,
      });

      await inject({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        token: t.owner.token,
        payload: { workspaceId: a.teamId },
      });
      // Now switch to B, then issue a write that explicitly names A.
      const toB = await inject({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        token: t.owner.token,
        payload: { workspaceId: b.teamId },
      });
      expect(toB.statusCode, toB.body).toBe(200);

      const res = await inject({
        method: "POST",
        url: "/v1/cases",
        token: t.owner.token,
        payload: { name: `p7 stale write ${deps.tag}`, teamId: a.teamId },
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      const created = res.json() as { id: string; teamId: string };
      // Attributed to the workspace the REQUEST named, never to the pointer.
      expect(created.teamId).toBe(a.teamId);
      const row = await prisma.case.findUniqueOrThrow({
        where: { id: created.id },
        select: { teamId: true },
      });
      expect(row.teamId).toBe(a.teamId);
      expect(row.teamId).not.toBe(b.teamId);
      provenScenario("SERVER", "p7.ctx.switch.stale_response_not_committed");
    });

    it("p7.ctx.switch.no_cross_workspace_cache_reuse (server projection half)", async () => {
      // Two workspaces of the SAME account with different commercial states.
      // Consecutive envelope reads after a switch must project the ACTIVE
      // one's plan, never the previous one's — the projection is what the
      // client caches, so a server that answers staleley makes correct client
      // caching impossible.
      const t = await seedPersonalTenant(deps, "PRO");
      const paid = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      const unpaid = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
        billingPlan: "FREE",
        billingStatus: "INACTIVE",
      });

      await inject({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        token: t.owner.token,
        payload: { workspaceId: paid.teamId },
      });
      const inPaid = (await context(t.owner.token)).json();
      expect(inPaid.activeSpace.id).toBe(paid.teamId);

      await inject({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        token: t.owner.token,
        payload: { workspaceId: unpaid.teamId },
      });
      const inUnpaid = (await context(t.owner.token)).json();
      expect(inUnpaid.activeSpace.id).toBe(unpaid.teamId);
      expect(inUnpaid.activeSpace.plan).not.toBe(inPaid.activeSpace.plan);
      // The capability projection moved with it.
      expect(inUnpaid.planFeatures.reviewerOperationsIncluded).toBe(false);
      provenScenario("SERVER", "p7.ctx.switch.no_cross_workspace_cache_reuse");
    });
  });
});
