// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * A DENIED WORKSPACE SWITCH NEVER TOUCHES THE WORKSPACE IT NAMED (live PostgreSQL 16).
 *
 * An actor who belongs to their own workspace (A) asks to switch into another
 * tenant's workspace (B). Five properties, each proven on the database:
 *
 *   1. NOTHING IS WRITTEN TO B — no security event, no operational condition,
 *      no tenant audit row, no governance notification, no inbox state, and the
 *      actor's own context pointer is unchanged.
 *   2. NOTHING BECOMES VISIBLE TO B — B's own Operations queue and summary, read
 *      through the API as B's owner, are exactly what they were.
 *   3. THE DENIAL IS RECORDED by the canonical security log — bound to the
 *      ACTOR's own context (A), or to no workspace when the actor has none,
 *      and classified ROUTINE so it opens no condition anywhere.
 *   4. IDENTIFIERS ARE MINIMISED — the record carries only the actor, the
 *      actor's own previous context, the id the actor typed, the outcome, the
 *      reason and the request id; nothing B owns (name, owner, members).
 *   5. NO EXISTENCE ORACLE — the reply to a real foreign workspace and to an id
 *      that does not exist are byte-identical apart from the request id.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootOps, makeUser, makeWorkspace, type Ctx } from "./operations-truth-fixtures.js";

