/**
 * PLATFORM ADMIN — COMMERCIAL REQUEST STATUS TRANSITIONS, executed against
 * live PostgreSQL 16 through the real Fastify app.
 *
 *   PATCH /v1/admin/contact-sales/:id   services/api/src/routes/admin-contact-sales.routes.ts
 *   PATCH /v1/admin/demo-requests/:id   services/api/src/routes/admin-demo-requests.routes.ts
 *
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * Two operators triaging the same inbound queue is the normal case, not the
 * edge case. Before the transition contract, the PATCH handlers accepted ANY
 * status for ANY row and wrote it with a plain `update`, so:
 *
 *   - the second click always won, silently. Operator A rejected a request;
 *     operator B, still looking at a tab that said NEW, clicked "contacted" and
 *     reopened it. Nobody was told, nothing was logged as a conflict.
 *   - a double-click on the same button was two writes, the second stamping
 *     over the first's `reviewedAt`.
 *   - ARCHIVED → NEW was a click away, because no table anywhere said which
 *     moves exist.
 *
 * The contract now under test, shared by both routes through
 * `@proovra/shared` `COMMERCIAL_REQUEST_TRANSITIONS`:
 *
 *   1. a status change must be an edge in the table, else 409
 *      `transition_not_allowed` and the row is untouched;
 *   2. `expectedStatus`, when sent, must equal the row's current status, else
 *      409 `stale_status` and the row is untouched;
 *   3. the write is a compare-and-set on the status the transition was
 *      validated against, so of two overlapping saves exactly one lands;
 *   4. every refusal AND every success is a platform audit row.
 *
 * Every case reads the row from the database BEFORE and AFTER the request.
 * The response body is evidence of what the handler SAID; the row is evidence
 * of what it DID, and the two are asserted separately.
 *
 * WHAT THE HARNESS GUARANTEES FOR THE CONCURRENCY CASE
 * ---------------------------------------------------------------------------
 * `app.inject` (light-my-request) runs the full request pipeline in-process
 * without a socket. Two injects fired under `Promise.all` are two independent
 * async chains that interleave at every `await` — in particular at the
 * handler's initial `findUnique`, so both can observe the row as NEW before
 * either writes. That is the race the compare-and-set exists for, and the
 * assertion is written so it holds whether or not the interleaving actually
 * happens on a given run: if the two do overlap, the CAS rejects the loser
 * (`updateMany` count 0); if they happen to serialise, the loser's
 * `expectedStatus` no longer matches and the stale check rejects it. Either
 * way the contract is "exactly one winner, and the row holds the winner's
 * status", which is what is asserted.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedUser,
  registerSessionForToken,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

type Status = "NEW" | "REVIEWED" | "CONTACTED" | "QUALIFIED" | "REJECTED" | "ARCHIVED";

type PatchBody = {
  status?: Status;
  priority?: "LOW" | "NORMAL" | "HIGH";
  notes?: string | null;
  expectedStatus?: Status;
  followUpStatus?: "ACTIVE" | "PAUSED" | "COMPLETED" | "REPLIED" | "STOPPED";
  nextFollowUpAt?: string | null;
};

type ErrorBody = {
  error: { code: string; message: string; requestId: string; details: Record<string, unknown> };
};

const CONTACT_SALES_ACTION = "ADMIN_CONTACT_SALES_UPDATE";
const DEMO_REQUEST_ACTION = "admin.demo_requests.update";

describe("PLATFORM ADMIN — commercial request status transitions (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let secret: string;
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];

  /** An ordinary authenticated user with no platform role. */
  let normalUser: SeededUser;
  /** A genuine platform admin (`User.platformRole = 'admin'`). */
  let platformAdmin: SeededUser;

  const tag = `adm-cr-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const seededContactIds: string[] = [];
  const seededDemoIds: string[] = [];

  /**
   * Mint a token the way `auth.routes.ts#jwtPayloadFromUser` does, including
   * the `role: "admin"` claim for an admin. The gate reads the DB role on
   * every request; the claim is reproduced only so the token shape matches
   * production.
   */
  function mintTokenWithRole(userId: string, email: string, role: "admin" | null): string {
    return signJwt(
      {
        sub: userId,
        provider: "EMAIL",
        email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
        ...(role === "admin" ? { role: "admin" as const } : {}),
      },
      secret,
      60 * 60,
    );
  }

  async function patch(
    url: string,
    payload: PatchBody,
    token: string | null = platformAdmin.token,
  ): Promise<{ statusCode: number; json: () => unknown }> {
    const res = await harness.app.inject({
      method: "PATCH",
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      payload,
    });
    return { statusCode: res.statusCode, json: () => JSON.parse(res.body) as unknown };
  }

  const patchContact = (id: string, body: PatchBody, token?: string | null) =>
    patch(`/v1/admin/contact-sales/${id}`, body, token);
  const patchDemo = (id: string, body: PatchBody, token?: string | null) =>
    patch(`/v1/admin/demo-requests/${id}`, body, token);

  // ── Seeding (fresh ids + tagged emails, so runs never collide) ───────────

  async function seedContact(status: Status = "NEW") {
    const id = randomUUID();
    seededContactIds.push(id);
    return prisma.contactSalesRequest.create({
      data: {
        id,
        fullName: "Sam Transition",
        workEmail: `sam-${tag}-${id.slice(0, 8)}@fixture-sales.local`,
        organization: "Fixture Sales GmbH",
        jobTitle: "CTO",
        country: "DE",
        teamSize: "51-200",
        discussionTopic: "ENTERPRISE_PRICING",
        stage: "EVALUATING",
        currentChallenge: "Our current evidence store cannot prove when a photograph was taken.",
        deploymentTimeline: "THIS_QUARTER",
        estimatedUsers: "50-100",
        source: "integration-transitions",
        status,
      },
    });
  }

  async function seedDemo(status: Status = "NEW", extra: Record<string, unknown> = {}) {
    const id = randomUUID();
    seededDemoIds.push(id);
    return prisma.demoRequest.create({
      data: {
        id,
        fullName: "Dana Transition",
        workEmail: `dana-${tag}-${id.slice(0, 8)}@fixture-demo.local`,
        organization: "Fixture Demo Co",
        jobTitle: "Head of Legal Operations",
        country: "PT",
        teamSize: "11-50",
        useCase: "Evaluating chain-of-custody evidence capture for insurance disputes.",
        message: "Interested in the verification package format.",
        source: "integration-transitions",
        status,
        ...extra,
      },
    });
  }

  const readContact = (id: string) =>
    prisma.contactSalesRequest.findUniqueOrThrow({ where: { id } });
  const readDemo = (id: string) => prisma.demoRequest.findUniqueOrThrow({ where: { id } });

  // ── Audit (platform audit rows land in admin_audit_logs) ─────────────────

  type AuditRow = {
    userId: string | null;
    outcome: string | null;
    metadata: Record<string, unknown>;
    // PHASE 5 — the identity and transition contract, read back from the row
    // rather than from the handler that wrote it.
    actorType: string | null;
    actorDisplay: string | null;
    actorAuthority: string | null;
    targetDisplay: string | null;
    previousState: string | null;
    requestedState: string | null;
    resultingState: string | null;
    reasonCode: string | null;
    eventVersion: number | null;
    requestId: string | null;
  };

  async function auditRows(
    action: string,
    resourceId: string,
    outcome: "success" | "denied" | "no_op",
  ) {
    const rows = await prisma.adminAuditLog.findMany({
      where: { action, resourceId, outcome },
      orderBy: { createdAt: "asc" },
      select: {
        userId: true,
        outcome: true,
        metadata: true,
        actorType: true,
        actorDisplay: true,
        actorAuthority: true,
        targetDisplay: true,
        previousState: true,
        requestedState: true,
        resultingState: true,
        reasonCode: true,
        eventVersion: true,
        requestId: true,
      },
    });
    return rows as AuditRow[];
  }

  /**
   * The demo-requests success audit is `void`-ed (fire-and-forget), so the
   * response can return before the row is committed. Poll briefly rather
   * than sleep; the contact-sales handler awaits its audit and resolves on
   * the first pass.
   */
  async function waitForAudit(
    action: string,
    resourceId: string,
    outcome: "success" | "denied" | "no_op",
    minCount = 1,
  ): Promise<AuditRow[]> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = await auditRows(action, resourceId, outcome);
      if (rows.length >= minCount) return rows;
      if (Date.now() > deadline) {
        throw new Error(
          `audit row not found within 5s: action=${action} resourceId=${resourceId} outcome=${outcome} (have ${rows.length}, want ${minCount})`,
        );
      }
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
      tag,
      mintToken: (userId, email) => mintTokenWithRole(userId, email, null),
    };

    // `seedUser` mints AND registers the session for its own token; only a
    // re-minted token (the admin claim below) needs a second registration.
    normalUser = await seedUser(deps, "normal");

    platformAdmin = await seedUser(deps, "platform-admin");
    await prisma.user.update({
      where: { id: platformAdmin.userId },
      data: { platformRole: "admin" },
    });
    platformAdmin = {
      ...platformAdmin,
      token: mintTokenWithRole(platformAdmin.userId, platformAdmin.email, "admin"),
    };
    await registerSessionForToken(deps, platformAdmin.userId, platformAdmin.token);
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.adminAuditLog.deleteMany({
        where: { resourceId: { in: [...seededContactIds, ...seededDemoIds] } },
      });
      await prisma.contactSalesRequest.deleteMany({ where: { id: { in: seededContactIds } } });
      await prisma.demoRequest.deleteMany({ where: { id: { in: seededDemoIds } } });
    }
    await harness?.cleanup();
  });

  // =========================================================================
  // PATCH /v1/admin/contact-sales/:id
  // =========================================================================

  describe("PATCH /v1/admin/contact-sales/:id", () => {
    it("1. routine edge NEW → REVIEWED succeeds, stamps reviewedAt, audits the transition", async () => {
      const row = await seedContact("NEW");
      expect(row.status).toBe("NEW");
      expect(row.reviewedAt).toBeNull();

      const res = await patchContact(row.id, { status: "REVIEWED" });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
      const body = res.json() as { ok: boolean; data: { id: string; status: string } };
      expect(body.ok).toBe(true);
      expect(body.data.id).toBe(row.id);
      expect(body.data.status).toBe("REVIEWED");

      const after = await readContact(row.id);
      expect(after.status).toBe("REVIEWED");
      expect(after.reviewedAt).not.toBeNull();

      const audits = await waitForAudit(CONTACT_SALES_ACTION, row.id, "success");
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata.transition).toEqual({ from: "NEW", to: "REVIEWED" });
      expect(audits[0].metadata.previous).toEqual({ status: "NEW", priority: "NORMAL" });
      expect(audits[0].metadata.next).toEqual({ status: "REVIEWED", priority: "NORMAL" });
      expect(await auditRows(CONTACT_SALES_ACTION, row.id, "denied")).toHaveLength(0);
    });

    it("2. disallowed edge NEW → QUALIFIED is refused 409 transition_not_allowed and audited as denied", async () => {
      const row = await seedContact("NEW");

      const res = await patchContact(row.id, { status: "QUALIFIED" });
      expect(res.statusCode).toBe(409);
      const body = res.json() as ErrorBody;
      expect(body.error.code).toBe("transition_not_allowed");
      expect(body.error.details).toEqual({ from: "NEW", to: "QUALIFIED" });

      const after = await readContact(row.id);
      expect(after.status).toBe("NEW");
      expect(after.reviewedAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());

      const denied = await waitForAudit(CONTACT_SALES_ACTION, row.id, "denied");
      expect(denied).toHaveLength(1);
      expect(denied[0].metadata.reason).toBe("transition_not_allowed");
      expect(denied[0].metadata.from).toBe("NEW");
      expect(denied[0].metadata.to).toBe("QUALIFIED");
      expect(await auditRows(CONTACT_SALES_ACTION, row.id, "success")).toHaveLength(0);
    });

    it("3. a terminal state is left only through its reopen edge: REJECTED → QUALIFIED refused, REJECTED → REVIEWED allowed", async () => {
      const row = await seedContact("REJECTED");

      const refused = await patchContact(row.id, { status: "QUALIFIED" });
      expect(refused.statusCode).toBe(409);
      expect((refused.json() as ErrorBody).error.code).toBe("transition_not_allowed");
      expect((refused.json() as ErrorBody).error.details).toEqual({
        from: "REJECTED",
        to: "QUALIFIED",
      });
      expect((await readContact(row.id)).status).toBe("REJECTED");

      const reopened = await patchContact(row.id, { status: "REVIEWED" });
      expect(reopened.statusCode, JSON.stringify(reopened.json())).toBe(200);
      const after = await readContact(row.id);
      expect(after.status).toBe("REVIEWED");
      expect(after.reviewedAt).not.toBeNull();

      const success = await waitForAudit(CONTACT_SALES_ACTION, row.id, "success");
      expect(success).toHaveLength(1);
      expect(success[0].metadata.transition).toEqual({ from: "REJECTED", to: "REVIEWED" });
      expect(await auditRows(CONTACT_SALES_ACTION, row.id, "denied")).toHaveLength(1);
    });

    it("4. NEW is never a destination: REVIEWED → NEW refused 409", async () => {
      const row = await seedContact("REVIEWED");

      const res = await patchContact(row.id, { status: "NEW" });
      expect(res.statusCode).toBe(409);
      expect((res.json() as ErrorBody).error.code).toBe("transition_not_allowed");
      expect((res.json() as ErrorBody).error.details).toEqual({ from: "REVIEWED", to: "NEW" });

      const after = await readContact(row.id);
      expect(after.status).toBe("REVIEWED");
      expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());
      expect(await auditRows(CONTACT_SALES_ACTION, row.id, "success")).toHaveLength(0);
    });

    it("5. a stale view is refused: expectedStatus CONTACTED against a NEW row → 409 stale_status", async () => {
      const row = await seedContact("NEW");

      const res = await patchContact(row.id, { status: "REVIEWED", expectedStatus: "CONTACTED" });
      expect(res.statusCode).toBe(409);
      const body = res.json() as ErrorBody;
      expect(body.error.code).toBe("stale_status");
      expect(body.error.details).toEqual({ expected: "CONTACTED", actual: "NEW" });

      const after = await readContact(row.id);
      expect(after.status).toBe("NEW");
      expect(after.reviewedAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());

      const denied = await waitForAudit(CONTACT_SALES_ACTION, row.id, "denied");
      expect(denied).toHaveLength(1);
      expect(denied[0].metadata.reason).toBe("stale_status");
      expect(denied[0].metadata.expected).toBe("CONTACTED");
      expect(denied[0].metadata.actual).toBe("NEW");
    });

    it("6. a double submit lands once: the same {REVIEWED, expectedStatus NEW} twice → 200 then 409 stale_status, timestamps do not move", async () => {
      const row = await seedContact("NEW");
      const body: PatchBody = { status: "REVIEWED", expectedStatus: "NEW" };

      const first = await patchContact(row.id, body);
      expect(first.statusCode, JSON.stringify(first.json())).toBe(200);
      const afterFirst = await readContact(row.id);
      expect(afterFirst.status).toBe("REVIEWED");
      expect(afterFirst.reviewedAt).not.toBeNull();

      const second = await patchContact(row.id, body);
      expect(second.statusCode).toBe(409);
      expect((second.json() as ErrorBody).error.code).toBe("stale_status");
      expect((second.json() as ErrorBody).error.details).toEqual({
        expected: "NEW",
        actual: "REVIEWED",
      });

      const afterSecond = await readContact(row.id);
      expect(afterSecond.status).toBe("REVIEWED");
      expect(afterSecond.reviewedAt!.getTime()).toBe(afterFirst.reviewedAt!.getTime());
      expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());

      expect(await waitForAudit(CONTACT_SALES_ACTION, row.id, "success")).toHaveLength(1);
      expect(await waitForAudit(CONTACT_SALES_ACTION, row.id, "denied")).toHaveLength(1);
    });

    it("7. two concurrent allowed moves from NEW: exactly one wins, the row holds the winner's status", async () => {
      const row = await seedContact("NEW");

      const [a, b] = await Promise.all([
        patchContact(row.id, { status: "REVIEWED", expectedStatus: "NEW" }),
        patchContact(row.id, { status: "CONTACTED", expectedStatus: "NEW" }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes, `a=${JSON.stringify(a.json())} b=${JSON.stringify(b.json())}`).toEqual([
        200, 409,
      ]);

      const winner = a.statusCode === 200 ? a : b;
      const loser = a.statusCode === 200 ? b : a;
      const winnerStatus = (winner.json() as { data: { status: string } }).data.status;
      expect(["REVIEWED", "CONTACTED"]).toContain(winnerStatus);
      expect((loser.json() as ErrorBody).error.code).toBe("stale_status");

      const after = await readContact(row.id);
      expect(after.status).toBe(winnerStatus);
      expect(after.reviewedAt).not.toBeNull();

      expect(await waitForAudit(CONTACT_SALES_ACTION, row.id, "success")).toHaveLength(1);
      expect(await waitForAudit(CONTACT_SALES_ACTION, row.id, "denied")).toHaveLength(1);
    });

    it("8. a priority/notes-only PATCH succeeds without stamping a transition (reviewedAt stays null)", async () => {
      // The handler only builds `reviewed` when `to !== null`, i.e. when a
      // DIFFERENT status was sent. No status → no transition → no stamp, and
      // the success audit carries no `transition` key.
      const row = await seedContact("NEW");

      const res = await patchContact(row.id, { priority: "HIGH", notes: "call back Monday" });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
      const body = res.json() as { ok: boolean; data: { status: string; priority: string; notes: string | null } };
      expect(body.data.status).toBe("NEW");
      expect(body.data.priority).toBe("HIGH");
      expect(body.data.notes).toBe("call back Monday");

      const after = await readContact(row.id);
      expect(after.status).toBe("NEW");
      expect(after.priority).toBe("HIGH");
      expect(after.notes).toBe("call back Monday");
      expect(after.reviewedAt).toBeNull();
      expect(after.reviewedByUserId).toBeNull();

      const success = await waitForAudit(CONTACT_SALES_ACTION, row.id, "success");
      expect(success).toHaveLength(1);
      expect(success[0].metadata).not.toHaveProperty("transition");
      expect(success[0].metadata.previous).toEqual({ status: "NEW", priority: "NORMAL" });
      expect(success[0].metadata.next).toEqual({ status: "NEW", priority: "HIGH" });
    });

    it("9. anonymous → 401 and a non-admin user → 403; the row is untouched and nothing is audited", async () => {
      const row = await seedContact("NEW");

      const anon = await patchContact(row.id, { status: "REVIEWED" }, null);
      expect(anon.statusCode).toBe(401);

      const nonAdmin = await patchContact(row.id, { status: "REVIEWED" }, normalUser.token);
      expect(nonAdmin.statusCode).toBe(403);

      const after = await readContact(row.id);
      expect(after.status).toBe("NEW");
      expect(after.reviewedAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());
      expect(await auditRows(CONTACT_SALES_ACTION, row.id, "success")).toHaveLength(0);
      expect(await auditRows(CONTACT_SALES_ACTION, row.id, "denied")).toHaveLength(0);
    });

    it("attributes a successful transition to the operator (reviewedByUserId + audit actor)", async () => {
      // A reviewed request must say WHO reviewed it, and the audit row must
      // name the actor — that is the entire point of the audit. This is a
      // separate case so the transition contract above stands on its own.
      //
      // This case caught a real defect on first run: the handler read
      // `req.userId`, which nothing in the pipeline ever assigns (`requireAuth`
      // populates `req.user.sub`), so every reviewedByUserId and audit actor
      // on this route was null. The handler now reads `req.user?.sub`; this
      // case is what stops that regressing.
      const row = await seedContact("NEW");

      const res = await patchContact(row.id, { status: "REVIEWED" });
      expect(res.statusCode).toBe(200);

      const after = await readContact(row.id);
      expect(after.reviewedByUserId).toBe(platformAdmin.userId);

      const success = await waitForAudit(CONTACT_SALES_ACTION, row.id, "success");
      expect(success[0].userId).toBe(platformAdmin.userId);
    });
  });

  // =========================================================================
  // PATCH /v1/admin/demo-requests/:id
  // =========================================================================

  describe("PATCH /v1/admin/demo-requests/:id", () => {
    it("1. routine edge NEW → REVIEWED succeeds, stamps reviewedAt, audits previous/next status", async () => {
      const row = await seedDemo("NEW");
      expect(row.status).toBe("NEW");
      expect(row.reviewedAt).toBeNull();

      const res = await patchDemo(row.id, { status: "REVIEWED" });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
      const body = res.json() as { ok: boolean; item: { id: string; status: string } };
      expect(body.ok).toBe(true);
      expect(body.item.id).toBe(row.id);
      expect(body.item.status).toBe("REVIEWED");

      const after = await readDemo(row.id);
      expect(after.status).toBe("REVIEWED");
      expect(after.reviewedAt).not.toBeNull();
      expect(after.reviewedByUserId).toBe(platformAdmin.userId);

      const audits = await waitForAudit(DEMO_REQUEST_ACTION, row.id, "success");
      expect(audits).toHaveLength(1);
      expect(audits[0].userId).toBe(platformAdmin.userId);
      expect(audits[0].metadata.previousStatus).toBe("NEW");
      expect(audits[0].metadata.nextStatus).toBe("REVIEWED");
      expect(await auditRows(DEMO_REQUEST_ACTION, row.id, "denied")).toHaveLength(0);
    });

    it("2. disallowed edge NEW → QUALIFIED is refused 409 transition_not_allowed and audited as denied", async () => {
      const row = await seedDemo("NEW");

      const res = await patchDemo(row.id, { status: "QUALIFIED" });
      expect(res.statusCode).toBe(409);
      const body = res.json() as ErrorBody;
      expect(body.error.code).toBe("transition_not_allowed");
      expect(body.error.details).toEqual({ from: "NEW", to: "QUALIFIED" });

      const after = await readDemo(row.id);
      expect(after.status).toBe("NEW");
      expect(after.reviewedAt).toBeNull();
      expect(after.followUpStatus).toBe("ACTIVE");
      expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());

      const denied = await waitForAudit(DEMO_REQUEST_ACTION, row.id, "denied");
      expect(denied).toHaveLength(1);
      expect(denied[0].metadata.reason).toBe("transition_not_allowed");
      expect(denied[0].metadata.from).toBe("NEW");
      expect(denied[0].metadata.to).toBe("QUALIFIED");
      expect(await auditRows(DEMO_REQUEST_ACTION, row.id, "success")).toHaveLength(0);
    });

    it("3. a terminal state is left only through its reopen edge: REJECTED → QUALIFIED refused, REJECTED → REVIEWED allowed", async () => {
      const row = await seedDemo("REJECTED", { followUpStatus: "STOPPED" });

      const refused = await patchDemo(row.id, { status: "QUALIFIED" });
      expect(refused.statusCode).toBe(409);
      expect((refused.json() as ErrorBody).error.code).toBe("transition_not_allowed");
      expect((refused.json() as ErrorBody).error.details).toEqual({
        from: "REJECTED",
        to: "QUALIFIED",
      });
      expect((await readDemo(row.id)).status).toBe("REJECTED");

      const reopened = await patchDemo(row.id, { status: "REVIEWED" });
      expect(reopened.statusCode, JSON.stringify(reopened.json())).toBe(200);
      const after = await readDemo(row.id);
      expect(after.status).toBe("REVIEWED");
      expect(after.reviewedAt).not.toBeNull();

      const success = await waitForAudit(DEMO_REQUEST_ACTION, row.id, "success");
      expect(success).toHaveLength(1);
      expect(success[0].metadata.previousStatus).toBe("REJECTED");
      expect(success[0].metadata.nextStatus).toBe("REVIEWED");
      expect(await auditRows(DEMO_REQUEST_ACTION, row.id, "denied")).toHaveLength(1);
    });

    it("4. NEW is never a destination: REVIEWED → NEW refused 409", async () => {
      const row = await seedDemo("REVIEWED");

      const res = await patchDemo(row.id, { status: "NEW" });
      expect(res.statusCode).toBe(409);
      expect((res.json() as ErrorBody).error.code).toBe("transition_not_allowed");
      expect((res.json() as ErrorBody).error.details).toEqual({ from: "REVIEWED", to: "NEW" });

      const after = await readDemo(row.id);
      expect(after.status).toBe("REVIEWED");
      expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());
      expect(await auditRows(DEMO_REQUEST_ACTION, row.id, "success")).toHaveLength(0);
    });

    it("5. a stale view is refused: expectedStatus CONTACTED against a NEW row → 409 stale_status", async () => {
      const row = await seedDemo("NEW");

      const res = await patchDemo(row.id, { status: "REVIEWED", expectedStatus: "CONTACTED" });
      expect(res.statusCode).toBe(409);
      const body = res.json() as ErrorBody;
      expect(body.error.code).toBe("stale_status");
      expect(body.error.details).toEqual({ expected: "CONTACTED", actual: "NEW" });

      const after = await readDemo(row.id);
      expect(after.status).toBe("NEW");
      expect(after.reviewedAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());

      const denied = await waitForAudit(DEMO_REQUEST_ACTION, row.id, "denied");
      expect(denied).toHaveLength(1);
      expect(denied[0].metadata.reason).toBe("stale_status");
      expect(denied[0].metadata.expected).toBe("CONTACTED");
      expect(denied[0].metadata.actual).toBe("NEW");
    });

    it("6. a double submit lands once: the same {REVIEWED, expectedStatus NEW} twice → 200 then 409 stale_status, timestamps do not move", async () => {
      const row = await seedDemo("NEW");
      const body: PatchBody = { status: "REVIEWED", expectedStatus: "NEW" };

      const first = await patchDemo(row.id, body);
      expect(first.statusCode, JSON.stringify(first.json())).toBe(200);
      const afterFirst = await readDemo(row.id);
      expect(afterFirst.status).toBe("REVIEWED");
      expect(afterFirst.reviewedAt).not.toBeNull();

      const second = await patchDemo(row.id, body);
      expect(second.statusCode).toBe(409);
      expect((second.json() as ErrorBody).error.code).toBe("stale_status");
      expect((second.json() as ErrorBody).error.details).toEqual({
        expected: "NEW",
        actual: "REVIEWED",
      });

      const afterSecond = await readDemo(row.id);
      expect(afterSecond.status).toBe("REVIEWED");
      expect(afterSecond.reviewedAt!.getTime()).toBe(afterFirst.reviewedAt!.getTime());
      expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());

      expect(await waitForAudit(DEMO_REQUEST_ACTION, row.id, "success")).toHaveLength(1);
      expect(await waitForAudit(DEMO_REQUEST_ACTION, row.id, "denied")).toHaveLength(1);
    });

    it("7. two concurrent allowed moves from NEW: exactly one wins, the row holds the winner's status", async () => {
      const row = await seedDemo("NEW");

      const [a, b] = await Promise.all([
        patchDemo(row.id, { status: "REVIEWED", expectedStatus: "NEW" }),
        patchDemo(row.id, { status: "CONTACTED", expectedStatus: "NEW" }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes, `a=${JSON.stringify(a.json())} b=${JSON.stringify(b.json())}`).toEqual([
        200, 409,
      ]);

      const winner = a.statusCode === 200 ? a : b;
      const loser = a.statusCode === 200 ? b : a;
      const winnerStatus = (winner.json() as { item: { status: string } }).item.status;
      expect(["REVIEWED", "CONTACTED"]).toContain(winnerStatus);
      expect((loser.json() as ErrorBody).error.code).toBe("stale_status");

      const after = await readDemo(row.id);
      expect(after.status).toBe(winnerStatus);
      expect(after.reviewedAt).not.toBeNull();
      if (winnerStatus === "CONTACTED") {
        expect(after.contactedAt).not.toBeNull();
        expect(after.contactedByUserId).toBe(platformAdmin.userId);
      } else {
        expect(after.contactedAt).toBeNull();
      }

      expect(await waitForAudit(DEMO_REQUEST_ACTION, row.id, "success")).toHaveLength(1);
      expect(await waitForAudit(DEMO_REQUEST_ACTION, row.id, "denied")).toHaveLength(1);
    });

    it("8. a priority/notes-only PATCH succeeds without stamping a transition (reviewedAt stays null)", async () => {
      // `shouldStampReviewed` requires a status in the body; none was sent,
      // so the row keeps status NEW and reviewedAt null. The audit records the
      // unchanged status as previous === next.
      const row = await seedDemo("NEW");

      const res = await patchDemo(row.id, { priority: "HIGH", notes: "call back Monday" });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
      const body = res.json() as { ok: boolean; item: { status: string; priority: string; notes: string | null } };
      expect(body.item.status).toBe("NEW");
      expect(body.item.priority).toBe("HIGH");
      expect(body.item.notes).toBe("call back Monday");

      const after = await readDemo(row.id);
      expect(after.status).toBe("NEW");
      expect(after.priority).toBe("HIGH");
      expect(after.notes).toBe("call back Monday");
      expect(after.reviewedAt).toBeNull();
      expect(after.reviewedByUserId).toBeNull();
      expect(after.followUpStatus).toBe("ACTIVE");

      const success = await waitForAudit(DEMO_REQUEST_ACTION, row.id, "success");
      expect(success).toHaveLength(1);
      expect(success[0].metadata.previousStatus).toBe("NEW");
      expect(success[0].metadata.nextStatus).toBe("NEW");
      expect(success[0].metadata.previousPriority).toBe("NORMAL");
      expect(success[0].metadata.nextPriority).toBe("HIGH");
      expect(success[0].metadata.notesChanged).toBe(true);
    });

    it("9. anonymous → 401 and a non-admin user → 403; the row is untouched and nothing is audited", async () => {
      const row = await seedDemo("NEW");

      const anon = await patchDemo(row.id, { status: "REVIEWED" }, null);
      expect(anon.statusCode).toBe(401);

      const nonAdmin = await patchDemo(row.id, { status: "REVIEWED" }, normalUser.token);
      expect(nonAdmin.statusCode).toBe(403);

      const after = await readDemo(row.id);
      expect(after.status).toBe("NEW");
      expect(after.reviewedAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());
      expect(await auditRows(DEMO_REQUEST_ACTION, row.id, "success")).toHaveLength(0);
      expect(await auditRows(DEMO_REQUEST_ACTION, row.id, "denied")).toHaveLength(0);
    });

    it("10. a terminal move through the CAS path still stops follow-up: REVIEWED → REJECTED sets followUpStatus STOPPED and clears nextFollowUpAt", async () => {
      const scheduled = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const row = await seedDemo("REVIEWED", {
        followUpStatus: "ACTIVE",
        nextFollowUpAt: scheduled,
        reviewedAt: new Date(),
        reviewedByUserId: platformAdmin.userId,
      });
      expect(row.followUpStatus).toBe("ACTIVE");
      expect(row.nextFollowUpAt).not.toBeNull();
      expect(row.followUpStoppedAt).toBeNull();

      const res = await patchDemo(row.id, { status: "REJECTED", expectedStatus: "REVIEWED" });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
      const body = res.json() as {
        item: { status: string; followUpStatus: string; nextFollowUpAt: string | null };
      };
      expect(body.item.status).toBe("REJECTED");
      expect(body.item.followUpStatus).toBe("STOPPED");
      expect(body.item.nextFollowUpAt).toBeNull();

      const after = await readDemo(row.id);
      expect(after.status).toBe("REJECTED");
      expect(after.followUpStatus).toBe("STOPPED");
      expect(after.nextFollowUpAt).toBeNull();
      expect(after.followUpStoppedAt).not.toBeNull();

      const success = await waitForAudit(DEMO_REQUEST_ACTION, row.id, "success");
      expect(success).toHaveLength(1);
      expect(success[0].metadata.previousStatus).toBe("REVIEWED");
      expect(success[0].metadata.nextStatus).toBe("REJECTED");
      expect(success[0].metadata.previousFollowUpStatus).toBe("ACTIVE");
      expect(success[0].metadata.nextFollowUpStatus).toBe("STOPPED");
    });
  });

  // =========================================================================
  // PHASE 5 — WHO ACTED, ON WHAT, FROM WHERE TO WHERE (family A).
  //
  // The transition semantics above are already proven. What was never read
  // back is the ATTRIBUTION on the rows those transitions write: the audit
  // said an update happened and could not say who did it, to which account,
  // or what the record looked like before and after.
  //
  // Each field is checked against a DIFFERENT source, because that is the only
  // way to catch a facade that fabricates a plausible value — the actor
  // against the seeded operator, the target against the seeded record, the
  // previous state against storage read before the call, and the resulting
  // state against storage re-read after it.
  // =========================================================================
  describe("PHASE 5 — attribution on the commercial transition", () => {
    it("a successful transition names the operator, the account, and both real states", async () => {
      const row = await seedContact("NEW");
      const beforeDb = await readContact(row.id);

      const res = await patchContact(row.id, { status: "REVIEWED" });
      expect(res.statusCode).toBe(200);

      const afterDb = await readContact(row.id);
      const [audit] = await waitForAudit(CONTACT_SALES_ACTION, row.id, "success");

      // ACTOR — the authenticated executor, not the target and not a label.
      expect(audit.actorType, "an operator action was not recorded as HUMAN").toBe("HUMAN");
      expect(audit.userId, "the audit names a different user than the caller").toBe(
        platformAdmin.userId,
      );
      expect(audit.actorDisplay, "no contemporaneous actor label was captured").toBeTruthy();
      expect(
        audit.actorDisplay,
        "the raw identifier was stored where a display label belongs",
      ).not.toBe(platformAdmin.userId);
      expect(audit.actorAuthority, "the authority used was not recorded").toBe("PLATFORM_ADMIN");

      // TARGET — the account an operator would recognise, from the seeded row.
      expect(audit.targetDisplay).toBe(beforeDb.organization);

      // STATE — three fields, three sources.
      expect(audit.previousState, "previous state did not come from storage").toBe(
        beforeDb.status,
      );
      expect(audit.requestedState).toBe("REVIEWED");
      expect(
        audit.resultingState,
        "resulting state did not come from storage re-read after the write",
      ).toBe(afterDb.status);
      expect(audit.reasonCode).toBe("OPERATOR_TRANSITION");
      expect(audit.eventVersion).toBe(2);
      expect(
        audit.requestId ?? audit.metadata.correlationId,
        "the operation is not correlatable",
      ).toBeTruthy();
    });

    it("a REFUSED transition records what was asked for and NO resulting state", async () => {
      /*
       * The dangerous shape is a refusal that records the current status as
       * its resulting state: it reads as a successful no-op, so an operator
       * reviewing the log sees a request that was turned down as one that
       * deliberately changed nothing.
       */
      const row = await seedContact("NEW");
      const res = await patchContact(row.id, { status: "QUALIFIED" });
      expect(res.statusCode).toBe(409);

      const [audit] = await waitForAudit(CONTACT_SALES_ACTION, row.id, "denied");
      expect(audit.previousState).toBe("NEW");
      expect(audit.requestedState).toBe("QUALIFIED");
      expect(
        audit.resultingState,
        "a refused transition claimed a resulting state — storage did not change",
      ).toBeNull();
      expect(audit.reasonCode).toBe("transition_not_allowed");
      expect(audit.actorType).toBe("HUMAN");
      expect(audit.userId).toBe(platformAdmin.userId);

      expect((await readContact(row.id)).status).toBe("NEW");
    });

    it("an edit that moves no status says so in the STATE, not by faking an outcome", async () => {
      /*
       * PHASE 5 §4, and the distinction is deliberate.
       *
       * A notes-only PATCH really does change the row, so it is a success —
       * calling it `no_op` would tell an operator looking for "who edited this
       * note" that nothing happened. What must be visible is that no
       * TRANSITION occurred, and that is carried by the state fields:
       * `requestedState` null, and previous equal to resulting.
       *
       * `no_op` is reserved for a request that changed nothing at all, which
       * on this route is a 409 refusal rather than a 200.
       */
      const row = await seedContact("REVIEWED");
      const res = await patchContact(row.id, { notes: "left a voicemail" });
      expect(res.statusCode).toBe(200);

      const [audit] = await waitForAudit(CONTACT_SALES_ACTION, row.id, "success");
      expect(audit.previousState).toBe("REVIEWED");
      expect(
        audit.requestedState,
        "no transition was requested, so none may be recorded as requested",
      ).toBeNull();
      expect(audit.resultingState).toBe("REVIEWED");
      expect(
        audit.previousState,
        "an edit with no transition must read as unchanged, not as a move",
      ).toBe(audit.resultingState);
      expect(audit.reasonCode).toBe("NO_STATUS_CHANGE");
    });

    it("concurrent transitions leave exactly one success and one truthful refusal", async () => {
      /*
       * PHASE 5 §5, over the compare-and-set the transition proof already
       * established. The attribution claim is the new part: the loser must not
       * be recorded as a second success, and the winner's audit must still
       * carry the real before and after.
       */
      const row = await seedContact("NEW");
      const [a, b] = await Promise.all([
        patchContact(row.id, { status: "REVIEWED", expectedStatus: "NEW" }),
        patchContact(row.id, { status: "CONTACTED", expectedStatus: "NEW" }),
      ]);
      expect([a.statusCode, b.statusCode].sort(), "both concurrent transitions were accepted").toEqual([
        200, 409,
      ]);

      const successes = await waitForAudit(CONTACT_SALES_ACTION, row.id, "success");
      expect(
        successes,
        "one persisted transition produced more than one success row",
      ).toHaveLength(1);
      const afterDb = await readContact(row.id);
      expect(successes[0].resultingState).toBe(afterDb.status);
      expect(successes[0].previousState).toBe("NEW");

      const denials = await waitForAudit(CONTACT_SALES_ACTION, row.id, "denied");
      expect(denials.length, "the losing request left no record").toBeGreaterThanOrEqual(1);
      for (const d of denials) {
        expect(d.resultingState, "the losing request claimed a result").toBeNull();
      }
    });
  });
});
