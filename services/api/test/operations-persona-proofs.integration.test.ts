// Database acquisition: bootOps() -> bootIntegrationHarness() (the ONE canonical helper).
/**
 * OPERATIONS PERSONA PROOFS (live PostgreSQL 16 + Redis).
 *
 * One property set per customer persona, proven end to end through the HTTP
 * API (Fastify inject) and read back from the database:
 *
 *   FREE        a Personal FREE workspace has no Operations workbench: the
 *               envelope advertises no OPERATIONS_* capability, the
 *               workbench reads and every mutation are refused with the
 *               canonical code, and the refusal writes nothing.
 *   PAYG        a credit-funded record whose report failed: two CONCURRENT
 *               recovery requests produce ONE durable report request and the
 *               credit ledger is not debited again.
 *   PRO         a Personal (team_id NULL) record's failed report: two
 *               SIMULTANEOUS Operations remediations collapse onto ONE
 *               request row; the second answers with the live work.
 *   TEAM        the role matrix on the wire: who may read, acknowledge,
 *               assign, suppress and resolve; billing guidance requires
 *               billing.manage; only ACTIVE operators are assignable.
 *   ENTERPRISE  the organisation roll-up covers only readable workspaces,
 *               reports an unreadable one as UNKNOWN (never zero), reads the
 *               same operational_incidents rows the canonical writer writes,
 *               and the platform-wide feed is a separate authority a tenant
 *               owner cannot reach.
 *
 * Every row is created with a fresh workspace / user / fingerprint, so no
 * cleanup of another suite's rows is ever needed or attempted.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  bootOps,
  envelopeFor,
  makeUser,
  makeWorkspace,
  personalSpace,
  seedEvidence,
  type Ctx,
} from "./operations-truth-fixtures.js";

describe("Operations persona proofs (live PostgreSQL 16)", () => {
  let c: Ctx;
  let incidents: typeof import("../src/services/observability/incident.service.js");

  beforeAll(async () => {
    c = await bootOps();
    incidents = await import("../src/services/observability/incident.service.js");
  }, 900_000);
  afterAll(async () => {
    await c?.h.cleanup();
  });

  /** A condition written through the canonical writer. */
  async function writeCondition(
    teamId: string,
    o: { sourceId: string; category: string; fingerprint: string; severity?: string; relatedEvidenceId?: string },
  ) {
    const r = await incidents.recordIncident({
      teamId,
      sourceId: o.sourceId,
      category: o.category,
      severity: o.severity ?? "HIGH",
      fingerprint: o.fingerprint,
      title: "persona proof condition",
      safeSummary: "persona proof condition",
      ...(o.relatedEvidenceId ? { relatedEvidenceId: o.relatedEvidenceId } : {}),
    } as never);
    return r.incident;
  }

  /** The record's report failed, as the Worker records it. */
  async function failReport(evidenceId: string) {
    const { recordReportFailureIncident } = await import("../../worker/src/processor.js");
    await recordReportFailureIncident({
      evidenceId,
      jobId: `persona-${randomUUID()}`,
      error: new Error("render failed"),
      severity: "HIGH",
      retriable: false,
    });
    return c.prisma.operationalIncident.findFirstOrThrow({ where: { relatedEvidenceId: evidenceId } });
  }

  /** Spend one evidence credit on the record, as completion does. */
  async function fundWithCredit(userId: string, evidenceId: string) {
    const { consumeEvidenceCreditForCompletion } = await import("../src/services/billing/evidence-credits.service.js");
    await c.prisma.$transaction((tx) => consumeEvidenceCreditForCompletion({ userId, evidenceId }, tx as never));
  }

  async function ledgerFor(userId: string) {
    return c.prisma.evidenceCreditLedgerEntry.findMany({
      where: { userId },
      select: { entryType: true, creditsDelta: true, evidenceId: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async function creditsOf(userId: string) {
    const e = await c.prisma.entitlement.findFirstOrThrow({ where: { userId, active: true }, orderBy: { createdAt: "desc" } });
    return e.credits;
  }

  async function snapshot(id: string) {
    const row = await c.prisma.operationalIncident.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        acknowledgedAtUtc: true,
        acknowledgedByUserId: true,
        assignedOperatorUserId: true,
        resolvedAtUtc: true,
        resolutionNote: true,
        updatedAt: true,
      },
    });
    const events = await c.prisma.operationalIncidentEvent.count({ where: { incidentId: id } });
    return { row, events };
  }

  // ===========================================================================
  // FREE
  // ===========================================================================
  describe("FREE — no Operations workbench", () => {
    it("FREE: the envelope advertises no OPERATIONS_* capability; workbench reads and mutations are refused and write nothing", async () => {
      const u = await makeUser(c, "persona-free", { plan: "FREE" });
      const space = await personalSpace(c, u.id);
      const ev = await seedEvidence(c, null, u.id);
      const cond = await writeCondition(space, {
        sourceId: "pipeline.package_generation_failed",
        category: "PACKAGE",
        fingerprint: `PACKAGE:${ev.id}:v1:UNCLASSIFIED`,
        relatedEvidenceId: ev.id,
      });

      const env = await envelopeFor(c, u.token, space);
      expect(env.status).toBe(200);
      const opsCaps = Object.entries(env.caps).filter(([k, v]) => k.startsWith("OPERATIONS_") && v === true);
      expect(opsCaps).toEqual([]);

      const before = await snapshot(cond.id);
      const auditBefore = await c.prisma.adminAuditLog.count({ where: { resourceId: cond.id } });

      // The workbench READS are refused: no Operations in this package.
      for (const url of [`/v1/ops/incidents?teamId=${space}`, `/v1/ops/incidents/${cond.id}?teamId=${space}`]) {
        const r = await c.inj("GET", url, u.token);
        expect(r.statusCode, url).toBe(403);
        expect(r.json().error).toMatchObject({ code: "permission_denied", reason: "operations_not_included" });
      }

      // Every MUTATION is refused with the same canonical code.
      const mutations: Array<[string, Record<string, unknown>, string]> = [
        [`/v1/ops/incidents/${cond.id}/ack`, { teamId: space }, "OPERATIONS_ACKNOWLEDGE"],
        [`/v1/ops/incidents/${cond.id}/assign`, { teamId: space, assigneeUserId: u.id }, "OPERATIONS_ASSIGN"],
        [`/v1/ops/incidents/${cond.id}/suppress`, { teamId: space, reason: "persona" }, "OPERATIONS_SUPPRESS"],
        [`/v1/ops/incidents/${cond.id}/resolve`, { teamId: space, resolutionNote: "persona" }, "OPERATIONS_RESOLVE"],
        [`/v1/ops/incidents/${cond.id}/remediate`, { teamId: space, actionId: "report.regenerate_artifacts" }, "OPERATIONS_VIEW"],
      ];
      for (const [url, body, capability] of mutations) {
        const r = await c.inj("POST", url, u.token, body);
        expect(r.statusCode, url).toBe(403);
        expect(r.json().error, url).toMatchObject({
          code: "permission_denied",
          reason: "operations_not_included",
          requiredCapability: capability,
        });
      }

      // NOTHING was written: the condition, its history, its audit trail and
      // the record's output requests are exactly as they were.
      expect(await snapshot(cond.id)).toEqual(before);
      expect(await c.prisma.adminAuditLog.count({ where: { resourceId: cond.id } })).toBe(auditBefore);
      expect(await c.prisma.reportGenerationRequest.count({ where: { evidenceId: ev.id } })).toBe(0);

      // The OWN-RECORD summary stays readable by design (Home's count of the
      // member's own records — `requireOpsMemberRead`), and it is not the
      // workbench: it confers no capability and is read-only.
      const s = await c.inj("GET", `/v1/ops/summary?teamId=${space}`, u.token);
      expect(s.statusCode).toBe(200);
      expect(s.json().summary.open).toBe(1);
      expect(await snapshot(cond.id)).toEqual(before);
    });

    it("FREE: a stranger is told the workspace does not exist (anti-enumeration), on reads and mutations", async () => {
      const u = await makeUser(c, "persona-free-owner", { plan: "FREE" });
      const stranger = await makeUser(c, "persona-free-stranger", { plan: "FREE" });
      const space = await personalSpace(c, u.id);
      for (const [m, url, body] of [
        ["GET", `/v1/ops/summary?teamId=${space}`, undefined],
        ["GET", `/v1/ops/incidents?teamId=${space}`, undefined],
        ["POST", `/v1/ops/incidents/${randomUUID()}/ack`, { teamId: space }],
      ] as const) {
        const r = await c.inj(m, url, stranger.token, body);
        expect(r.statusCode, url).toBe(404);
        expect(r.json().error.code).toBe("not_found");
      }
    });
  });

  // ===========================================================================
  // PAYG / evidence credit
  // ===========================================================================
  describe("PAYG — a credit-funded record", () => {
    it("PAYG: two CONCURRENT recoveries of a credit-funded record's failed report make ONE request and debit nothing", async () => {
      // FREE plan + purchased evidence credits: the record earns the paid
      // outputs from its own funding, not from the plan.
      const u = await makeUser(c, "persona-payg", { plan: "FREE" });
      await c.prisma.entitlement.updateMany({ where: { userId: u.id, active: true }, data: { credits: 3 } });
      const space = await personalSpace(c, u.id);
      const ev = await seedEvidence(c, null, u.id);
      await fundWithCredit(u.id, ev.id);
      const ledgerBefore = await ledgerFor(u.id);
      expect(ledgerBefore).toEqual([{ entryType: "CONSUMPTION", creditsDelta: -1, evidenceId: ev.id }]);
      expect(await creditsOf(u.id)).toBe(2);

      const cond = await failReport(ev.id);
      expect(cond.teamId).toBe(space);

      // The workbench is not part of a FREE package: the Operations route
      // refuses, and the record's own recovery is the remediation path.
      const ops = await c.inj("POST", `/v1/ops/incidents/${cond.id}/remediate`, u.token, {
        teamId: space,
        actionId: "report.regenerate_artifacts",
      });
      expect(ops.statusCode).toBe(403);
      expect(ops.json().error.reason).toBe("operations_not_included");

      const [a, b] = await Promise.all([
        c.inj("POST", `/v1/evidence/${ev.id}/reports/regenerate`, u.token, {}),
        c.inj("POST", `/v1/evidence/${ev.id}/reports/regenerate`, u.token, {}),
      ]);
      const statuses = [a.statusCode, b.statusCode];
      // Both accepted-or-collapsed; neither a server error.
      for (const r of [a, b]) expect([200, 202, 409], r.body).toContain(r.statusCode);
      expect(statuses.some((s) => s === 200 || s === 202)).toBe(true);

      // ONE durable report-generation request.
      const requests = await c.prisma.reportGenerationRequest.findMany({ where: { evidenceId: ev.id } });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.teamId).toBe(space);
      // Both answers name that ONE request, and only one of them claims to
      // have started work; the other reports the live work it found.
      const accepted = [a, b].filter((r) => r.statusCode === 202).map((r) => r.json() as { requestId: string; outcome: string });
      for (const r of accepted) expect(r.requestId).toBe(requests[0]!.id);
      expect(accepted.filter((r) => r.outcome === "ENQUEUED").length, JSON.stringify(accepted)).toBeLessThanOrEqual(1);

      // NO second debit: the ledger and the wallet are exactly as they were.
      expect(await ledgerFor(u.id)).toEqual(ledgerBefore);
      expect(await creditsOf(u.id)).toBe(2);
    });

    it("PAYG plan: two CONCURRENT Operations remediations of a credit-funded record collapse to ONE request and debit nothing", async () => {
      const u = await makeUser(c, "persona-payg-plan", { plan: "PAYG" });
      await c.prisma.entitlement.updateMany({ where: { userId: u.id, active: true }, data: { credits: 5 } });
      const space = await personalSpace(c, u.id);
      const ev = await seedEvidence(c, null, u.id);
      await fundWithCredit(u.id, ev.id);
      const ledgerBefore = await ledgerFor(u.id);
      const creditsBefore = await creditsOf(u.id);
      expect(creditsBefore).toBe(4);
      const cond = await failReport(ev.id);

      const body = { teamId: space, actionId: "report.regenerate_artifacts" };
      const [a, b] = await Promise.all([
        c.inj("POST", `/v1/ops/incidents/${cond.id}/remediate`, u.token, body),
        c.inj("POST", `/v1/ops/incidents/${cond.id}/remediate`, u.token, body),
      ]);
      const results = [a.json().remediation?.result, b.json().remediation?.result].sort();
      expect(results, `${a.body} | ${b.body}`).toEqual(["ALREADY_IN_PROGRESS", "QUEUED"]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 202]);

      expect(await c.prisma.reportGenerationRequest.count({ where: { evidenceId: ev.id } })).toBe(1);
      expect(await ledgerFor(u.id)).toEqual(ledgerBefore);
      expect(await creditsOf(u.id)).toBe(creditsBefore);
      // Exactly one "accepted" entry in the condition's own history.
      expect(
        await c.prisma.operationalIncidentEvent.count({ where: { incidentId: cond.id, eventType: "remediation_queued" } }),
      ).toBe(1);
    });
  });

  // ===========================================================================
  // PRO Personal (team_id NULL)
  // ===========================================================================
  describe("PRO Personal — a team_id NULL record", () => {
    it("PRO: two SIMULTANEOUS remediations of a team_id NULL record's failed report collapse to ONE request row", async () => {
      const u = await makeUser(c, "persona-pro", { plan: "PRO" });
      const space = await personalSpace(c, u.id);
      const ev = await seedEvidence(c, null, u.id);
      expect(ev.teamId).toBeNull();
      const cond = await failReport(ev.id);
      expect(cond.teamId).toBe(space);

      const env = await envelopeFor(c, u.token, space);
      expect(env.caps.OPERATIONS_VIEW).toBe(true);

      const body = { teamId: space, actionId: "report.regenerate_artifacts" };
      const [a, b] = await Promise.all([
        c.inj("POST", `/v1/ops/incidents/${cond.id}/remediate`, u.token, body),
        c.inj("POST", `/v1/ops/incidents/${cond.id}/remediate`, u.token, body),
      ]);
      const byResult = new Map([a, b].map((r) => [r.json().remediation?.result, r]));
      expect([...byResult.keys()].sort(), `${a.body} | ${b.body}`).toEqual(["ALREADY_IN_PROGRESS", "QUEUED"]);
      expect(byResult.get("QUEUED")!.statusCode).toBe(202);
      // The second answers with the live work — a 200, not a second 202.
      expect(byResult.get("ALREADY_IN_PROGRESS")!.statusCode).toBe(200);

      const rows = await c.prisma.reportGenerationRequest.findMany({ where: { evidenceId: ev.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.teamId).toBe(space);
      expect(byResult.get("QUEUED")!.json().remediation.reference).toBe(rows[0]!.id);
      expect(
        await c.prisma.operationalIncidentEvent.count({ where: { incidentId: cond.id, eventType: "remediation_queued" } }),
      ).toBe(1);
    });
  });

  // ===========================================================================
  // TEAM
  // ===========================================================================
  describe("TEAM — the role matrix on the wire", () => {
    async function teamFixture(tag: string) {
      const owner = await makeUser(c, `${tag}-owner`, { plan: "TEAM" });
      const ws = await makeWorkspace(c, owner.id, { name: tag, kind: "OWNED", billingPlan: "TEAM", billingStatus: "ACTIVE" });
      const admin = await makeUser(c, `${tag}-admin`);
      const reviewer = await makeUser(c, `${tag}-reviewer`);
      const viewer = await makeUser(c, `${tag}-viewer`);
      const suspended = await makeUser(c, `${tag}-suspended`);
      const revoked = await makeUser(c, `${tag}-revoked`);
      const outsider = await makeUser(c, `${tag}-outsider`);
      await addMember(c, ws.teamId, admin.id, "ADMIN");
      await addMember(c, ws.teamId, reviewer.id, "MEMBER");
      await addMember(c, ws.teamId, viewer.id, "VIEWER");
      await addMember(c, ws.teamId, suspended.id, "ADMIN", "SUSPENDED");
      await addMember(c, ws.teamId, revoked.id, "ADMIN", "REVOKED");
      return { teamId: ws.teamId, owner, admin, reviewer, viewer, suspended, revoked, outsider };
    }

    const storm = (teamId: string) =>
      writeCondition(teamId, {
        sourceId: "review.escalation_storm",
        category: "GOVERNANCE",
        fingerprint: `review-escalation-storm:${randomUUID()}`,
      });

    it("TEAM: viewer and reviewer may READ; viewer is refused every mutation; reviewer is refused assign and suppress", async () => {
      const t = await teamFixture("persona-team-read");
      const cond = await storm(t.teamId);

      for (const who of [t.viewer, t.reviewer]) {
        const list = await c.inj("GET", `/v1/ops/incidents?teamId=${t.teamId}`, who.token);
        expect(list.statusCode).toBe(200);
        expect((list.json().incidents as Array<{ id: string }>).map((r) => r.id)).toContain(cond.id);
        const detail = await c.inj("GET", `/v1/ops/incidents/${cond.id}?teamId=${t.teamId}`, who.token);
        expect(detail.statusCode).toBe(200);
      }

      const before = await snapshot(cond.id);
      const refusals: Array<[{ token: string }, string, Record<string, unknown>, string]> = [
        [t.viewer, "ack", { teamId: t.teamId }, "operations.acknowledge"],
        [t.viewer, "assign", { teamId: t.teamId, assigneeUserId: t.admin.id }, "operations.assign"],
        [t.viewer, "suppress", { teamId: t.teamId, reason: "persona" }, "operations.suppress"],
        [t.viewer, "resolve", { teamId: t.teamId, resolutionNote: "persona" }, "operations.resolve"],
        [t.reviewer, "assign", { teamId: t.teamId, assigneeUserId: t.admin.id }, "operations.assign"],
        [t.reviewer, "suppress", { teamId: t.teamId, reason: "persona" }, "operations.suppress"],
      ];
      for (const [who, verb, body, permission] of refusals) {
        const r = await c.inj("POST", `/v1/ops/incidents/${cond.id}/${verb}`, who.token, body);
        expect(r.statusCode, `${verb} ${permission}`).toBe(403);
        expect(r.json().error, `${verb} ${permission}`).toMatchObject({ code: "permission_denied", requiredPermission: permission });
      }
      expect(await snapshot(cond.id)).toEqual(before);

      // The canonical matrix grants a REVIEWER acknowledge (and resolve):
      // "a reviewer OPERATES" (packages/shared/src/permissions.ts).
      const ack = await c.inj("POST", `/v1/ops/incidents/${cond.id}/ack`, t.reviewer.token, { teamId: t.teamId });
      expect(ack.statusCode).toBe(200);
      expect(ack.json().incident.status).toBe("ACKNOWLEDGED");

      // A suspended or revoked member cannot even read.
      for (const who of [t.suspended, t.revoked]) {
        const r = await c.inj("GET", `/v1/ops/incidents?teamId=${t.teamId}`, who.token);
        expect(r.statusCode).toBe(403);
        expect(r.json().error.code).toBe("permission_denied");
      }
    });

    it("TEAM: owner and admin acknowledge, assign, suppress and resolve-where-allowed", async () => {
      const t = await teamFixture("persona-team-act");
      const a = await storm(t.teamId);
      const ack = await c.inj("POST", `/v1/ops/incidents/${a.id}/ack`, t.owner.token, { teamId: t.teamId });
      expect(ack.statusCode).toBe(200);
      const assign = await c.inj("POST", `/v1/ops/incidents/${a.id}/assign`, t.admin.token, { teamId: t.teamId, assigneeUserId: t.reviewer.id });
      expect(assign.statusCode).toBe(200);
      expect((await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: a.id } })).assignedOperatorUserId).toBe(t.reviewer.id);
      const sup = await c.inj("POST", `/v1/ops/incidents/${a.id}/suppress`, t.admin.token, { teamId: t.teamId, reason: "persona proof" });
      expect(sup.statusCode).toBe(200);
      expect(sup.json().incident.status).toBe("SUPPRESSED");

      // An OPERATOR_DECISION source closes with a written conclusion.
      const sec = await writeCondition(t.teamId, {
        sourceId: "identity.security_condition",
        category: "IDENTITY_SECURITY",
        fingerprint: "identity_security:security_event:suspicious_login_detected",
      });
      const noNote = await c.inj("POST", `/v1/ops/incidents/${sec.id}/resolve`, t.admin.token, { teamId: t.teamId });
      expect(noNote.statusCode).toBe(409);
      expect(noNote.json().error.code).toBe("RESOLUTION_NOTE_REQUIRED");
      const resolved = await c.inj("POST", `/v1/ops/incidents/${sec.id}/resolve`, t.admin.token, {
        teamId: t.teamId,
        resolutionNote: "Investigated: a known load test.",
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().incident.status).toBe("RESOLVED");

      // The reviewer resolves an operator-decision condition with a note too.
      const storm2 = await storm(t.teamId);
      const byReviewer = await c.inj("POST", `/v1/ops/incidents/${storm2.id}/resolve`, t.reviewer.token, {
        teamId: t.teamId,
        resolutionNote: "Handled by the reviewer.",
      });
      expect(byReviewer.statusCode).toBe(200);
      expect(byReviewer.json().incident.status).toBe("RESOLVED");
    });

    it("TEAM: only an ACTIVE member holding the operations tier is an assignee", async () => {
      const t = await teamFixture("persona-team-assign");
      const cond = await storm(t.teamId);
      const ok = await c.inj("POST", `/v1/ops/incidents/${cond.id}/assign`, t.owner.token, { teamId: t.teamId, assigneeUserId: t.admin.id });
      expect(ok.statusCode).toBe(200);

      for (const [label, who] of [
        ["viewer", t.viewer],
        ["suspended", t.suspended],
        ["revoked", t.revoked],
        ["outsider", t.outsider],
      ] as const) {
        const r = await c.inj("POST", `/v1/ops/incidents/${cond.id}/assign`, t.owner.token, { teamId: t.teamId, assigneeUserId: who.id });
        expect(r.statusCode, label).toBe(400);
        // This route answers with the bare `{ error: "invalid_assignee" }`
        // (ops.routes.ts, assign route), which both clients read explicitly.
        expect(r.json().error, label).toBe("invalid_assignee");
      }
      // The refused assignments changed nothing.
      expect((await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: cond.id } })).assignedOperatorUserId).toBe(t.admin.id);

      // The picker offers exactly the set the mutation accepts.
      const picker = await c.inj("GET", `/v1/ops/assignable-operators?teamId=${t.teamId}`, t.owner.token);
      expect(picker.statusCode).toBe(200);
      const body = picker.json() as { operators?: Array<{ userId: string }> };
      const ids = (body.operators ?? []).map((o) => o.userId).sort();
      expect(ids).toEqual([t.owner.id, t.admin.id, t.reviewer.id].sort());
    });

    it("TEAM: a billing condition's action is offered only to billing.manage, and it cannot be closed by hand", async () => {
      const t = await teamFixture("persona-team-billing");
      // A REAL still-charging add-on: its plan was cancelled and the provider
      // has not confirmed the add-on stopped. The canonical producer writes
      // the condition from it.
      const addon = await c.prisma.workspaceStorageAddon.create({
        data: {
          ownerUserId: t.owner.id,
          teamId: t.teamId,
          addonKey: "TEAM_100_GB",
          extraStorageBytes: BigInt(100) * BigInt(1024 ** 3),
          billingCycle: "MONTHLY",
          status: "ACTIVE",
          paymentProvider: "STRIPE",
          externalSubscriptionId: `persona-addon-${randomUUID()}`,
          dependentCancellationState: "ACTION_REQUIRED",
          dependentCancellationRequestedAtUtc: new Date(),
          dependentCancellationFailedAtUtc: new Date(),
          dependentCancellationAttemptCount: 3,
        },
      });
      const { syncDependentCancellationConditions } = await import(
        "../src/services/billing/dependent-cancellation-conditions.service.js"
      );
      await syncDependentCancellationConditions({ teamId: t.teamId });
      const bill = await c.prisma.operationalIncident.findFirstOrThrow({
        where: { teamId: t.teamId, sourceId: "billing.dependent_cancellation_failed" },
      });
      expect(bill.fingerprint).toContain(addon.id);

      const ownerEnv = await envelopeFor(c, t.owner.token, t.teamId);
      expect(ownerEnv.caps.BILLING_MANAGE).toBe(true);
      // The envelope and the canonical `billing.manage` (OWNER only) agree:
      // an administrator who is not the payer is offered no billing control.
      for (const who of [t.admin, t.reviewer, t.viewer]) {
        const env = await envelopeFor(c, who.token, t.teamId);
        expect(env.caps.BILLING_MANAGE, who.id).toBe(false);
      }

      const ownerDetail = await c.inj("GET", `/v1/ops/incidents/${bill.id}?teamId=${t.teamId}`, t.owner.token);
      expect(ownerDetail.statusCode).toBe(200);
      expect(ownerDetail.json().remediation.deepLink).toMatchObject({ requiredPermission: "billing.manage" });
      expect(ownerDetail.json().remediation.actions).toEqual([]);

      for (const who of [t.admin, t.reviewer, t.viewer]) {
        const d = await c.inj("GET", `/v1/ops/incidents/${bill.id}?teamId=${t.teamId}`, who.token);
        expect(d.statusCode).toBe(200);
        // The guidance is there; the billing destination is withheld.
        expect(d.json().remediation.deepLink).toBeNull();
        expect(typeof d.json().remediation.guidance).toBe("string");
      }

      // Nobody — not even the payer — closes "may still be charging" by hand.
      const before = await snapshot(bill.id);
      const r = await c.inj("POST", `/v1/ops/incidents/${bill.id}/resolve`, t.owner.token, { teamId: t.teamId, resolutionNote: "persona" });
      expect(r.statusCode).toBe(409);
      expect(await snapshot(bill.id)).toEqual(before);
      // No Operations remediation action exists for it, so a posted one is refused.
      const rem = await c.inj("POST", `/v1/ops/incidents/${bill.id}/remediate`, t.owner.token, {
        teamId: t.teamId,
        actionId: "report.regenerate_artifacts",
      });
      expect(rem.statusCode).toBe(403);
      expect(rem.json().remediation.result).toBe("REFUSED");
    });
  });

  // ===========================================================================
  // ENTERPRISE
  // ===========================================================================
  describe("ENTERPRISE — the organisation roll-up", () => {
    async function orgFixture(tag: string) {
      const owner = await makeUser(c, `${tag}-owner`, { plan: "ENTERPRISE" });
      const other = await makeUser(c, `${tag}-other`);
      const w1 = await makeWorkspace(c, owner.id, { name: `${tag}-one`, billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
      const w2 = await makeWorkspace(c, owner.id, { name: `${tag}-two`, orgId: w1.orgId, billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
      // The owner is a SUSPENDED member of w3, and no member of w4.
      const w3 = await makeWorkspace(c, other.id, { name: `${tag}-three`, orgId: w1.orgId, billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
      await addMember(c, w3.teamId, owner.id, "ADMIN", "SUSPENDED");
      const w4 = await makeWorkspace(c, other.id, { name: `${tag}-four`, orgId: w1.orgId, billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" });
      await c.prisma.organizationMembership
        .create({ data: { organizationId: w1.orgId, userId: other.id, role: "ORG_MEMBER" } })
        .catch(() => null);
      return { owner, other, orgId: w1.orgId, w1: w1.teamId, w2: w2.teamId, w3: w3.teamId, w4: w4.teamId, tag };
    }

    const rollup = (orgId: string, token: string) => c.inj("GET", `/v1/orgs/${orgId}/operations/rollup`, token);
    const govern = (teamId: string) =>
      writeCondition(teamId, {
        sourceId: "governance.notification_escalated",
        category: "GOVERNANCE",
        fingerprint: `governance:persona:${randomUUID()}`,
      });

    it("ENTERPRISE: only authorized workspaces are included; the rest are counted, never named", async () => {
      const o = await orgFixture("persona-ent-scope");
      await govern(o.w3);
      await govern(o.w4);
      const r = await rollup(o.orgId, o.owner.token);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.workspaces.map((w: { workspaceId: string }) => w.workspaceId).sort()).toEqual([o.w1, o.w2].sort());
      expect(body.coverage).toMatchObject({ workspacesInOrganization: 4, workspacesIncluded: 2, workspacesNotReadable: 2, complete: false });
      for (const hidden of [o.w3, o.w4, `${o.tag}-three`, `${o.tag}-four`]) expect(r.body).not.toContain(hidden);
      expect(body.totals.open).toBe(0);

      // The drill-down obeys the same boundary, even when asked by id.
      const drill = await c.inj("GET", `/v1/orgs/${o.orgId}/operations/incidents?workspaceId=${o.w4}`, o.owner.token);
      expect(drill.statusCode).toBe(200);
      expect(drill.json().incidents).toEqual([]);
    });

    it("ENTERPRISE: the roll-up reads the SAME operational_incidents rows the canonical writer writes", async () => {
      const o = await orgFixture("persona-ent-store");
      const before = (await rollup(o.orgId, o.owner.token)).json();
      const cond = await govern(o.w1);
      const after = (await rollup(o.orgId, o.owner.token)).json();
      expect(after.totals.open).toBe(before.totals.open + 1);
      const w1 = after.workspaces.find((w: { workspaceId: string }) => w.workspaceId === o.w1);
      expect(w1.summary.open).toBe(1);
      // …the same number the workspace's own summary reports…
      const own = await c.inj("GET", `/v1/ops/summary?teamId=${o.w1}`, o.owner.token);
      expect(own.json().summary.open).toBe(1);
      // …and the drill-down lists the very row the writer created.
      const drill = await c.inj("GET", `/v1/orgs/${o.orgId}/operations/incidents`, o.owner.token);
      expect(drill.statusCode).toBe(200);
      const ids = (drill.json().incidents as Array<{ id: string; workspaceId: string }>).map((i) => [i.id, i.workspaceId]);
      expect(ids).toEqual([[cond.id, o.w1]]);
      const row = await c.prisma.operationalIncident.findUniqueOrThrow({ where: { id: cond.id } });
      expect(row.teamId).toBe(o.w1);

      // An acknowledgement in the workspace is what the roll-up sees next.
      await c.inj("POST", `/v1/ops/incidents/${cond.id}/ack`, o.owner.token, { teamId: o.w1 });
      const drill2 = await c.inj("GET", `/v1/orgs/${o.orgId}/operations/incidents`, o.owner.token);
      expect(drill2.json().incidents[0].status).toBe("ACKNOWLEDGED");
    });

    it("ENTERPRISE: a workspace whose state cannot be read is UNKNOWN, never zero, and the totals say they are partial", async () => {
      const o = await orgFixture("persona-ent-unknown");
      await govern(o.w1);
      await govern(o.w2);
      await govern(o.w2);
      // Fault injection: the incident read fails for w2 ONLY (the route and
      // the summary service share this client instance).
      const delegate = c.prisma.operationalIncident as unknown as Record<string, unknown>;
      const original = delegate.findMany as (a: unknown) => Promise<unknown>;
      let injected = 0;
      Object.defineProperty(delegate, "findMany", {
        configurable: true,
        writable: true,
        value: (args: unknown) => {
          if (JSON.stringify(args ?? {}).includes(o.w2)) {
            injected += 1;
            return Promise.reject(new Error("connection reset"));
          }
          return original.call(delegate, args);
        },
      });
      let body: {
        workspaces: Array<{
          workspaceId: string;
          coverage: string;
          summary: { open: number | null; critical: number | null; mayAssertAllClear: boolean; incompleteReason: string | null };
        }>;
        coverage: { workspacesUnknown: number; complete: boolean };
        totals: { open: number };
      };
      try {
        const r = await rollup(o.orgId, o.owner.token);
        expect(r.statusCode).toBe(200);
        body = r.json();
      } finally {
        // Prisma's delegate proxy reports an own descriptor whose value is
        // undefined, so the captured function itself is what is restored.
        Object.defineProperty(delegate, "findMany", { configurable: true, writable: true, value: original });
      }
      expect(typeof c.prisma.operationalIncident.findMany).toBe("function");
      expect(injected).toBeGreaterThan(0);
      const w2 = body.workspaces.find((w) => w.workspaceId === o.w2)!;
      expect(w2, "w2 is reported (as UNKNOWN), never dropped").toBeTruthy();
      expect(w2.coverage).toBe("UNKNOWN");
      expect(w2.summary.open).toBeNull();
      expect(w2.summary.critical).toBeNull();
      expect(w2.summary.mayAssertAllClear).toBe(false);
      expect(w2.summary.incompleteReason).toBe("SOURCE_FAILED");
      expect(body.coverage.workspacesUnknown).toBe(1);
      expect(body.coverage.complete).toBe(false);
      // The totals are w1's alone: w2's two conditions are not a zero.
      expect(body.totals.open).toBe(1);

      // Once readable again, w2 is KNOWN with its real count.
      const healed = (await rollup(o.orgId, o.owner.token)).json();
      expect(healed.workspaces.find((w: { workspaceId: string }) => w.workspaceId === o.w2).coverage).toBe("KNOWN");
      expect(healed.totals.open).toBe(3);
    });

    it("ENTERPRISE: the platform-wide feed is a separate authority a tenant owner cannot reach", async () => {
      const o = await orgFixture("persona-ent-platform");
      const cond = await govern(o.w1);
      const admin = await makeUser(c, "persona-platform-admin", { platformRole: "admin" });

      for (const url of ["/v1/admin/incidents", `/v1/admin/incidents?teamId=${o.w1}`, `/v1/admin/incidents/${cond.id}`]) {
        const r = await c.inj("GET", url, o.owner.token);
        expect(r.statusCode, url).toBe(403);
        expect(r.body).not.toContain(cond.id);
      }
      const ok = await c.inj("GET", `/v1/admin/incidents?teamId=${o.w1}`, admin.token);
      expect(ok.statusCode).toBe(200);
      expect((ok.json().items as Array<{ id: string }>).map((i) => i.id)).toEqual([cond.id]);

      // …and platform authority is NOT tenant authority: the platform admin,
      // who is no member of the organisation, is refused the roll-up.
      const tenant = await rollup(o.orgId, admin.token);
      expect([403, 404]).toContain(tenant.statusCode);
      expect(tenant.body).not.toContain(o.w1);
    });
  });
});
