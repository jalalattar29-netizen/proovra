/**
 * MATTER ACCESS TAB — runtime proof for the case-access family the matter
 * workspace "Access" tab drives (live PostgreSQL 16).
 *
 *   GET    /v1/cases/:id                    explicit grants (`case.access`)
 *   GET    /v1/cases/:id/team-members       who may be granted / has access
 *   POST   /v1/cases/:id/access             the canonical grant
 *   DELETE /v1/cases/:id/access/:accessId   revoke
 *   POST   /v1/cases/:id/share-email        legacy grant-by-address
 *
 * One authority decides who manages access: an ACTIVE member of the case's
 * workspace who is a workspace OWNER/ADMIN or the case owner
 * (`evaluateCaseMutationPermission("MANAGE_ACCESS")`). A caller with no
 * relationship to the case is answered exactly as a missing case.
 *
 * Defects proven here:
 *   D5  — the grant route wrote a standing CaseAccess row for ANY userId,
 *         including a foreign tenant's user or a suspended member.
 *   D6  — share-email answered 404 "No user found" for an unknown address and
 *         400/201 for a known one: an account-existence oracle.
 *   D47 — revoke answered another tenant 403 for an existing case, where the
 *         family conceals existence with 404.
 *
 * Every refusal re-reads the durable rows: a 4xx that wrote anyway is the
 * failure a status assertion cannot see.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];

describe("matter Access tab — case access family (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;

  const call = (opts: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  const newCase = (teamId: string | null, ownerUserId: string) =>
    prisma.case.create({
      data: { name: `access tab ${randomUUID().slice(0, 8)}`, teamId, ownerUserId },
      select: { id: true },
    });

  const grants = (caseId: string) =>
    prisma.caseAccess.findMany({ where: { caseId }, select: { userId: true } });

  const setStatus = (teamId: string, userId: string, status: "ACTIVE" | "SUSPENDED") =>
    prisma.teamMember.updateMany({ where: { teamId, userId }, data: { status } });

  const emailOf = async (userId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }))
      .email as string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // D5 — POST /v1/cases/:id/access
  // ===========================================================================
  describe("D5 — POST /v1/cases/:id/access grants only to ACTIVE members of the case's workspace", () => {
    it("refuses a foreign tenant's user, a suspended member and an unknown id with CASE_ACCESS_TARGET_NOT_MEMBER; no row is written", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const url = `/v1/cases/${c.id}/access`;

      const foreign = await call({ method: "POST", url, token: a.adminToken, payload: { userId: b.memberUserId } });
      expect(foreign.statusCode, foreign.body).toBe(400);
      expect(foreign.json()).toEqual({
        message: "User is not in this team",
        code: "CASE_ACCESS_TARGET_NOT_MEMBER",
      });

      const unknown = await call({ method: "POST", url, token: a.adminToken, payload: { userId: randomUUID() } });
      expect(unknown.statusCode, unknown.body).toBe(400);
      expect(unknown.body).toBe(foreign.body);

      await setStatus(a.teamId, a.viewerUserId, "SUSPENDED");
      try {
        const suspended = await call({ method: "POST", url, token: a.adminToken, payload: { userId: a.viewerUserId } });
        expect(suspended.statusCode, suspended.body).toBe(400);
        expect(suspended.body).toBe(foreign.body);
      } finally {
        await setStatus(a.teamId, a.viewerUserId, "ACTIVE");
      }

      expect(await grants(c.id)).toEqual([]);
    });

    it("CONTROL — an ACTIVE member is granted (201) by the workspace ADMIN and by the case owner", async () => {
      const a = h.fixtures.teamA;
      const c = await newCase(a.teamId, a.memberUserId);
      const url = `/v1/cases/${c.id}/access`;

      const byAdmin = await call({ method: "POST", url, token: a.adminToken, payload: { userId: a.viewerUserId } });
      expect(byAdmin.statusCode, byAdmin.body).toBe(201);
      // The case owner here is a plain workspace MEMBER — ownership of the
      // case is what makes them an access manager.
      const byOwner = await call({ method: "POST", url, token: a.memberToken, payload: { userId: a.adminUserId } });
      expect(byOwner.statusCode, byOwner.body).toBe(201);
      expect((await grants(c.id)).map((g) => g.userId).sort()).toEqual(
        [a.viewerUserId, a.adminUserId].sort(),
      );
    });

    it("a non-manager MEMBER is refused 403; another tenant is answered exactly as a missing case", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);

      const member = await call({
        method: "POST",
        url: `/v1/cases/${c.id}/access`,
        token: a.memberToken,
        payload: { userId: a.viewerUserId },
      });
      expect(member.statusCode, member.body).toBe(403);

      const foreign = await call({
        method: "POST",
        url: `/v1/cases/${c.id}/access`,
        token: b.ownerToken,
        payload: { userId: b.memberUserId },
      });
      const missing = await call({
        method: "POST",
        url: `/v1/cases/${randomUUID()}/access`,
        token: b.ownerToken,
        payload: { userId: b.memberUserId },
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);
      expect(await grants(c.id)).toEqual([]);
    });
  });

  // ===========================================================================
  // D6 — POST /v1/cases/:id/share-email
  // ===========================================================================
  describe("D6 — POST /v1/cases/:id/share-email is not an account-existence oracle", () => {
    it("answers byte-identically for a member, a foreign account, a suspended member and an unknown address; only the member is granted", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const url = `/v1/cases/${c.id}/share-email`;
      const share = (email: string) =>
        call({ method: "POST", url, token: a.ownerToken, payload: { email } });

      const unknown = await share(`nobody-${randomUUID()}@test.proovra.local`);
      const foreign = await share(await emailOf(b.memberUserId));
      await setStatus(a.teamId, a.viewerUserId, "SUSPENDED");
      let suspended;
      try {
        suspended = await share(await emailOf(a.viewerUserId));
      } finally {
        await setStatus(a.teamId, a.viewerUserId, "ACTIVE");
      }
      expect(await grants(c.id)).toEqual([]);

      const member = await share(await emailOf(a.memberUserId));

      for (const res of [unknown, foreign, suspended, member]) {
        expect(res.statusCode, res.body).toBe(202);
        expect(res.body).toBe(unknown.body);
      }
      expect(unknown.json()).toEqual({ accepted: true });
      // The real effect is kept for the real member, and only for them.
      expect(await grants(c.id)).toEqual([{ userId: a.memberUserId }]);
    });

    it("a case with no workspace is refused the same way whether or not the address has an account", async () => {
      const p = h.fixtures.personal;
      const c = await newCase(null, p.userId);
      const url = `/v1/cases/${c.id}/share-email`;
      const known = await call({
        method: "POST",
        url,
        token: p.token,
        payload: { email: await emailOf(h.fixtures.teamB.memberUserId) },
      });
      const unknown = await call({
        method: "POST",
        url,
        token: p.token,
        payload: { email: `nobody-${randomUUID()}@test.proovra.local` },
      });
      expect(known.statusCode, known.body).toBe(400);
      expect(known.body).toBe(unknown.body);
      expect(await grants(c.id)).toEqual([]);
    });
  });

  // ===========================================================================
  // D47 — DELETE /v1/cases/:id/access/:accessId
  // ===========================================================================
  describe("D47 — DELETE /v1/cases/:id/access/:accessId conceals the case from another tenant", () => {
    it("another tenant's owner gets the byte-identical 404 of a missing case; the grant survives", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const access = await prisma.caseAccess.create({
        data: { caseId: c.id, userId: a.memberUserId },
        select: { id: true },
      });

      const foreign = await call({
        method: "DELETE",
        url: `/v1/cases/${c.id}/access/${access.id}`,
        token: b.ownerToken,
      });
      const missing = await call({
        method: "DELETE",
        url: `/v1/cases/${randomUUID()}/access/${access.id}`,
        token: b.ownerToken,
      });
      expect(foreign.statusCode, foreign.body).toBe(404);
      expect(foreign.body).toBe(missing.body);
      expect(await prisma.caseAccess.count({ where: { id: access.id } })).toBe(1);

      // A same-workspace non-manager can see the case exists: still 403.
      const viewer = await call({
        method: "DELETE",
        url: `/v1/cases/${c.id}/access/${access.id}`,
        token: a.viewerToken,
      });
      expect(viewer.statusCode, viewer.body).toBe(403);
      expect(await prisma.caseAccess.count({ where: { id: access.id } })).toBe(1);
    });
  });

  // ===========================================================================
  // O1 — the reads the Access tab consumes
  // ===========================================================================
  describe("O1 — the Access tab's reads", () => {
    it("team-members lists ACTIVE members for an access manager; grants are read from GET /v1/cases/:id", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);

      await setStatus(a.teamId, a.viewerUserId, "SUSPENDED");
      try {
        const res = await call({ method: "GET", url: `/v1/cases/${c.id}/team-members`, token: a.adminToken });
        expect(res.statusCode, res.body).toBe(200);
        const ids = (res.json().items as Array<{ userId: string }>).map((m) => m.userId);
        expect(ids).toContain(a.memberUserId);
        expect(ids).not.toContain(a.viewerUserId);
      } finally {
        await setStatus(a.teamId, a.viewerUserId, "ACTIVE");
      }

      const foreign = await call({ method: "GET", url: `/v1/cases/${c.id}/team-members`, token: b.ownerToken });
      const missing = await call({ method: "GET", url: `/v1/cases/${randomUUID()}/team-members`, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);

      const granted = await call({
        method: "POST",
        url: `/v1/cases/${c.id}/access`,
        token: a.ownerToken,
        payload: { userId: a.memberUserId },
      });
      expect(granted.statusCode, granted.body).toBe(201);
      const detail = await call({ method: "GET", url: `/v1/cases/${c.id}`, token: a.ownerToken });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().case.access).toEqual([
        expect.objectContaining({ id: granted.json().access.id, userId: a.memberUserId }),
      ]);

      // Revoke by an ADMIN who is not the case owner — the same authority
      // that may grant may withdraw.
      const revoked = await call({
        method: "DELETE",
        url: `/v1/cases/${c.id}/access/${granted.json().access.id}`,
        token: a.adminToken,
      });
      expect(revoked.statusCode, revoked.body).toBe(204);
      expect(await grants(c.id)).toEqual([]);
    });
  });
});
