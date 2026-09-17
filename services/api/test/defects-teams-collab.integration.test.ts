/**
 * DEFECT CLOSURE — workspace people, discussion assignment and saved views.
 *
 *   D34  POST /v1/collaboration/threads/:id/assign accepted any user id.
 *   D44  personal workspace: the access review listed grants on legacy
 *        NULL-team cases that the external-grant revoke then called missing.
 *   D45  GET /v1/teams/:id/members: address search by a non-admin, and 500s on
 *        a malformed status / cursor.
 *   D46  ownership transfer offered only the first 50 members.
 *   D22  shared saved views: every mutation in the three SavedSearchView /
 *        SIU families follows one rule (creator, or OWNER/ADMIN for a shared
 *        view), and the search family no longer reaches the other families'
 *        rows.
 *
 * Every case drives the REAL route through `harness.app.inject` against a
 * disposable PostgreSQL 16 and re-reads the row the action would change.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];

describe("defects — teams, collaboration, saved views (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  const disposableUsers: string[] = [];
  const disposableTeams: string[] = [];
  const disposableOrgs: string[] = [];

  const call = (opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token?: string;
    payload?: unknown;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  const tag = () => randomUUID().slice(0, 8);

  async function disposableUser(label: string, displayName?: string) {
    const email = `dtc-${label}-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: {
        email,
        firstName: "DTC",
        lastName: label,
        displayName: displayName ?? null,
        provider: "EMAIL",
        providerUserId: email,
      },
      select: { id: true },
    });
    disposableUsers.push(user.id);
    return { id: user.id, email };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 900_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.teamMember
        .deleteMany({ where: { teamId: { in: disposableTeams } } })
        .catch(() => undefined);
      await prisma.team.deleteMany({ where: { id: { in: disposableTeams } } }).catch(() => undefined);
      await prisma.organization
        .deleteMany({ where: { id: { in: disposableOrgs } } })
        .catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: disposableUsers } } }).catch(() => undefined);
    }
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // D34
  // ===========================================================================

  describe("D34 — discussion thread assignment", () => {
    async function newThread() {
      const a = h.fixtures.teamA;
      return prisma.discussionThread.create({
        data: {
          teamId: a.teamId,
          evidenceId: a.evidenceId,
          title: `d34 thread ${tag()}`,
          visibility: "INTERNAL",
          createdByUserId: a.ownerUserId,
        },
      });
    }

    it("D34 assign refuses a user who is not an ACTIVE member of the thread's workspace and writes nothing", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const thread = await newThread();
      const suspended = await disposableUser("d34-suspended");
      await prisma.teamMember.create({
        data: { teamId: a.teamId, userId: suspended.id, role: "MEMBER", status: "SUSPENDED" },
      });
      const outsider = await disposableUser("d34-outsider");
      const url = `/v1/collaboration/threads/${thread.id}/assign`;

      for (const assignedToUserId of [b.memberUserId, outsider.id, suspended.id, randomUUID()]) {
        const res = await call({
          method: "POST",
          url,
          token: a.memberToken,
          payload: { teamId: a.teamId, assignedToUserId },
        });
        expect(res.statusCode, res.body).toBe(400);
        expect((res.json() as { error: { code: string } }).error.code).toBe(
          "assignee_not_workspace_member",
        );
      }
      const after = await prisma.discussionThread.findUniqueOrThrow({ where: { id: thread.id } });
      expect(after.assignedToUserId).toBeNull();
      expect(after.assignedAtUtc).toBeNull();
      expect(await prisma.discussionParticipant.count({ where: { threadId: thread.id } })).toBe(0);

      // An ACTIVE member of the same workspace is still assignable.
      const ok = await call({
        method: "POST",
        url,
        token: a.memberToken,
        payload: { teamId: a.teamId, assignedToUserId: a.adminUserId },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(
        (await prisma.discussionThread.findUniqueOrThrow({ where: { id: thread.id } }))
          .assignedToUserId,
      ).toBe(a.adminUserId);
      expect(
        await prisma.discussionParticipant.findMany({
          where: { threadId: thread.id },
          select: { userId: true, role: true },
        }),
      ).toEqual([{ userId: a.adminUserId, role: "RESOLVER" }]);
    });
  });

  // ===========================================================================
  // D44
  // ===========================================================================

  describe("D44 — personal workspace access review vs revoke", () => {
    it("D44 a grant the personal access review lists on a NULL-team case is revocable; another owner's NULL-team case is not", async () => {
      const p = h.fixtures.personal;
      const external = await disposableUser("d44-external");
      const legacyCase = await prisma.case.create({
        data: { name: `d44 legacy ${tag()}`, teamId: null, ownerUserId: p.userId },
      });
      const grant = await prisma.caseAccess.create({
        data: { caseId: legacyCase.id, userId: external.id },
      });
      // A NULL-team case belonging to someone else is NOT this workspace's.
      const foreignLegacy = await prisma.case.create({
        data: { name: `d44 foreign ${tag()}`, teamId: null, ownerUserId: h.fixtures.teamA.ownerUserId },
      });
      const foreignGrant = await prisma.caseAccess.create({
        data: { caseId: foreignLegacy.id, userId: external.id },
      });

      const review = await call({
        method: "GET",
        url: `/v1/teams/${p.teamId}/access-review`,
        token: p.token,
      });
      expect(review.statusCode, review.body).toBe(200);
      const listed = (
        review.json() as {
          externalCollaborators: Array<{ userId: string; grants: Array<{ grantId: string }> }>;
        }
      ).externalCollaborators.flatMap((c) => c.grants.map((g) => g.grantId));
      expect(listed).toContain(grant.id);
      expect(listed).not.toContain(foreignGrant.id);

      const foreign = await call({
        method: "DELETE",
        url: `/v1/teams/${p.teamId}/external-grants/${foreignGrant.id}`,
        token: p.token,
      });
      expect(foreign.statusCode).toBe(404);
      expect((foreign.json() as { code: string }).code).toBe("GRANT_NOT_FOUND");
      expect(await prisma.caseAccess.findUnique({ where: { id: foreignGrant.id } })).not.toBeNull();

      const res = await call({
        method: "DELETE",
        url: `/v1/teams/${p.teamId}/external-grants/${grant.id}`,
        token: p.token,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true, grantId: grant.id });
      expect(await prisma.caseAccess.findUnique({ where: { id: grant.id } })).toBeNull();

      const again = await call({
        method: "GET",
        url: `/v1/teams/${p.teamId}/access-review`,
        token: p.token,
      });
      const relisted = (
        again.json() as {
          externalCollaborators: Array<{ grants: Array<{ grantId: string }> }>;
        }
      ).externalCollaborators.flatMap((c) => c.grants.map((g) => g.grantId));
      expect(relisted).not.toContain(grant.id);
    });
  });

  // ===========================================================================
  // D45
  // ===========================================================================

  describe("D45 — workspace members read", () => {
    it("D45 a non-admin cannot find a member by address, and never receives addresses from the detail read", async () => {
      const a = h.fixtures.teamA;
      const name = `Quill Marrow ${tag()}`;
      const target = await disposableUser("d45-target", name);
      await prisma.teamMember.create({
        data: { teamId: a.teamId, userId: target.id, role: "MEMBER", status: "ACTIVE" },
      });
      const byEmail = `/v1/teams/${a.teamId}/members?q=${encodeURIComponent(target.email)}`;

      for (const token of [a.viewerToken, a.memberToken]) {
        const res = await call({ method: "GET", url: byEmail, token });
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json() as { members: unknown[]; total: number };
        expect(body.members).toEqual([]);
        expect(body.total).toBe(0);

        // A name search still works, and still carries no address.
        const byName = await call({
          method: "GET",
          url: `/v1/teams/${a.teamId}/members?q=${encodeURIComponent(name)}`,
          token,
        });
        const found = byName.json() as {
          members: Array<{ userId: string; label: string; user?: { email?: string } }>;
        };
        expect(found.members.map((m) => m.userId)).toEqual([target.id]);
        expect(found.members[0].user?.email).toBeUndefined();
        expect(found.members[0].label).toBe(name);

        const detail = await call({ method: "GET", url: `/v1/teams/${a.teamId}`, token });
        expect(detail.statusCode, detail.body).toBe(200);
        const members = (
          detail.json() as { members: Array<{ label: string; user?: { email?: string } }> }
        ).members;
        expect(members.length).toBeGreaterThan(0);
        for (const m of members) {
          expect(m.user?.email).toBeUndefined();
          expect(m.label).not.toContain("@");
        }
      }

      // An administrator may search by address and sees it.
      const admin = await call({ method: "GET", url: byEmail, token: a.adminToken });
      const adminBody = admin.json() as { members: Array<{ userId: string; user?: { email?: string } }> };
      expect(adminBody.members.map((m) => m.userId)).toEqual([target.id]);
      expect(adminBody.members[0].user?.email).toBe(target.email);
      const adminDetail = await call({ method: "GET", url: `/v1/teams/${a.teamId}`, token: a.adminToken });
      expect(
        (adminDetail.json() as { members: Array<{ user?: { email?: string } }> }).members.some(
          (m) => typeof m.user?.email === "string" && m.user.email.includes("@"),
        ),
      ).toBe(true);
    });

    it("D45 a malformed status or cursor is a bounded 400, not a 500", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const foreignRow = await prisma.teamMember.findFirstOrThrow({
        where: { teamId: b.teamId },
        select: { id: true },
      });
      const cases: Array<[string, string]> = [
        ["status=bogus", "INVALID_QUERY"],
        ["status=%27%3B--", "INVALID_QUERY"],
        ["cursor=not-a-uuid", "INVALID_QUERY"],
        [`cursor=${randomUUID()}`, "INVALID_CURSOR"],
        [`cursor=${foreignRow.id}`, "INVALID_CURSOR"],
      ];
      for (const [qs, code] of cases) {
        const res = await call({
          method: "GET",
          url: `/v1/teams/${a.teamId}/members?${qs}`,
          token: a.adminToken,
        });
        expect(res.statusCode, `${qs}: ${res.body}`).toBe(400);
        expect((res.json() as { error: { code: string } }).error.code, qs).toBe(code);
      }

      // The valid shapes still answer: lower-case status, an own cursor.
      const ok = await call({
        method: "GET",
        url: `/v1/teams/${a.teamId}/members?status=active&limit=1`,
        token: a.adminToken,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const first = ok.json() as { members: Array<{ id: string; status: string }>; nextCursor: string | null };
      expect(first.members.every((m) => m.status === "ACTIVE")).toBe(true);
      expect(first.nextCursor).not.toBeNull();
      const next = await call({
        method: "GET",
        url: `/v1/teams/${a.teamId}/members?status=ACTIVE&limit=1&cursor=${first.nextCursor}`,
        token: a.adminToken,
      });
      expect(next.statusCode, next.body).toBe(200);
      expect((next.json() as { members: Array<{ id: string }> }).members[0]?.id).not.toBe(
        first.members[0].id,
      );
    });
  });

  // ===========================================================================
  // D46
  // ===========================================================================

  describe("D46 — ownership transfer beyond the first 50 members", () => {
    it("D46 the eligible-member read pages and searches every ACTIVE non-owner member, and the transfer reaches the 61st", async () => {
      const a = h.fixtures.teamA;
      const owner = a.ownerUserId;
      const org = await prisma.organization.create({
        data: {
          name: `d46 container ${tag()}`,
          billingOwnerUserId: owner,
          status: "ACTIVE",
          kind: "SYSTEM",
        } as never,
        select: { id: true },
      });
      disposableOrgs.push(org.id);
      const team = await prisma.team.create({
        data: {
          name: `d46 owned ${tag()}`,
          ownerUserId: owner,
          billingOwnerUserId: owner,
          isPersonal: false,
          organizationId: org.id,
          workspaceKind: "OWNED",
        } as never,
        select: { id: true },
      });
      disposableTeams.push(team.id);
      await prisma.teamMember.create({
        data: { teamId: team.id, userId: owner, role: "OWNER", status: "ACTIVE" },
      });
      const run = tag();
      const heirs: string[] = [];
      for (let i = 1; i <= 61; i += 1) {
        const u = await disposableUser(`d46-${i}`, `Heir ${run} ${String(i).padStart(2, "0")}`);
        heirs.push(u.id);
        await prisma.teamMember.create({
          data: { teamId: team.id, userId: u.id, role: "MEMBER", status: "ACTIVE" },
        });
      }
      const paused = await disposableUser("d46-paused", `Heir ${run} paused`);
      await prisma.teamMember.create({
        data: { teamId: team.id, userId: paused.id, role: "MEMBER", status: "SUSPENDED" },
      });

      // The detail read embeds a bounded first page — the old picker's source.
      const detail = await call({ method: "GET", url: `/v1/teams/${team.id}`, token: a.ownerToken });
      expect(detail.statusCode, detail.body).toBe(200);
      const embedded = (detail.json() as { members: Array<{ userId: string }> }).members.map(
        (m) => m.userId,
      );
      expect(embedded.length).toBe(50);
      expect(embedded).not.toContain(heirs[60]);

      // Paging the eligible read yields exactly the 61 ACTIVE non-owners.
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await call({
          method: "GET",
          url: `/v1/teams/${team.id}/members?eligible=ownership_transfer&limit=50${
            cursor ? `&cursor=${cursor}` : ""
          }`,
          token: a.ownerToken,
        });
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json() as {
          members: Array<{ userId: string; status: string }>;
          nextCursor: string | null;
          total: number;
        };
        expect(body.total).toBe(61);
        expect(body.members.every((m) => m.status === "ACTIVE")).toBe(true);
        seen.push(...body.members.map((m) => m.userId));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor && pages < 5);
      expect(pages).toBe(2);
      expect(seen).not.toContain(owner);
      expect(seen).not.toContain(paused.id);
      expect([...seen].sort()).toEqual([...heirs].sort());

      // The server-side search finds the 61st directly.
      const search = await call({
        method: "GET",
        url: `/v1/teams/${team.id}/members?eligible=ownership_transfer&q=${encodeURIComponent(
          `Heir ${run} 61`,
        )}`,
        token: a.ownerToken,
      });
      expect((search.json() as { members: Array<{ userId: string }> }).members.map((m) => m.userId)).toEqual([
        heirs[60],
      ]);
      // ...and eligibility holds under search: the suspended member is not offered.
      const pausedSearch = await call({
        method: "GET",
        url: `/v1/teams/${team.id}/members?eligible=ownership_transfer&q=${encodeURIComponent(
          `Heir ${run} paused`,
        )}`,
        token: a.ownerToken,
      });
      expect((pausedSearch.json() as { total: number }).total).toBe(0);

      // The transfer itself accepts the member the old picker could not offer.
      const { hashPassword } = await import("../src/services/email-password-auth.service.js");
      const prior = await prisma.user.findUniqueOrThrow({
        where: { id: owner },
        select: { passwordHash: true },
      });
      const password = `D46-${randomUUID()}`;
      await prisma.user.update({ where: { id: owner }, data: { passwordHash: hashPassword(password) } });
      try {
        const res = await call({
          method: "POST",
          url: `/v1/teams/${team.id}/transfer-ownership`,
          token: a.ownerToken,
          payload: {
            newOwnerUserId: heirs[60],
            stepUp: { method: "password", currentPassword: password },
          },
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(
          (await prisma.team.findUniqueOrThrow({ where: { id: team.id }, select: { ownerUserId: true } }))
            .ownerUserId,
        ).toBe(heirs[60]);
      } finally {
        await prisma.user.update({ where: { id: owner }, data: { passwordHash: prior.passwordHash } });
      }
    });
  });

  // ===========================================================================
  // D22
  // ===========================================================================

  describe("D22 — shared saved views", () => {
    const view = (data: {
      teamId: string;
      createdByUserId: string;
      scope: "SEARCH" | "REVIEWER_OPS" | "OPERATIONS";
      visibility: "PRIVATE" | "TEAM";
    }) =>
      prisma.savedSearchView.create({
        data: {
          ...data,
          name: `d22 ${data.scope} ${tag()}`,
          queryJson: { teamId: data.teamId },
        },
      });

    it("D22 the search family never lists or mutates a reviewer-ops or operations view", async () => {
      const a = h.fixtures.teamA;
      const reviewerView = await view({
        teamId: a.teamId,
        createdByUserId: a.adminUserId,
        scope: "REVIEWER_OPS",
        visibility: "TEAM",
      });
      const opsView = await view({
        teamId: a.teamId,
        createdByUserId: a.adminUserId,
        scope: "OPERATIONS",
        visibility: "TEAM",
      });
      const searchView = await view({
        teamId: a.teamId,
        createdByUserId: a.adminUserId,
        scope: "SEARCH",
        visibility: "TEAM",
      });

      const list = await call({
        method: "GET",
        url: `/v1/search/saved-views?teamId=${a.teamId}&limit=200`,
        token: a.memberToken,
      });
      expect(list.statusCode, list.body).toBe(200);
      const ids = (list.json() as { views: Array<{ id: string }> }).views.map((v) => v.id);
      expect(ids).toContain(searchView.id);
      expect(ids).not.toContain(reviewerView.id);
      expect(ids).not.toContain(opsView.id);

      // The creator renames through the search route: a foreign family is missing.
      for (const foreign of [reviewerView, opsView]) {
        const rename = await call({
          method: "PATCH",
          url: `/v1/search/saved-views/${foreign.id}`,
          token: a.adminToken,
          payload: { teamId: a.teamId, name: "renamed through search" },
        });
        expect(rename.statusCode, rename.body).toBe(404);
        const del = await call({
          method: "DELETE",
          url: `/v1/search/saved-views/${foreign.id}?teamId=${a.teamId}`,
          token: a.ownerToken,
        });
        expect(del.statusCode, del.body).toBe(404);
        expect(await prisma.savedSearchView.findUniqueOrThrow({ where: { id: foreign.id } })).toMatchObject({
          name: foreign.name,
          scope: foreign.scope,
        });
      }

      // A view created through the search route is a SEARCH view.
      const created = await call({
        method: "POST",
        url: "/v1/search/saved-views",
        token: a.memberToken,
        payload: {
          teamId: a.teamId,
          name: `d22 created ${tag()}`,
          visibility: "PRIVATE",
          query: { teamId: a.teamId },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const createdId = (created.json() as { view: { id: string } }).view.id;
      expect(
        (await prisma.savedSearchView.findUniqueOrThrow({ where: { id: createdId } })).scope,
      ).toBe("SEARCH");
    });

    it("D22 search: a non-admin cannot rename or delete a colleague's shared view; an admin may delete but not rename it; members may publish shared views", async () => {
      const a = h.fixtures.teamA;
      const shared = await view({
        teamId: a.teamId,
        createdByUserId: a.memberUserId,
        scope: "SEARCH",
        visibility: "TEAM",
      });
      for (const token of [a.viewerToken]) {
        const rename = await call({
          method: "PATCH",
          url: `/v1/search/saved-views/${shared.id}`,
          token,
          payload: { teamId: a.teamId, name: "viewer rename" },
        });
        expect(rename.statusCode).toBe(404);
        const del = await call({
          method: "DELETE",
          url: `/v1/search/saved-views/${shared.id}?teamId=${a.teamId}`,
          token,
        });
        expect(del.statusCode).toBe(404);
      }
      // Rename is creator-only, deliberately stricter than delete.
      const adminRename = await call({
        method: "PATCH",
        url: `/v1/search/saved-views/${shared.id}`,
        token: a.adminToken,
        payload: { teamId: a.teamId, name: "admin rename" },
      });
      expect(adminRename.statusCode).toBe(404);
      expect((await prisma.savedSearchView.findUniqueOrThrow({ where: { id: shared.id } })).name).toBe(
        shared.name,
      );
      const creatorRename = await call({
        method: "PATCH",
        url: `/v1/search/saved-views/${shared.id}`,
        token: a.memberToken,
        payload: { teamId: a.teamId, name: `creator rename ${tag()}` },
      });
      expect(creatorRename.statusCode, creatorRename.body).toBe(200);

      const adminDelete = await call({
        method: "DELETE",
        url: `/v1/search/saved-views/${shared.id}?teamId=${a.teamId}`,
        token: a.adminToken,
      });
      expect(adminDelete.statusCode, adminDelete.body).toBe(204);
      expect(await prisma.savedSearchView.findUnique({ where: { id: shared.id } })).toBeNull();

      // Publishing a shared search view is a member feature (the route admits
      // every ACTIVE member; nothing in the product reserves it to admins).
      const viewerShared = await call({
        method: "POST",
        url: "/v1/search/saved-views",
        token: a.viewerToken,
        payload: {
          teamId: a.teamId,
          name: `d22 viewer shared ${tag()}`,
          visibility: "TEAM",
          query: { teamId: a.teamId },
        },
      });
      expect(viewerShared.statusCode, viewerShared.body).toBe(201);
    });

    it("D22 reviewer-ops: a non-admin cannot delete a colleague's shared view; an admin can; a viewer cannot publish one", async () => {
      const a = h.fixtures.teamA;
      const shared = await view({
        teamId: a.teamId,
        createdByUserId: a.adminUserId,
        scope: "REVIEWER_OPS",
        visibility: "TEAM",
      });
      const memberDelete = await call({
        method: "DELETE",
        url: `/v1/reviewer-ops/saved-views/${shared.id}?teamId=${a.teamId}`,
        token: a.memberToken,
      });
      expect(memberDelete.statusCode).toBe(404);
      expect(await prisma.savedSearchView.findUnique({ where: { id: shared.id } })).not.toBeNull();

      const ownerDelete = await call({
        method: "DELETE",
        url: `/v1/reviewer-ops/saved-views/${shared.id}?teamId=${a.teamId}`,
        token: a.ownerToken,
      });
      expect(ownerDelete.statusCode, ownerDelete.body).toBe(204);
      expect(await prisma.savedSearchView.findUnique({ where: { id: shared.id } })).toBeNull();

      const viewerCreate = await call({
        method: "POST",
        url: "/v1/reviewer-ops/saved-views",
        token: a.viewerToken,
        payload: {
          teamId: a.teamId,
          name: `d22 viewer ${tag()}`,
          visibility: "TEAM",
          filter: { teamId: a.teamId },
        },
      });
      expect(viewerCreate.statusCode, viewerCreate.body).toBe(403);
      expect(
        await prisma.savedSearchView.count({
          where: { teamId: a.teamId, createdByUserId: a.viewerUserId, scope: "REVIEWER_OPS" },
        }),
      ).toBe(0);
    });

    it("D22 SIU: rename, filter change, share/unshare and delete of a colleague's shared view are creator-or-admin only", async () => {
      const a = h.fixtures.teamA;
      const make = (userId: string, visibility: "team" | "organization" | "private") =>
        prisma.caseSiuSavedView.create({
          data: {
            teamId: a.teamId,
            name: `d22 siu ${tag()}`,
            filterJson: {},
            sortJson: { key: "updatedAtUtc", direction: "desc" },
            visibility,
            createdByUserId: userId,
            updatedByUserId: userId,
          },
        });
      const shared = await make(a.adminUserId, "team");
      const patches = [
        { name: "viewer rename" },
        { filter: { requireOpenFollowUps: true } },
        { visibility: "private" },
        { visibility: "organization" },
      ];
      for (const token of [a.viewerToken, a.memberToken]) {
        for (const payload of patches) {
          const res = await call({
            method: "PATCH",
            url: `/v1/siu/saved-views/${shared.id}?teamId=${a.teamId}`,
            token,
            payload,
          });
          expect(res.statusCode, JSON.stringify(payload)).toBe(404);
        }
        const del = await call({
          method: "DELETE",
          url: `/v1/siu/saved-views/${shared.id}?teamId=${a.teamId}`,
          token,
        });
        expect(del.statusCode).toBe(404);
      }
      const untouched = await prisma.caseSiuSavedView.findUniqueOrThrow({ where: { id: shared.id } });
      expect(untouched).toMatchObject({
        name: shared.name,
        visibility: "team",
        updatedByUserId: a.adminUserId,
      });
      expect(untouched.filterJson).toEqual({});

      // An administrator who did not create it may manage it.
      const ownerPatch = await call({
        method: "PATCH",
        url: `/v1/siu/saved-views/${shared.id}?teamId=${a.teamId}`,
        token: a.ownerToken,
        payload: { name: "owner rename", visibility: "private" },
      });
      expect(ownerPatch.statusCode, ownerPatch.body).toBe(200);
      expect(await prisma.caseSiuSavedView.findUniqueOrThrow({ where: { id: shared.id } })).toMatchObject({
        name: "owner rename",
        visibility: "private",
        updatedByUserId: a.ownerUserId,
      });
      // Now PRIVATE to its creator: even the owner cannot reach it any more.
      const ownerDelete = await call({
        method: "DELETE",
        url: `/v1/siu/saved-views/${shared.id}?teamId=${a.teamId}`,
        token: a.ownerToken,
      });
      expect(ownerDelete.statusCode).toBe(404);
      const creatorDelete = await call({
        method: "DELETE",
        url: `/v1/siu/saved-views/${shared.id}?teamId=${a.teamId}`,
        token: a.adminToken,
      });
      expect(creatorDelete.statusCode, creatorDelete.body).toBe(200);

      // Publishing a shared SIU view is a member feature: the worklist panel
      // creates every view as `team`, for any member who can use it.
      const viewerCreate = await call({
        method: "POST",
        url: "/v1/siu/saved-views",
        token: a.viewerToken,
        payload: {
          teamId: a.teamId,
          name: `d22 siu viewer ${tag()}`,
          filter: {},
          sort: { key: "updatedAtUtc", direction: "desc" },
          visibility: "team",
        },
      });
      expect(viewerCreate.statusCode, viewerCreate.body).toBe(201);
      const created = (viewerCreate.json() as { view: { id: string } }).view.id;
      // ...and its creator may still manage it, whatever their role.
      const viewerOwnPatch = await call({
        method: "PATCH",
        url: `/v1/siu/saved-views/${created}?teamId=${a.teamId}`,
        token: a.viewerToken,
        payload: { visibility: "private" },
      });
      expect(viewerOwnPatch.statusCode, viewerOwnPatch.body).toBe(200);
    });
  });
});
