// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * "RESOLVED IN THE LAST 7 DAYS" IS THE SERVER'S WINDOW OVER resolvedAtUtc
 * (2026-10-12, live PostgreSQL 16).
 *
 * The Operations page selected RESOLVED groups and then filtered them in the
 * browser, on the browser's clock, by each group's LAST-SEEN time. A condition
 * resolved a minute ago that was last seen eight days ago disappeared; one
 * last seen today but resolved a fortnight ago was listed as recent; and a
 * browser clock running ahead or behind moved the boundary. The window is now
 * applied by the API, on its own clock, to resolvedAtUtc, inside the
 * workspace's tenant predicate — and the all-time Resolved count is the
 * summary's, which reads "unavailable", never 0, when it cannot be counted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootOps, makeUser, makeWorkspace, seedIncident, type Ctx } from "./operations-truth-fixtures.js";

const DAY = 24 * 60 * 60 * 1000;

type GroupsBody = {
  groups: Array<{ sourceId: string; conditionCount: number; latestResolvedAtUtc: string | null; affectedSample: Array<{ conditionId: string }> }>;
  totals: { groups: number; conditions: number };
  window: { resolvedWithinDays: number; resolvedSinceUtc: string; serverNowUtc: string } | null;
};

describe("Operations — resolved window, grouping and isolation (live PostgreSQL 16)", () => {
  let c: Ctx;
  let teamId: string;
  let token: string;
  let otherTeamId: string;
  let otherToken: string;

  const groupsOf = async (query: string, as = token, team = teamId): Promise<{ status: number; body: GroupsBody }> => {
    const r = await c.inj("GET", `/v1/ops/incident-groups?teamId=${team}${query}`, as);
    return { status: r.statusCode, body: r.json() as GroupsBody };
  };
  const conditionIds = (b: GroupsBody) => b.groups.flatMap((g) => g.affectedSample.map((a) => a.conditionId)).sort();
  const setTimes = (id: string, t: { resolvedAtUtc?: Date | null; lastSeenAtUtc?: Date; status?: "RESOLVED" | "OPEN" }) =>
    c.prisma.operationalIncident.update({ where: { id }, data: t as never });

  // Five conditions from two sources in one workspace.
  let recentButLastSeenLongAgo: string;
  let seenTodayButResolvedLongAgo: string;
  let resolvedRecently: string;
  let open1: string;
  let open2: string;

  beforeAll(async () => {
    c = await bootOps();
    const owner = await makeUser(c, "resolved-window");
    const ws = await makeWorkspace(c, owner.id, { name: "resolved-window", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    teamId = ws.teamId;
    token = owner.token;
    const other = await makeUser(c, "resolved-window-other");
    const ws2 = await makeWorkspace(c, other.id, { name: "resolved-window-other", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    otherTeamId = ws2.teamId;
    otherToken = other.token;

    const now = Date.now();
    const gov = { sourceId: "governance.policy_condition", category: "GOVERNANCE" as const };
    const backlog = { sourceId: "pipeline.report_backlog", category: "REPORT" as const };
    recentButLastSeenLongAgo = (await seedIncident(c, teamId, { ...gov, status: "RESOLVED" })).id;
    seenTodayButResolvedLongAgo = (await seedIncident(c, teamId, { ...gov, status: "RESOLVED" })).id;
    open1 = (await seedIncident(c, teamId, { ...gov, status: "OPEN" })).id;
    resolvedRecently = (await seedIncident(c, teamId, { ...backlog, status: "RESOLVED" })).id;
    open2 = (await seedIncident(c, teamId, { ...backlog, status: "OPEN" })).id;
    await setTimes(recentButLastSeenLongAgo, { resolvedAtUtc: new Date(now - 60_000), lastSeenAtUtc: new Date(now - 10 * DAY) });
    await setTimes(seenTodayButResolvedLongAgo, { resolvedAtUtc: new Date(now - 9 * DAY), lastSeenAtUtc: new Date(now) });
    await setTimes(resolvedRecently, { resolvedAtUtc: new Date(now - 2 * DAY), lastSeenAtUtc: new Date(now - 2 * DAY) });

    // Another workspace's recent resolution, which must never be seen here.
    const foreign = await seedIncident(c, otherTeamId, { ...gov, status: "RESOLVED" });
    await setTimes(foreign.id, { resolvedAtUtc: new Date(now - 60_000), lastSeenAtUtc: new Date(now) });
  }, 900_000);

  afterAll(async () => {
    await c?.h.cleanup();
  });

  it("5 conditions from 2 sources group into 2 sources, all statuses, conserving the count", async () => {
    const { status, body } = await groupsOf("");
    expect(status).toBe(200);
    expect(body.totals).toEqual({ groups: 2, conditions: 5 });
    expect(body.groups.map((g) => g.sourceId).sort()).toEqual(["governance.policy_condition", "pipeline.report_backlog"]);
    expect(body.groups.reduce((n, g) => n + g.conditionCount, 0)).toBe(5);
    expect(body.window).toBeNull();
    expect(conditionIds(body)).toEqual([recentButLastSeenLongAgo, seenTodayButResolvedLongAgo, open1, resolvedRecently, open2].sort());
  });

  it("the window is resolvedAtUtc on the server clock: resolved now but last seen long ago is IN; seen today but resolved long ago is OUT", async () => {
    const before = Date.now();
    const { status, body } = await groupsOf("&status=RESOLVED&resolvedWithinDays=7");
    expect(status).toBe(200);
    expect(conditionIds(body)).toEqual([recentButLastSeenLongAgo, resolvedRecently].sort());
    expect(body.totals).toEqual({ groups: 2, conditions: 2 });
    // The window is stated, from the server's own instant.
    const serverNow = Date.parse(body.window!.serverNowUtc);
    expect(serverNow).toBeGreaterThanOrEqual(before - 1000);
    expect(serverNow - Date.parse(body.window!.resolvedSinceUtc)).toBe(7 * DAY);
    // Each group states its latest RESOLUTION, not its latest activity.
    const gov = body.groups.find((g) => g.sourceId === "governance.policy_condition")!;
    expect(Date.parse(gov.latestResolvedAtUtc!)).toBeGreaterThan(Date.now() - 5 * 60_000);
  });

  it("a status other than RESOLVED with the window is refused", async () => {
    const { status } = await groupsOf("&status=OPEN&resolvedWithinDays=7");
    expect(status).toBe(400);
  });

  it("the boundary is inclusive at exactly seven days and excludes one millisecond earlier (the service, at a fixed instant)", async () => {
    const { listIncidents } = await import("../src/services/observability/incident.service.js");
    const since = new Date("2026-10-05T12:00:00.000Z");
    const at = await seedIncident(c, teamId, { status: "RESOLVED" });
    const justBefore = await seedIncident(c, teamId, { status: "RESOLVED" });
    await setTimes(at.id, { resolvedAtUtc: since });
    await setTimes(justBefore.id, { resolvedAtUtc: new Date(since.getTime() - 1) });
    const page = await listIncidents({ teamId, resolvedSince: since, limit: 500 });
    const ids = page.incidents.map((i) => i.id);
    expect(ids).toContain(at.id);
    expect(ids).not.toContain(justBefore.id);
  });

  it("a browser clock ahead or behind changes nothing: the request carries no client time, and the answer is the same", async () => {
    const a = await groupsOf("&status=RESOLVED&resolvedWithinDays=7");
    const b = await groupsOf("&status=RESOLVED&resolvedWithinDays=7");
    // Refresh stability: the same workspace state gives the same sources, keys and members.
    expect(conditionIds(b.body)).toEqual(conditionIds(a.body));
    expect(b.body.groups.map((g) => g.sourceId)).toEqual(a.body.groups.map((g) => g.sourceId));
  });

  it("paging through the window one row at a time returns every condition exactly once (stable keyset pagination)", async () => {
    const { listIncidents } = await import("../src/services/observability/incident.service.js");
    const since = new Date(Date.now() - 7 * DAY);
    const all = (await listIncidents({ teamId, resolvedSince: since, limit: 500 })).incidents.map((i) => i.id);
    const paged: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await listIncidents({ teamId, resolvedSince: since, limit: 1, cursor });
      paged.push(...page.incidents.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(paged).size).toBe(paged.length);
    expect([...paged].sort()).toEqual([...all].sort());
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("another workspace's resolutions are never in this window, and this one's are never in theirs", async () => {
    const mine = await groupsOf("&status=RESOLVED&resolvedWithinDays=7");
    const theirs = await groupsOf("&status=RESOLVED&resolvedWithinDays=7", otherToken, otherTeamId);
    const mineIds = new Set(conditionIds(mine.body));
    expect(conditionIds(theirs.body).some((id) => mineIds.has(id))).toBe(false);
    expect(theirs.body.totals.conditions).toBe(1);
    // A caller cannot read another workspace by naming it: the same answer
    // as a workspace that does not exist (no existence oracle).
    const probe = await groupsOf("&status=RESOLVED&resolvedWithinDays=7", token, otherTeamId);
    expect(probe.status).toBe(404);
    expect(JSON.stringify(probe.body)).not.toContain(conditionIds(theirs.body)[0]!);
  });

  it("a resolved condition that reopens leaves the window, and enters it again when it is resolved again", async () => {
    const { recordIncident, resolveConditionFromSourceRecovery } = await import("../src/services/observability/incident.service.js");
    const fingerprint = `ops-truth:reopen:${Date.now()}`;
    const row = await seedIncident(c, teamId, { status: "RESOLVED", fingerprint });
    await setTimes(row.id, { resolvedAtUtc: new Date(Date.now() - 20 * DAY), lastSeenAtUtc: new Date(Date.now() - 20 * DAY) });
    expect(conditionIds((await groupsOf("&status=RESOLVED&resolvedWithinDays=7")).body)).not.toContain(row.id);

    // A fresh observation reopens it: no resolution time, not resolved.
    await recordIncident({
      teamId,
      sourceId: "governance.policy_condition",
      category: "GOVERNANCE",
      severity: "HIGH",
      fingerprint,
      title: "ops-truth condition",
      safeSummary: "observed again",
    } as never);
    const reopened = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: row.id } });
    expect(reopened.status).not.toBe("RESOLVED");
    expect(reopened.resolvedAtUtc).toBeNull();
    expect(conditionIds((await groupsOf("&status=RESOLVED&resolvedWithinDays=7")).body)).not.toContain(row.id);

    // Resolved again by its source: a new resolution time, inside the window.
    expect((await resolveConditionFromSourceRecovery({ teamId, fingerprint, safeMessage: "recovered" })).resolved).toBe(true);
    expect(conditionIds((await groupsOf("&status=RESOLVED&resolvedWithinDays=7")).body)).toContain(row.id);
  });

  it("JOURNEY D: five RESOLVED conditions under two sources — the KPI says 5 all-time, the 7-day section shows the sources resolved in the window", async () => {
    const owner = await makeUser(c, "journey-d");
    const ws = await makeWorkspace(c, owner.id, { name: "journey-d", kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
    const now = Date.now();
    const gov = { sourceId: "governance.policy_condition", category: "GOVERNANCE" as const, status: "RESOLVED" as const };
    const backlog = { sourceId: "pipeline.report_backlog", category: "REPORT" as const, status: "RESOLVED" as const };
    // Source 1: three resolved — two this week, one a month ago.
    // Source 2: two resolved — both a month ago (last seen today).
    const seeds: Array<[typeof gov | typeof backlog, number, number]> = [
      [gov, 1 * DAY, 9 * DAY],
      [gov, 3 * DAY, 3 * DAY],
      [gov, 30 * DAY, 30 * DAY],
      [backlog, 30 * DAY, 0],
      [backlog, 31 * DAY, 0],
    ];
    for (const [src, resolvedAgo, seenAgo] of seeds) {
      const row = await seedIncident(c, ws.teamId, src);
      await setTimes(row.id, { resolvedAtUtc: new Date(now - resolvedAgo), lastSeenAtUtc: new Date(now - seenAgo) });
    }
    const summary = await c.inj("GET", `/v1/ops/summary?teamId=${ws.teamId}`, owner.token);
    const s = (summary.json() as { summary?: { resolved: number | null } }).summary ?? (summary.json() as { resolved: number | null });
    expect(s.resolved).toBe(5);
    const all = await groupsOf("&status=RESOLVED", owner.token, ws.teamId);
    expect(all.body.totals).toEqual({ groups: 2, conditions: 5 });
    const recent = await groupsOf("&status=RESOLVED&resolvedWithinDays=7", owner.token, ws.teamId);
    expect(recent.body.groups.map((g) => g.sourceId)).toEqual(["governance.policy_condition"]);
    expect(recent.body.totals).toEqual({ groups: 1, conditions: 2 });
    expect(Date.parse(recent.body.groups[0]!.latestResolvedAtUtc!)).toBeGreaterThan(now - 2 * DAY);
  });

  it("the all-time Resolved count is every RESOLVED condition in the workspace, and unavailable (null) — never 0 — when it cannot be read", async () => {
    const r = await c.inj("GET", `/v1/ops/summary?teamId=${teamId}`, token);
    expect(r.statusCode).toBe(200);
    const all = await c.prisma.operationalIncident.count({ where: { teamId, scope: "WORKSPACE", status: "RESOLVED" } });
    const summary = (r.json() as { summary?: { resolved: number | null }; resolved?: number | null }).summary ?? (r.json() as { resolved: number | null });
    expect(summary.resolved).toBe(all);

    const { buildOperationsSummary, unavailableSummary } = await import("../src/services/operations/operations-summary.service.js");
    expect(unavailableSummary(teamId, new Date(), "test").resolved).toBeNull();
    // The resolved COUNT fails while everything else reads: unavailable, not 0.
    const real = c.prisma;
    const failingCount = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "operationalIncident") {
          const model = target.operationalIncident;
          return new Proxy(model, {
            get(m, p, r) {
              if (p === "count") return async () => { throw new Error("count unavailable"); };
              const v = Reflect.get(m, p, r);
              return typeof v === "function" ? v.bind(m) : v;
            },
          });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const degraded = await buildOperationsSummary({ workspaceId: teamId, viewerUserId: null } as never, failingCount as never);
    expect(degraded.resolved).toBeNull();
    expect(degraded.open).toBeGreaterThan(0);
  });
});
