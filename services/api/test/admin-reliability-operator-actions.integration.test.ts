/**
 * ADMIN CONTROL PLANE — RELIABILITY OPERATOR ACTIONS, executed against live
 * PostgreSQL 16.
 *
 * WHAT THIS SUITE PROVES
 * ---------------------------------------------------------------------------
 * The admin page /admin/platform/reliability offers two operator mutations on
 * an upload session:
 *
 *   POST /v1/reliability/upload-sessions/:evidenceId/mark-abandoned   { teamId }
 *   POST /v1/reliability/upload-sessions/:evidenceId/request-review   { teamId }
 *
 * Both are implemented in `src/routes/reliability.routes.ts` on top of
 * `operatorMarkAbandoned` / `operatorRequestReview`
 * (`src/services/reliability/upload-reconciliation.service.ts`) and the
 * transition matrix in `@proovra/shared` (`isAllowedUploadSessionTransition`).
 *
 * Every existing test of these routes reads the source text. This suite issues
 * real HTTP requests through the real Fastify app against a real database and
 * asserts REAL status codes and REAL rows before and after each call, because a
 * gate that is written is not the same as a gate that holds — and because the
 * transition rules have a self-transition allowance (`from === to` is allowed
 * for heartbeats) whose runtime consequence for an operator's double-click
 * cannot be seen in the route file at all. The operator services opt out of
 * that allowance with `TransitionInput.exclusive`, and this suite is what
 * proves the opt-out holds: a repeat click and a lost race both answer 409,
 * write nothing, and emit nothing.
 *
 * WHY THE SEEDED SESSIONS START IN `UPLOADING`
 * ---------------------------------------------------------------------------
 * The matrix allows BOTH `ABANDONED` and `REVIEW_REQUIRED` from `CREATED`,
 * `PRESIGNED`, `UPLOADING`, `PARTIAL` and `STALLED`. `UPLOADING` is chosen
 * because (a) it is the state an operator actually sees on the reliability
 * page for an in-flight upload that stopped reporting, and (b) it is NOT the
 * model's default (`CREATED`), so a seed that silently dropped the status
 * would be visible in the "state before" assertions rather than masked.
 *
 * WHAT WAS MEASURED (recorded in each case's comment)
 * ---------------------------------------------------------------------------
 * The denial matrix (anonymous / outsider / non-admin role / cross-workspace
 * probe), the happy paths with exact before/after rows, the security-event
 * rows the services emit, tenant isolation of a second workspace, the
 * double-submit path, and two concurrent submissions on one fresh session.
 *
 * HISTORY. The first execution of this suite (2026-09-03, before
 * `exclusive` existed) measured the double-submit answering 200 while
 * re-stamping `abandonedAtUtc` and emitting a second `upload_abandoned`
 * event, and both concurrent requests answering 200. Those were product
 * defects in the transition authority, fixed the same day; cases 6 and 10
 * now pin the corrected contract exactly and would fail if the self-noop or
 * lost-race path ever handed the operator route a row again.
 *
 * Executed against a disposable pgvector/pgvector:pg16 (testcontainers) + a
 * local disposable Redis, ~25s including container start and
 * `prisma migrate deploy`.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
// `seedUser` mints each token AND registers its `AuthenticatedSession` row via
// `registerSessionForToken`; every actor below is created through it, so
// nothing here re-registers a session (a second row for one sid would be a
// duplicate, not a stronger fixture).
import {
  seedOrganizationTenant,
  seedUser,
  type FixtureDeps,
  type OrganizationTenant,
  type SeededUser,
} from "./point7/product-fixtures.js";

const MARK_ABANDONED = (evidenceId: string): string =>
  `/v1/reliability/upload-sessions/${evidenceId}/mark-abandoned`;
const REQUEST_REVIEW = (evidenceId: string): string =>
  `/v1/reliability/upload-sessions/${evidenceId}/request-review`;

/** The status every seeded session starts in — see the header for why. */
const SEED_STATUS = "UPLOADING" as const;

type SessionSnapshot = {
  status: string;
  abandonedAtUtc: Date | null;
  stalledAtUtc: Date | null;
  completedAtUtc: Date | null;
  failureReason: string | null;
  retryCount: number;
  lastActivityAtUtc: Date;
  updatedAt: Date;
};

