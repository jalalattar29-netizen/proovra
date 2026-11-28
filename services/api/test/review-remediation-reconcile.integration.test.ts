/**
 * Source review E (2026-11-27) — legacy compatibility and the plan-bound,
 * audited reconciliation. Isolated fixtures on a disposable PostgreSQL; no
 * production data.
 *
 *  - Legacy reads keep the pre-change meaning: a creator-less, non-sweep,
 *    non-integrity escalation recorded before the change still forces (E.1); a
 *    stored ESCALATED status set by a pre-change escalation still forces, and a
 *    later sweep escalation does not lift it (E.2). Post-change administrative
 *    escalations add nothing.
 *  - The plan lists every affected record with its precondition; apply is
 *    bound to the plan hash, touches only listed records, compare-and-sets
 *    each one, writes a durable audit row per change, is idempotent, refuses a
 *    tampered plan, reports records changed after planning, rolls back on a
 *    failure, and compensation undoes exactly what was applied.
 *  - IR-04 (2026-11-28): every item carries the reviewed context; apply
 *    recomputes it under the review / escalation row locks and refuses an
 *    item whose context changed (status, round, causes, escalations,
 *    attribution source), naming the facts. Sibling items never conflict.
 *  - IR-05: the overturned-challenge report is decided per challenge from
 *    supersede evidence, not from a fixed date.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let svc: typeof import("../src/services/reviewer-ops/review-remediation-reconcile.service.js");
let second: typeof import("../src/services/evidence-review/second-review.service.js");
let outcome: typeof import("../src/services/evidence-review/review-outcome.service.js");
let defaults: typeof import("../src/services/reviewer-workspace/coding-schema-defaults.js");
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;

let teamId: string;
let ownerId: string;

async function newUserId(label: string): Promise<string> {
  const email = `rrec-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
  return (
    await prisma.user.create({
      data: { email, firstName: "RRec", lastName: label, displayName: `RRec ${label}`, provider: "EMAIL", providerUserId: email },
      select: { id: true },
    })
  ).id;
}

async function review(status = "IN_REVIEW", opts: { round?: number } = {}) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `rrec ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "CREATED", teamId, organizationId: t.organizationId, ownerUserId: ownerId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId, status, workspaceType: "TEAM", assignedToUserId: ownerId, decisionRound: opts.round ?? 0 } as never,
      select: { id: true },
    })
  ).id;
  return { evidenceId, workflowId };
}

async function escalation(
  r: { workflowId: string; evidenceId: string },
  o: { reason: string; createdByUserId: string | null; requiresIndependentReview: boolean | null; status?: string },
) {
  return (
    await prisma.reviewEscalation.create({
      data: {
        teamId,
        workflowId: r.workflowId,
        evidenceId: r.evidenceId,
        reason: o.reason,
        severity: "WARNING",
        status: o.status ?? "OPEN",
        safeSummary: "fixture",
        createdByUserId: o.createdByUserId,
        requiresIndependentReview: o.requiresIndependentReview,
        fingerprint: randomUUID(),
      } as never,
      select: { id: true },
    })
  ).id;
}

/** The ESCALATED workflow event the review-operations Escalate writes (escalationId on nextValue). */
async function escalatedEvent(r: { workflowId: string; evidenceId: string }, escalationId: string | null) {
  await prisma.evidenceReviewWorkflowEvent.create({
    data: {
      workflowId: r.workflowId,
      evidenceId: r.evidenceId,
      actorUserId: ownerId,
      eventType: "ESCALATED",
      previousValue: { stage: "IN_REVIEW" },
      nextValue: { stage: "ESCALATED", decision: "ESCALATE", ...(escalationId ? { escalationId } : {}) },
    } as never,
  });
}

