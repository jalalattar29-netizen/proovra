// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * THE OPERATIONS STATUS, END TO END (live PostgreSQL 16) — 2026-10-14.
 *
 * The production reproduction: a TEAM owner's Personal Space with three
 * resolved sources and nothing open. The page showed "status unconfirmed"
 * above that history because the summary was STALE: the scheduler only picked
 * a workspace up after its picture had already expired. Proven here, through
 * the real routes and the real reconciliation:
 *
 *   1. after a real check, the summary says CONFIRMED_CLEAR with open 0,
 *      resolved 4, and the three resolved groups are intact — a Personal
 *      Space's sources that find nothing are successes, never failures;
 *   2. the same check aged past the freshness window says STALE, with the
 *      last complete check time, and never clear;
 *   3. "Check again" (the canonical workspace-reconcile) runs a real check and
 *      the summary is CONFIRMED_CLEAR again; history is untouched;
 *   4. the scheduler picks a workspace up BEFORE it turns stale;
 *   5. plans × roles: the server's answer equals the canonical capability
 *      envelope, an allowed reader sees only their own workspace, a denied
 *      one is refused by the server; a platform admin who is not a member
 *      and another tenant's owner get 404.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { roleHasPermission } from "@proovra/shared";

import {
  addMember,
  bootOps,
  envelopeFor,
  makeUser,
  makeWorkspace,
  personalSpace,
  seedIncident,
  sweep,
  type Ctx,
} from "./operations-truth-fixtures.js";

type Summary = {
  open: number | null;
  resolved: number | null;
  mayAssertAllClear: boolean;
  workspaceId: string;
  status: {
    state: string;
    freshness: string;
    lastCompleteCheckAtUtc: string | null;
    failedSourceIds: string[];
    resolvedCount: number | null;
  };
};

