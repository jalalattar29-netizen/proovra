/**
 * PHASE A — WORKSPACE LIFECYCLE SAFETY (audit LIFE-01..08, DOM-01).
 *
 * `DELETE /v1/teams/:id` used to hard-delete any Workspace whose owner asked:
 * Personal and Organization Workspaces included, outside the closure
 * lifecycle, without a transaction, behind a legal-hold read that failed open,
 * cascading ~60 tables. The audit observed the Personal Workspace case answer
 * a code-less 409 that the client rendered as "Please review your input".
 *
 * The rule now: NO Workspace kind has a self-service hard delete
 * (`resolveWorkspaceLifecyclePolicy`). The route makes zero mutations and
 * answers a typed refusal naming the path that does end the Workspace:
 *
 *   PERSONAL      409 WORKSPACE_KIND_NOT_DELETABLE  → CLOSE_ACCOUNT
 *   ORGANIZATION  409 WORKSPACE_KIND_NOT_DELETABLE  → ORGANIZATION_OFFBOARDING
 *   OWNED         409 WORKSPACE_CLOSURE_REQUIRED    → REQUEST_WORKSPACE_CLOSURE
 *   non-owner     403 WORKSPACE_OWNER_REQUIRED
 *
 * Every refusal carries `requestId`, and the proof of "zero mutations" is a
 * before/after count of every table the old handler wrote — taken on a
 * workspace that would have SATISFIED the old gates (no evidence, no
 * subscription), so the old code would have deleted it.
 *
 * Closure is the only way a closable Workspace ends, and it refuses kinds that
 * do not close on their own BEFORE asking for step-up — the audit found the
 * Personal Workspace card spending a step-up and persisting a BLOCKED row for
 * a blocker nobody can resolve (LIFE-02).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

describe("Phase A — no Workspace kind has a self-service hard delete", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let counter = 0;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /** An OWNED (legacy self-service) workspace in the exact `POST /v1/teams` shape. */
  async function seedOwnedWorkspace(ownerUserId: string, memberUserId?: string) {
    counter += 1;
    const name = `phase-a-owned-${Date.now().toString(36)}-${counter}`;
    const org = await prisma.organization.create({
      data: { name, billingOwnerUserId: ownerUserId, status: "ACTIVE", kind: "SYSTEM" },
      select: { id: true },
    });
    const team = await prisma.team.create({
      data: {
        name,
        ownerUserId,
        billingOwnerUserId: ownerUserId,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "OWNED",
      },
      select: { id: true },
    });
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: ownerUserId, role: "OWNER", status: "ACTIVE" },
    });
    if (memberUserId) {
      await prisma.teamMember.create({
        data: { teamId: team.id, userId: memberUserId, role: "ADMIN", status: "ACTIVE" },
      });
    }
    await prisma.teamInvite.create({
      data: {
        teamId: team.id,
        email: `phase-a-invitee-${counter}@test.proovra.local`,
        role: "MEMBER",
        tokenHash: `phase-a-token-hash-${Date.now()}-${counter}`,
        invitedByUserId: ownerUserId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return team.id;
  }

  /** Every table the old DELETE handler wrote, counted for one workspace. */
  async function footprint(teamId: string) {
    const [team, members, invites, cases, closures] = await Promise.all([
      prisma.team.count({ where: { id: teamId } }),
      prisma.teamMember.count({ where: { teamId } }),
      prisma.teamInvite.count({ where: { teamId } }),
      prisma.case.count({ where: { teamId } }),
      prisma.workspaceClosureRequest.count({ where: { teamId } }),
    ]);
    return { team, members, invites, cases, closures };
  }

  function expectTypedRefusal(
    res: { statusCode: number; json: () => unknown; headers: Record<string, unknown> },
    status: number,
    code: string,
    nextAction?: string,
  ) {
    expect(res.statusCode, JSON.stringify(res.json())).toBe(status);
    const body = res.json() as {
      error?: { code?: string; message?: string; state?: string; nextAction?: string };
      requestId?: string;
    };
    expect(body.error?.code).toBe(code);
    expect(typeof body.error?.message).toBe("string");
    expect((body.error?.message ?? "").length).toBeGreaterThan(10);
    // The word "team" never names a Workspace in customer copy.
    expect(body.error?.message ?? "").not.toMatch(/\bteam\b/i);
    if (nextAction) expect(body.error?.nextAction).toBe(nextAction);
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId).toBe(res.headers["x-request-id"]);
  }

  it("PERSONAL — DELETE is a typed 409 pointing at account closure, with zero mutations", async () => {
    const p = h.fixtures.personal;
    const before = await footprint(p.teamId);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/v1/teams/${p.teamId}`,
      headers: bearer(p.token),
    });
    expectTypedRefusal(res, 409, "WORKSPACE_KIND_NOT_DELETABLE", "CLOSE_ACCOUNT");
    expect(await footprint(p.teamId)).toEqual(before);
  });

  it("ORGANIZATION — DELETE is a typed 409 pointing at organization offboarding, with zero mutations", async () => {
    const a = h.fixtures.teamA;
    const before = await footprint(a.teamId);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/v1/teams/${a.teamId}`,
      headers: bearer(a.ownerToken),
    });
    expectTypedRefusal(res, 409, "WORKSPACE_KIND_NOT_DELETABLE", "ORGANIZATION_OFFBOARDING");
    expect(await footprint(a.teamId)).toEqual(before);
  });

  it("OWNED — an empty workspace the old handler WOULD have deleted survives; closure is the only path", async () => {
    const a = h.fixtures.teamA;
    const teamId = await seedOwnedWorkspace(a.ownerUserId, a.adminUserId);
    const before = await footprint(teamId);
    expect(before).toMatchObject({ team: 1, members: 2, invites: 1 });

    const res = await h.app.inject({
      method: "DELETE",
      url: `/v1/teams/${teamId}`,
      headers: bearer(a.ownerToken),
    });
    expectTypedRefusal(res, 409, "WORKSPACE_CLOSURE_REQUIRED", "REQUEST_WORKSPACE_CLOSURE");
    expect(await footprint(teamId)).toEqual(before);
  });

  it("non-owner — DELETE is a typed 403 and nothing moves", async () => {
    const a = h.fixtures.teamA;
    const teamId = await seedOwnedWorkspace(a.ownerUserId, a.adminUserId);
    const before = await footprint(teamId);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/v1/teams/${teamId}`,
      headers: bearer(a.adminToken),
    });
    expectTypedRefusal(res, 403, "WORKSPACE_OWNER_REQUIRED");
    expect(await footprint(teamId)).toEqual(before);
  });

  it("PERSONAL — a closure request is refused BEFORE step-up and persists no BLOCKED row", async () => {
    const p = h.fixtures.personal;
    const before = await footprint(p.teamId);
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${p.teamId}/closure`,
      headers: bearer(p.token),
      // Correct phrase, no step-up proof: the old route asked for step-up
      // first, then wrote a BLOCKED row for an unresolvable blocker.
      payload: { confirmation: "close this workspace" },
    });
    expectTypedRefusal(res, 409, "WORKSPACE_KIND_NOT_CLOSABLE", "CLOSE_ACCOUNT");
    expect(await footprint(p.teamId)).toEqual(before);
  });

  it("ORGANIZATION — a closure request is refused before step-up, pointing at offboarding", async () => {
    const a = h.fixtures.teamA;
    const before = await footprint(a.teamId);
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${a.teamId}/closure`,
      headers: bearer(a.ownerToken),
      payload: { confirmation: "close this workspace" },
    });
    expectTypedRefusal(res, 409, "WORKSPACE_KIND_NOT_CLOSABLE", "ORGANIZATION_OFFBOARDING");
    expect(await footprint(a.teamId)).toEqual(before);
  });

  it("GET /v1/teams/:id projects the lifecycle policy the clients render", async () => {
    const p = h.fixtures.personal;
    const personal = await h.app.inject({
      method: "GET",
      url: `/v1/teams/${p.teamId}`,
      headers: bearer(p.token),
    });
    expect(personal.statusCode).toBe(200);
    expect(personal.json().lifecycle).toEqual({
      kind: "PERSONAL",
      endPath: "ACCOUNT_CLOSURE",
      deletable: false,
      closable: false,
      transferable: false,
      nextAction: "CLOSE_ACCOUNT",
    });

    const a = h.fixtures.teamA;
    const owned = await seedOwnedWorkspace(a.ownerUserId);
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/teams/${owned}`,
      headers: bearer(a.ownerToken),
    });
    expect(res.json().lifecycle).toMatchObject({
      kind: "OWNED",
      endPath: "WORKSPACE_CLOSURE",
      deletable: false,
      closable: true,
    });
  });
});