const required = async (r: { workflowId: string; evidenceId: string }) => {
  const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: r.workflowId } });
  const one = await second.secondReviewForRound({ workflowId: r.workflowId, teamId, evidenceId: r.evidenceId, round: wf.decisionRound });
  return one;
};

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  svc = await import("../src/services/reviewer-ops/review-remediation-reconcile.service.js");
  second = await import("../src/services/evidence-review/second-review.service.js");
  outcome = await import("../src/services/evidence-review/review-outcome.service.js");
  defaults = await import("../src/services/reviewer-workspace/coding-schema-defaults.js");
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
  ownerId = await newUserId("owner");
  teamId = (await ensurePersonalWorkspace({ userId: ownerId })).teamId;
  await prisma.entitlement.updateMany({ where: { userId: ownerId }, data: { plan: "TEAM", active: true } });
}, 900_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

describe("legacy reads keep the pre-change meaning (E.1, E.2)", () => {
  it("E.1 — a creator-less, non-sweep, non-integrity escalation recorded before the change still forces; a sweep one never did", async () => {
    const r = await review();
    await escalation(r, { reason: "REVIEW_OVERDUE", createdByUserId: null, requiresIndependentReview: null });
    expect((await required(r)).required).toBe(false);
    await escalation(r, { reason: "NO_REVIEWER_ASSIGNED", createdByUserId: null, requiresIndependentReview: null });
    expect(await required(r)).toMatchObject({ required: true, reason: "legacy_escalation" });
  });

  it("E.1 — a NEW creator-less administrative escalation (explicit false) adds nothing", async () => {
    const r = await review();
    await escalation(r, { reason: "WORKFLOW_STALLED", createdByUserId: null, requiresIndependentReview: false });
    expect((await required(r)).required).toBe(false);
  });

  it("E.2 — a stored ESCALATED status set before the change forces; a later sweep escalation does not lift it", async () => {
    const r = await review("ESCALATED");
    const legacy = await escalation(r, { reason: "REVIEWER_ESCALATED", createdByUserId: ownerId, requiresIndependentReview: null, status: "RESOLVED" });
    await escalatedEvent(r, legacy);
    expect(await required(r)).toMatchObject({ required: true, reason: "legacy_escalated_status" });
    // A post-change overdue escalation arrives later: the status was not set by it.
    await escalation(r, { reason: "REVIEW_OVERDUE", createdByUserId: null, requiresIndependentReview: false });
    expect(await required(r)).toMatchObject({ required: true, reason: "legacy_escalated_status" });
  });

  it("E.2 — an ESCALATED status with no identifiable setter keeps forcing; one set by a post-change administrative Escalate does not", async () => {
    const unknown = await review("ESCALATED");
    expect(await required(unknown)).toMatchObject({ required: true, reason: "legacy_escalated_status" });
    const fresh = await review("ESCALATED");
    const e = await escalation(fresh, { reason: "REVIEWER_ESCALATED", createdByUserId: ownerId, requiresIndependentReview: false });
    await escalatedEvent(fresh, e);
    expect((await required(fresh)).required).toBe(false);
  });

  it("the batched reader agrees with the per-workflow reader on every legacy case", async () => {
    const cases = [await review("ESCALATED"), await review("ESCALATED"), await review(), await review()];
    const l = await escalation(cases[0]!, { reason: "REVIEWER_ESCALATED", createdByUserId: ownerId, requiresIndependentReview: null });
    await escalatedEvent(cases[0]!, l);
    const n = await escalation(cases[1]!, { reason: "REVIEWER_ESCALATED", createdByUserId: ownerId, requiresIndependentReview: false });
    await escalatedEvent(cases[1]!, n);
    await escalation(cases[2]!, { reason: "NO_REVIEWER_ASSIGNED", createdByUserId: null, requiresIndependentReview: null });
    await escalation(cases[3]!, { reason: "WORKFLOW_STALLED", createdByUserId: null, requiresIndependentReview: false });
    // Give each a FIRST decision so the requirement changes the verdict.
    for (const c of cases) {
      await prisma.workflowReviewDecision.create({
        data: { workflowId: c.workflowId, teamId, stage: "FIRST", reviewerUserId: ownerId, decision: "APPROVE", rationale: "ok", round: 0 } as never,
      });
    }
    const refs = await prisma.evidenceReviewWorkflow.findMany({
      where: { id: { in: cases.map((c) => c.workflowId) } },
      select: { id: true, teamId: true, evidenceId: true, decisionRound: true },
    });
    const batched = await outcome.secondReviewRequiredForRounds(refs.map((w) => ({ ...w, teamId: w.teamId! })), [], prisma);
    for (const c of cases) expect(batched.get(c.workflowId), c.workflowId).toBe((await required(c)).required);
    expect(cases.map((c) => batched.get(c.workflowId))).toEqual([true, false, true, false]);
  });
});

