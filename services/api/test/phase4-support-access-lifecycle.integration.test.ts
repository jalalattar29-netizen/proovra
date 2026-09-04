/**
 * PHASE 4 CLOSURE — THE SUPPORT ACCESS LIFECYCLE, END TO END.
 *
 * Live PostgreSQL 16, real routes, real authorization, real persistence.
 *
 * Earlier work proved only that the grant inventory is not enumerable and that
 * a refused start writes nothing. This drives the whole lifecycle, because the
 * dangerous states are the ones between creation and revocation: a grant whose
 * window has closed but whose stored column still says ACTIVE is access that
 * has expired in fact and not in the console.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOrganizationTenant,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

describe("PHASE 4 — support access lifecycle (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;

  let staff: SeededUser;
  let otherStaff: SeededUser;
  let orgA: { organizationId: string; workspaceId: string; owner: SeededUser };
  let orgB: { organizationId: string; workspaceId: string; owner: SeededUser };
  let personal: SeededUser;

  async function call(
    token: string | null,
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
  ) {
    const res = await harness.app.inject({
      method,
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    let body: unknown = null;
    try {
      body = JSON.parse(res.body);
    } catch {
      body = res.body;
    }
    return {
      status: res.statusCode,
      body: body as Record<string, unknown>,
      text: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
      code:
        (body as { error?: { code?: string } })?.error?.code ??
        (body as { code?: string })?.code ??
        null,
    };
  }

  const refused = (r: { status: number }) => [401, 402, 403, 404].includes(r.status);

  /** A grant written straight to the store, so its window can be controlled. */
  async function seedGrant(opts: {
    organizationId: string;
    teamId?: string | null;
    supportUserId: string;
    expiresInMs: number;
    status?: string;
    revokedAtUtc?: Date | null;
  }) {
    return prisma.supportAccessGrant.create({
      data: {
        supportUserId: opts.supportUserId,
        organizationId: opts.organizationId,
        teamId: opts.teamId ?? null,
        reason: `phase4 lifecycle probe ${randomUUID().slice(0, 8)}`,
        accessLevel: "READ_ONLY",
        status: opts.status ?? "ACTIVE",
        startedAtUtc: new Date(Date.now() - 60_000),
        expiresAtUtc: new Date(Date.now() + opts.expiresInMs),
        revokedAtUtc: opts.revokedAtUtc ?? null,
      },
      select: { id: true },
    });
  }

  /**
   * Start a grant through the REAL service, so the start audit is written the
   * way production writes it.
   *
   * `seedGrant` above inserts a row directly, which is right for the effective
   * state cases — it proves the projection reads the store rather than
   * remembering what this process created. It is exactly wrong for an audit
   * case: a row inserted behind the service emits no audit at all.
   */
  async function startSupportAccessDirect(opts: {
    organizationId: string;
    teamId: string;
    supportUserId: string;
  }) {
    const { startSupportAccess } = await import(
      "../src/services/identity/support-access.service.js"
    );
    return startSupportAccess({
      supportUserId: opts.supportUserId,
      organizationId: opts.organizationId,
      teamId: opts.teamId,
      reason: `phase4 audit lifecycle probe ${randomUUID().slice(0, 8)}`,
      accessLevel: "READ_ONLY",
      approvedByUserId: null,
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `p4sa-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          3600,
        ),
    };

    staff = await seedUser(deps, "p4sa-staff");
    await prisma.user.update({
      where: { id: staff.userId },
      data: { platformRole: "admin" },
    });
    await bootstrapPersonalSpace(deps, staff.userId);

    otherStaff = await seedUser(deps, "p4sa-other-staff");
    await prisma.user.update({
      where: { id: otherStaff.userId },
      data: { platformRole: "admin" },
    });
    await bootstrapPersonalSpace(deps, otherStaff.userId);

    const a = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    orgA = { organizationId: a.organizationId, workspaceId: a.workspaceId, owner: a.owner };
    const b = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    orgB = { organizationId: b.organizationId, workspaceId: b.workspaceId, owner: b.owner };

    personal = (await seedPersonalTenant(deps, "FREE")).owner;
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  // =========================================================================
  // EFFECTIVE STATE — the half of the lifecycle a stored column cannot tell.
  // =========================================================================
  describe("a grant whose window has closed is not effectively ACTIVE", () => {
    it("a lapsed grant is projected EXPIRED, not ACTIVE", async () => {
      /*
       * Nothing sweeps the status column the moment a window closes, so a
       * grant that expired a second ago still reads `status: "ACTIVE"` in the
       * row. The console must answer with the EFFECTIVE state — expiry is a
       * function of the clock, and an operator reading this list is asking
       * "who can reach customer data right now".
       */
      const lapsed = await seedGrant({
        organizationId: orgA.organizationId,
        supportUserId: staff.userId,
        expiresInMs: -30_000,
      });

      const res = await call(staff.token, "GET", "/v1/support-access/grants?limit=200");
      expect(res.status).toBe(200);
      const row = (res.body["grants"] as Array<Record<string, unknown>>).find(
        (g) => g["id"] === lapsed.id,
      );
      expect(row, "the lapsed grant is not listed at all").toBeTruthy();
      expect(
        row!["effectiveStatus"],
        "a grant past its window still reads as effectively ACTIVE",
      ).toBe("EXPIRED");
    });

    it("filtering by ACTIVE does not return a lapsed grant", async () => {
      const lapsed = await seedGrant({
        organizationId: orgA.organizationId,
        supportUserId: staff.userId,
        expiresInMs: -45_000,
      });
      const live = await seedGrant({
        organizationId: orgA.organizationId,
        supportUserId: staff.userId,
        expiresInMs: 10 * 60_000,
      });

      const res = await call(
        staff.token,
        "GET",
        "/v1/support-access/grants?status=ACTIVE&limit=200",
      );
      expect(res.status).toBe(200);
      const ids = (res.body["grants"] as Array<Record<string, unknown>>).map((g) => g["id"]);
      expect(ids, "a lapsed grant answered a status=ACTIVE filter").not.toContain(lapsed.id);
      expect(ids, "the live grant is missing from status=ACTIVE").toContain(live.id);
    });

    it("filtering by EXPIRED includes a lapsed-but-unswept grant", async () => {
      const lapsed = await seedGrant({
        organizationId: orgA.organizationId,
        supportUserId: staff.userId,
        expiresInMs: -90_000,
      });
      const res = await call(
        staff.token,
        "GET",
        "/v1/support-access/grants?status=EXPIRED&limit=200",
      );
      expect(res.status).toBe(200);
      const ids = (res.body["grants"] as Array<Record<string, unknown>>).map((g) => g["id"]);
      expect(ids, "a lapsed grant is invisible under status=EXPIRED").toContain(lapsed.id);
    });
  });

  // =========================================================================
  // REVOCATION — always available, idempotent, convergent.
  // =========================================================================
  describe("revocation is idempotent and converges under concurrency", () => {
    it("revoking twice does not move the moment the access died", async () => {
      const grant = await seedGrant({
        organizationId: orgA.organizationId,
        supportUserId: staff.userId,
        expiresInMs: 10 * 60_000,
      });

      const first = await call(staff.token, "POST", "/v1/support-access/revoke", {
        teamId: orgA.workspaceId,
        grantId: grant.id,
      });
      expect(first.status, `first revoke ${first.code ?? ""}`).toBe(200);
      const afterFirst = await prisma.supportAccessGrant.findUniqueOrThrow({
        where: { id: grant.id },
        select: { status: true, revokedAtUtc: true },
      });
      expect(afterFirst.status).toBe("REVOKED");

      const second = await call(staff.token, "POST", "/v1/support-access/revoke", {
        teamId: orgA.workspaceId,
        grantId: grant.id,
      });
      const afterSecond = await prisma.supportAccessGrant.findUniqueOrThrow({
        where: { id: grant.id },
        select: { status: true, revokedAtUtc: true },
      });
      expect(second.status, "a repeated revoke was not a safe answer").toBeLessThan(500);
      expect(
        afterSecond.revokedAtUtc?.getTime(),
        "a repeated revoke moved the revocation timestamp",
      ).toBe(afterFirst.revokedAtUtc?.getTime());
    });

    it("four simultaneous revokes converge on one revocation", async () => {
      const grant = await seedGrant({
        organizationId: orgA.organizationId,
        supportUserId: staff.userId,
        expiresInMs: 10 * 60_000,
      });
      await Promise.all(
        Array.from({ length: 4 }, () =>
          call(staff.token, "POST", "/v1/support-access/revoke", {
            teamId: orgA.workspaceId,
            grantId: grant.id,
          }),
        ),
      );
      const row = await prisma.supportAccessGrant.findUniqueOrThrow({
        where: { id: grant.id },
        select: { status: true, revokedAtUtc: true },
      });
      expect(row.status).toBe("REVOKED");
      expect(row.revokedAtUtc, "a converged revoke left no timestamp").not.toBeNull();
    });

    it("a revoked grant is never effectively ACTIVE again", async () => {
      const grant = await seedGrant({
        organizationId: orgA.organizationId,
        supportUserId: staff.userId,
        expiresInMs: 60 * 60_000,
        status: "REVOKED",
        revokedAtUtc: new Date(),
      });
      const res = await call(staff.token, "GET", "/v1/support-access/grants?limit=200");
      const row = (res.body["grants"] as Array<Record<string, unknown>>).find(
        (g) => g["id"] === grant.id,
      );
      expect(row!["effectiveStatus"], "a revoked grant inside its window read ACTIVE").toBe(
        "REVOKED",
      );
    });
  });

  // =========================================================================
  // AUTHORITY AND TARGETING.
  // =========================================================================
  describe("only platform staff reach the lifecycle, and the target is explicit", () => {
    it("no workspace identity can enumerate, start or revoke", async () => {
      const grant = await seedGrant({
        organizationId: orgA.organizationId,
        supportUserId: staff.userId,
        expiresInMs: 10 * 60_000,
      });
      for (const token of [orgA.owner.token, orgB.owner.token, personal.token, null]) {
        const list = await call(token, "GET", "/v1/support-access/grants");
        expect(refused(list), `grants enumerated with ${list.status}`).toBe(true);

        const start = await call(token, "POST", "/v1/support-access/start", {
          teamId: orgA.workspaceId,
          organizationId: orgA.organizationId,
          reason: "phase4 unauthorized probe",
        });
        expect(refused(start), `start opened with ${start.status}`).toBe(true);

        const revoke = await call(token, "POST", "/v1/support-access/revoke", {
          teamId: orgA.workspaceId,
          grantId: grant.id,
        });
        expect(refused(revoke), `revoke opened with ${revoke.status}`).toBe(true);
      }
      // Nothing above may have changed the grant.
      const row = await prisma.supportAccessGrant.findUniqueOrThrow({
        where: { id: grant.id },
        select: { status: true, revokedAtUtc: true },
      });
      expect(row.status, "an unauthorized revoke landed").toBe("ACTIVE");
      expect(row.revokedAtUtc, "an unauthorized revoke stamped a timestamp").toBeNull();
    });

    it("the grant records its target organization explicitly, not the caller's header", async () => {
      const grant = await seedGrant({
        organizationId: orgB.organizationId,
        teamId: orgB.workspaceId,
        supportUserId: staff.userId,
        expiresInMs: 10 * 60_000,
      });
      const res = await call(
        staff.token,
        "GET",
        `/v1/support-access/grants?organizationId=${orgB.organizationId}&mine=false&limit=200`,
      );
      const row = (res.body["grants"] as Array<Record<string, unknown>>).find(
        (g) => g["id"] === grant.id,
      );
      expect(row, "the grant is not findable by its explicit target").toBeTruthy();
      expect(row!["organizationId"], "the target organization is not projected").toBe(
        orgB.organizationId,
      );
      expect(row!["teamId"], "the target workspace is not projected").toBe(orgB.workspaceId);
    });
  });

  // =========================================================================
  // PROJECTION SAFETY AND PERSISTENCE.
  // =========================================================================
  describe("the inventory carries no activation material, and survives a restart", () => {
    it("no grant listing contains a token, secret or hash", async () => {
      const res = await call(
        staff.token,
        "GET",
        "/v1/support-access/grants?mine=false&limit=200",
      );
      expect(res.status).toBe(200);
      for (const forbidden of [
        "supportContextToken",
        "contextToken",
        "tokenHash",
        "token_hash",
        "secret",
        "Bearer ",
      ]) {
        expect(
          res.text.includes(forbidden),
          `the grant inventory leaked ${forbidden}`,
        ).toBe(false);
      }
    });

    it("effective state is recomputed from the store, not from process memory", async () => {
      /*
       * The restart property, expressed the way it can actually be observed
       * in-process: the answer comes from the row and the clock, so a grant
       * seeded directly into the database — never seen by this process's
       * lifecycle code — projects the same effective state as one this API
       * created. If effective state were cached anywhere, this would differ.
       */
      const seeded = await seedGrant({
        organizationId: orgA.organizationId,
        supportUserId: staff.userId,
        expiresInMs: -5_000,
      });
      const res = await call(staff.token, "GET", "/v1/support-access/grants?limit=200");
      const row = (res.body["grants"] as Array<Record<string, unknown>>).find(
        (g) => g["id"] === seeded.id,
      );
      expect(row!["effectiveStatus"]).toBe("EXPIRED");
    });

    it("the listing is NOT narrowed by any workspace — the console's label depends on it", async () => {
      /*
       * WHY THIS IS A TEST AND NOT A COMMENT.
       *
       * The Admin console prints one of two banners on this page, and the
       * choice is a claim about behaviour: "workspace-scoped — this page
       * administers your own active workspace", or "platform-wide — that
       * workspace is not a filter on what you see". Until this phase it
       * printed the first, which told an operator about to break glass into a
       * customer organization that they were looking at their own tenant.
       *
       * The label is now the second one. That is only honest while the
       * listing really does cross tenants, so the label is pinned here rather
       * than left to the next person's reading of the handler: two grants on
       * two different organizations and two different workspaces, one staff
       * caller, one request, both rows back.
       */
      const inA = await seedGrant({
        organizationId: orgA.organizationId,
        teamId: orgA.workspaceId,
        supportUserId: staff.userId,
        expiresInMs: 10 * 60_000,
      });
      const inB = await seedGrant({
        organizationId: orgB.organizationId,
        teamId: orgB.workspaceId,
        supportUserId: staff.userId,
        expiresInMs: 10 * 60_000,
      });

      const res = await call(staff.token, "GET", "/v1/support-access/grants?limit=200");
      expect(res.status).toBe(200);
      const ids = (res.body["grants"] as Array<Record<string, unknown>>).map(
        (g) => g["id"],
      );
      expect(ids, "a grant on organization A was not listed").toContain(inA.id);
      expect(
        ids,
        "the listing dropped organization B — it is narrowing by workspace, " +
          "and the platform-wide banner on /admin/support-access is now a lie",
      ).toContain(inB.id);
    });
  });

  // =========================================================================
  // THE FOUR STATES NOTHING ELSE ASSERTED.
  //
  // Creation, step-up refusal, activation, expiry, revocation, repeat
  // revocation, cross-tenant refusal, zero-write-after-refusal and restart
  // persistence are all proven elsewhere (phase-12b-identity-security-matrix,
  // phase-10-support-*, and the cases above). These four were not, and each
  // one is a place where the console could tell an operator something the
  // database does not say.
  // =========================================================================
  describe("the states nothing else asserted", () => {
    it("a live grant projects effectively ACTIVE — the positive half of the clock", async () => {
      /*
       * Every other effective-state case here is a NEGATIVE: lapsed is not
       * ACTIVE, revoked is not ACTIVE. A projection hard-coded to answer
       * EXPIRED would satisfy all of them. This is the case that fails if
       * effective state stops tracking a grant that really is live.
       */
      const live = await seedGrant({
        organizationId: orgA.organizationId,
        supportUserId: staff.userId,
        expiresInMs: 10 * 60_000,
      });
      const res = await call(staff.token, "GET", "/v1/support-access/grants?limit=200");
      expect(res.status).toBe(200);
      const row = (res.body["grants"] as Array<Record<string, unknown>>).find(
        (g) => g["id"] === live.id,
      );
      expect(row, "a live grant was not listed").toBeTruthy();
      expect(
        row!["effectiveStatus"],
        "a grant inside its window is not effectively ACTIVE",
      ).toBe("ACTIVE");
    });

    it("revocation racing activation never leaves usable access behind", async () => {
      /*
       * The dangerous interleaving is not two revokes (proved convergent
       * above) — it is revoke against ENTRY. If entry validates a grant that
       * revocation is concurrently killing, the loser can still walk away
       * with a session-bound support token, and the console will show the
       * grant as REVOKED while the token keeps working.
       *
       * The invariant is not "entry loses". Either order is legitimate. The
       * invariant is that once revocation has returned, no entry succeeds —
       * so the same entry is replayed AFTER the race has settled.
       */
      const grant = await seedGrant({
        organizationId: orgA.organizationId,
        teamId: orgA.workspaceId,
        supportUserId: staff.userId,
        expiresInMs: 10 * 60_000,
      });

      const [revoke, race] = await Promise.all([
        call(staff.token, "POST", "/v1/support-access/revoke", { grantId: grant.id }),
        call(staff.token, "POST", "/v1/support-access/enter", {
          teamId: orgA.workspaceId,
          grantId: grant.id,
        }),
      ]);
      expect(revoke.status, "revocation did not complete").toBe(200);
      // The race itself may go either way; both outcomes are correct.
      expect([200, 403]).toContain(race.status);

      const settled = await prisma.supportAccessGrant.findUniqueOrThrow({
        where: { id: grant.id },
        select: { status: true, revokedAtUtc: true },
      });
      expect(settled.status, "the grant survived a completed revocation").toBe("REVOKED");
      expect(settled.revokedAtUtc).toBeTruthy();

      const after = await call(staff.token, "POST", "/v1/support-access/enter", {
        teamId: orgA.workspaceId,
        grantId: grant.id,
      });
      expect(
        after.status,
        "a revoked grant still minted a support-context token",
      ).toBe(403);
      expect(after.text, "a token was issued for revoked access").not.toContain(
        "supportContextToken",
      );
    });

    it("the audit records WHO acted, WHAT was targeted, and the transition — with no secret", async () => {
      /*
       * The audit trail is the only durable account of support access, and
       * three things make it an account rather than a log line: the actor, the
       * target, and the transition. The transition is carried by the ACTION
       * pair on one grantId — started then revoked — which is what makes a
       * previous → next state readable from an append-only chain that never
       * rewrites a row.
       *
       * The revoking actor is deliberately a DIFFERENT staff user from the one
       * who started the grant, because an audit that always names one identity
       * cannot be shown to be recording the real one.
       */
      const grant = await startSupportAccessDirect({
        organizationId: orgB.organizationId,
        teamId: orgB.workspaceId,
        supportUserId: staff.userId,
      });

      const revoked = await call(otherStaff.token, "POST", "/v1/support-access/revoke", {
        grantId: grant.id,
      });
      expect(revoked.status).toBe(200);

      const rows = await prisma.adminAuditLog.findMany({
        where: {
          action: { in: ["identity.support_access.started", "identity.support_access.revoked"] },
          OR: [{ resourceId: grant.id }, { resourceId: orgB.organizationId }],
        },
        orderBy: { createdAt: "asc" },
        select: {
          action: true,
          userId: true,
          organizationId: true,
          workspaceId: true,
          resourceType: true,
          resourceId: true,
          metadata: true,
        },
      });

      const started = rows.find(
        (r) =>
          r.action === "identity.support_access.started" &&
          (r.metadata as { grantId?: string } | null)?.grantId === grant.id,
      );
      const killed = rows.find(
        (r) => r.action === "identity.support_access.revoked" && r.resourceId === grant.id,
      );

      // PREVIOUS → NEXT. Both ends of the transition exist for this one grant,
      // and they are ordered.
      expect(started, "no audit row records the grant being started").toBeTruthy();
      expect(killed, "no audit row records the grant being revoked").toBeTruthy();

      // ACTOR — and specifically the one who really acted, not the grant holder.
      expect(started!.userId, "the start audit does not name the support actor").toBe(
        staff.userId,
      );
      expect(
        killed!.userId,
        "the revoke audit named the grant holder instead of the staff user who revoked",
      ).toBe(otherStaff.userId);

      // TARGET — the tenant columns are authoritative, not JSON-only.
      expect(killed!.organizationId, "the revoke audit lost its organization").toBe(
        orgB.organizationId,
      );
      expect(killed!.workspaceId, "the revoke audit lost its workspace").toBe(
        orgB.workspaceId,
      );
      expect(killed!.resourceType).toBe("support_access_grant");
      expect(killed!.resourceId).toBe(grant.id);

      // NO SECRET. The listings are proved clean above; the audit is the other
      // place activation material could come to rest.
      const serialized = JSON.stringify(rows);
      for (const marker of [
        "supportContextToken",
        "tokenHash",
        "secret",
        "passwordHash",
        "privateKey",
      ]) {
        expect(
          serialized.toLowerCase(),
          `the support audit trail carries ${marker}`,
        ).not.toContain(marker.toLowerCase());
      }
    });
  });
});