/** Wait for an EXPECTED asynchronous write (the security log is fire-and-forget). */
async function waitFor<T>(read: () => Promise<T | null>, what: string, ms = 5_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== null) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("a denied workspace switch never writes to, or is visible in, the workspace it named", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await bootOps();
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  /** Everything B could ever see or own, counted. */
  async function footprintOf(teamId: string) {
    const [securityEvents, conditions, auditRows, notifications] = await Promise.all([
      c.prisma.securityEvent.count({ where: { teamId } }),
      c.prisma.operationalIncident.count({ where: { teamId } }),
      c.prisma.adminAuditLog.count({ where: { workspaceId: teamId } }),
      c.prisma.governanceNotification.count({ where: { teamId } }),
    ]);
    return { securityEvents, conditions, auditRows, notifications };
  }

  async function bView(owner: { token: string }, teamId: string) {
    const list = await c.inj("GET", `/v1/ops/incidents?teamId=${teamId}&limit=50`, owner.token);
    const summary = await c.inj("GET", `/v1/ops/summary?teamId=${teamId}`, owner.token);
    return {
      listStatus: list.statusCode,
      ids: ((list.json() as { incidents?: Array<{ id: string }> }).incidents ?? []).map((i) => i.id).sort(),
      summaryStatus: summary.statusCode,
      open: (summary.json() as { summary?: { open?: number } }).summary?.open ?? null,
    };
  }

  it("proves all five properties for an actor switching from their own workspace", async () => {
    const aOwner = await makeUser(c, "switch-a-owner", { plan: "PRO" });
    const a = await makeWorkspace(c, aOwner.id, { name: "switch-a", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const bOwner = await makeUser(c, "switch-b-owner", { plan: "PRO" });
    const b = await makeWorkspace(c, bOwner.id, { name: "switch-b-SECRET-NAME", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const bTeam = await c.prisma.team.findUniqueOrThrow({ where: { id: b.teamId }, select: { name: true, ownerUserId: true } });

    // The actor's own context is A.
    await c.prisma.user.update({ where: { id: aOwner.id }, data: { currentWorkspaceId: a.teamId } });

    const beforeB = await footprintOf(b.teamId);
    const beforeView = await bView(bOwner, b.teamId);
    expect(beforeView.listStatus).toBe(200);

    // --- the denied switch into B ------------------------------------------
    const denied = await c.inj("POST", "/v1/platform/context/switch-workspace", aOwner.token, { workspaceId: b.teamId });
    expect(denied.statusCode).toBe(403);
    const deniedBody = denied.json() as Record<string, unknown>;
    expect(deniedBody.code).toBe("workspace_membership_required");

    // (3) Recorded — in the ACTOR's own security log (A), never B's.
    const event = await waitFor(
      () =>
        c.prisma.securityEvent.findFirst({
          where: {
            eventType: "workspace_context_switched",
            details: { path: ["actorUserId"], equals: aOwner.id },
          },
          orderBy: { createdAt: "desc" },
        }),
      "the denial's security event",
    );
    expect(event.teamId).toBe(a.teamId);
    expect(event.severity).toBe("WARNING");
    const details = event.details as Record<string, unknown>;
    expect(details.result).toBe("denied");
    expect(details.reason).toBe("workspace_membership_required");
    // Classified ROUTINE: the bridge opens no condition for it, anywhere.
    const { classifySecurityEvent } = await import("../src/services/security/security-event.service.js");
    expect(classifySecurityEvent("workspace_context_switched").kind).toBe("ROUTINE");

    // (4) Minimised: exactly these keys, and nothing B owns.
    expect(Object.keys(details).sort()).toEqual(
      ["actorUserId", "previousWorkspaceId", "reason", "requestId", "result", "targetWorkspaceId"].sort(),
    );
    expect(details.previousWorkspaceId).toBe(a.teamId);
    expect(details.targetWorkspaceId).toBe(b.teamId); // only the id the actor typed
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(bTeam.name);
    expect(serialized).not.toContain(bTeam.ownerUserId!);
    // The reply names nothing of B either.
    expect(Object.keys(deniedBody).sort()).toEqual(["code", "message", "requestId"]);
    expect(JSON.stringify(deniedBody)).not.toContain(b.teamId);
    expect(JSON.stringify(deniedBody)).not.toContain(bTeam.name);

    // (1) Nothing written to B; the actor's pointer did not move.
    expect(await footprintOf(b.teamId)).toEqual(beforeB);
    expect(
      await c.prisma.securityEvent.count({ where: { teamId: b.teamId, eventType: "workspace_context_switched" } }),
    ).toBe(0);
    const actor = await c.prisma.user.findUniqueOrThrow({ where: { id: aOwner.id }, select: { currentWorkspaceId: true } });
    expect(actor.currentWorkspaceId).toBe(a.teamId);
    // And the actor's own workspace gained no condition from it either.
    expect(await c.prisma.operationalIncident.count({ where: { teamId: a.teamId } })).toBe(0);

    // (2) Nothing visible to B through its own Operations surfaces.
    expect(await bView(bOwner, b.teamId)).toEqual(beforeView);

    // (5) No existence oracle: a real foreign workspace and a nonexistent id
    // get the same status and the same body, apart from the request id.
    const ghost = await c.inj("POST", "/v1/platform/context/switch-workspace", aOwner.token, { workspaceId: randomUUID() });
    expect(ghost.statusCode).toBe(denied.statusCode);
    const strip = (b: Record<string, unknown>) => ({ ...b, requestId: undefined });
    expect(strip(ghost.json() as Record<string, unknown>)).toEqual(strip(deniedBody));
    expect(ghost.headers["content-type"]).toBe(denied.headers["content-type"]);
  });

  it("an actor with no workspace context records the denial against no workspace at all", async () => {
    const lone = await makeUser(c, "switch-lone", { plan: "PRO" });
    const bOwner = await makeUser(c, "switch-b2-owner", { plan: "PRO" });
    const b = await makeWorkspace(c, bOwner.id, { name: "switch-b2", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    await c.prisma.user.update({ where: { id: lone.id }, data: { currentWorkspaceId: null } });
    const beforeB = await footprintOf(b.teamId);

    const r = await c.inj("POST", "/v1/platform/context/switch-workspace", lone.token, { workspaceId: b.teamId });
    expect(r.statusCode).toBe(403);

    const event = await waitFor(
      () =>
        c.prisma.securityEvent.findFirst({
          where: { eventType: "workspace_context_switched", details: { path: ["actorUserId"], equals: lone.id } },
        }),
      "the denial's security event",
    );
    // Recorded, owned by the actor (details.actorUserId), bound to NO workspace.
    expect(event.teamId).toBeNull();
    expect((event.details as Record<string, unknown>).previousWorkspaceId).toBeNull();
    expect(await footprintOf(b.teamId)).toEqual(beforeB);
  });

  it("a member of the target whose switch is refused by the target's own policy is the target's business", async () => {
    // The counter-case that keeps the binding honest: once ACTIVE membership
    // is proven, a later refusal is the workspace's own policy acting on its
    // own member and belongs in that workspace's log. (A suspended org here.)
    const owner = await makeUser(c, "switch-own-owner", { plan: "PRO" });
    const w = await makeWorkspace(c, owner.id, { name: "switch-own", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const team = await c.prisma.team.findUniqueOrThrow({ where: { id: w.teamId }, select: { organizationId: true } });
    expect(team.organizationId, "the fixture workspace belongs to an organisation").toBeTruthy();
    await c.prisma.organization.update({ where: { id: team.organizationId! }, data: { status: "SUSPENDED" } });
    try {
      const r = await c.inj("POST", "/v1/platform/context/switch-workspace", owner.token, { workspaceId: w.teamId });
      expect(r.statusCode).toBe(403);
      const event = await waitFor(
        () =>
          c.prisma.securityEvent.findFirst({
            where: { eventType: "workspace_context_switched", details: { path: ["actorUserId"], equals: owner.id } },
          }),
        "the member's denial",
      );
      expect(event.teamId).toBe(w.teamId);
      expect((event.details as Record<string, unknown>).reason).toBe("organization_unavailable");
    } finally {
      await c.prisma.organization.update({ where: { id: team.organizationId! }, data: { status: "ACTIVE" } });
    }
  });
});
