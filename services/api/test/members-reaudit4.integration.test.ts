/**
 * MEMBERS RE-AUDIT, FOURTH ROUND — R4-1, R4-2, R4-3, R4-4, R4-6 (live PostgreSQL).
 *
 *   R4-1  Once phase A of an account closure committed (access ended), a
 *         non-hold failure of phase B no longer strands the request in FAILED:
 *         it stays PROCESSING with `anonymisation_retrying`, ONE
 *         `identity.account_closure_waiting` audit (outcome error) records it,
 *         a reaper pass that fails again writes no second row, and once the
 *         cause is gone the reaper completes it (failureCode cleared).
 *         Control: a failure where A rolled back still records FAILED.
 *   R4-6  A legal hold placed after A defers with `legal_hold_deferred`, the
 *         hold's code in blockersJson, ONE waiting audit (outcome denied); a
 *         second pass while held writes nothing new; release → completes.
 *   R4-2  The `all_sessions_revoked` security event of a closure is emitted
 *         after A commits: exactly one per closure, none when A is refused.
 *   R4-3  The ASSIGNED / assigned event of an Operations workflow / incident
 *         assignment is part of the assignment's transaction: a refused event
 *         insert (a real trigger) fails the assignment with ITS error and
 *         commits nothing; control: assignment + exactly one event.
 *   R4-4  Collaboration Team comment create, edit and delete write their audit
 *         inside the mutation's transaction: a refused audit fails the request
 *         and changes nothing; control: 2xx with exactly one audit row.
 *
 * Failure injection is a real PostgreSQL BEFORE INSERT trigger per table,
 * driven by rows in `ra4_fail`; every trigger is dropped in afterAll.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps } from "./point7/product-fixtures.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Inject = Awaited<ReturnType<IntegrationHarness["app"]["inject"]>>;
const WS = "x-proovra-workspace-id";

describe("members re-audit 4 — closure waiting states, post-commit session event, transactional assignment events and comment audits (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let accountClosure: typeof import("../src/services/identity/account-closure.service.js");
  let holds: typeof import("../src/services/governance/legal-hold.service.js");
  let workflows: typeof import("../src/services/observability/workflow.service.js");
  let incidents: typeof import("../src/services/observability/incident.service.js");
  let deps: FixtureDeps;
  const A = () => h.fixtures.teamA;

  const TRIGGERS: Array<[trigger: string, table: string]> = [
    ["ra4_audit_fail_trg", "admin_audit_logs"],
    ["ra4_session_fail_trg", "revoked_sessions"],
    ["ra4_wf_event_fail_trg", "operational_workflow_events"],
    ["ra4_inc_event_fail_trg", "operational_incident_events"],
  ];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    accountClosure = await import("../src/services/identity/account-closure.service.js");
    holds = await import("../src/services/governance/legal-hold.service.js");
    workflows = await import("../src/services/observability/workflow.service.js");
    incidents = await import("../src/services/observability/incident.service.js");
    deps = {
      prisma: prisma as never,
      tag: `ra4-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, process.env.AUTH_JWT_SECRET as string, 3600),
    };
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });

    // Failure-injection seams. `kind` names the table; `key` is matched
    // against the row: audit → action || ':' || resource_id (or action || ':*'
    // for any resource), session → user_id, wf/inc → the parent id.
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ra4_fail (kind text NOT NULL, key text NOT NULL)`);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ra4_audit_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ra4_fail f WHERE f.kind = 'audit'
                    AND (f.key = NEW.action || ':' || COALESCE(NEW.resource_id, '') OR f.key = NEW.action || ':*')) THEN
          RAISE EXCEPTION 'ra4 injected audit failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ra4_session_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ra4_fail f WHERE f.kind = 'session' AND f.key = NEW.user_id::text) THEN
          RAISE EXCEPTION 'ra4 injected session revocation failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ra4_wf_event_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ra4_fail f WHERE f.kind = 'wf_event' AND f.key = NEW.workflow_id::text) THEN
          RAISE EXCEPTION 'ra4 injected workflow event failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ra4_inc_event_fail_fn() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ra4_fail f WHERE f.kind = 'inc_event' AND f.key = NEW.incident_id::text) THEN
          RAISE EXCEPTION 'ra4 injected incident event failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    const fn: Record<string, string> = {
      ra4_audit_fail_trg: "ra4_audit_fail_fn",
      ra4_session_fail_trg: "ra4_session_fail_fn",
      ra4_wf_event_fail_trg: "ra4_wf_event_fail_fn",
      ra4_inc_event_fail_trg: "ra4_inc_event_fail_fn",
    };
    for (const [trigger, table] of TRIGGERS) {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn[trigger]}()`,
      );
    }
  }, 900_000);

  afterAll(async () => {
    if (prisma) {
      for (const [trigger, table] of TRIGGERS) {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`).catch(() => undefined);
      }
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ra4_fail`).catch(() => undefined);
    }
    await h?.cleanup();
  }, 300_000);

  type Kind = "audit" | "session" | "wf_event" | "inc_event";
  async function inject(kind: Kind, key: string): Promise<void> {
    await prisma.$executeRawUnsafe(`INSERT INTO ra4_fail (kind, key) VALUES ($1, $2)`, kind, key);
  }
  async function clearInjections(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM ra4_fail`);
  }
  async function withInjected<T>(kind: Kind, key: string, body: () => Promise<T>): Promise<T> {
    await inject(kind, key);
    try {
      return await body();
    } finally {
      await clearInjections();
    }
  }
  const tag = () => randomUUID().slice(0, 8);

  // ===========================================================================
  // Account closure (R4-1, R4-6, R4-2)
  // ===========================================================================
  const STALE = () => new Date(Date.now() - 2 * 60 * 60 * 1000);
  const processingRequest = (userId: string) =>
    prisma.accountClosureRequest.create({
      data: { userId, status: "PROCESSING", startedAtUtc: STALE() },
      select: { id: true },
    });
  const makeStale = (id: string) =>
    prisma.accountClosureRequest.update({ where: { id }, data: { startedAtUtc: STALE() } });
  /** One reaper pass over this request (made due first). */
  async function reaperPass(requestId: string): Promise<void> {
    await makeStale(requestId);
    await accountClosure.processAccountClosures(new Date());
  }
  const request = (id: string) => prisma.accountClosureRequest.findUniqueOrThrow({ where: { id } });
  const userRow = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
  const auditRows = (action: string, resourceId: string) =>
    prisma.adminAuditLog.findMany({ where: { action, resourceId }, select: { outcome: true } });
  const audits = (action: string, resourceId: string) => prisma.adminAuditLog.count({ where: { action, resourceId } });
  const sessionsRevokedEvents = (userId: string) =>
    prisma.securityEvent.count({
      where: { eventType: "all_sessions_revoked", details: { path: ["subjectUserId"], equals: userId } },
    });
  /** The event is fire-and-forget: wait (bounded) for the dispatched write. */
  const awaitOneSessionsRevokedEvent = (userId: string) =>
    vi.waitFor(
      async () => {
        expect(await sessionsRevokedEvents(userId)).toBe(1);
      },
      { timeout: 10_000, interval: 25 },
    );

  describe("R4-1 / R4-2 — a phase-B failure after A committed retries instead of FAILED", () => {
    it("R4-1: stays PROCESSING with anonymisation_retrying and ONE waiting audit; a failing retry writes none; the reaper completes it once the cause is gone (R4-2: one all_sessions_revoked event)", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const userId = t.owner.userId;
      const req = await processingRequest(userId);

      // B's completion audit is refused for the whole of steps 1 and 2.
      await inject("audit", `identity.account_closure_completed:${req.id}`);
      try {
        // 1. The reaper runs it: A commits, B fails.
        await reaperPass(req.id);
        const afterFirst = await request(req.id);
        expect(afterFirst.status).toBe("PROCESSING");
        expect(afterFirst.failureCode).toBe("anonymisation_retrying");
        expect(afterFirst.completedAtUtc).toBeNull();
        const waiting = await auditRows("identity.account_closure_waiting", req.id);
        expect(waiting).toEqual([{ outcome: "error" }]);
        expect(await audits("identity.account_closure_failed", req.id)).toBe(0);
        const closedUser = await userRow(userId);
        expect(closedUser.providerUserId).toBe(`closed:${userId}`); // A committed
        expect(closedUser.email).not.toBeNull(); // B did not

        // 2. Another reaper pass fails the same way: no second waiting row.
        await reaperPass(req.id);
        const afterSecond = await request(req.id);
        expect(afterSecond.status).toBe("PROCESSING");
        expect(afterSecond.failureCode).toBe("anonymisation_retrying");
        expect(await audits("identity.account_closure_waiting", req.id)).toBe(1);
        expect(await audits("identity.account_closure_failed", req.id)).toBe(0);
      } finally {
        await clearInjections();
      }

      // 3. The cause is gone: the next pass completes it.
      await reaperPass(req.id);
      const done = await request(req.id);
      expect(done.status).toBe("COMPLETED");
      expect(done.failureCode).toBeNull();
      expect((await userRow(userId)).email).toBeNull();
      expect(await audits("identity.account_closure_completed", req.id)).toBe(1);
      expect(await audits("identity.account_closure_waiting", req.id)).toBe(1);
      expect(await audits("identity.account_closure_failed", req.id)).toBe(0);

      // R4-2 — exactly one all_sessions_revoked event for the closure (the
      // resumed passes found access already ended and revoked nothing again).
      await awaitOneSessionsRevokedEvent(userId);
    });

    it("R4-1 control / R4-2 control: when phase A is refused the request records FAILED (no waiting row) and no all_sessions_revoked event is emitted", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const userId = t.owner.userId;
      const req = await processingRequest(userId);

      await withInjected("session", userId, () => reaperPass(req.id));
      const failed = await request(req.id);
      expect(failed.status).toBe("FAILED");
      expect(failed.failureCode).toBe("closure_failed");
      expect(await audits("identity.account_closure_failed", req.id)).toBe(1);
      expect(await audits("identity.account_closure_waiting", req.id)).toBe(0);
      const untouched = await userRow(userId);
      expect(untouched.providerUserId).not.toBe(`closed:${userId}`);
      expect(await prisma.revokedSession.count({ where: { userId, reason: "ACCOUNT_CLOSED" } })).toBe(0);

      // Barrier: a later closure of the same account that does commit A emits
      // its one event. Exactly one then means the refused run emitted none.
      await accountClosure.executeAccountClosure(userId);
      await awaitOneSessionsRevokedEvent(userId);
    });

    it("R5-1: when B fails after A committed AND the 'did A commit?' lookup also fails, the request stays PROCESSING (never FAILED); the next pass completes it", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const userId = t.owner.userId;
      const req = await processingRequest(userId);

      // Only the post-failure lookup selects providerUserId alone on the root
      // client (phase A reads the user through its transaction client).
      const realFindUnique = prisma.user.findUnique.bind(prisma.user);
      let lookupsRefused = 0;
      const spy = vi.spyOn(prisma.user, "findUnique").mockImplementation(((args: {
        where: { id?: string };
        select?: Record<string, unknown>;
      }) => {
        const keys = Object.keys(args.select ?? {});
        if (args.where.id === userId && keys.length === 1 && keys[0] === "providerUserId") {
          lookupsRefused += 1;
          return Promise.reject(new Error("ra4 injected lookup failure"));
        }
        return realFindUnique(args as never);
      }) as never);
      try {
        await withInjected("audit", `identity.account_closure_completed:${req.id}`, () => reaperPass(req.id));
      } finally {
        // Back to pass-through: `mockRestore` cannot reinstate a Prisma model
        // delegate's method (later tests then find none).
        spy.mockImplementation(realFindUnique as never);
      }
      expect(lookupsRefused).toBe(1);
      const stillOpen = await request(req.id);
      expect(stillOpen.status).toBe("PROCESSING");
      expect(stillOpen.completedAtUtc).toBeNull();
      expect(await audits("identity.account_closure_failed", req.id)).toBe(0);
      expect((await userRow(userId)).providerUserId).toBe(`closed:${userId}`); // A committed

      await reaperPass(req.id);
      const done = await request(req.id);
      expect(done.status).toBe("COMPLETED");
      expect((await userRow(userId)).email).toBeNull();
      expect(await audits("identity.account_closure_failed", req.id)).toBe(0);
    });
  });

  describe("R4-6 — a hold placed after A defers visibly, audited once", () => {
    it("R4-6: legal_hold_deferred with the hold's code and ONE denied waiting audit; a second held pass writes none; release → COMPLETED, failureCode cleared", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const userId = t.owner.userId;
      const req = await processingRequest(userId);

      // Phase A commits, phase B fails (its completion audit is refused).
      await withInjected("audit", `identity.account_closure_completed:${req.id}`, async () => {
        await expect(accountClosure.executeAccountClosure(userId, { closureRequestId: req.id })).rejects.toThrow();
      });
      expect((await userRow(userId)).providerUserId).toBe(`closed:${userId}`);

      const hold = (await holds.placeCanonicalLegalHold({
        teamId: t.personalTeamId,
        scope: "WORKSPACE",
        actorUserId: userId,
        title: `ra4 placed mid-closure ${tag()}`,
      } as never)) as { id: string };

      await reaperPass(req.id);
      const held = await request(req.id);
      expect(held.status).toBe("PROCESSING");
      expect(held.failureCode).toBe("legal_hold_deferred");
      const blockers = JSON.parse(held.blockersJson ?? "[]") as Array<{ code: string }>;
      expect(blockers.map((b) => b.code)).toContain("LEGAL_HOLD_ACTIVE");
      expect(await auditRows("identity.account_closure_waiting", req.id)).toEqual([{ outcome: "denied" }]);
      expect(await audits("identity.account_closure_blocked", req.id)).toBe(0);
      expect((await userRow(userId)).email).not.toBeNull(); // the hold governs anonymisation

      // Still held: the next pass writes no new row and changes nothing.
      await reaperPass(req.id);
      const stillHeld = await request(req.id);
      expect(stillHeld.status).toBe("PROCESSING");
      expect(stillHeld.failureCode).toBe("legal_hold_deferred");
      expect(await audits("identity.account_closure_waiting", req.id)).toBe(1);

      // Released: the reaper completes it and the waiting reason is cleared.
      await prisma.evidenceLegalHold.update({ where: { id: hold.id }, data: { status: "RELEASED", releasedAtUtc: new Date() } as never });
      await reaperPass(req.id);
      const done = await request(req.id);
      expect(done.status).toBe("COMPLETED");
      expect(done.failureCode).toBeNull();
      expect((await userRow(userId)).email).toBeNull();
      expect(await audits("identity.account_closure_completed", req.id)).toBe(1);
      expect(await audits("identity.account_closure_waiting", req.id)).toBe(1);
    });
  });

  // ===========================================================================
  // R4-3 — the assignment event is part of the assignment transaction
  // ===========================================================================
  describe("R4-3 — an Operations assignment commits with its event or not at all", () => {
    const opsWorkflow = () =>
      prisma.operationalWorkflow.create({
        data: {
          teamId: A().teamId,
          workflowKey: `ra4-${randomUUID()}`,
          workflowType: "REPORT_RETRY",
          title: "Report generation failed",
          safeSummary: "A report job failed and needs another attempt.",
        },
        select: { id: true, status: true },
      });
    const condition = () =>
      prisma.operationalIncident.create({
        data: {
          teamId: A().teamId,
          category: "EVIDENCE_INTEGRITY",
          severity: "HIGH",
          status: "OPEN",
          fingerprint: `ra4:${randomUUID()}`,
          title: "R4-3 condition",
          safeSummary: "Integrity condition seeded for the event atomicity proof.",
        },
        select: { id: true, status: true },
      });

    it("workflow assign: a refused ASSIGNED event fails the assignment with that error and commits nothing; control: assigned with exactly one event and its audit", async () => {
      const wf = await opsWorkflow();
      const assign = () =>
        prisma.$transaction(async (tx) =>
          workflows.assignWorkflow(
            { workflowId: wf.id, teamId: A().teamId, assigneeUserId: A().ownerUserId, actorUserId: A().ownerUserId },
            tx as never,
          ),
        );
      await withInjected("wf_event", wf.id, async () => {
        await expect(assign()).rejects.toThrow(/ra4 injected workflow event failure/);
      });
      const unchanged = await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: wf.id } });
      expect(unchanged.assignedOwnerUserId).toBeNull();
      expect(unchanged.assignedAtUtc).toBeNull();
      expect(unchanged.status).toBe(wf.status);
      expect(await prisma.operationalWorkflowEvent.count({ where: { workflowId: wf.id } })).toBe(0);
      expect(await audits("observability.workflow.assigned", wf.id)).toBe(0);

      await assign();
      const assigned = await prisma.operationalWorkflow.findUniqueOrThrow({ where: { id: wf.id } });
      expect(assigned.assignedOwnerUserId).toBe(A().ownerUserId);
      expect(await prisma.operationalWorkflowEvent.count({ where: { workflowId: wf.id } })).toBe(1);
      expect(await prisma.operationalWorkflowEvent.count({ where: { workflowId: wf.id, eventType: "ASSIGNED" } })).toBe(1);
      expect(await audits("observability.workflow.assigned", wf.id)).toBe(1);
    });

    it("incident assign: a refused assigned event fails the assignment with that error and commits nothing; control: assigned with exactly one event", async () => {
      const inc = await condition();
      const assign = () =>
        incidents.assignIncident({
          incidentId: inc.id,
          teamId: A().teamId,
          assigneeUserId: A().ownerUserId,
          actorUserId: A().ownerUserId,
        });
      await withInjected("inc_event", inc.id, async () => {
        await expect(assign()).rejects.toThrow(/ra4 injected incident event failure/);
      });
      const unchanged = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: inc.id } });
      expect(unchanged.assignedOperatorUserId).toBeNull();
      expect(unchanged.status).toBe(inc.status);
      expect(await prisma.operationalIncidentEvent.count({ where: { incidentId: inc.id } })).toBe(0);
      expect(await audits("observability.incident.assigned", inc.id)).toBe(0);

      const assigned = await assign();
      expect(assigned.assignedOperatorUserId).toBe(A().ownerUserId);
      expect(
        (await prisma.operationalIncident.findUniqueOrThrow({ where: { id: inc.id } })).assignedOperatorUserId,
      ).toBe(A().ownerUserId);
      expect(await prisma.operationalIncidentEvent.count({ where: { incidentId: inc.id } })).toBe(1);
      expect(await prisma.operationalIncidentEvent.count({ where: { incidentId: inc.id, eventType: "assigned" } })).toBe(1);
      expect(await audits("observability.incident.assigned", inc.id)).toBe(1);
    });
  });

  // ===========================================================================
  // R4-4 — Collaboration Team comments audit inside the mutation
  // ===========================================================================
  describe("R4-4 — Collaboration Team comment create, edit and delete never commit without their audit row", () => {
    const base = "/v1/collaboration-teams";
    const send = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
      h.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${A().ownerToken}`, [WS]: A().teamId },
        ...(payload === undefined ? {} : { payload: payload as never }),
      });
    const failed = (res: Inject) => expect(res.statusCode, res.body).toBeGreaterThanOrEqual(500);
    const successAudits = (action: string, resourceId: string) =>
      prisma.adminAuditLog.count({ where: { action, resourceId, outcome: "success" } });

    /** A fresh ACTIVE group led by the workspace owner. */
    async function group(): Promise<string> {
      await prisma.collaborationTeam.updateMany({
        where: { workspaceId: A().teamId, status: "ACTIVE" },
        data: { status: "ARCHIVED", archivedAtUtc: new Date() },
      });
      const res = await send("POST", base, { name: `ra4 group ${tag()}` });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().team.id as string;
    }
    async function comment(teamId: string, body: string): Promise<string> {
      const res = await send("POST", `${base}/${teamId}/comments`, { targetType: "TEAM", body });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().comment.id as string;
    }
    const commentRow = (id: string) =>
      prisma.collaborationTeamComment.findUniqueOrThrow({
        where: { id },
        select: { body: true, status: true, deletedAtUtc: true, deletedByUserId: true },
      });

    it("create — refused audit: 5xx and no comment; control: 201 with exactly one created row", async () => {
      const id = await group();
      const body = `ra4 create ${tag()}`;
      failed(
        await withInjected("audit", "collaboration_team.comment.created:*", () =>
          send("POST", `${base}/${id}/comments`, { targetType: "TEAM", body }),
        ),
      );
      expect(await prisma.collaborationTeamComment.count({ where: { teamId: id } })).toBe(0);

      const commentId = await comment(id, body);
      expect(await prisma.collaborationTeamComment.count({ where: { teamId: id } })).toBe(1);
      expect(await successAudits("collaboration_team.comment.created", commentId)).toBe(1);
    });

    it("edit — refused audit: 5xx and the body and status unchanged; control: 200 with exactly one edited row", async () => {
      const id = await group();
      const commentId = await comment(id, "ra4 original body");
      const before = await commentRow(commentId);
      failed(
        await withInjected("audit", `collaboration_team.comment.edited:${commentId}`, () =>
          send("PATCH", `${base}/${id}/comments/${commentId}`, { body: "ra4 edited body" }),
        ),
      );
      expect(await commentRow(commentId)).toEqual(before);
      expect(await successAudits("collaboration_team.comment.edited", commentId)).toBe(0);

      const ok = await send("PATCH", `${base}/${id}/comments/${commentId}`, { body: "ra4 edited body" });
      expect(ok.statusCode, ok.body).toBe(200);
      const after = await commentRow(commentId);
      expect(after.status).toBe("EDITED");
      expect(after.body).toContain("ra4 edited body");
      expect(await successAudits("collaboration_team.comment.edited", commentId)).toBe(1);
    });

    it("delete — refused audit: 5xx and the comment still ACTIVE; control: 200, DELETED, exactly one deleted row", async () => {
      const id = await group();
      const commentId = await comment(id, "ra4 to be deleted");
      failed(
        await withInjected("audit", `collaboration_team.comment.deleted:${commentId}`, () =>
          send("DELETE", `${base}/${id}/comments/${commentId}`),
        ),
      );
      expect(await commentRow(commentId)).toMatchObject({ status: "ACTIVE", deletedAtUtc: null, deletedByUserId: null });
      expect(await successAudits("collaboration_team.comment.deleted", commentId)).toBe(0);

      const ok = await send("DELETE", `${base}/${id}/comments/${commentId}`);
      expect(ok.statusCode, ok.body).toBe(200);
      const after = await commentRow(commentId);
      expect(after.status).toBe("DELETED");
      expect(after.deletedByUserId).toBe(A().ownerUserId);
      expect(await successAudits("collaboration_team.comment.deleted", commentId)).toBe(1);
    });
  });
});