describe("the plan-bound, audited reconciliation (E.3)", () => {
  async function fixtures() {
    const helperOwner = await newUserId("helper");
    const admin = await review();
    const adminEsc = await escalation(admin, { reason: "WORKFLOW_STALLED", createdByUserId: helperOwner, requiresIndependentReview: null });
    const creatorless = await review();
    const creatorlessEsc = await escalation(creatorless, { reason: "NO_REVIEWER_ASSIGNED", createdByUserId: null, requiresIndependentReview: null });
    const integrity = await review();
    const integrityEsc = await escalation(integrity, { reason: "INTEGRITY_RISK", createdByUserId: helperOwner, requiresIndependentReview: null });
    const status = await review("ESCALATED");
    const statusEsc = await escalation(status, { reason: "REVIEWER_ESCALATED", createdByUserId: helperOwner, requiresIndependentReview: null, status: "RESOLVED" });
    await escalatedEvent(status, statusEsc);
    const unknown = await review("ESCALATED");
    const backfill = await review();
    await prisma.evidenceReviewWorkflow.update({ where: { id: backfill.workflowId }, data: { escalatedAtUtc: new Date(), escalatedByUserId: null } });
    await escalation(backfill, { reason: "REVIEW_OVERDUE", createdByUserId: helperOwner, requiresIndependentReview: false, status: "RESOLVED" });
    const schema = await prisma.codingSchema.create({
      data: { teamId, name: "Legacy", slug: `rrec-${randomUUID().slice(0, 6)}`, label: "Legacy", category: "GENERAL_EVIDENCE", createdByUserId: ownerId, state: "PUBLISHED", status: "PUBLISHED", version: 1 } as never,
      select: { id: true },
    });
    const field = await prisma.codingField.create({
      data: { teamId, schemaId: schema.id, slug: "verdict", label: "Verdict", fieldType: "REVIEWER_VERDICT", required: true, orderIndex: 0, helpText: defaults.LEGACY_VERDICT_HELP_TEXT } as never,
      select: { id: true },
    });
    return { helperOwner, admin, adminEsc, creatorless, creatorlessEsc, integrity, integrityEsc, status, statusEsc, unknown, backfill, fieldId: field.id };
  }

  it("plans every record with its precondition, applies every writable category with an audit row each, and is idempotent", async () => {
    const f = await fixtures();
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    const byCat = (c: string) => plan.items.filter((i) => i.category === c).map((i) => i.recordId);
    expect(byCat("legacy_administrative_escalations")).toContain(f.adminEsc);
    expect(byCat("legacy_creatorless_escalations")).toContain(f.creatorlessEsc);
    expect(byCat("legacy_integrity_escalations")).toContain(f.integrityEsc);
    expect(byCat("legacy_escalated_status")).toContain(f.statusEsc);
    expect(byCat("legacy_escalated_status_unknown")).toContain(f.unknown.workflowId);
    expect(byCat("escalated_by_backfill")).toContain(f.backfill.workflowId);
    expect(byCat("seeded_verdict_help_text")).toContain(f.fieldId);
    // Every item carries its exact precondition and effect; report-only items carry no change.
    for (const i of plan.items) {
      if (svc.APPLICABLE_CATEGORIES.has(i.category)) expect(i.change).not.toBeNull();
      else expect(i.change).toBeNull();
      expect(i.effect.before.length).toBeGreaterThan(0);
    }
    // One record, one change: no record id appears twice.
    const changed = plan.items.filter((i) => i.change).map((i) => i.recordId);
    expect(new Set(changed).size).toBe(changed.length);
    // Planning wrote nothing.
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: f.adminEsc } })).requiresIndependentReview).toBeNull();

    const cats = [...svc.APPLICABLE_CATEGORIES];
    const applied = await svc.applyReconciliationPlan({ plan, expectedPlanHash: plan.planHash, categories: cats, operator: "QA operator" }, prisma);
    expect(applied.summary.failed).toBe(0);
    expect(applied.summary.changed_since_plan).toBe(0);
    expect(applied.summary.applied).toBe(plan.items.filter((i) => i.change).length);

    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: f.adminEsc } })).requiresIndependentReview).toBe(false);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: f.creatorlessEsc } })).requiresIndependentReview).toBe(false);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: f.integrityEsc } })).requiresIndependentReview).toBe(true);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: f.statusEsc } })).requiresIndependentReview).toBe(false);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: f.backfill.workflowId } })).escalatedByUserId).toBe(f.helperOwner);
    expect((await prisma.codingField.findUniqueOrThrow({ where: { id: f.fieldId } })).helpText).toBe(defaults.VERDICT_HELP_TEXT);
    // Effective behaviour after: the administrative/creator-less/status records stop forcing; integrity still forces.
    expect((await required(f.admin)).required).toBe(false);
    expect((await required(f.creatorless)).required).toBe(false);
    expect((await required(f.status)).required).toBe(false);
    expect((await required(f.integrity)).required).toBe(true);
    // Report-only stayed untouched.
    expect(await required(f.unknown)).toMatchObject({ required: true, reason: "legacy_escalated_status" });

    // One durable audit row per applied change: operation = plan hash, operator, record, before/after.
    const audit = await prisma.adminAuditLog.findMany({
      where: { action: "review.remediation.reconcile.applied", metadata: { path: ["planHash"], equals: plan.planHash } },
    });
    expect(audit).toHaveLength(applied.summary.applied);
    const row = audit.find((a) => a.resourceId === f.adminEsc)!;
    expect(row.metadata).toMatchObject({ operator: "QA operator", category: "legacy_administrative_escalations", field: "requires_independent_review", from: null, to: false });
    expect(row.workspaceId).toBe(teamId);

    // Re-apply: nothing changes, nothing new is audited.
    const again = await svc.applyReconciliationPlan({ plan, expectedPlanHash: plan.planHash, categories: cats, operator: "QA operator" }, prisma);
    expect(again.summary.applied).toBe(0);
    expect(again.summary.already_applied).toBe(applied.summary.applied);
    expect(
      await prisma.adminAuditLog.count({ where: { action: "review.remediation.reconcile.applied", metadata: { path: ["planHash"], equals: plan.planHash } } }),
    ).toBe(applied.summary.applied);

    // Compensation restores exactly the captured values, audited; repeated compensation is a no-op.
    const comp = await svc.compensateReconciliationPlan({ plan, expectedPlanHash: plan.planHash, operator: "QA operator" }, prisma);
    expect(comp.results.every((r) => r.outcome === "compensated")).toBe(true);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: f.adminEsc } })).requiresIndependentReview).toBeNull();
    expect((await prisma.codingField.findUniqueOrThrow({ where: { id: f.fieldId } })).helpText).toBe(defaults.LEGACY_VERDICT_HELP_TEXT);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: f.backfill.workflowId } })).escalatedByUserId).toBeNull();
    expect((await required(f.admin)).required).toBe(true);
    const comp2 = await svc.compensateReconciliationPlan({ plan, expectedPlanHash: plan.planHash, operator: "QA operator" }, prisma);
    expect(comp2.results.every((r) => r.outcome === "already_compensated")).toBe(true);
  });

  it("refuses a tampered plan, an unknown or report-only category and a missing operator", async () => {
    await fixtures();
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    const tampered = { ...plan, items: plan.items.slice(1) };
    await expect(
      svc.applyReconciliationPlan({ plan: tampered, expectedPlanHash: plan.planHash, categories: ["legacy_integrity_escalations"], operator: "x" }, prisma),
    ).rejects.toMatchObject({ code: "plan_hash_mismatch" });
    await expect(
      svc.applyReconciliationPlan({ plan, expectedPlanHash: plan.planHash, categories: ["overturned_challenges_before_change"], operator: "x" }, prisma),
    ).rejects.toMatchObject({ code: "category_not_applicable" });
    await expect(
      svc.applyReconciliationPlan({ plan, expectedPlanHash: plan.planHash, categories: ["nope"], operator: "x" }, prisma),
    ).rejects.toMatchObject({ code: "unknown_category" });
    await expect(
      svc.applyReconciliationPlan({ plan, expectedPlanHash: plan.planHash, categories: ["legacy_integrity_escalations"], operator: " " }, prisma),
    ).rejects.toMatchObject({ code: "operator_required" });
  });

  it("a stale plan: records changed after planning are reported and left alone; records created after planning are never touched", async () => {
    const f = await fixtures();
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    // Changed after planning: someone stored an explicit value meanwhile.
    await prisma.reviewEscalation.update({ where: { id: f.adminEsc }, data: { requiresIndependentReview: true } });
    // Created after planning.
    const later = await review();
    const laterEsc = await escalation(later, { reason: "WORKFLOW_STALLED", createdByUserId: f.helperOwner, requiresIndependentReview: null });
    const res = await svc.applyReconciliationPlan(
      { plan, expectedPlanHash: plan.planHash, categories: ["legacy_administrative_escalations"], operator: "QA operator" },
      prisma,
    );
    expect(res.results.find((r) => r.recordId === f.adminEsc)).toMatchObject({ outcome: "changed_since_plan", current: true });
    expect(res.results.some((r) => r.recordId === laterEsc)).toBe(false);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: f.adminEsc } })).requiresIndependentReview).toBe(true);
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: laterEsc } })).requiresIndependentReview).toBeNull();
    expect(
      await prisma.adminAuditLog.count({ where: { resourceId: f.adminEsc, action: "review.remediation.reconcile.applied", metadata: { path: ["planHash"], equals: plan.planHash } } }),
    ).toBe(0);
  });

  it("a failure inside the transaction rolls back the change and its audit row; a retry applies it once", async () => {
    const f = await fixtures();
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    const failing = await svc.applyReconciliationPlan(
      {
        plan,
        expectedPlanHash: plan.planHash,
        categories: ["legacy_creatorless_escalations"],
        operator: "QA operator",
        hooks: {
          beforeCommit: (item) => {
            if (item.recordId === f.creatorlessEsc) throw new Error("forced failure");
          },
        },
      },
      prisma,
    );
    expect(failing.results.find((r) => r.recordId === f.creatorlessEsc)).toMatchObject({ outcome: "failed" });
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: f.creatorlessEsc } })).requiresIndependentReview).toBeNull();
    const auditFor = () =>
      prisma.adminAuditLog.count({ where: { resourceId: f.creatorlessEsc, action: "review.remediation.reconcile.applied", metadata: { path: ["planHash"], equals: plan.planHash } } });
    expect(await auditFor()).toBe(0);
    const retry = await svc.applyReconciliationPlan(
      { plan, expectedPlanHash: plan.planHash, categories: ["legacy_creatorless_escalations"], operator: "QA operator" },
      prisma,
    );
    expect(retry.results.find((r) => r.recordId === f.creatorlessEsc)).toMatchObject({ outcome: "applied" });
    expect(await auditFor()).toBe(1);
  });

  it("compensation refuses a record changed after the apply (conflict) and leaves it alone", async () => {
    const f = await fixtures();
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    await svc.applyReconciliationPlan({ plan, expectedPlanHash: plan.planHash, categories: ["legacy_administrative_escalations"], operator: "QA operator" }, prisma);
    await prisma.reviewEscalation.update({ where: { id: f.adminEsc }, data: { requiresIndependentReview: true } });
    const comp = await svc.compensateReconciliationPlan({ plan, expectedPlanHash: plan.planHash, operator: "QA operator" }, prisma);
    expect(comp.results.find((r) => r.recordId === f.adminEsc)).toMatchObject({ outcome: "conflict", current: true });
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: f.adminEsc } })).requiresIndependentReview).toBe(true);
  });

  it("a pinned round stays pinned after its escalation is reclassified", async () => {
    const helper = await newUserId("pin");
    const r = await review();
    const e = await escalation(r, { reason: "WORKFLOW_STALLED", createdByUserId: helper, requiresIndependentReview: null });
    // A FIRST decision logged under the requirement (the decision authority's event shape).
    const d = await prisma.workflowReviewDecision.create({
      data: { workflowId: r.workflowId, teamId, stage: "FIRST", reviewerUserId: ownerId, decision: "APPROVE", rationale: "ok", round: 0 } as never,
      select: { id: true },
    });
    await prisma.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: r.workflowId,
        evidenceId: r.evidenceId,
        actorUserId: ownerId,
        eventType: "DECISION_LOGGED",
        nextValue: { decisionId: d.id, decision: "APPROVE", decisionStage: "FIRST", state: "second_required", round: 0, secondReviewCause: "legacy_escalation" },
      } as never,
    });
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    const item = plan.items.find((i) => i.recordId === e)!;
    expect(item.effect.roundPinned).toBe(true);
    await svc.applyReconciliationPlan({ plan, expectedPlanHash: plan.planHash, categories: ["legacy_administrative_escalations"], operator: "QA operator" }, prisma);
    expect(await required(r)).toMatchObject({ required: true, reason: "legacy_escalation" });
  });
});