describe("Operations status truth (live PostgreSQL 16)", () => {
  let c: Ctx;
  let owner: { id: string; token: string };
  let personal: string;

  beforeAll(async () => {
    c = await bootOps();
    owner = await makeUser(c, "team-owner", { plan: "TEAM" });
    personal = await personalSpace(c, owner.id);
    // The production history: three sources, four conditions, closed 4 days ago.
    const fourDaysAgo = new Date(Date.now() - 4 * 86400_000);
    for (const [sourceId, category, severity] of [
      ["pipeline.report_generation_failed", "REPORT", "CRITICAL"],
      ["pipeline.report_generation_failed", "REPORT", "CRITICAL"],
      ["billing.dependent_cancellation_failed", "STORAGE", "HIGH"],
      ["intake.delivery_failed", "UPLOAD", "WARNING"],
    ] as const) {
      const row = await seedIncident(c, personal, { sourceId, category, severity, status: "RESOLVED" });
      await c.prisma.operationalIncident.update({ where: { id: row.id }, data: { resolvedAtUtc: fourDaysAgo } });
    }
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  const summary = async (teamId: string, token = owner.token) => {
    const r = await c.inj("GET", `/v1/ops/summary?teamId=${teamId}`, token);
    return { status: r.statusCode, body: r.statusCode === 200 ? (r.json() as { summary: Summary }).summary : null };
  };
  const resolvedGroups = async () => {
    const r = await c.inj("GET", `/v1/ops/incident-groups?teamId=${personal}&status=RESOLVED&resolvedWithinDays=7`, owner.token);
    expect(r.statusCode).toBe(200);
    return (r.json() as { groups: Array<{ groupKey: string; conditionCount: number }> }).groups;
  };

  it("1. after a real check: CONFIRMED_CLEAR, open 0, resolved 4, three resolved groups intact", async () => {
    await sweep(personal);
    const s = (await summary(personal)).body!;
    expect(s.open).toBe(0);
    expect(s.resolved).toBe(4);
    expect(s.mayAssertAllClear).toBe(true);
    expect(s.status).toMatchObject({ state: "CONFIRMED_CLEAR", freshness: "FRESH", resolvedCount: 4 });
    // Every source the Personal Space does not use ran, found nothing and
    // SUCCEEDED: none of them makes the workspace unconfirmed.
    expect(s.status.failedSourceIds).toEqual([]);
    const groups = await resolvedGroups();
    expect(groups.map((g) => g.groupKey).sort()).toEqual(
      ["billing.dependent_cancellation_failed", "intake.delivery_failed", "pipeline.report_generation_failed"].sort(),
    );
    expect(groups.find((g) => g.groupKey === "pipeline.report_generation_failed")?.conditionCount).toBe(2);
  });

  it("2. the same check, aged past the freshness window: STALE with its time, never clear", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await c.prisma.governanceReconciliationRun.updateMany({
      where: { teamId: personal },
      data: { startedAtUtc: twoHoursAgo, finishedAtUtc: twoHoursAgo },
    });
    const s = (await summary(personal)).body!;
    expect(s.mayAssertAllClear).toBe(false);
    expect(s.status.state).toBe("STALE");
    expect(s.status.freshness).toBe("STALE");
    expect(s.status.lastCompleteCheckAtUtc).toBe(twoHoursAgo.toISOString());
    expect(s.resolved).toBe(4);
  });

  it("3. Check again runs a real check; the summary is CONFIRMED_CLEAR again; history untouched", async () => {
    const r = await c.inj("POST", "/v1/ops/workspace-reconcile", owner.token, { teamId: personal, explicit: true });
    expect(r.statusCode).toBe(202);
    expect((r.json() as { ran: boolean; readiness: string })).toMatchObject({ ran: true, readiness: "READY" });
    const s = (await summary(personal)).body!;
    expect(s.status.state).toBe("CONFIRMED_CLEAR");
    expect(s.resolved).toBe(4);
    expect(await c.prisma.operationalIncident.count({ where: { teamId: personal, status: "RESOLVED" } })).toBe(4);
    expect(await c.prisma.operationalIncident.count({ where: { teamId: personal, status: { not: "RESOLVED" } } })).toBe(0);
  });

  it("4. the scheduler picks a workspace up before its picture turns stale", async () => {
    const { workspacesNeedingReconciliation } = await import("../src/jobs/workspace-operations-reconciliation.job.js");
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await c.prisma.governanceReconciliationRun.updateMany({ where: { teamId: personal }, data: { startedAtUtc: at(25), finishedAtUtc: at(25) } });
    // Still FRESH (inside the 45-minute window) …
    expect((await summary(personal)).body!.status.state).toBe("CONFIRMED_CLEAR");
    // … and already due, so the next tick refreshes it before it expires.
    const due = await workspacesNeedingReconciliation(10_000, new Date());
    expect(due.ids).toContain(personal);
    await c.prisma.governanceReconciliationRun.updateMany({ where: { teamId: personal }, data: { startedAtUtc: at(5), finishedAtUtc: at(5) } });
    expect((await workspacesNeedingReconciliation(10_000, new Date())).ids).not.toContain(personal);
  });

  describe("5. plans × roles — the server decides, and agrees with the canonical envelope", () => {
    const ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
    for (const plan of ["PRO", "TEAM", "ENTERPRISE"] as const) {
      it(`${plan}: each role's server answer equals its capability envelope; readers see only their workspace`, async () => {
        const wsOwner = await makeUser(c, `${plan.toLowerCase()}-ws-owner`, { plan });
        const ws = await makeWorkspace(c, wsOwner.id, { name: `${plan}-ws`, billingPlan: plan, billingStatus: "ACTIVE" });
        await sweep(ws.teamId);
        for (const role of ROLES) {
          const user = role === "OWNER" ? wsOwner : await makeUser(c, `${plan.toLowerCase()}-${role.toLowerCase()}`, { plan: "PRO" });
          if (role !== "OWNER") await addMember(c, ws.teamId, user.id, role);
          const env = await envelopeFor(c, user.token, ws.teamId);
          // The WORKBENCH (list, groups, check) follows the canonical
          // capability envelope exactly.
          const workbench = await c.inj("GET", `/v1/ops/incidents?teamId=${ws.teamId}&status=ALL`, user.token);
          const allowed = env.caps.OPERATIONS_VIEW === true;
          expect(workbench.statusCode === 200, `${plan}/${role} workbench`).toBe(allowed);
          const check = await c.inj("POST", "/v1/ops/workspace-reconcile", user.token, { teamId: ws.teamId, explicit: true });
          expect(check.statusCode === 202, `${plan}/${role} check`).toBe(allowed);
          if (!allowed) expect([403, 404], `${plan}/${role}`).toContain(workbench.statusCode);
          // The SUMMARY is a member's own-health read (Home shows it without
          // the workbench): it follows the canonical role permission, and it
          // only ever describes the workspace that was asked for.
          const s = await summary(ws.teamId, user.token);
          expect(s.status === 200, `${plan}/${role} summary`).toBe(roleHasPermission(role, "operations.view"));
          if (s.status === 200) {
            expect(s.body!.workspaceId).toBe(ws.teamId);
            expect(s.body!.status.state).toBe("CONFIRMED_CLEAR");
          }
        }
      });
    }

    it("a PRO owner's Personal Space reads the same way", async () => {
      const pro = await makeUser(c, "pro-owner", { plan: "PRO" });
      const space = await personalSpace(c, pro.id);
      await sweep(space);
      const env = await envelopeFor(c, pro.token, space);
      const s = await summary(space, pro.token);
      expect(s.status === 200).toBe(env.caps.OPERATIONS_VIEW === true);
      if (s.status === 200) expect(s.body!.status.state).toBe("CONFIRMED_CLEAR");
    });

    it("a platform admin who is not a member, and another tenant's owner, get 404 — read and check alike", async () => {
      const admin = await makeUser(c, "status-admin", { platformRole: "admin" });
      const stranger = await makeUser(c, "status-stranger", { plan: "TEAM" });
      for (const u of [admin, stranger]) {
        expect((await summary(personal, u.token)).status).toBe(404);
        const check = await c.inj("POST", "/v1/ops/workspace-reconcile", u.token, { teamId: personal, explicit: true });
        expect(check.statusCode).toBe(404);
        const groups = await c.inj("GET", `/v1/ops/incident-groups?teamId=${personal}&status=RESOLVED&resolvedWithinDays=7`, u.token);
        expect(groups.statusCode).toBe(404);
      }
    });
  });
});
