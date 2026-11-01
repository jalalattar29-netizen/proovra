/**
 * REVIEW AUTHORITY, DOOR BY DOOR (live PostgreSQL) — WORKFLOW-001 to 005, 019, 020.
 *
 * The same person gets the same answer through the console, the legacy routes
 * and the bulk routes, and a record closed by a restricted case is a 404 on all
 * of them. Persistent effects are read back: decision rows, statuses, policy
 * version, tenant audit.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Person = { id: string; token: string };
type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

describe("review door authority (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legalVersions: Record<string, string>;
  let reconcile: typeof import("../src/services/reviewer-ops/reviewer-operations-engine.service.js")["runReconcile"];
  let reconcileProjection: typeof import("../src/services/reviewer-ops/review-decision.service.js")["reconcileWorkflowProjection"];
  const A = () => h.fixtures.teamA;

  let reviewer: Person;
  let viewer: Person;
  let admin: Person;
  let listed: Person;
  let restrictedCaseId: string;

  const tag = () => randomUUID().slice(0, 8);
  const headers = (who: Person, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${who.token}`,
    ...extra,
  });
  const get = (url: string, who: Person) => h.app.inject({ method: "GET", url, headers: headers(who) });
  const post = (url: string, who: Person, payload: unknown, extra: Record<string, string> = {}) =>
    h.app.inject({ method: "POST", url, headers: headers(who, extra), payload: payload as never });
  const teamQ = () => `teamId=${A().teamId}`;

  async function person(role: Role): Promise<Person> {
    const email = `door-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }

  async function reviewRecord(
    status: string = "IN_REVIEW",
    extra: Record<string, unknown> = {},
  ): Promise<{ evidenceId: string; workflowId: string }> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: {
        title: `door ${tag()}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        sizeBytes: 1_000n,
      } as never,
      select: { id: true },
    });
    const workflow = await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId: evidence.id, teamId: A().teamId, workspaceType: "TEAM", status, ...extra } as never,
      select: { id: true },
    });
    return { evidenceId: evidence.id, workflowId: workflow.id };
  }

  async function closedRecord() {
    const r = await reviewRecord();
    await prisma.caseEvidenceLink.create({
      data: { caseId: restrictedCaseId, evidenceId: r.evidenceId, teamId: A().teamId } as never,
    });
    return r;
  }

  async function approvedChallenge(who: Person, purpose: string, resourceKind: string, resourceId: string) {
    const { startContactFactorEnrollment, completeContactFactorEnrollment } = await import(
      "../src/services/security/verified-contact-factor.service.js"
    );
    const started = await startContactFactorEnrollment({
      userId: who.id,
      kind: "SMS",
      destinationRaw: `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
      label: "door-test",
    });
    await completeContactFactorEnrollment({ userId: who.id, factorId: started.factor.factorId });
    const factor = await prisma.mfaFactor.findUniqueOrThrow({ where: { id: started.factor.factorId } });
    const challenge = await prisma.stepUpChallenge.create({
      data: {
        teamId: A().teamId,
        initiatedByUserId: who.id,
        purpose,
        resourceKind,
        resourceId,
        status: "APPROVED" as never,
        factorId: factor.id,
        factorGeneration: (factor as unknown as { generation: number }).generation,
        approvedAtUtc: new Date(),
        expiresAtUtc: new Date(Date.now() + 10 * 60_000),
      },
    });
    return challenge.id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ REQUIRED_LEGAL_VERSIONS: legalVersions } = (await import("../src/legal/legal-versioning.js")) as never);
    ({ runReconcile: reconcile } = await import("../src/services/reviewer-ops/reviewer-operations-engine.service.js"));
    ({ reconcileWorkflowProjection: reconcileProjection } = await import("../src/services/reviewer-ops/review-decision.service.js"));
    await prisma.team.updateMany({
      where: { id: A().teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" },
    });
    [reviewer, viewer, admin, listed] = await Promise.all([
      person("MEMBER"),
      person("VIEWER"),
      person("ADMIN"),
      person("MEMBER"),
    ]);
    restrictedCaseId = (
      await prisma.case.create({
        data: { name: `restricted-${tag()}`, teamId: A().teamId, ownerUserId: A().ownerUserId, restrictedAtUtc: new Date() } as never,
        select: { id: true },
      })
    ).id;
    await prisma.caseAccess.create({ data: { caseId: restrictedCaseId, userId: listed.id } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const decisionsOn = (workflowId: string) => prisma.workflowReviewDecision.count({ where: { workflowId } });
  const statusOf = async (workflowId: string) =>
    String((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId } })).status);

  // ===========================================================================
  describe("WORKFLOW-001: a verdict needs the review permission on every door", () => {
    it("VIEWER is refused at the decisions route, with no row and no status change", async () => {
      const r = await reviewRecord();
      const res = await post(`/v1/reviewer-ops/workspace/${r.workflowId}/decisions`, viewer, {
        teamId: A().teamId,
        decision: "APPROVE",
        rationale: "x",
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(await decisionsOn(r.workflowId)).toBe(0);
      expect(await statusOf(r.workflowId)).toBe("IN_REVIEW");
    });

    it("the authority itself refuses a VIEWER, whatever door calls it", async () => {
      const { recordReviewDecision, ReviewDecisionAuthorityError } = await import(
        "../src/services/reviewer-ops/review-decision.service.js"
      );
      const r = await reviewRecord();
      await expect(
        recordReviewDecision({
          workflowId: r.workflowId,
          teamId: A().teamId,
          actorUserId: viewer.id,
          decision: "APPROVE",
          rationale: "x",
          actorIsAdjudicator: false,
        } as never),
      ).rejects.toBeInstanceOf(ReviewDecisionAuthorityError);
      expect(await decisionsOn(r.workflowId)).toBe(0);
    });

    it("VIEWER cannot add a reviewer note; a reviewer can", async () => {
      const r = await reviewRecord();
      const notes = () => prisma.evidenceReviewerComment.count({ where: { evidenceId: r.evidenceId } });
      const refused = await post(`/v1/reviewer-ops/workspace/${r.workflowId}/notes`, viewer, {
        teamId: A().teamId,
        type: "observation",
        body: "viewer note",
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(await notes()).toBe(0);
      const ok = await post(`/v1/reviewer-ops/workspace/${r.workflowId}/notes`, reviewer, {
        teamId: A().teamId,
        type: "observation",
        body: "reviewer note",
      });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await notes()).toBe(1);
    });

    it("positive control: a reviewer records a verdict at the same door", async () => {
      const r = await reviewRecord();
      const res = await post(`/v1/reviewer-ops/workspace/${r.workflowId}/decisions`, reviewer, {
        teamId: A().teamId,
        decision: "APPROVE",
        rationale: "looks right",
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(await decisionsOn(r.workflowId)).toBe(1);
    });

    it("the step-up flag binds this door too", async () => {
      const r = await reviewRecord();
      await prisma.workspaceGovernancePolicy.upsert({
        where: { teamId: A().teamId },
        update: { requireStepUpForApprove: true },
        create: { teamId: A().teamId, requireStepUpForApprove: true },
      });
      try {
        const res = await post(`/v1/reviewer-ops/workspace/${r.workflowId}/decisions`, reviewer, {
          teamId: A().teamId,
          decision: "APPROVE",
          rationale: "x",
        });
        expect(res.statusCode, res.body).toBe(401);
        expect(res.body).toContain("STEP_UP_REQUIRED");
        expect(await decisionsOn(r.workflowId)).toBe(0);
      } finally {
        await prisma.workspaceGovernancePolicy.update({
          where: { teamId: A().teamId },
          data: { requireStepUpForApprove: false },
        });
      }
    });
  });

  // ===========================================================================
  describe("WORKFLOW-003: review surfaces obey the record rule", () => {
    it("reads are 404 by id and the lists omit the record", async () => {
      const r = await closedRecord();
      for (const who of [reviewer, viewer, admin]) {
        for (const url of [
          `/v1/reviewer-ops/workspace/${r.workflowId}?${teamQ()}`,
          `/v1/reviewer-ops/workspace/${r.workflowId}/notes?${teamQ()}`,
          `/v1/reviewer-ops/workspace/${r.workflowId}/decisions?${teamQ()}`,
          `/v1/reviewer/evidence/${r.evidenceId}/annotations?${teamQ()}`,
        ]) {
          const res = await get(url, who);
          expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
        }
        // The coding sheet answers an unknown workflow as empty, so a closed
        // record must read exactly the same, value for value.
        const coding = await get(`/v1/reviewer/work/${r.workflowId}/coding?${teamQ()}`, who);
        expect(coding.statusCode, coding.body).toBe(200);
        const unknown = await get(`/v1/reviewer/work/${randomUUID()}/coding?${teamQ()}`, who);
        expect(coding.json()).toEqual(unknown.json());
        const summary = await get(`/v1/reviewer-ops/decisions/summary?${teamQ()}&previewLimit=50`, who);
        expect(summary.statusCode, summary.body).toBe(200);
        expect(summary.body).not.toContain(r.evidenceId);
      }
      const mine = await get(`/v1/reviewer-ops/workspace/${r.workflowId}?${teamQ()}`, listed);
      expect(mine.statusCode, mine.body).toBe(200);
      const myNotes = await get(`/v1/reviewer-ops/workspace/${r.workflowId}/notes?${teamQ()}`, listed);
      expect(myNotes.statusCode, myNotes.body).toBe(200);
      expect((await get(`/v1/reviewer-ops/decisions/summary?${teamQ()}&previewLimit=50`, listed)).body).toContain(r.evidenceId);
    });

    it("every write door answers 404 and nothing moves", async () => {
      const r = await closedRecord();
      for (const [url, body] of [
        [`/v1/reviewer-ops/reviews/${r.workflowId}/approve`, { teamId: A().teamId }],
        [`/v1/reviewer-ops/reviews/${r.workflowId}/reject`, { teamId: A().teamId, note: "x" }],
        [`/v1/reviewer-ops/reviews/${r.workflowId}/request-info`, { teamId: A().teamId, note: "x" }],
        [`/v1/reviewer-ops/reviews/${r.workflowId}/pause`, { teamId: A().teamId, pausedReason: "x" }],
        [`/v1/reviewer-ops/workspace/${r.workflowId}/decisions`, { teamId: A().teamId, decision: "APPROVE", rationale: "x" }],
        [`/v1/reviewer-ops/workspace/${r.workflowId}/notes`, { teamId: A().teamId, type: "observation", body: "x" }],
        [`/v1/review-operations/evidence/${r.evidenceId}/decision`, { decision: "APPROVE_INTERNAL", note: "x" }],
        [`/v1/review-operations/evidence/${r.evidenceId}/claim`, { teamId: A().teamId }],
        [`/v1/reviewer-ops/escalations`, { teamId: A().teamId, workflowId: r.workflowId, reason: "WORKFLOW_STALLED", safeSummary: "x" }],
      ] as Array<[string, unknown]>) {
        const res = await post(url, reviewer, body);
        expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
      }
      expect(await decisionsOn(r.workflowId)).toBe(0);
      expect(await statusOf(r.workflowId)).toBe("IN_REVIEW");
      expect(await prisma.reviewEscalation.count({ where: { workflowId: r.workflowId } })).toBe(0);
    });

    it("a bulk row on a closed record is refused as not found; the open row in the same call proceeds", async () => {
      const closed = await closedRecord();
      const open = await reviewRecord();
      const res = await post(`/v1/reviewer-ops/reviews/bulk`, admin, {
        teamId: A().teamId,
        workflowIds: [closed.workflowId, open.workflowId],
        action: "CLOSE",
        note: "done",
      });
      expect([200, 207], res.body).toContain(res.statusCode);
      expect(await statusOf(closed.workflowId)).toBe("IN_REVIEW");
      expect(await statusOf(open.workflowId)).toBe("CLOSED");
      const legacy = await post(`/v1/review-operations/bulk`, admin, {
        teamId: A().teamId,
        evidenceIds: [closed.evidenceId],
        action: "CLOSE",
        note: "done",
      });
      expect(legacy.statusCode, legacy.body).toBe(200);
      expect(legacy.body).toContain("not_in_workspace");
      expect(await statusOf(closed.workflowId)).toBe("IN_REVIEW");
    });

    it("an escalation on a closed record is not listed and cannot be moved", async () => {
      const r = await closedRecord();
      const esc = await prisma.reviewEscalation.create({
        data: {
          teamId: A().teamId,
          workflowId: r.workflowId,
          evidenceId: r.evidenceId,
          reason: "WORKFLOW_STALLED",
          severity: "WARNING",
          status: "OPEN",
          safeSummary: `sentinel-${tag()}`,
          fingerprint: randomUUID(),
        } as never,
      });
      const list = await get(`/v1/reviewer-ops/escalations?${teamQ()}&status=ALL&limit=200`, reviewer);
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(esc.id);
      expect((await get(`/v1/reviewer-ops/escalations?${teamQ()}&status=ALL&limit=200`, listed)).body).toContain(esc.id);
      const ack = await post(`/v1/reviewer-ops/escalations/${esc.id}/acknowledge`, reviewer, { teamId: A().teamId });
      expect(ack.statusCode, ack.body).toBe(404);
      const row = await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: esc.id } });
      expect(row.status).toBe("OPEN");
    });

    it("a closed record's review is not counted in analytics for an off-list reader", async () => {
      const before = (await get(`/v1/reviewer-ops/analytics/escalations?${teamQ()}`, reviewer)).json() as { totalOpen: number };
      const mine = (await get(`/v1/reviewer-ops/analytics/escalations?${teamQ()}`, listed)).json() as { totalOpen: number };
      expect(mine.totalOpen).toBeGreaterThan(before.totalOpen);
    });
  });

  // ===========================================================================
  describe("WORKFLOW-002: the policy has one writer and one permission", () => {
    it("a MEMBER is refused even with a valid step-up; the policy does not move", async () => {
      const before = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId: A().teamId } });
      const challenge = await approvedChallenge(reviewer, "GOVERNANCE_POLICY_UPDATE", "workspace_reviewer_ops_policy", A().teamId);
      const res = await post(
        `/v1/reviewer-ops/sla-policy`,
        reviewer,
        { teamId: A().teamId, flags: { requireStepUpForApprove: false }, overrides: { completionHours: 1 } },
        { "x-proovra-step-up-challenge-id": challenge },
      );
      expect(res.statusCode, res.body).toBe(403);
      const after = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId: A().teamId } });
      expect(after?.version).toBe(before?.version);
      expect(after?.defaultCompletionDueHours).toBe(before?.defaultCompletionDueHours);
    });

    it("an ADMIN write bumps the version, audits changed names, and leaves omitted keys alone", async () => {
      const seed = await approvedChallenge(admin, "GOVERNANCE_POLICY_UPDATE", "workspace_reviewer_ops_policy", A().teamId);
      const first = await post(
        `/v1/reviewer-ops/sla-policy`,
        admin,
        { teamId: A().teamId, overrides: { completionHours: 12, firstReviewHours: 4 } },
        { "x-proovra-step-up-challenge-id": seed },
      );
      expect(first.statusCode, first.body).toBe(200);
      const v1 = await prisma.workspaceGovernancePolicy.findUniqueOrThrow({ where: { teamId: A().teamId } });

      const next = await approvedChallenge(admin, "GOVERNANCE_POLICY_UPDATE", "workspace_reviewer_ops_policy", A().teamId);
      const second = await post(
        `/v1/reviewer-ops/sla-policy`,
        admin,
        { teamId: A().teamId, overrides: { completionHours: 24 } },
        { "x-proovra-step-up-challenge-id": next },
      );
      expect(second.statusCode, second.body).toBe(200);
      const v2 = await prisma.workspaceGovernancePolicy.findUniqueOrThrow({ where: { teamId: A().teamId } });
      expect(v2.version).toBe(v1.version + 1);
      expect(v2.defaultCompletionDueHours).toBe(24);
      expect(v2.defaultFirstResponseDueHours).toBe(4);

      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: "governance.workspace_policy_updated", userId: admin.id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
    });

    it("a stale expected version writes nothing", async () => {
      const current = await prisma.workspaceGovernancePolicy.findUniqueOrThrow({ where: { teamId: A().teamId } });
      const challenge = await approvedChallenge(admin, "GOVERNANCE_POLICY_UPDATE", "workspace_reviewer_ops_policy", A().teamId);
      const res = await post(
        `/v1/reviewer-ops/sla-policy`,
        admin,
        { teamId: A().teamId, overrides: { completionHours: 99 }, expectedVersion: current.version - 1 },
        { "x-proovra-step-up-challenge-id": challenge },
      );
      expect(res.statusCode, res.body).toBe(409);
      const after = await prisma.workspaceGovernancePolicy.findUniqueOrThrow({ where: { teamId: A().teamId } });
      expect(after.version).toBe(current.version);
    });
  });

  // ===========================================================================
  describe("WORKFLOW-004: the same person gets the same answer at every door", () => {
    it("a MEMBER closing through the legacy bulk door is refused exactly as on the console", async () => {
      const r = await reviewRecord();
      const legacy = await post(`/v1/review-operations/bulk`, reviewer, {
        teamId: A().teamId,
        evidenceIds: [r.evidenceId],
        action: "CLOSE",
        note: "x",
      });
      expect(legacy.statusCode, legacy.body).toBe(403);
      expect(legacy.body).toContain("review_bulk_required");
      const console_ = await post(`/v1/reviewer-ops/reviews/bulk`, reviewer, {
        teamId: A().teamId,
        workflowIds: [r.workflowId],
        action: "CLOSE",
        note: "x",
      });
      expect(console_.statusCode, console_.body).toBe(403);
      expect(console_.body).toContain("review_bulk_required");
      expect(await statusOf(r.workflowId)).toBe("IN_REVIEW");
    });

    it("the bulk step-up flag binds the legacy door too", async () => {
      const r = await reviewRecord();
      await prisma.workspaceGovernancePolicy.update({
        where: { teamId: A().teamId },
        data: { requireStepUpForBulk: true },
      });
      try {
        const res = await post(`/v1/review-operations/bulk`, admin, {
          teamId: A().teamId,
          evidenceIds: [r.evidenceId],
          action: "CLOSE",
          note: "x",
        });
        expect(res.statusCode, res.body).toBe(401);
        expect(await statusOf(r.workflowId)).toBe("IN_REVIEW");
      } finally {
        await prisma.workspaceGovernancePolicy.update({
          where: { teamId: A().teamId },
          data: { requireStepUpForBulk: false },
        });
      }
    });

    it("positive control: an ADMIN closes through the legacy door", async () => {
      const r = await reviewRecord();
      const res = await post(`/v1/review-operations/bulk`, admin, {
        teamId: A().teamId,
        evidenceIds: [r.evidenceId],
        action: "CLOSE",
        note: "x",
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await statusOf(r.workflowId)).toBe("CLOSED");
    });
  });

  // ===========================================================================
  describe("WORKFLOW-005: suppress, audit, and a resolved breach stays resolved", () => {
    const seedEscalation = async (workflowId: string, evidenceId: string, status = "OPEN", extra = {}) =>
      prisma.reviewEscalation.create({
        data: {
          teamId: A().teamId,
          workflowId,
          evidenceId,
          reason: "REVIEW_OVERDUE",
          severity: "HIGH",
          status,
          safeSummary: "seed",
          fingerprint: randomUUID(),
          ...extra,
        } as never,
      });

    it("a reviewer cannot suppress; an admin can, and every move leaves a tenant audit row", async () => {
      const r = await reviewRecord();
      const esc = await seedEscalation(r.workflowId, r.evidenceId);
      const refused = await post(`/v1/reviewer-ops/escalations/${esc.id}/suppress`, reviewer, {
        teamId: A().teamId,
        suppressionReason: "noise",
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: esc.id } })).status).toBe("OPEN");

      const ack = await post(`/v1/reviewer-ops/escalations/${esc.id}/acknowledge`, reviewer, { teamId: A().teamId });
      expect(ack.statusCode, ack.body).toBe(200);
      const suppressed = await post(`/v1/reviewer-ops/escalations/${esc.id}/suppress`, admin, {
        teamId: A().teamId,
        suppressionReason: "noise",
      });
      expect(suppressed.statusCode, suppressed.body).toBe(200);
      const actions = (
        await prisma.adminAuditLog.findMany({ where: { resourceId: esc.id }, select: { action: true } })
      ).map((a) => a.action);
      expect(actions).toContain("reviewer.escalation.acknowledge");
      expect(actions).toContain("reviewer.escalation.suppress");
    });

    it("a resolved breach is not re-raised by the sweep; an unaddressed one is", async () => {
      const past = new Date(Date.now() - 3 * 86_400_000);
      const addressed = await reviewRecord("IN_REVIEW", { slaStatus: "BREACHED", dueAt: past, lastReviewedAt: past });
      await seedEscalation(addressed.workflowId, addressed.evidenceId, "RESOLVED", { resolvedAtUtc: new Date() });
      const unaddressed = await reviewRecord("IN_REVIEW", { slaStatus: "BREACHED", dueAt: past, lastReviewedAt: past });

      await reconcile({ teamId: A().teamId }, prisma);
      await reconcile({ teamId: A().teamId }, prisma);

      expect(await prisma.reviewEscalation.count({ where: { workflowId: addressed.workflowId } })).toBe(1);
      expect(await prisma.reviewEscalation.count({ where: { workflowId: unaddressed.workflowId } })).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  describe("WORKFLOW-020: re-raising after a resolution opens a new escalation", () => {
    it("a person gets a new row; a repeat while open still dedupes", async () => {
      const r = await reviewRecord();
      const body = { teamId: A().teamId, workflowId: r.workflowId, reason: "WORKFLOW_STALLED", severity: "WARNING", safeSummary: "first" };
      const first = await post(`/v1/reviewer-ops/escalations`, reviewer, body);
      expect(first.statusCode, first.body).toBe(201);
      const repeat = await post(`/v1/reviewer-ops/escalations`, reviewer, body);
      expect(repeat.statusCode, repeat.body).toBe(200);
      expect(await prisma.reviewEscalation.count({ where: { workflowId: r.workflowId } })).toBe(1);

      const id = (first.json() as { escalation: { id: string } }).escalation.id;
      const resolved = await post(`/v1/reviewer-ops/escalations/${id}/resolve`, reviewer, {
        teamId: A().teamId,
        resolutionNote: "fixed",
      });
      expect(resolved.statusCode, resolved.body).toBe(200);

      const again = await post(`/v1/reviewer-ops/escalations`, reviewer, { ...body, safeSummary: "it came back" });
      expect(again.statusCode, again.body).toBe(201);
      expect((again.json() as { escalation: { status: string } }).escalation.status).toBe("OPEN");
      expect(await prisma.reviewEscalation.count({ where: { workflowId: r.workflowId } })).toBe(2);
    });
  });

  // ===========================================================================
  describe("WORKFLOW-019: projection repair", () => {
    async function diverged() {
      const r = await reviewRecord();
      await prisma.workflowReviewDecision.create({
        data: {
          workflowId: r.workflowId,
          teamId: A().teamId,
          stage: "FIRST",
          reviewerUserId: reviewer.id,
          decision: "APPROVE",
          rationale: "ok",
          round: 0,
        } as never,
      });
      return r;
    }

    it("repairs a real divergence and writes a null-actor audit event", async () => {
      const r = await diverged();
      const result = await reconcileProjection(r.workflowId, prisma);
      expect(result.repaired).toBe(true);
      expect(await statusOf(r.workflowId)).toBe("APPROVED_INTERNAL");
      const events = await prisma.evidenceReviewerAuditEvent.findMany({ where: { evidenceId: r.evidenceId } });
      expect(events.some((e) => e.actorUserId === null)).toBe(true);
    });

    it("a move committed after the read wins: the repair stands down and writes nothing", async () => {
      const r = await diverged();
      const moving = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop !== "workflowReviewDecision") return Reflect.get(target, prop, receiver);
          return new Proxy(target.workflowReviewDecision, {
            get(model, method, modelReceiver) {
              if (method !== "findMany") return Reflect.get(model, method, modelReceiver);
              return async (args: never) => {
                await target.evidenceReviewWorkflow.update({
                  where: { id: r.workflowId },
                  data: { status: "NEEDS_INFO" as never },
                });
                return model.findMany(args);
              };
            },
          });
        },
      });
      const result = await reconcileProjection(r.workflowId, moving as never);
      expect(result, JSON.stringify(result)).toMatchObject({ repaired: false, reason: "moved_during_repair" });
      expect(await statusOf(r.workflowId)).toBe("NEEDS_INFO");
    });
  });
});