describe("IR-04 — apply refuses an item whose reviewed context changed since planning", () => {
  const itemOf = (plan: { items: Array<{ recordId: string }> }, id: string) => plan.items.find((i) => i.recordId === id)!;
  const apply = (plan: Awaited<ReturnType<typeof svc.buildReconciliationPlan>>, categories: string[]) =>
    svc.applyReconciliationPlan({ plan, expectedPlanHash: plan.planHash, categories, operator: "QA operator" }, prisma);
  const auditCount = (recordId: string, planHash: string) =>
    prisma.adminAuditLog.count({
      where: { resourceId: recordId, action: "review.remediation.reconcile.applied", metadata: { path: ["planHash"], equals: planHash } },
    });

  it("every escalation item carries its precondition (escalation + review facts); attribution items carry their source escalation", async () => {
    const helper = await newUserId("pre");
    const r = await review();
    const e = await escalation(r, { reason: "WORKFLOW_STALLED", createdByUserId: helper, requiresIndependentReview: null });
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    expect(plan.version).toBe(2);
    expect(itemOf(plan, e)).toMatchObject({
      precondition: {
        escalation: { status: "OPEN", reason: "WORKFLOW_STALLED", createdByUserId: helper, workflowId: r.workflowId },
        workflow: { status: "IN_REVIEW", decisionRound: 0, roundPinned: false, setterEscalationId: null, causes: [], otherActiveEscalations: [] },
      },
    });
  });

  it("an escalation that moved OPEN → RESOLVED after planning (flag still NULL) is changed_since_plan, untouched, unaudited", async () => {
    const helper = await newUserId("res");
    const r = await review();
    const e = await escalation(r, { reason: "WORKFLOW_STALLED", createdByUserId: helper, requiresIndependentReview: null });
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    await prisma.reviewEscalation.update({ where: { id: e }, data: { status: "RESOLVED" } as never });
    const res = await apply(plan, ["legacy_administrative_escalations"]);
    expect(res.results.find((x) => x.recordId === e)).toMatchObject({ outcome: "changed_since_plan", current: null, changedFacts: ["escalation.status"] });
    expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: e } })).requiresIndependentReview).toBeNull();
    expect(await auditCount(e, plan.planHash)).toBe(0);
  });

  it("the review's round advanced, a legal hold was placed, or another escalation was raised after planning: each refuses the item and names the fact", async () => {
    const helper = await newUserId("ctx");
    const roundR = await review();
    const roundE = await escalation(roundR, { reason: "WORKFLOW_STALLED", createdByUserId: helper, requiresIndependentReview: null });
    const holdR = await review();
    const holdE = await escalation(holdR, { reason: "WORKFLOW_STALLED", createdByUserId: helper, requiresIndependentReview: null });
    const newEscR = await review();
    const newEscE = await escalation(newEscR, { reason: "WORKFLOW_STALLED", createdByUserId: helper, requiresIndependentReview: null });
    const statusR = await review();
    const statusE = await escalation(statusR, { reason: "WORKFLOW_STALLED", createdByUserId: helper, requiresIndependentReview: null });
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);

    await prisma.evidenceReviewWorkflow.update({ where: { id: roundR.workflowId }, data: { decisionRound: 1 } });
    await prisma.evidenceLegalHold.create({
      data: { scope: "EVIDENCE", evidenceId: holdR.evidenceId, teamId, status: "ACTIVE", title: "Hold", placedByUserId: ownerId } as never,
    });
    await escalation(newEscR, { reason: "REVIEW_OVERDUE", createdByUserId: helper, requiresIndependentReview: false });
    await prisma.evidenceReviewWorkflow.update({ where: { id: statusR.workflowId }, data: { status: "APPROVED_INTERNAL" } as never });

    const res = await apply(plan, ["legacy_administrative_escalations"]);
    const by = (id: string) => res.results.find((x) => x.recordId === id);
    expect(by(roundE)).toMatchObject({ outcome: "changed_since_plan", changedFacts: ["workflow.decisionRound"] });
    expect(by(holdE)).toMatchObject({ outcome: "changed_since_plan", changedFacts: ["workflow.causes"] });
    expect(by(newEscE)).toMatchObject({ outcome: "changed_since_plan", changedFacts: ["workflow.otherActiveEscalations"] });
    expect(by(statusE)).toMatchObject({ outcome: "changed_since_plan", changedFacts: ["workflow.status"] });
    for (const id of [roundE, holdE, newEscE, statusE]) {
      expect((await prisma.reviewEscalation.findUniqueOrThrow({ where: { id } })).requiresIndependentReview).toBeNull();
      expect(await auditCount(id, plan.planHash)).toBe(0);
    }
    // A fresh plan lists them again with the current context; that plan applies.
    const replan = await svc.buildReconciliationPlan({ teamId }, prisma);
    const again = await apply(replan, ["legacy_administrative_escalations"]);
    expect(again.results.find((x) => x.recordId === holdE)).toMatchObject({ outcome: "applied" });
  });

  it("two listed escalations on ONE review: applying one never makes its sibling stale (both apply)", async () => {
    const helper = await newUserId("sib");
    const r = await review();
    const a = await escalation(r, { reason: "WORKFLOW_STALLED", createdByUserId: helper, requiresIndependentReview: null });
    const b = await escalation(r, { reason: "REVIEW_OVERDUE", createdByUserId: helper, requiresIndependentReview: null });
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    expect(itemOf(plan, a)).toBeTruthy();
    expect(itemOf(plan, b)).toBeTruthy();
    const res = await apply(plan, ["legacy_administrative_escalations"]);
    expect(res.results.find((x) => x.recordId === a)).toMatchObject({ outcome: "applied" });
    expect(res.results.find((x) => x.recordId === b)).toMatchObject({ outcome: "applied" });
    expect((await required(r)).required).toBe(false);
  });

  it("attribution backfill: a newer person-raised escalation after planning changes the source; the item is refused", async () => {
    const first = await newUserId("attr1");
    const later = await newUserId("attr2");
    const r = await review();
    await prisma.evidenceReviewWorkflow.update({ where: { id: r.workflowId }, data: { escalatedAtUtc: new Date(), escalatedByUserId: null } });
    await escalation(r, { reason: "REVIEW_OVERDUE", createdByUserId: first, requiresIndependentReview: false, status: "RESOLVED" });
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    await new Promise((res) => setTimeout(res, 5));
    await escalation(r, { reason: "WORKFLOW_STALLED", createdByUserId: later, requiresIndependentReview: false, status: "RESOLVED" });
    const res = await apply(plan, ["escalated_by_backfill"]);
    expect(res.results.find((x) => x.recordId === r.workflowId)).toMatchObject({
      outcome: "changed_since_plan",
      changedFacts: ["attribution.createdByUserId", "attribution.escalationId"],
    });
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: r.workflowId } })).escalatedByUserId).toBeNull();
  });

  it("a version-1 plan (no preconditions) is refused even with a matching hash", async () => {
    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    const v1 = { kind: plan.kind, version: 1 as never, teamId: plan.teamId, items: plan.items.map((i) => ({ ...i, precondition: undefined })) };
    await expect(
      svc.applyReconciliationPlan({ plan: v1, expectedPlanHash: svc.planHashOf(v1), categories: ["legacy_integrity_escalations"], operator: "x" }, prisma),
    ).rejects.toMatchObject({ code: "plan_version_unsupported" });
  });
});

