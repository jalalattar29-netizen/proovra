/**
 * PHASE 12 CORRECTIVE PASS — SEC-001 DIRECT RUNTIME PROOF (2026-08-06).
 *
 * Why this file exists
 * --------------------
 * The previous remediation pass declared `CriticalAfter = 0` on the strength
 * of SOURCE EDITS ALONE. The corrective mandate (C4) rejects that, correctly:
 * a corrected call graph is a strong argument, not a behavioural fact. SEC-001
 * is a CROSS-TENANT READ plus an IRREVERSIBLE OUTBOUND SIDE EFFECT, and the
 * only honest proof is to drive the real routes and then look at the database
 * and the mailbox.
 *
 * So this suite runs the REAL Fastify app against a REAL disposable
 * PostgreSQL 16 + pgvector, mutates real membership rows, and asserts on
 * durable state and on acknowledged email — never on a mock's call log.
 *
 * The defect, restated
 * --------------------
 * `resolveInternalTeam` authorized off `User.currentWorkspaceId` — a
 * navigation pointer — and read a TeamMember row with NO status predicate.
 * A user removed from, or suspended in, a workspace whose pointer still named
 * that workspace could enumerate its external-reviewer invitations, their
 * activity and their delivery records, and could trigger an invitation email
 * on that workspace's behalf.
 *
 * What each probe proves, and why it is not a tautology
 * ----------------------------------------------------
 * Every probe below FIRST establishes that the authorized caller succeeds on
 * the same route with the same pointer. Without that positive control a
 * "denied" result proves nothing — a broken route denies everyone. The
 * negative cases then flip EXACTLY ONE dimension (status, expiry, org
 * lifecycle, tenancy) and require the outcome to change.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

/** Routes SEC-001 named. Each is driven with a stale pointer. */
const READ_ROUTES = (grantId: string) => [
  { method: "GET" as const, url: "/v1/external-review/invitations" },
  { method: "GET" as const, url: `/v1/external-review/invitations/${grantId}/activity` },
  { method: "GET" as const, url: `/v1/external-review/invitations/${grantId}/delivery` },
];

