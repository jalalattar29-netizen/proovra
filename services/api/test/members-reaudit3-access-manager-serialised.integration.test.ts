/**
 * MEMBERS RE-AUDIT, THIRD ROUND — N5: THE ACCESS-LIST MANAGER DECISION
 * SERIALISES WITH THE WRITE (live PostgreSQL).
 *
 * A listed ADMIN of a restricted case may manage its access list. If another
 * manager removes that ADMIN from the list at the same moment, the ADMIN must
 * not complete one more grant or revoke. The decision is now taken again
 * inside the write transaction, after a FOR UPDATE lock on the case row that
 * every access-list write takes.
 *
 * DETERMINISTIC INTERLEAVING (no timing guesses): a competing transaction
 * locks the case row (as the routes do) and removes the ADMIN's entry. While
 * it is still open, the ADMIN's request is sent: its pre-check, outside any
 * transaction, still sees the ADMIN listed. The test waits until PostgreSQL
 * reports that request's backend as blocked BY the competing transaction's
 * backend (pg_blocking_pids), then commits. The request must then be refused
 * exactly as an outsider (404) and change nothing.
 *
 * Positive control for every route: the identical interleaving where the
 * competing transaction does NOT remove the ADMIN — the request waits, then
 * succeeds.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Inject = Awaited<ReturnType<IntegrationHarness["app"]["inject"]>>;

describe("members re-audit 3 — N5: access-list manager decision and write serialise (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  const createdCases: string[] = [];
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 900_000);

  afterAll(async () => {
    if (prisma && createdCases.length) {
      await prisma.caseCollaborationTeamAccess.deleteMany({ where: { caseId: { in: createdCases } } }).catch(() => undefined);
      await prisma.caseAccess.deleteMany({ where: { caseId: { in: createdCases } } }).catch(() => undefined);
    }
    await h?.cleanup();
  }, 300_000);

  const send = (method: "POST" | "DELETE", url: string, token: string, payload?: unknown) =>
    h.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as never }) });

  /** A restricted case owned by the workspace OWNER, with the ADMIN on its list. */
  async function restrictedCaseWithListedAdmin(): Promise<string> {
    const { id } = await prisma.case.create({
      data: { name: `ra3n5-${randomUUID().slice(0, 8)}`, teamId: A().teamId, ownerUserId: A().ownerUserId, restrictedAtUtc: new Date() } as never,
      select: { id: true },
    });
    createdCases.push(id);
    await prisma.caseAccess.create({ data: { caseId: id, userId: A().adminUserId } });
    return id;
  }
  async function newGroup(): Promise<string> {
    const g = await prisma.collaborationTeam.create({
      data: { workspaceId: A().teamId, name: `ra3n5-group-${randomUUID().slice(0, 8)}`, createdByUserId: A().ownerUserId } as never,
      select: { id: true },
    });
    return g.id;
  }

  /**
   * Hold a competing transaction open with the case row locked (and, when
   * `removeAdmin`, the ADMIN's entry deleted), fire `request` inside it, wait
   * until PostgreSQL shows the request blocked by this transaction, commit.
   */
  async function interleave(caseId: string, removeAdmin: boolean, request: () => Promise<Inject>) {
    let pending!: Promise<Inject>;
    let settled = false;
    let blocked = false;
    await prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT "id" FROM "cases" WHERE "id" = ${caseId}::uuid FOR UPDATE`;
        if (removeAdmin) await tx.caseAccess.deleteMany({ where: { caseId, userId: A().adminUserId } });
        pending = request().finally(() => {
          settled = true;
        });
        pending.catch(() => undefined);
        // Condition wait (bounded): the request's backend is blocked by ours.
        const deadline = Date.now() + 15_000;
        while (!settled && Date.now() < deadline) {
          const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
          if (n > 0) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      },
      { timeout: 30_000 },
    );
    const res = await pending;
    return { res, blocked };
  }

  const adminToken = () => A().adminToken;
  const entries = (caseId: string, userId: string) => prisma.caseAccess.count({ where: { caseId, userId } });
  const successAudits = (action: string, caseId: string) =>
    prisma.adminAuditLog.count({ where: { action, resourceId: caseId, outcome: "success" } as never });

  for (const route of [
    { action: "cases.access_grant", path: "access", ok: 201 },
    { action: "cases.share_team", path: "share-team", ok: 201 },
  ]) {
    it(`POST /v1/cases/:id/${route.path} — an ADMIN removed from the list concurrently cannot complete the grant`, async () => {
      const caseId = await restrictedCaseWithListedAdmin();
      const { res, blocked } = await interleave(caseId, true, () =>
        send("POST", `/v1/cases/${caseId}/${route.path}`, adminToken(), { userId: A().memberUserId }),
      );
      expect(blocked).toBe(true);
      expect(res.statusCode, res.body).toBe(404);
      expect(await entries(caseId, A().memberUserId)).toBe(0);
      expect(await successAudits(route.action, caseId)).toBe(0);
    });

    it(`POST /v1/cases/:id/${route.path} — control: still listed, the same interleaving waits and then grants`, async () => {
      const caseId = await restrictedCaseWithListedAdmin();
      const { res, blocked } = await interleave(caseId, false, () =>
        send("POST", `/v1/cases/${caseId}/${route.path}`, adminToken(), { userId: A().memberUserId }),
      );
      expect(blocked).toBe(true);
      expect(res.statusCode, res.body).toBe(route.ok);
      expect(await entries(caseId, A().memberUserId)).toBe(1);
      expect(await successAudits(route.action, caseId)).toBe(1);
    });
  }

  it("DELETE /v1/cases/:id/access/:accessId — an ADMIN removed from the list concurrently cannot complete the revoke", async () => {
    const caseId = await restrictedCaseWithListedAdmin();
    const entry = await prisma.caseAccess.create({ data: { caseId, userId: A().memberUserId } });
    const { res, blocked } = await interleave(caseId, true, () =>
      send("DELETE", `/v1/cases/${caseId}/access/${entry.id}`, adminToken()),
    );
    expect(blocked).toBe(true);
    expect(res.statusCode, res.body).toBe(404);
    expect(await prisma.caseAccess.count({ where: { id: entry.id } })).toBe(1);
    expect(await successAudits("cases.access_revoke", caseId)).toBe(0);
  });

  it("DELETE /v1/cases/:id/access/:accessId — control: still listed, the same interleaving waits and then revokes", async () => {
    const caseId = await restrictedCaseWithListedAdmin();
    const entry = await prisma.caseAccess.create({ data: { caseId, userId: A().memberUserId } });
    const { res, blocked } = await interleave(caseId, false, () =>
      send("DELETE", `/v1/cases/${caseId}/access/${entry.id}`, adminToken()),
    );
    expect(blocked).toBe(true);
    expect(res.statusCode, res.body).toBe(204);
    expect(await prisma.caseAccess.count({ where: { id: entry.id } })).toBe(0);
    expect(await successAudits("cases.access_revoke", caseId)).toBe(1);
  });

  it("POST /v1/cases/:id/team-access — an ADMIN removed from the list concurrently cannot grant a Collaboration Team; control grants", async () => {
    const caseId = await restrictedCaseWithListedAdmin();
    const g = await newGroup();
    const refused = await interleave(caseId, true, () =>
      send("POST", `/v1/cases/${caseId}/team-access`, adminToken(), { collaborationTeamId: g }),
    );
    expect(refused.blocked).toBe(true);
    expect(refused.res.statusCode, refused.res.body).toBe(404);
    expect(await prisma.caseCollaborationTeamAccess.count({ where: { caseId } })).toBe(0);
    expect(await successAudits("cases.team_access_grant", caseId)).toBe(0);

    const controlCase = await restrictedCaseWithListedAdmin();
    const ok = await interleave(controlCase, false, () =>
      send("POST", `/v1/cases/${controlCase}/team-access`, adminToken(), { collaborationTeamId: g }),
    );
    expect(ok.blocked).toBe(true);
    expect(ok.res.statusCode, ok.res.body).toBe(201);
    expect(await prisma.caseCollaborationTeamAccess.count({ where: { caseId: controlCase, collaborationTeamId: g } })).toBe(1);
    expect(await successAudits("cases.team_access_grant", controlCase)).toBe(1);
  });

  it("DELETE /v1/cases/:id/team-access/:teamId — an ADMIN removed from the list concurrently cannot revoke a Collaboration Team; control revokes", async () => {
    const g = await newGroup();
    const caseId = await restrictedCaseWithListedAdmin();
    await prisma.caseCollaborationTeamAccess.create({ data: { caseId, collaborationTeamId: g, grantedByUserId: A().ownerUserId } });
    const refused = await interleave(caseId, true, () =>
      send("DELETE", `/v1/cases/${caseId}/team-access/${g}`, adminToken()),
    );
    expect(refused.blocked).toBe(true);
    expect(refused.res.statusCode, refused.res.body).toBe(404);
    expect(await prisma.caseCollaborationTeamAccess.count({ where: { caseId, collaborationTeamId: g } })).toBe(1);
    expect(await successAudits("cases.team_access_revoke", caseId)).toBe(0);

    const controlCase = await restrictedCaseWithListedAdmin();
    await prisma.caseCollaborationTeamAccess.create({ data: { caseId: controlCase, collaborationTeamId: g, grantedByUserId: A().ownerUserId } });
    const ok = await interleave(controlCase, false, () =>
      send("DELETE", `/v1/cases/${controlCase}/team-access/${g}`, adminToken()),
    );
    expect(ok.blocked).toBe(true);
    expect(ok.res.statusCode, ok.res.body).toBe(204);
    expect(await prisma.caseCollaborationTeamAccess.count({ where: { caseId: controlCase, collaborationTeamId: g } })).toBe(0);
    expect(await successAudits("cases.team_access_revoke", controlCase)).toBe(1);
  });
});
