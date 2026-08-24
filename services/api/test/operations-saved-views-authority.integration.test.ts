/**
 * SHARED SAVED VIEWS — the authorization contract, against live PostgreSQL 16.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS SUITE EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * A TEAM saved view is workspace CONFIGURATION: it appears in every authorized
 * colleague's toolbar and names a slice of the queue on their behalf. It was
 * previously gated on `operations.view` — a READ capability — so anybody who
 * could look at the queue could publish configuration into everybody else's
 * workbench. A read capability must not imply authority over shared state.
 *
 * ---------------------------------------------------------------------------
 * TWO OWNERSHIP MODELS, AND THE ASYMMETRY IS THE POINT
 * ---------------------------------------------------------------------------
 * PRIVATE is strictly the creator's, with NO administrative override. An
 * administrator holds authority over the WORKSPACE, not over a colleague's own
 * working notes, and somebody else's private bookmark is NOT FOUND rather than
 * forbidden — confirming the id exists is already too much.
 *
 * TEAM is manageable by any holder of the capability, administrators included,
 * because creator-only management strands shared configuration the moment
 * somebody leaves — which is precisely when a workspace needs to clean it up.
 * An administrator acting on somebody else's view does NOT become its author:
 * `createdByUserId` survives, and the audit event records both.
 *
 * Every case drives the REAL routes. A service-level test would prove the
 * service refuses and say nothing about whether the route asks it to.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Operations saved views — authorization (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  let A: {
    teamId: string;
    ownerToken: string;
    ownerUserId: string;
    adminToken: string;
    adminUserId: string;
    memberToken: string;
    memberUserId: string;
    viewerToken: string;
    viewerUserId: string;
  };
  let B: { teamId: string; ownerToken: string; ownerUserId: string };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    A = {
      teamId: harness.fixtures.teamA.teamId,
      ownerToken: harness.fixtures.teamA.ownerToken,
      ownerUserId: harness.fixtures.teamA.ownerUserId,
      adminToken: harness.fixtures.teamA.adminToken,
      adminUserId: harness.fixtures.teamA.adminUserId,
      memberToken: harness.fixtures.teamA.memberToken,
      memberUserId: harness.fixtures.teamA.memberUserId,
      viewerToken: harness.fixtures.teamA.viewerToken,
      viewerUserId: harness.fixtures.teamA.viewerUserId,
    };
    B = {
      teamId: harness.fixtures.teamB.teamId,
      ownerToken: harness.fixtures.teamB.ownerToken,
      ownerUserId: harness.fixtures.teamB.ownerUserId,
    };
  }, 240_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  beforeEach(async () => {
    await prisma.savedSearchView
      .deleteMany({ where: { teamId: { in: [A.teamId, B.teamId] } } })
      .catch(() => null);
  });

  // -------------------------------------------------------------------------
  // Helpers — every one goes through the ROUTE
  // -------------------------------------------------------------------------

  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    token: string,
    payload?: unknown,
  ) =>
    harness.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  const save = (
    token: string,
    visibility: "PRIVATE" | "TEAM",
    teamId = A.teamId,
    name = `v-${randomUUID()}`,
  ) =>
    call("POST", "/v1/ops/saved-views", token, {
      teamId,
      name,
      visibility,
      filter: { teamId, status: "OPEN" },
    });

  const list = async (token: string, teamId = A.teamId) =>
    JSON.parse((await call("GET", `/v1/ops/saved-views?teamId=${teamId}`, token)).body)
      .views as Array<{ id: string; name: string; visibility: string }>;

  const patch = (
    token: string,
    id: string,
    updatedAt: string,
    body: Record<string, unknown> = { name: `r-${randomUUID()}` },
  ) =>
    call("PATCH", `/v1/ops/saved-views/${id}`, token, {
      teamId: A.teamId,
      expectedUpdatedAt: updatedAt,
      ...body,
    });

  const remove = (token: string, id: string, teamId = A.teamId) =>
    call("DELETE", `/v1/ops/saved-views/${id}?teamId=${teamId}`, token);

  /** Create through the route as an authorized manager, and return the row. */
  async function teamView(token = A.adminToken) {
    const res = await save(token, "TEAM");
    expect(res.statusCode, "the fixture manager must be able to create").toBe(201);
    return JSON.parse(res.body).view as {
      id: string;
      updatedAt: string;
      createdByUserId: string;
    };
  }

  // =========================================================================
  // 1. PRIVATE — available to every authorized reader, and strictly theirs
  // =========================================================================

  describe("private views", () => {
    it("1. a VIEWER creates a PRIVATE view", async () => {
      // Requiring an administrative capability to keep a personal bookmark
      // would make the feature useless to the readers who most need it.
      expect((await save(A.viewerToken, "PRIVATE")).statusCode).toBe(201);
    });

    it("a viewer may rename, update and delete their OWN private view", async () => {
      const created = JSON.parse((await save(A.viewerToken, "PRIVATE")).body).view;
      expect(
        (await patch(A.viewerToken, created.id, created.updatedAt)).statusCode,
      ).toBe(200);
      const after = (await list(A.viewerToken)).find(
        (v) => v.id === created.id,
      );
      expect(after).toBeTruthy();
      const fresh = JSON.parse(
        (await call("GET", `/v1/ops/saved-views?teamId=${A.teamId}`, A.viewerToken))
          .body,
      ).views.find((v: { id: string }) => v.id === created.id);
      expect((await remove(A.viewerToken, fresh.id)).statusCode).toBe(204);
    });

    it("15. an ADMIN cannot read another user's private view", async () => {
      const created = JSON.parse((await save(A.viewerToken, "PRIVATE")).body).view;
      const adminSees = (await list(A.adminToken)).some((v) => v.id === created.id);
      // "Admin" is authority over the workspace, not over a colleague's own
      // working notes.
      expect(adminSees).toBe(false);
    });

    it("an ADMIN cannot rename or delete another user's private view, and learns nothing", async () => {
      const created = JSON.parse((await save(A.viewerToken, "PRIVATE")).body).view;
      // 404, not 403: confirming the id exists is already more than an actor
      // who cannot touch it should learn.
      expect(
        (await patch(A.adminToken, created.id, created.updatedAt)).statusCode,
      ).toBe(404);
      expect((await remove(A.adminToken, created.id)).statusCode).toBe(404);
      // …and it survived.
      expect((await list(A.viewerToken)).some((v) => v.id === created.id)).toBe(
        true,
      );
    });

    it("an ADMIN cannot convert another user's private view to TEAM", async () => {
      const created = JSON.parse((await save(A.viewerToken, "PRIVATE")).body).view;
      const res = await patch(A.adminToken, created.id, created.updatedAt, {
        visibility: "TEAM",
      });
      expect(res.statusCode).toBe(404);
      const row = await prisma.savedSearchView.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.visibility).toBe("PRIVATE");
    });
  });

  // =========================================================================
  // 2. TEAM — the capability, and only the capability
  // =========================================================================

  describe("shared views require the management capability", () => {
    it("2/3. a VIEWER cannot create a TEAM view, and the server refuses directly", async () => {
      const res = await save(A.viewerToken, "TEAM");
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("not_permitted");
      expect(await prisma.savedSearchView.count({ where: { teamId: A.teamId } })).toBe(
        0,
      );
    });

    it("9. an ordinary MEMBER without the capability cannot create a TEAM view", async () => {
      // The member holds acknowledge/resolve — real operational authority —
      // and still may not publish configuration into a colleague's toolbar.
      expect((await save(A.memberToken, "TEAM")).statusCode).toBe(403);
    });

    it("8. an ADMIN with the capability creates a TEAM view", async () => {
      expect((await save(A.adminToken, "TEAM")).statusCode).toBe(201);
    });

    it("4. a VIEWER can read and apply an existing TEAM view", async () => {
      const view = await teamView();
      const seen = (await list(A.viewerToken)).find((v) => v.id === view.id);
      expect(seen, "a shared view must be visible to authorized readers").toBeTruthy();
      expect(seen?.visibility).toBe("TEAM");
    });

    it("5/6/7. a VIEWER cannot rename, update or delete a TEAM view", async () => {
      const view = await teamView();
      // 403, not 404: the view is visible to them, so its existence is not a
      // secret. The honest refusal names the authority.
      expect((await patch(A.viewerToken, view.id, view.updatedAt)).statusCode).toBe(
        403,
      );
      expect(
        (
          await patch(A.viewerToken, view.id, view.updatedAt, {
            filter: { teamId: A.teamId, severity: "CRITICAL" },
          })
        ).statusCode,
      ).toBe(403);
      expect((await remove(A.viewerToken, view.id)).statusCode).toBe(403);
    });

    it("10. the TEAM creator with the capability may rename, update and delete", async () => {
      const view = await teamView();
      const renamed = await patch(A.adminToken, view.id, view.updatedAt);
      expect(renamed.statusCode).toBe(200);
      const next = JSON.parse(renamed.body).view;
      expect(
        (
          await patch(A.adminToken, view.id, next.updatedAt, {
            filter: { teamId: A.teamId, severity: "HIGH" },
          })
        ).statusCode,
      ).toBe(200);
      expect((await remove(A.adminToken, view.id)).statusCode).toBe(204);
    });

    it("11. a creator who LOSES the capability can no longer mutate the shared view", async () => {
      const view = await teamView();
      // Demote the creator to VIEWER. Authorization is resolved per request,
      // so the control disappears immediately rather than at next login.
      await prisma.teamMember.updateMany({
        where: { teamId: A.teamId, userId: A.adminUserId },
        data: { role: "VIEWER" as never },
      });
      try {
        expect(
          (await patch(A.adminToken, view.id, view.updatedAt)).statusCode,
        ).toBe(403);
        expect((await remove(A.adminToken, view.id)).statusCode).toBe(403);
      } finally {
        await prisma.teamMember.updateMany({
          where: { teamId: A.teamId, userId: A.adminUserId },
          data: { role: "ADMIN" as never },
        });
      }
    });
  });

  // =========================================================================
  // 3. ADMIN OVERRIDE — without pretending the admin is the author
  // =========================================================================

  describe("an authorized admin manages another creator's shared view", () => {
    /** A TEAM view created by the OWNER, so the admin is not its author. */
    async function othersTeamView() {
      const res = await save(A.ownerToken, "TEAM");
      expect(res.statusCode).toBe(201);
      return JSON.parse(res.body).view as {
        id: string;
        updatedAt: string;
        createdByUserId: string;
      };
    }

    it("12. renames it", async () => {
      const view = await othersTeamView();
      const name = `admin-renamed-${randomUUID()}`;
      const res = await patch(A.adminToken, view.id, view.updatedAt, { name });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).view.name).toBe(name);
    });

    it("13. updates its filter", async () => {
      const view = await othersTeamView();
      const res = await patch(A.adminToken, view.id, view.updatedAt, {
        filter: { teamId: A.teamId, sla: "BREACHED" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).view.filter.sla).toBe("BREACHED");
    });

    it("14. deletes it", async () => {
      const view = await othersTeamView();
      expect((await remove(A.adminToken, view.id)).statusCode).toBe(204);
      expect(
        await prisma.savedSearchView.count({ where: { id: view.id } }),
      ).toBe(0);
    });

    it("does NOT become the author", async () => {
      const view = await othersTeamView();
      await patch(A.adminToken, view.id, view.updatedAt, {
        name: `x-${randomUUID()}`,
      });
      const row = await prisma.savedSearchView.findUniqueOrThrow({
        where: { id: view.id },
      });
      // Pretending the admin is the owner would erase who actually made it.
      expect(row.createdByUserId).toBe(A.ownerUserId);
    });

    it("a departed creator does not strand a shared view", async () => {
      const view = await othersTeamView();
      await prisma.teamMember.updateMany({
        where: { teamId: A.teamId, userId: A.ownerUserId },
        data: { status: "SUSPENDED" as never },
      });
      try {
        // Creator-only management would leave this unmanageable forever,
        // which is exactly when a workspace needs to clean it up.
        expect((await remove(A.adminToken, view.id)).statusCode).toBe(204);
      } finally {
        await prisma.teamMember.updateMany({
          where: { teamId: A.teamId, userId: A.ownerUserId },
          data: { status: "ACTIVE" as never },
        });
      }
    });

    it("25. the override emits the canonical audit event with the REAL actor and creator", async () => {
      const view = await othersTeamView();
      await patch(A.adminToken, view.id, view.updatedAt, {
        name: `audited-${randomUUID()}`,
      });

      const events = await prisma.adminAuditLog.findMany({
        where: { workspaceId: A.teamId, resourceId: view.id },
        orderBy: { createdAt: "desc" },
      });
      const renamed = events.find((e) =>
        String(e.action).includes("saved_view.renamed"),
      );
      expect(renamed, "a shared-view rename must be audited").toBeTruthy();

      const meta = (renamed!.metadata ?? {}) as Record<string, unknown>;
      expect(renamed!.userId).toBe(A.adminUserId);
      expect(meta.creatorUserId).toBe(A.ownerUserId);
      expect(meta.adminOverride).toBe(true);
      // Field NAMES only: a stored query can name a colleague or a case, and
      // an audit row is read by more people than the view is.
      expect(meta.changedFields).toContain("name");
      expect(JSON.stringify(meta)).not.toContain("status");
    });

    it("a creator acting on their OWN shared view is not recorded as an override", async () => {
      const view = await teamView();
      await patch(A.adminToken, view.id, view.updatedAt, {
        name: `self-${randomUUID()}`,
      });
      const events = await prisma.adminAuditLog.findMany({
        where: { workspaceId: A.teamId, resourceId: view.id },
        orderBy: { createdAt: "desc" },
      });
      const meta = (events[0]?.metadata ?? {}) as Record<string, unknown>;
      expect(meta.adminOverride).toBe(false);
    });
  });

  // =========================================================================
  // 4. TENANT AND CONTEXT BOUNDARIES
  // =========================================================================

  describe("boundaries", () => {
    it("18. a cross-tenant id is refused without revealing existence", async () => {
      const view = await teamView();
      // B's owner asking about A's view, in B's own workspace.
      const res = await call(
        "DELETE",
        `/v1/ops/saved-views/${view.id}?teamId=${B.teamId}`,
        B.ownerToken,
      );
      expect(res.statusCode).toBe(404);
      expect(await prisma.savedSearchView.count({ where: { id: view.id } })).toBe(1);
    });

    it("19. a wrong workspace context is refused", async () => {
      const view = await teamView();
      // A's admin naming B's workspace: the route gate refuses before the
      // view is ever looked up.
      const res = await call(
        "DELETE",
        `/v1/ops/saved-views/${view.id}?teamId=${B.teamId}`,
        A.adminToken,
      );
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(await prisma.savedSearchView.count({ where: { id: view.id } })).toBe(1);
    });

    it("20. a missing envelope fails closed", async () => {
      const res = await harness.app.inject({
        method: "POST",
        url: "/v1/ops/saved-views",
        payload: {
          teamId: A.teamId,
          name: "no-auth",
          visibility: "TEAM",
          filter: { teamId: A.teamId },
        } as never,
      });
      expect(res.statusCode).toBe(401);
    });

    it("21. a SUSPENDED member cannot mutate", async () => {
      const view = await teamView();
      await prisma.teamMember.updateMany({
        where: { teamId: A.teamId, userId: A.ownerUserId },
        data: { status: "SUSPENDED" as never },
      });
      try {
        const res = await patch(A.ownerToken, view.id, view.updatedAt);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
      } finally {
        await prisma.teamMember.updateMany({
          where: { teamId: A.teamId, userId: A.ownerUserId },
          data: { status: "ACTIVE" as never },
        });
      }
    });

    it("23. a shared view grants no underlying Operations data access", async () => {
      const view = await teamView();
      const seen = (await list(A.viewerToken)).find((v) => v.id === view.id);
      expect(seen).toBeTruthy();
      // The view names a filter; it confers nothing. The reader's own
      // authority still decides what the queue returns.
      const queue = await call(
        "GET",
        `/v1/ops/incidents?teamId=${A.teamId}`,
        A.viewerToken,
      );
      expect(queue.statusCode).toBe(200);
      // …and it did not become a mutation authority either.
      expect((await remove(A.viewerToken, view.id)).statusCode).toBe(403);
    });
  });

  // =========================================================================
  // 5. CONCURRENCY, NAMING, AND THE VOCABULARY
  // =========================================================================

  describe("write semantics", () => {
    it("24. a stale token is a conflict, and the first write survives", async () => {
      const view = await teamView();
      const first = `first-${randomUUID()}`;
      expect(
        (await patch(A.adminToken, view.id, view.updatedAt, { name: first }))
          .statusCode,
      ).toBe(200);

      const second = await patch(A.adminToken, view.id, view.updatedAt, {
        name: `second-${randomUUID()}`,
      });
      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).error.code).toBe("conflict");

      const row = await prisma.savedSearchView.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(row.name).toBe(first);
    });

    it("26. duplicate-name behaviour stays deterministic", async () => {
      const name = `dupe-${randomUUID()}`;
      expect((await save(A.adminToken, "TEAM", A.teamId, name)).statusCode).toBe(201);
      const again = await save(A.adminToken, "TEAM", A.teamId, name);
      expect(again.statusCode).toBe(409);
      expect(JSON.parse(again.body).error.code).toBe("duplicate_name");
    });

    it("an unknown filter key or SLA state is still refused", async () => {
      for (const filter of [
        { teamId: A.teamId, rawSql: "1=1" },
        { teamId: A.teamId, sla: "VERY_LATE" },
        { teamId: A.teamId, v: 9 },
      ]) {
        const res = await call("POST", "/v1/ops/saved-views", A.adminToken, {
          teamId: A.teamId,
          name: `bad-${randomUUID()}`,
          visibility: "PRIVATE",
          filter,
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
      }
    });

    it("no response body leaks a database or permission internal", async () => {
      const view = await teamView();
      for (const res of [
        await save(A.viewerToken, "TEAM"),
        await patch(A.viewerToken, view.id, view.updatedAt),
        await remove(A.viewerToken, view.id),
      ]) {
        for (const leak of [
          "PrismaClient",
          "saved_search_views",
          "createdByUserId",
          "evaluateMemberAccess",
          "operations.saved_views.manage",
        ]) {
          expect(res.body, `${leak} must not reach the browser`).not.toContain(leak);
        }
      }
    });
  });
});