describe("IR-05 — the historical overturned-challenge report is decided per challenge, never by a fixed date", () => {
  async function challenge(r: { workflowId: string }, state: string, resolvedAtUtc: Date) {
    return (
      await prisma.reviewerDisagreement.create({
        data: { workflowId: r.workflowId, teamId, state, resolvedAtUtc, challengerUserId: ownerId, reason: "fixture" },
        select: { id: true },
      })
    ).id;
  }

  it("lists overturned challenges with no supersede record (26 Nov, 27 Nov, after deployment); omits those with a supersede event or a supersede audit row; changes no history", async () => {
    const { emitTenantAudit } = await import("../src/services/audit/tenant-audit.service.js");
    const r = await review();
    const before26 = await challenge(r, "RESOLVED_OVERTURNED", new Date("2026-11-26T12:00:00Z"));
    const on27 = await challenge(r, "RESOLVED_PARTIAL", new Date("2026-11-27T12:00:00Z"));
    const justBeforeDeploy = await challenge(r, "RESOLVED_OVERTURNED", new Date(Date.now() - 60_000));
    // The earlier code also audited the transition, without saying what it did to the review.
    await emitTenantAudit(
      { action: "reviewer.disagreement.transitioned", outcome: "success", sourceApp: "API", actorUserId: ownerId, workspaceId: teamId, resourceType: "reviewer_disagreement", resourceId: justBeforeDeploy, metadata: { disagreementId: justBeforeDeploy, toState: "RESOLVED_OVERTURNED" } },
      prisma as never,
    );
    // Superseded by the new behaviour on 27 Nov: a REOPENED event naming the challenge.
    const reopened = await challenge(r, "RESOLVED_OVERTURNED", new Date("2026-11-27T13:00:00Z"));
    await prisma.evidenceReviewWorkflowEvent.create({
      data: { workflowId: r.workflowId, evidenceId: r.evidenceId, actorUserId: ownerId, eventType: "REOPENED", nextValue: { source: "challenge_overturned", disagreementId: reopened } } as never,
    });
    // New behaviour, nothing left to supersede: the audit row says so.
    const alreadySuperseded = await challenge(r, "RESOLVED_OVERTURNED", new Date("2026-11-27T14:00:00Z"));
    await emitTenantAudit(
      { action: "reviewer.disagreement.transitioned", outcome: "success", sourceApp: "API", actorUserId: ownerId, workspaceId: teamId, resourceType: "reviewer_disagreement", resourceId: alreadySuperseded, metadata: { disagreementId: alreadySuperseded, superseded: "already_superseded" } },
      prisma as never,
    );
    const upheld = await challenge(r, "RESOLVED_UPHELD", new Date("2026-11-26T12:00:00Z"));
    const snapshot = await prisma.reviewerDisagreement.findMany({ where: { workflowId: r.workflowId }, orderBy: { id: "asc" } });

    const plan = await svc.buildReconciliationPlan({ teamId }, prisma);
    const listed = plan.items.filter((i) => i.category === "overturned_challenges_before_change").map((i) => i.recordId);
    expect(listed).toEqual(expect.arrayContaining([before26, on27, justBeforeDeploy]));
    for (const id of [reopened, alreadySuperseded, upheld]) expect(listed).not.toContain(id);
    expect(plan.items.find((i) => i.recordId === on27)).toMatchObject({ change: null });
    expect(await prisma.reviewerDisagreement.findMany({ where: { workflowId: r.workflowId }, orderBy: { id: "asc" } })).toEqual(snapshot);
  });
});
