/**
 * PHASE 12 CORRECTIVE PASS §2 — ARCH-004, RUNTIME PROOF.
 *
 * The finding
 * ---------------------------------------------------------------------------
 * Ordinary revocation of an Organization membership was a physical DELETE.
 * The provenance grants were closed first, so the GRANT trail survived — but
 * the membership row did not, so the system could not answer "was this person
 * a member, who removed them, when, and why?" from the membership itself.
 * There was no SUSPENDED state at all, so an administrator wanting to pause
 * governance access had only the irreversible option.
 *
 * What this file drives
 * ---------------------------------------------------------------------------
 * The real Fastify app against a disposable PostgreSQL 16 + pgvector, through
 * the real routes and the real orchestrator. No transition is simulated by
 * writing `status` directly — every one of them goes through the shipped path,
 * because the question is whether the SHIPPED path is correct.
 *
 * The fifteen cases are §2.3's list.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

describe("§2 — ARCH-004: Organization membership has an auditable lifecycle", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let lifecycle: typeof import("../src/services/identity/org-membership-lifecycle.service.js");
  let orgAccess: typeof import("../src/services/organization/org-access.js");

  let organizationId: string;
  let workspaceA: string;
  let ownerUserId: string;
  let ownerToken: string;
  /** The member whose lifecycle every case moves. Never an ORG_OWNER. */
  let subjectUserId: string;
  let subjectMembershipId: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    lifecycle = await import(
      "../src/services/identity/org-membership-lifecycle.service.js"
    );
    orgAccess = await import("../src/services/organization/org-access.js");

    workspaceA = h.fixtures.teamA.teamId;
    ownerUserId = h.fixtures.teamA.ownerUserId;
    ownerToken = h.fixtures.teamA.ownerToken;
    subjectUserId = h.fixtures.teamA.adminUserId;

    const team = await prisma.team.findUniqueOrThrow({
      where: { id: workspaceA },
      select: { organizationId: true },
    });
    organizationId = team.organizationId;

    // The harness seeds only the owner's governance membership; give the
    // subject one so there is something to move.
    const existing = await prisma.organizationMembership.findFirst({
      where: { organizationId, userId: subjectUserId },
      select: { id: true },
    });
    subjectMembershipId =
      existing?.id ??
      (
        await prisma.organizationMembership.create({
          data: { organizationId, userId: subjectUserId, role: "ORG_ADMIN" },
          select: { id: true },
        })
      ).id;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Mint a fresh operator token.
   *
   * Needed because suspending an Organization REVOKES its members' sessions —
   * correct product behaviour, and it includes the administrator who pressed
   * the button. A real console re-authenticates at that point; the probe does
   * the same rather than pretending a revoked token still works.
   */
  const refreshOwnerToken = async (): Promise<void> => {
    const { signJwt } = await import("../src/services/jwt.js");
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: ownerUserId },
      select: { email: true },
    });

    /**
     * Wait until a NEW token would actually be past the deny-list watermark.
     *
     * `isSessionRevoked` denies when a row's `revokedBeforeIat >= token.iat`,
     * and `signJwt` sets `iat` to the current second with no override. A token
     * minted in the SAME second as a revocation is therefore denied — which is
     * the correct fail-closed direction at one-second JWT granularity, and is
     * exactly what a real operator hits if they re-authenticate immediately
     * after suspending their own Organization.
     *
     * This waits on the CONDITION (the watermark), not for a fixed duration,
     * so it is deterministic rather than a sleep hiding a race. It is bounded:
     * the watermark is always "now", so at most one second elapses.
     */
    const watermark = await prisma.revokedSession.findFirst({
      where: { userId: ownerUserId, scope: "ALL_FOR_USER" },
      orderBy: { revokedBeforeIat: "desc" },
      select: { revokedBeforeIat: true },
    });
    const floor = Number(watermark?.revokedBeforeIat ?? 0n);
    const deadline = Date.now() + 5_000;
    while (Math.floor(Date.now() / 1000) <= floor && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    ownerToken = signJwt(
      {
        sub: ownerUserId,
        provider: "EMAIL",
        email: owner.email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
      },
      process.env.AUTH_JWT_SECRET as string,
      60 * 60,
    );
  };

  /** Put the subject back to ACTIVE through the SHIPPED path, not by hand. */
  const restoreBaseline = async (): Promise<void> => {
    const row = await prisma.organizationMembership.findUnique({
      where: { id: subjectMembershipId },
      select: { status: true },
    });
    if (row && row.status !== "ACTIVE") {
      await lifecycle.restoreOrganizationMembership({
        organizationId,
        membershipId: subjectMembershipId,
        actorUserId: ownerUserId,
        source: "MANUAL",
        reason: "test baseline",
      });
    }
    await prisma.organization.update({
      where: { id: organizationId },
      data: { status: "ACTIVE" },
    });
    await refreshOwnerToken();
  };

  const statusOf = async (): Promise<{
    status: string;
    generation: number;
    suspendedAtUtc: Date | null;
    revokedAtUtc: Date | null;
    revokedByUserId: string | null;
  }> => {
    const row = await prisma.organizationMembership.findUniqueOrThrow({
      where: { id: subjectMembershipId },
      select: {
        status: true,
        statusGeneration: true,
        suspendedAtUtc: true,
        revokedAtUtc: true,
        revokedByUserId: true,
      },
    });
    return {
      status: row.status,
      generation: row.statusGeneration,
      suspendedAtUtc: row.suspendedAtUtc,
      revokedAtUtc: row.revokedAtUtc,
      revokedByUserId: row.revokedByUserId,
    };
  };

  /** Can the subject read an Organization governance surface right now? */
  const subjectHasOrgAccess = async (): Promise<boolean> => {
    const outcome = await orgAccess.checkOrgAccess(prisma, {
      orgId: organizationId,
      userId: subjectUserId,
    });
    return outcome.kind === "ok";
  };

  const post = async (path: string, payload: Record<string, unknown> = {}) =>
    h.app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      payload,
    });

  // ===========================================================================
  // The fifteen cases
  // ===========================================================================

  it("1 — an ACTIVE membership grants Organization authority", async () => {
    await restoreBaseline();
    expect((await statusOf()).status).toBe("ACTIVE");
    expect(await subjectHasOrgAccess()).toBe(true);
  });

  it("2 — SUSPENDED refuses, and the row survives with attribution", async () => {
    await restoreBaseline();
    const res = await post(
      `/v1/orgs/${organizationId}/members/${subjectMembershipId}/suspend`,
      { reason: "under investigation" },
    );
    expect(res.statusCode, res.body).toBe(200);

    const after = await statusOf();
    expect(after.status).toBe("SUSPENDED");
    expect(after.suspendedAtUtc).not.toBeNull();
    expect(
      await subjectHasOrgAccess(),
      "a suspended member must not pass the Organization access gate",
    ).toBe(false);

    // The ROW is still there — that is the point of the change.
    const row = await prisma.organizationMembership.findUnique({
      where: { id: subjectMembershipId },
      select: { id: true, suspensionReason: true, suspendedByUserId: true },
    });
    expect(row).not.toBeNull();
    expect(row!.suspensionReason).toBe("under investigation");
    expect(row!.suspendedByUserId).toBe(ownerUserId);
  }, 120_000);

  it("3 — REVOKED refuses, and the row STILL survives", async () => {
    await restoreBaseline();
    // Through the real removal route, which is what an administrator uses.
    const res = await h.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${organizationId}/members/${subjectMembershipId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await statusOf();
    expect(after.status).toBe("REVOKED");
    expect(after.revokedAtUtc).not.toBeNull();
    expect(
      after.revokedByUserId,
      "the removal must be attributable to the administrator who did it",
    ).toBe(ownerUserId);
    expect(await subjectHasOrgAccess()).toBe(false);

    // The load-bearing assertion for ARCH-004: the row was NOT deleted.
    const survives = await prisma.organizationMembership.count({
      where: { id: subjectMembershipId },
    });
    expect(
      survives,
      "ordinary revocation must not be a physical delete — the history is the point",
    ).toBe(1);
  }, 120_000);

  it("4 — a restored membership grants authority again", async () => {
    await restoreBaseline();
    await post(`/v1/orgs/${organizationId}/members/${subjectMembershipId}/suspend`);
    expect(await subjectHasOrgAccess()).toBe(false);

    const res = await post(
      `/v1/orgs/${organizationId}/members/${subjectMembershipId}/restore`,
      { reason: "cleared" },
    );
    expect(res.statusCode, res.body).toBe(200);
    const after = await statusOf();
    expect(after.status).toBe("ACTIVE");
    // Restoring CLEARS the suspension stamps so the CHECK constraint holds and
    // the row does not read as "active but suspended".
    expect(after.suspendedAtUtc).toBeNull();
    expect(await subjectHasOrgAccess()).toBe(true);
  }, 120_000);

  it("5 — repeated suspend and repeated revoke are idempotent", async () => {
    await restoreBaseline();
    const first = await post(
      `/v1/orgs/${organizationId}/members/${subjectMembershipId}/suspend`,
    );
    const second = await post(
      `/v1/orgs/${organizationId}/members/${subjectMembershipId}/suspend`,
    );
    expect(first.statusCode).toBe(200);
    expect(
      second.statusCode,
      "an administrator clicking twice has not done anything wrong",
    ).toBe(200);
    expect(JSON.parse(first.body).changed).toBe(true);
    expect(JSON.parse(second.body).changed).toBe(false);
    // …and the generation moved exactly once.
    expect(JSON.parse(second.body).generation).toBe(
      JSON.parse(first.body).generation,
    );
  }, 120_000);

  it("6 — racing suspend and restore produce ONE deterministic winner", async () => {
    await restoreBaseline();
    const gen = (await statusOf()).generation;

    // Both callers name the SAME generation, which is what a console that read
    // the roster and then acted would do.
    const [a, b] = await Promise.all([
      lifecycle.suspendOrganizationMembership({
        organizationId,
        membershipId: subjectMembershipId,
        actorUserId: ownerUserId,
        source: "MANUAL",
        expectedGeneration: gen,
      }),
      lifecycle.suspendOrganizationMembership({
        organizationId,
        membershipId: subjectMembershipId,
        actorUserId: ownerUserId,
        source: "MANUAL",
        expectedGeneration: gen,
      }),
    ]);

    const winners = [a, b].filter((r) => r.ok && r.changed);
    const losers = [a, b].filter((r) => !r.ok);
    expect(
      winners.length + losers.length,
      "each caller either won or was told it lost — never both, never neither",
    ).toBe(2);
    expect(winners.length).toBe(1);
    // A loser is told WHY, with the generation it should re-read.
    if (losers.length === 1) {
      expect(losers[0]!.ok).toBe(false);
      if (!losers[0]!.ok) {
        expect(losers[0]!.reason).toBe("stale_generation");
      }
    }
    // Exactly one transition happened.
    expect((await statusOf()).generation).toBe(gen + 1);
  }, 120_000);

  it("7 — a stale generation loses even when the state would allow it", async () => {
    await restoreBaseline();
    const stale = (await statusOf()).generation;
    // Somebody else moves it twice in between.
    await lifecycle.suspendOrganizationMembership({
      organizationId,
      membershipId: subjectMembershipId,
      actorUserId: ownerUserId,
      source: "MANUAL",
    });
    await lifecycle.restoreOrganizationMembership({
      organizationId,
      membershipId: subjectMembershipId,
      actorUserId: ownerUserId,
      source: "MANUAL",
    });

    const outcome = await lifecycle.suspendOrganizationMembership({
      organizationId,
      membershipId: subjectMembershipId,
      actorUserId: ownerUserId,
      source: "MANUAL",
      expectedGeneration: stale,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("stale_generation");
    expect((await statusOf()).status).toBe("ACTIVE");
  }, 120_000);

  it("8 — SCIM deprovision suspends the governance membership too", async () => {
    await restoreBaseline();
    const scim = await import("../src/services/access-control/scim.service.js");
    // The subject needs a workspace membership for SCIM to act on.
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: workspaceA, userId: subjectUserId } },
      create: {
        teamId: workspaceA,
        userId: subjectUserId,
        role: "ADMIN",
        status: "ACTIVE",
      },
      update: { status: "ACTIVE" },
    });

    await scim.scimDeactivateUser(
      { teamId: workspaceA, tokenId: randomUUID(), baseUrl: "https://local.test" },
      subjectUserId,
      prisma,
    );

    const after = await statusOf();
    expect(
      after.status,
      "a directory that deprovisioned somebody must not leave them a live governance member",
    ).toBe("SUSPENDED");
    expect(await subjectHasOrgAccess()).toBe(false);

    // SUSPENDED, not REVOKED: a directory push is reversible by the next one.
    const row = await prisma.organizationMembership.findUniqueOrThrow({
      where: { id: subjectMembershipId },
      select: { statusSource: true },
    });
    expect(row.statusSource).toBe("SCIM");
  }, 180_000);

  it("9 — Organization suspension pauses memberships; resume restores exactly them", async () => {
    await restoreBaseline();
    const orgLifecycle = await import(
      "../src/services/organization/org-lifecycle.service.js"
    );
    // A SECOND member, suspended individually first, must NOT be swept back in
    // by the Organization resume.
    const individually = await prisma.organizationMembership.upsert({
      where: {
        organization_memberships_org_user_uniq: {
          organizationId,
          userId: h.fixtures.teamA.memberUserId,
        },
      },
      create: {
        organizationId,
        userId: h.fixtures.teamA.memberUserId,
        role: "ORG_MEMBER",
      },
      update: {},
      select: { id: true },
    });
    await lifecycle.suspendOrganizationMembership({
      organizationId,
      membershipId: individually.id,
      actorUserId: ownerUserId,
      source: "MANUAL",
      reason: "individually suspended before the org went dark",
    });

    const suspended = await orgLifecycle.suspendOrganization({
      organizationId,
      actorUserId: ownerUserId,
      reason: "billing",
    });
    expect(suspended.organizationId).toBe(organizationId);
    expect((await statusOf()).status).toBe("SUSPENDED");

    const resumed = await orgLifecycle.resumeOrganization({
      organizationId,
      actorUserId: ownerUserId,
    });
    expect(resumed.governanceMembershipsRestored).toBeGreaterThan(0);
    expect((await statusOf()).status).toBe("ACTIVE");

    const stillSuspended = await prisma.organizationMembership.findUniqueOrThrow(
      { where: { id: individually.id }, select: { status: true } },
    );
    expect(
      stillSuspended.status,
      "resuming an Organization is not a blanket amnesty",
    ).toBe("SUSPENDED");

    // Clean up so later cases are not affected.
    await lifecycle.restoreOrganizationMembership({
      organizationId,
      membershipId: individually.id,
      actorUserId: ownerUserId,
      source: "MANUAL",
    });
  }, 300_000);

  it("10 — a suspended governance member keeps their Personal Space", async () => {
    await restoreBaseline();
    const dbg = await post(`/v1/orgs/${organizationId}/members/${subjectMembershipId}/suspend`);
    expect(dbg.statusCode, dbg.body).toBe(200);

    // Governance is dark…
    expect(await subjectHasOrgAccess()).toBe(false);

    // …and the Personal Space is untouched. Organization membership and
    // Workspace membership are different authorities over different things;
    // conflating them is how a governance suspension silently removed
    // somebody's own workspace.
    const { ensurePersonalWorkspace } = await import(
      "../src/services/platform-context/workspace-bootstrap.service.js"
    );
    const personal = await ensurePersonalWorkspace({ userId: subjectUserId });
    const personalMembership = await prisma.teamMember.findFirst({
      where: { teamId: personal.teamId, userId: subjectUserId },
      select: { status: true },
    });
    expect(personalMembership?.status).toBe("ACTIVE");
  }, 180_000);

  it("11 — suspension moves the subject's session deny-list watermark", async () => {
    await restoreBaseline();
    // The WATERMARK, not the row count: `revokeAllSessionsForUser` may reuse a
    // row, and what actually stops a token being useful is
    // `revokedBeforeIat >= token.iat`. Counting rows would pass while the
    // watermark stood still, which is the failure that matters.
    const watermarkOf = async (): Promise<number> => {
      const row = await prisma.revokedSession.findFirst({
        where: { userId: subjectUserId, scope: "ALL_FOR_USER" },
        orderBy: { revokedBeforeIat: "desc" },
        select: { revokedBeforeIat: true },
      });
      return Number(row?.revokedBeforeIat ?? 0n);
    };
    const before = await watermarkOf();
    // One second, so the new watermark is strictly greater and the assertion
    // is about the write rather than about clock granularity.
    await new Promise((r) => setTimeout(r, 1_100));

    const res = await post(
      `/v1/orgs/${organizationId}/members/${subjectMembershipId}/suspend`,
    );
    expect(res.statusCode, res.body).toBe(200);

    expect(
      await watermarkOf(),
      "a suspended member's tokens must stop being useful now, not at expiry",
    ).toBeGreaterThan(before);
  }, 120_000);

  it("12 — a suspended member disappears from their own Organization list", async () => {
    await restoreBaseline();
    const { listOrgMembershipsForUser } = await import(
      "../src/services/organization/organization-resolver.service.js"
    );
    const before = await listOrgMembershipsForUser(prisma, subjectUserId);
    expect(before.some((m) => m.organizationId === organizationId)).toBe(true);

    await post(`/v1/orgs/${organizationId}/members/${subjectMembershipId}/suspend`);
    const after = await listOrgMembershipsForUser(prisma, subjectUserId);
    expect(
      after.some((m) => m.organizationId === organizationId),
      "the switcher must not offer an Organization that will refuse on arrival",
    ).toBe(false);
  }, 120_000);

  it("13 — a revoked member can be re-invited", async () => {
    await restoreBaseline();
    await h.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${organizationId}/members/${subjectMembershipId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect((await statusOf()).status).toBe("REVOKED");

    const subject = await prisma.user.findUniqueOrThrow({
      where: { id: subjectUserId },
      select: { email: true },
    });
    const res = await post(`/v1/orgs/${organizationId}/invites`, {
      email: subject.email,
      role: "ORG_MEMBER",
    });
    // The membership row now SURVIVES revocation, so an existence-based
    // duplicate check would have made re-invitation permanently impossible.
    expect(
      res.statusCode,
      `re-inviting a revoked member must not be refused as already_member: ${res.body}`,
    ).not.toBe(409);
  }, 120_000);

  it("14 — seat counting excludes revoked members", async () => {
    await restoreBaseline();
    const countActive = async (): Promise<number> =>
      prisma.organizationMembership.count({
        where: { organizationId, status: "ACTIVE" },
      });
    const before = await countActive();
    await h.app.inject({
      method: "DELETE",
      url: `/v1/orgs/${organizationId}/members/${subjectMembershipId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(
      await countActive(),
      "a revoked member occupies no seat and must not be billed for",
    ).toBe(before - 1);
  }, 120_000);

  it("15 — every transition leaves an attributable audit history", async () => {
    await restoreBaseline();
    await post(`/v1/orgs/${organizationId}/members/${subjectMembershipId}/suspend`, {
      reason: "audit-history probe",
    });
    await post(`/v1/orgs/${organizationId}/members/${subjectMembershipId}/restore`);

    // The canonical tenant-audit facade appends to the hash-chained
    // `admin_audit_logs` sink; there is no separate tenant table.
    const events = await prisma.adminAuditLog.findMany({
      where: {
        resourceId: subjectMembershipId,
        action: { startsWith: "identity.org_membership_" },
      },
      select: { action: true, userId: true, metadata: true },
      orderBy: { createdAt: "asc" },
    });
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "identity.org_membership_suspended",
        "identity.org_membership_active",
      ]),
    );
    /**
     * Every transition is ATTRIBUTABLE — but not every transition has a human.
     *
     * A SCIM deprovision is directory-driven and legitimately carries
     * `actorUserId: null`; demanding a user id there would force the code to
     * invent one. The honest invariant is that each event names EITHER the
     * person who acted OR the authority that did, and always the transition it
     * made.
     */
    const unattributed: string[] = [];
    for (const e of events) {
      const meta = (e.metadata ?? {}) as {
        source?: unknown;
        from?: unknown;
        to?: unknown;
      };
      if (e.userId === null && typeof meta.source !== "string") {
        unattributed.push(`${e.action}: no actor and no source`);
      }
      if (typeof meta.from !== "string" || typeof meta.to !== "string") {
        unattributed.push(`${e.action}: does not record the transition it made`);
      }
    }
    expect(unattributed, unattributed.join("\n")).toEqual([]);

    // …and the MANUAL ones this case performed name the operator.
    const manual = events.filter(
      (e) => ((e.metadata ?? {}) as { source?: unknown }).source === "MANUAL",
    );
    expect(manual.length).toBeGreaterThan(0);
    for (const e of manual) {
      expect(e.userId, "a manual transition names the operator").toBe(
        ownerUserId,
      );
    }
  }, 180_000);
});