describe("ADMIN CONTROL PLANE — reliability operator actions (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let secret: string;
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];

  /** Workspace A — the one whose sessions the operator acts on. */
  let orgA: OrganizationTenant;
  /** Workspace B — an unrelated tenant that must be untouched throughout. */
  let orgB: OrganizationTenant;
  /** A legacy-role MEMBER of A (seeded by the fixture's `memberCount`). */
  let memberA: SeededUser;
  /** A VIEWER of A — holds `identity.org_policy.read`, is not OWNER/ADMIN. */
  let viewerA: SeededUser;
  /** An authenticated user who belongs to NO workspace. */
  let outsider: SeededUser;

  /** Baseline of B's sessions by status, taken once after seeding. */
  let orgBStatusBaseline: Record<string, number>;
  /** B's two seeded sessions — probed from outside, never mutated. */
  let orgBSessions: Array<{ evidenceId: string }>;

  function mintToken(userId: string, email: string): string {
    // Same shape `auth.routes.ts#jwtPayloadFromUser` mints for a password
    // login. `requireAuth` refuses tokens without proven provenance.
    return signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
      },
      secret,
      60 * 60,
    );
  }

  async function post(opts: {
    url: string;
    token?: string;
    payload: unknown;
  }): Promise<{ statusCode: number; json: () => unknown; body: string }> {
    const res = await harness.app.inject({
      method: "POST",
      url: opts.url,
      ...(opts.token
        ? { headers: { authorization: `Bearer ${opts.token}` } }
        : {}),
      payload: opts.payload as Record<string, unknown>,
    });
    return {
      statusCode: res.statusCode,
      json: () => res.json() as unknown,
      body: res.body,
    };
  }

  /**
   * Seed an Evidence row + its UploadSession in one workspace. The Evidence
   * row is required: `upload_sessions.evidence_id` is a FK onto `evidence.id`
   * (onDelete Cascade). Organization attribution derives from the workspace —
   * `evidence_team_implies_org_chk` forbids team-bound evidence without one.
   */
  async function seedSession(
    tenant: OrganizationTenant,
    status: typeof SEED_STATUS = SEED_STATUS,
  ): Promise<{ evidenceId: string }> {
    const evidence = await prisma.evidence.create({
      data: {
        title: `reliability-op ${deps.tag} ${randomUUID().slice(0, 8)}`,
        type: "PHOTO",
        status: "UPLOADING",
        teamId: tenant.workspaceId,
        organizationId: tenant.organizationId,
        ownerUserId: tenant.owner.userId,
      },
      select: { id: true },
    });
    await prisma.uploadSession.create({
      data: {
        evidenceId: evidence.id,
        teamId: tenant.workspaceId,
        status,
        isMultipart: false,
      },
    });
    return { evidenceId: evidence.id };
  }

  async function readSession(evidenceId: string): Promise<SessionSnapshot> {
    return prisma.uploadSession.findUniqueOrThrow({
      where: { evidenceId },
      select: {
        status: true,
        abandonedAtUtc: true,
        stalledAtUtc: true,
        completedAtUtc: true,
        failureReason: true,
        retryCount: true,
        lastActivityAtUtc: true,
        updatedAt: true,
      },
    });
  }

  /**
   * A NEGATIVE poll: wait long enough that a late duplicate emit would have
   * landed, then assert it did not. Every positive emit in this suite is
   * found on the first 50ms poll, so 1.5s is a ~30x margin, not a guess.
   */
  const NO_DUPLICATE_WINDOW_MS = 1_500;

  async function countSessionsByStatus(
    teamId: string,
  ): Promise<Record<string, number>> {
    const rows = await prisma.uploadSession.groupBy({
      by: ["status"],
      where: { teamId },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r._count._all;
    return out;
  }

  /**
   * `safeEmitSecurityEvent` is fire-and-forget: the route replies before the
   * `security_events` INSERT has necessarily committed. The row is looked up
   * with a bounded poll so the assertion is about the row, not about a race.
   *
   * There is no `evidence_id` column on `security_events` (Phase 32.7.2
   * aligned the model to the production table); the writer folds the id into
   * the `metadataJson` blob, which Prisma exposes as `details`.
   */
  async function findSecurityEvents(
    eventType: string,
    evidenceId: string,
    opts: { atLeast: number; deadlineMs?: number } = { atLeast: 1 },
  ): Promise<
    Array<{ id: string; teamId: string | null; severity: string; details: unknown }>
  > {
    const deadline = Date.now() + (opts.deadlineMs ?? 5_000);
    for (;;) {
      const rows = await prisma.securityEvent.findMany({
        where: {
          eventType,
          details: { path: ["evidenceId"], equals: evidenceId },
        },
        select: { id: true, teamId: true, severity: true, details: true },
        orderBy: { createdAt: "asc" },
      });
      if (rows.length >= opts.atLeast || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    secret = process.env.AUTH_JWT_SECRET!;

    deps = {
      prisma: prisma as never,
      tag: `adm-reliab-${Date.now().toString(36)}`,
      mintToken,
    };

    // `seedUser` (used inside the tenant builders) registers the session
    // inventory row for every token it mints, so OWNER/MEMBER tokens are live.
    orgA = await seedOrganizationTenant(deps, { memberCount: 1 });
    orgB = await seedOrganizationTenant(deps);
    memberA = orgA.members[0]!;

    // A VIEWER of A. The fixture only seeds MEMBERs, so the role row is added
    // here the way the integration harness adds its own viewer fixture.
    viewerA = await seedUser(deps, "viewer");
    await prisma.organizationMembership.create({
      data: {
        organizationId: orgA.organizationId,
        userId: viewerA.userId,
        role: "ORG_MEMBER",
      },
    });
    await prisma.teamMember.create({
      data: {
        teamId: orgA.workspaceId,
        userId: viewerA.userId,
        role: "VIEWER",
        status: "ACTIVE",
      },
    });

    outsider = await seedUser(deps, "outsider");

    // Workspace B holds two sessions so the isolation check has something to
    // count. Its baseline is read AFTER seeding and BEFORE any request; no
    // test seeds into B afterwards, so the final count must equal this.
    orgBSessions = [await seedSession(orgB), await seedSession(orgB)];
    orgBStatusBaseline = await countSessionsByStatus(orgB.workspaceId);
    expect(orgBStatusBaseline[SEED_STATUS]).toBe(2);
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // Denials. Each one must leave the row byte-for-byte as seeded.
  // =========================================================================

  describe("denials leave the session untouched", () => {
    it("1. anonymous caller → 401 on both actions, no state change", async () => {
      const { evidenceId } = await seedSession(orgA);
      const before = await readSession(evidenceId);

      for (const url of [MARK_ABANDONED(evidenceId), REQUEST_REVIEW(evidenceId)]) {
        const res = await post({ url, payload: { teamId: orgA.workspaceId } });
        // MEASURED: `requireAuth` answers 401 before the handler runs.
        expect(res.statusCode, `${url} anonymous`).toBe(401);
      }
      expect(await readSession(evidenceId)).toEqual(before);
      expect(before.status).toBe(SEED_STATUS);
    });

    it("2. authenticated non-member of the workspace → 404 (anti-enumeration), no state change", async () => {
      const { evidenceId } = await seedSession(orgA);
      const before = await readSession(evidenceId);

      for (const url of [MARK_ABANDONED(evidenceId), REQUEST_REVIEW(evidenceId)]) {
        const res = await post({
          url,
          token: outsider.token,
          payload: { teamId: orgA.workspaceId },
        });
        // MEASURED: `authorizeOrFail({ antiEnumeration: true })` conceals a
        // membership failure as 404, so an outsider cannot learn whether the
        // workspace — or the session — exists.
        expect(res.statusCode, `${url} outsider`).toBe(404);
        expect(res.json()).toEqual({ error: { code: "not_found" } });
      }
      expect(await readSession(evidenceId)).toEqual(before);
    });

    it("3a. a VIEWER of the workspace (not OWNER/ADMIN) → 404, no state change", async () => {
      const { evidenceId } = await seedSession(orgA);
      const before = await readSession(evidenceId);

      for (const url of [MARK_ABANDONED(evidenceId), REQUEST_REVIEW(evidenceId)]) {
        const res = await post({
          url,
          token: viewerA.token,
          payload: { teamId: orgA.workspaceId },
        });
        // MEASURED: VIEWER carries `identity.org_policy.read`, so the canonical
        // gate ADMITS the viewer and it is the route's own OWNER/ADMIN check
        // (`requireAdminMember`) that refuses — with the same flat 404, so a
        // viewer cannot distinguish "not admin" from "no such session".
        expect(res.statusCode, `${url} viewer`).toBe(404);
        expect(res.json()).toEqual({ error: { code: "not_found" } });
      }
      expect(await readSession(evidenceId)).toEqual(before);
    });

    it("3b. a MEMBER of the workspace (not OWNER/ADMIN) is refused, no state change", async () => {
      const { evidenceId } = await seedSession(orgA);
      const before = await readSession(evidenceId);

      for (const url of [MARK_ABANDONED(evidenceId), REQUEST_REVIEW(evidenceId)]) {
        const res = await post({
          url,
          token: memberA.token,
          payload: { teamId: orgA.workspaceId },
        });
        // MEASURED: 404. The legacy MEMBER role maps onto a canonical role
        // that holds `identity.org_policy.read`, so — exactly as for the
        // viewer — it is `requireAdminMember`'s OWNER/ADMIN check that
        // refuses, not the permission gate. Pinned to the one code the route
        // was written to give every non-admin.
        expect(res.statusCode, `${url} member`).toBe(404);
        expect(res.json()).toEqual({ error: { code: "not_found" } });
      }
      expect(await readSession(evidenceId)).toEqual(before);
    });

    it("4. cross-workspace probe: OWNER of B names A's evidenceId with teamId=B → 404, no state change", async () => {
      const { evidenceId } = await seedSession(orgA);
      const before = await readSession(evidenceId);

      for (const url of [MARK_ABANDONED(evidenceId), REQUEST_REVIEW(evidenceId)]) {
        const res = await post({
          url,
          token: orgB.owner.token,
          // B's owner IS an admin of B; the gate admits them for B. The
          // session belongs to A, so the route's ownership check must refuse.
          payload: { teamId: orgB.workspaceId },
        });
        expect(res.statusCode, `${url} cross-workspace`).toBe(404);
        expect(res.json()).toEqual({ error: { code: "not_found" } });
      }
      expect(await readSession(evidenceId)).toEqual(before);
    });

    it("4b. an OWNER of A cannot reach a session by naming a workspace they do not belong to", async () => {
      // The mirror probe: A's owner names B as the workspace. The gate refuses
      // at membership (404) before the session is even looked up. Uses one of
      // B's pre-seeded sessions so B's baseline count is not disturbed.
      const { evidenceId } = orgBSessions[0]!;
      const before = await readSession(evidenceId);
      const res = await post({
        url: MARK_ABANDONED(evidenceId),
        token: orgA.owner.token,
        payload: { teamId: orgB.workspaceId },
      });
      expect(res.statusCode).toBe(404);
      expect(await readSession(evidenceId)).toEqual(before);
    });
  });

  // =========================================================================
  // Happy paths, with exact before/after rows.
  // =========================================================================

  describe("OWNER of the owning workspace", () => {
    it("5. mark-abandoned → 200, session ABANDONED, abandonedAtUtc set, reason names the actor", async () => {
      const { evidenceId } = await seedSession(orgA);
      const before = await readSession(evidenceId);
      expect(before.status).toBe(SEED_STATUS);
      expect(before.abandonedAtUtc).toBeNull();
      expect(before.failureReason).toBeNull();

      const res = await post({
        url: MARK_ABANDONED(evidenceId),
        token: orgA.owner.token,
        payload: { teamId: orgA.workspaceId },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { session: Record<string, unknown> };
      expect(body.session.status).toBe("ABANDONED");
      expect(body.session.evidenceId).toBe(evidenceId);
      expect(body.session.teamId).toBe(orgA.workspaceId);
      expect(body.session.isTerminal).toBe(true);
      expect(typeof body.session.abandonedAtUtc).toBe("string");
      // The reserved column is deliberately not projected.
      expect(body.session).not.toHaveProperty("multipartUploadId");

      const after = await readSession(evidenceId);
      expect(after.status).toBe("ABANDONED");
      expect(after.abandonedAtUtc).not.toBeNull();
      expect(after.abandonedAtUtc!.getTime()).toBeGreaterThanOrEqual(
        before.lastActivityAtUtc.getTime(),
      );
      expect(after.lastActivityAtUtc.getTime()).toBeGreaterThan(
        before.lastActivityAtUtc.getTime(),
      );
      expect(after.failureReason).toBe(
        `marked_abandoned_by_user:${orgA.owner.userId}`,
      );
      // Columns the transition must NOT touch.
      expect(after.stalledAtUtc).toBeNull();
      expect(after.completedAtUtc).toBeNull();
      expect(after.retryCount).toBe(before.retryCount);
      // The response projected the row that was written.
      expect(body.session.abandonedAtUtc).toBe(after.abandonedAtUtc!.toISOString());
    });

    it("7. request-review → 200, session REVIEW_REQUIRED, DB matches the response", async () => {
      const { evidenceId } = await seedSession(orgA);
      const before = await readSession(evidenceId);
      expect(before.status).toBe(SEED_STATUS);

      const res = await post({
        url: REQUEST_REVIEW(evidenceId),
        token: orgA.owner.token,
        payload: { teamId: orgA.workspaceId },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { session: Record<string, unknown> };
      expect(body.session.status).toBe("REVIEW_REQUIRED");
      // REVIEW_REQUIRED is deliberately NOT terminal — recovery stays possible.
      expect(body.session.isTerminal).toBe(false);

      const after = await readSession(evidenceId);
      expect(after.status).toBe("REVIEW_REQUIRED");
      expect(after.abandonedAtUtc).toBeNull();
      expect(after.stalledAtUtc).toBeNull();
      expect(after.failureReason).toBe(
        `manual_review_request:${orgA.owner.userId}`,
      );
      expect(after.lastActivityAtUtc.getTime()).toBeGreaterThan(
        before.lastActivityAtUtc.getTime(),
      );
      expect(body.session.lastActivityAtUtc).toBe(
        after.lastActivityAtUtc.toISOString(),
      );
    });

    it("8. each successful action leaves a security_events row naming the evidence", async () => {
      const abandoned = await seedSession(orgA);
      const reviewed = await seedSession(orgA);

      expect(
        (
          await post({
            url: MARK_ABANDONED(abandoned.evidenceId),
            token: orgA.owner.token,
            payload: { teamId: orgA.workspaceId },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post({
            url: REQUEST_REVIEW(reviewed.evidenceId),
            token: orgA.owner.token,
            payload: { teamId: orgA.workspaceId },
          })
        ).statusCode,
      ).toBe(200);

      // Model `SecurityEvent` → table `security_events`; columns `eventType`,
      // `severity`, `teamId`, `metadataJson` (Prisma field `details`). The
      // evidence id lives INSIDE `details.evidenceId`.
      const abandonedEvents = await findSecurityEvents(
        "upload_abandoned",
        abandoned.evidenceId,
      );
      expect(abandonedEvents).toHaveLength(1);
      expect(abandonedEvents[0]!.teamId).toBe(orgA.workspaceId);
      expect(abandonedEvents[0]!.severity).toBe("INFO");
      expect(abandonedEvents[0]!.details).toEqual({
        actorUserId: orgA.owner.userId,
        manual: true,
        evidenceId: abandoned.evidenceId,
      });

      const reviewEvents = await findSecurityEvents(
        "recovery_review_required",
        reviewed.evidenceId,
      );
      expect(reviewEvents).toHaveLength(1);
      expect(reviewEvents[0]!.teamId).toBe(orgA.workspaceId);
      expect(reviewEvents[0]!.severity).toBe("WARNING");
      expect(reviewEvents[0]!.details).toEqual({
        actorUserId: orgA.owner.userId,
        manual: true,
        evidenceId: reviewed.evidenceId,
      });

      // Neither action emits the OTHER's event for its evidence.
      expect(
        await findSecurityEvents("recovery_review_required", abandoned.evidenceId, {
          atLeast: 0,
        }),
      ).toHaveLength(0);
      expect(
        await findSecurityEvents("upload_abandoned", reviewed.evidenceId, {
          atLeast: 0,
        }),
      ).toHaveLength(0);
    });
  });

  // =========================================================================
  // Repeat submission and a genuinely disallowed transition.
  // =========================================================================

  describe("repeat submission (double-click) and disallowed transitions", () => {
    it("6. the SAME mark-abandoned submitted twice → second answers 409, row and events untouched", async () => {
      const { evidenceId } = await seedSession(orgA);
      const first = await post({
        url: MARK_ABANDONED(evidenceId),
        token: orgA.owner.token,
        payload: { teamId: orgA.workspaceId },
      });
      expect(first.statusCode).toBe(200);
      const afterFirst = await readSession(evidenceId);
      expect(afterFirst.status).toBe("ABANDONED");
      const firstEvents = await findSecurityEvents("upload_abandoned", evidenceId);
      expect(firstEvents).toHaveLength(1);

      // Guarantee a later clock tick so a rewritten timestamp WOULD be
      // detectable — the assertion below is that it is not rewritten.
      await new Promise((r) => setTimeout(r, 15));

      const second = await post({
        url: MARK_ABANDONED(evidenceId),
        token: orgA.owner.token,
        payload: { teamId: orgA.workspaceId },
      });

      // The matrix allows ABANDONED → ABANDONED as a heartbeat self-noop, so
      // the refusal here comes from `exclusive: true` in
      // `operatorMarkAbandoned`, which makes the authority return null for a
      // self-transition; the route turns that into 409. Before that flag
      // existed this exact request answered 200, re-stamped `abandonedAtUtc`
      // and emitted a second event — so every one of these is asserted.
      expect(second.statusCode, second.body).toBe(409);
      expect(second.json()).toEqual({ error: { code: "transition_not_allowed" } });
      const afterSecond = await readSession(evidenceId);
      expect(afterSecond).toEqual(afterFirst);
      expect(afterSecond.status).toBe("ABANDONED");

      // Exactly one event, and still the one the first click wrote. The poll
      // asks for two so a late-arriving duplicate would be caught, not missed.
      const secondEvents = await findSecurityEvents("upload_abandoned", evidenceId, {
        atLeast: 2,
      deadlineMs: NO_DUPLICATE_WINDOW_MS,
      });
      expect(secondEvents).toHaveLength(1);
      expect(secondEvents[0]!.id).toBe(firstEvents[0]!.id);
    });

    it("6a. the SAME request-review submitted twice → second answers 409, row and events untouched", async () => {
      const { evidenceId } = await seedSession(orgA);
      expect(
        (
          await post({
            url: REQUEST_REVIEW(evidenceId),
            token: orgA.owner.token,
            payload: { teamId: orgA.workspaceId },
          })
        ).statusCode,
      ).toBe(200);
      const afterFirst = await readSession(evidenceId);
      expect(afterFirst.status).toBe("REVIEW_REQUIRED");
      await new Promise((r) => setTimeout(r, 15));

      const second = await post({
        url: REQUEST_REVIEW(evidenceId),
        token: orgA.owner.token,
        payload: { teamId: orgA.workspaceId },
      });
      expect(second.statusCode, second.body).toBe(409);
      expect(second.json()).toEqual({ error: { code: "transition_not_allowed" } });
      expect(await readSession(evidenceId)).toEqual(afterFirst);
      expect(
        await findSecurityEvents("recovery_review_required", evidenceId, {
          atLeast: 2,
        deadlineMs: NO_DUPLICATE_WINDOW_MS,
        }),
      ).toHaveLength(1);
    });

    it("6b. a genuinely disallowed transition → 409 transition_not_allowed and the row is unchanged", async () => {
      // ABANDONED is terminal: the matrix lists NO successor, so
      // request-review on an abandoned session is the real 409 path.
      const { evidenceId } = await seedSession(orgA);
      expect(
        (
          await post({
            url: MARK_ABANDONED(evidenceId),
            token: orgA.owner.token,
            payload: { teamId: orgA.workspaceId },
          })
        ).statusCode,
      ).toBe(200);
      const before = await readSession(evidenceId);
      expect(before.status).toBe("ABANDONED");

      const res = await post({
        url: REQUEST_REVIEW(evidenceId),
        token: orgA.owner.token,
        payload: { teamId: orgA.workspaceId },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({ error: { code: "transition_not_allowed" } });
      expect(await readSession(evidenceId)).toEqual(before);
      expect(
        await findSecurityEvents("recovery_review_required", evidenceId, {
          atLeast: 0,
        }),
      ).toHaveLength(0);
    });

    it("6c. mark-abandoned AFTER request-review is allowed (REVIEW_REQUIRED → ABANDONED)", async () => {
      // The operator's realistic two-step: flag for review, then give up.
      const { evidenceId } = await seedSession(orgA);
      expect(
        (
          await post({
            url: REQUEST_REVIEW(evidenceId),
            token: orgA.owner.token,
            payload: { teamId: orgA.workspaceId },
          })
        ).statusCode,
      ).toBe(200);
      const res = await post({
        url: MARK_ABANDONED(evidenceId),
        token: orgA.owner.token,
        payload: { teamId: orgA.workspaceId },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await readSession(evidenceId)).status).toBe("ABANDONED");
    });
  });

  // =========================================================================
  // Concurrency.
  // =========================================================================

  describe("concurrency", () => {
    it("10. two concurrent mark-abandoned requests on one fresh session → exactly one 200 and one 409, one event", async () => {
      const { evidenceId } = await seedSession(orgA);
      const before = await readSession(evidenceId);

      const [a, b] = await Promise.all([
        post({
          url: MARK_ABANDONED(evidenceId),
          token: orgA.owner.token,
          payload: { teamId: orgA.workspaceId },
        }),
        post({
          url: MARK_ABANDONED(evidenceId),
          token: orgA.owner.token,
          payload: { teamId: orgA.workspaceId },
        }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();

      // `app.inject` dispatches both requests on the same event loop; each
      // handler awaits several database round-trips, so the two genuinely
      // interleave and the row-level guard `updateMany where status = from`
      // decides. Whichever way they interleave, the loser is refused:
      //   - if its first read still saw UPLOADING, its guarded UPDATE matches
      //     zero rows and `exclusive` turns the lost race into null;
      //   - if its first read already saw ABANDONED, it is the self-transition
      //     of case 6 and `exclusive` refuses that too.
      // Either way exactly one request writes, one answers 200, one 409, and
      // one `upload_abandoned` event exists. Before `exclusive`, this same
      // pair measured [200, 200] with up to two events.
      expect(codes).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? a : b;
      const loser = a.statusCode === 200 ? b : a;
      expect((winner.json() as { session: { status: string } }).session.status).toBe(
        "ABANDONED",
      );
      expect(loser.json()).toEqual({ error: { code: "transition_not_allowed" } });

      const after = await readSession(evidenceId);
      expect(after.status).toBe("ABANDONED");
      expect(after.abandonedAtUtc).not.toBeNull();
      expect(after.failureReason).toBe(
        `marked_abandoned_by_user:${orgA.owner.userId}`,
      );
      expect(after.lastActivityAtUtc.getTime()).toBeGreaterThan(
        before.lastActivityAtUtc.getTime(),
      );
      // The winner's response projected the row that was written — so the
      // loser cannot have re-stamped it afterwards.
      expect(
        (winner.json() as { session: { abandonedAtUtc: string } }).session
          .abandonedAtUtc,
      ).toBe(after.abandonedAtUtc!.toISOString());
      // The row exists exactly once — the race cannot duplicate a session
      // (evidenceId is @unique) and cannot leave it in a third state.
      expect(
        await prisma.uploadSession.count({ where: { evidenceId } }),
      ).toBe(1);
      // Poll for two so a late duplicate from the loser would be caught.
      expect(
        await findSecurityEvents("upload_abandoned", evidenceId, { atLeast: 2, deadlineMs: NO_DUPLICATE_WINDOW_MS }),
      ).toHaveLength(1);
    });
  });

  // =========================================================================
  // Tenant isolation, evaluated LAST so every mutation above has happened.
  // =========================================================================

  describe("tenant isolation", () => {
    it("9. after every action above, workspace B's sessions are exactly as seeded", async () => {
      const now = await countSessionsByStatus(orgB.workspaceId);
      expect(now).toEqual(orgBStatusBaseline);
      // The seeded rows carry no abandonment / review footprint.
      const rows = await prisma.uploadSession.findMany({
        where: { teamId: orgB.workspaceId },
        select: { status: true, abandonedAtUtc: true, failureReason: true },
      });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(row.status).toBe(SEED_STATUS);
        expect(row.abandonedAtUtc).toBeNull();
        expect(row.failureReason).toBeNull();
      }
      // No security event was ever attributed to B.
      expect(
        await prisma.securityEvent.count({
          where: {
            teamId: orgB.workspaceId,
            eventType: { in: ["upload_abandoned", "recovery_review_required"] },
          },
        }),
      ).toBe(0);
    });
  });
});