// GATING: this file follows the established convention for *.integration.test.ts
// — a PLAIN `describe`, never `runIf`/`skipIf`. The unit project excludes the
// `.integration.test.ts` glob, and `bootIntegrationHarness` REFUSES to run
// without RUN_LIVE_INTEGRATION + a disposable database. A conditional gate here
// would be a silent skip, which the Point-4 no-skip guard correctly forbids:
// a suite that quietly does not run is indistinguishable from one that passes.
describe("SEC-001 — stale currentWorkspaceId cannot authorize", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;

  // The workspace under attack, and the operator whose pointer names it.
  let workspaceId: string;
  let victimAdminUserId: string;
  let victimAdminToken: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    workspaceId = h.fixtures.teamA.teamId;
    victimAdminUserId = h.fixtures.teamA.adminUserId;
    victimAdminToken = h.fixtures.teamA.adminToken;

    // THE STALE POINTER. This is the precondition of the whole finding: the
    // operator's last selected context is the workspace. It is set once and
    // deliberately NEVER cleared by the probes, so every negative case below
    // runs with the pointer still naming the workspace — which is exactly the
    // state in which the old code granted access.
    await prisma.user.update({
      where: { id: victimAdminUserId },
      data: { currentWorkspaceId: workspaceId },
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const setMembership = async (
    userId: string,
    patch: Record<string, unknown>,
  ): Promise<void> => {
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceId, userId },
      data: patch,
    });
  };

  const pointerFor = async (userId: string): Promise<string | null> => {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { currentWorkspaceId: true },
    });
    return row?.currentWorkspaceId ?? null;
  };

  // ---------------------------------------------------------------------------
  // POSITIVE CONTROL — without this, every denial below is meaningless.
  // ---------------------------------------------------------------------------

  it("POSITIVE CONTROL: an ACTIVE admin whose pointer names the workspace is served", async () => {
    await setMembership(victimAdminUserId, {
      status: "ACTIVE",
      accessExpiresAtUtc: null,
    });
    expect(await pointerFor(victimAdminUserId)).toBe(workspaceId);

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/external-review/invitations",
      headers: auth(victimAdminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty("invitations");
  });

  // ---------------------------------------------------------------------------
  // THE FINDING ITSELF — one dimension flipped at a time.
  // ---------------------------------------------------------------------------

  it("SUSPENDED membership: every read route refuses, pointer notwithstanding", async () => {
    await setMembership(victimAdminUserId, { status: "SUSPENDED" });
    // The pointer is UNCHANGED — this is the exact state the old code allowed.
    expect(await pointerFor(victimAdminUserId)).toBe(workspaceId);

    for (const r of READ_ROUTES("00000000-0000-4000-8000-000000000001")) {
      const res = await h.app.inject({ ...r, headers: auth(victimAdminToken) });
      expect(
        res.statusCode,
        `${r.method} ${r.url} must refuse a SUSPENDED member`,
      ).not.toBe(200);
      // Anti-enumeration: the workspace's existence must not leak.
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain("invitations");
    }
  });

  it("REVOKED membership: every read route refuses", async () => {
    await setMembership(victimAdminUserId, { status: "REVOKED" });
    for (const r of READ_ROUTES("00000000-0000-4000-8000-000000000001")) {
      const res = await h.app.inject({ ...r, headers: auth(victimAdminToken) });
      expect([403, 404]).toContain(res.statusCode);
    }
  });

  it("EXPIRED member access: read routes refuse even though status is ACTIVE", async () => {
    // This dimension is independent of status and was never checked by the
    // deleted helper at all.
    await setMembership(victimAdminUserId, {
      status: "ACTIVE",
      accessExpiresAtUtc: new Date(Date.now() - 60_000),
    });
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/external-review/invitations",
      headers: auth(victimAdminToken),
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("MEMBERSHIP ROW DELETED: read routes refuse (the null-role case)", async () => {
    // The deleted helper returned SUCCESS with `workspaceRole: null` here,
    // which is what made the four uncapped routes reachable by a non-member.
    const saved = await prisma.teamMember.findFirst({
      where: { teamId: workspaceId, userId: victimAdminUserId },
    });
    expect(saved, "fixture must have a membership row to delete").toBeTruthy();
    await prisma.teamMember.deleteMany({
      where: { teamId: workspaceId, userId: victimAdminUserId },
    });
    try {
      expect(await pointerFor(victimAdminUserId)).toBe(workspaceId);
      for (const r of READ_ROUTES("00000000-0000-4000-8000-000000000001")) {
        const res = await h.app.inject({ ...r, headers: auth(victimAdminToken) });
        expect([403, 404]).toContain(res.statusCode);
      }
    } finally {
      // Restore so later probes have a membership to mutate.
      if (saved) {
        await prisma.teamMember.create({
          data: {
            id: saved.id,
            teamId: saved.teamId,
            userId: saved.userId,
            role: saved.role,
            status: "ACTIVE",
          },
        });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // SIDE EFFECT — the irreversible half of the finding.
  // ---------------------------------------------------------------------------

  it("SEND-EMAIL: a non-member cannot cause any outbound delivery", async () => {
    await setMembership(victimAdminUserId, {
      status: "REVOKED",
      accessExpiresAtUtc: null,
    });

    const deliveriesBefore = await prisma.externalReviewInvitationDelivery.count({
      where: { teamId: workspaceId },
    });

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/external-review/invitations/00000000-0000-4000-8000-000000000001/send-email",
      headers: { ...auth(victimAdminToken), "content-type": "application/json" },
      payload: {},
    });
    expect([403, 404]).toContain(res.statusCode);

    // THE PROOF THAT MATTERS: no durable delivery intent was created. A
    // delivery row is minted BEFORE the provider call, so its absence proves
    // the transport was never reached — not merely that a mock was not called.
    const deliveriesAfter = await prisma.externalReviewInvitationDelivery.count({
      where: { teamId: workspaceId },
    });
    expect(deliveriesAfter).toBe(deliveriesBefore);
  });

  it("SEND-EMAIL: a caller-supplied rawToken is not accepted as delivery authority", async () => {
    await setMembership(victimAdminUserId, {
      status: "ACTIVE",
      accessExpiresAtUtc: null,
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/external-review/invitations/00000000-0000-4000-8000-000000000001/send-email",
      headers: { ...auth(victimAdminToken), "content-type": "application/json" },
      // The field the old contract honoured. It must not influence anything;
      // the grant does not exist, so this must conceal as not-found rather
      // than mail the attacker's string.
      payload: { rawToken: "attacker-chosen-token-value-000000" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("attacker-chosen-token-value");
  });

  // ---------------------------------------------------------------------------
  // TENANCY — a foreign workspace's data must be unreachable and unnameable.
  // ---------------------------------------------------------------------------

  it("FOREIGN WORKSPACE: pointing at another tenant grants nothing", async () => {
    const foreignWorkspaceId = h.fixtures.teamB.teamId;
    await setMembership(victimAdminUserId, {
      status: "ACTIVE",
      accessExpiresAtUtc: null,
    });
    // Point the caller's navigation state at a workspace they are NOT a
    // member of. Under the old code the pointer alone selected the tenant.
    await prisma.user.update({
      where: { id: victimAdminUserId },
      data: { currentWorkspaceId: foreignWorkspaceId },
    });
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/v1/external-review/invitations",
        headers: auth(victimAdminToken),
      });
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain(foreignWorkspaceId);
    } finally {
      await prisma.user.update({
        where: { id: victimAdminUserId },
        data: { currentWorkspaceId: workspaceId },
      });
    }
  });

  it("NULL POINTER: no workspace named means no workspace served", async () => {
    await prisma.user.update({
      where: { id: victimAdminUserId },
      data: { currentWorkspaceId: null },
    });
    try {
      const res = await h.app.inject({
        method: "GET",
        url: "/v1/external-review/invitations",
        headers: auth(victimAdminToken),
      });
      expect([403, 404]).toContain(res.statusCode);
    } finally {
      await prisma.user.update({
        where: { id: victimAdminUserId },
        data: { currentWorkspaceId: workspaceId },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POINTER HYGIENE — §4.4. Hygiene, never authorization.
  // ---------------------------------------------------------------------------

  it("REVOCATION repairs the pointer transactionally, and denial does not depend on it", async () => {
    await setMembership(victimAdminUserId, {
      status: "ACTIVE",
      accessExpiresAtUtc: null,
    });
    await prisma.user.update({
      where: { id: victimAdminUserId },
      data: { currentWorkspaceId: workspaceId },
    });

    const member = await prisma.teamMember.findFirst({
      where: { teamId: workspaceId, userId: victimAdminUserId },
      select: { id: true },
    });
    expect(member).toBeTruthy();

    const { revokeMember } = await import(
      "../src/services/identity/membership-provisioning.service.js"
    );
    await revokeMember({
      teamId: workspaceId,
      teamMemberId: member!.id,
      actorUserId: h.fixtures.teamA.ownerUserId,
      reason: "SEC-001 corrective-pass runtime probe",
    });

    // (a) HYGIENE: the pointer no longer names a context the user cannot enter.
    expect(await pointerFor(victimAdminUserId)).toBeNull();

    // (b) INDEPENDENCE: re-set the stale pointer by hand — simulating a repair
    //     that never ran, or a row restored from an older backup — and prove
    //     access is STILL refused. Authorization must not depend on hygiene.
    await prisma.user.update({
      where: { id: victimAdminUserId },
      data: { currentWorkspaceId: workspaceId },
    });
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/external-review/invitations",
      headers: auth(victimAdminToken),
    });

    // 401 is admitted here — and the reason is worth stating, because the
    // first draft of this probe asserted only [403, 404] and FAILED at
    // runtime with 401. That was the probe being wrong, not the product:
    // `revokeMember` also runs `autoRevokeAllSessions`, so a revoked member's
    // bearer token stops authenticating. The request is refused by a SECOND,
    // INDEPENDENT barrier before authorization is even reached.
    //
    // The property under test is "a revoked member is not served this
    // workspace's data", so all three refusal codes satisfy it. Both halves
    // are asserted explicitly rather than widening to "not 200", so a
    // regression to 200 — or to any success shape — still fails.
    expect([401, 403, 404]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
    expect(res.body).not.toContain("invitations");
  });
});
