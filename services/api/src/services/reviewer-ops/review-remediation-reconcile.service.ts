/**
 * Review remediation (2026-11-27) — reconciliation of EXISTING Review records,
 * bound to a reviewed plan (source review E, 2026-11-27).
 *
 *   1. PLAN (read-only). `buildReconciliationPlan` lists EVERY affected record
 *      (no sampling) with its category, the field and value it would change,
 *      the precondition (current value) and the effective before/after
 *      behaviour. The plan's identity is the SHA-256 of its canonical content
 *      (`planHash`). Report-only categories are listed and can never be applied.
 *
 *   2. APPLY (`applyReconciliationPlan`) takes the plan, its expected hash, the
 *      categories the owner approved and an operator name. It refuses a plan
 *      whose content does not match the hash. It only ever touches records
 *      listed in the plan, never ones that appeared afterwards. Each record is
 *      changed in its own transaction with a compare-and-set on the planned
 *      `from` value, and the same transaction writes a durable, hash-chained
 *      tenant audit row: operation = plan hash, operator, record, field,
 *      bounded before/after. A record whose value changed since planning is
 *      reported (`changed_since_plan`) and left alone. Re-applying the same
 *      plan is idempotent (`already_applied`).
 *
 *      IR-04 (2026-11-28) — the hash proves WHICH plan was approved; the
 *      item's `precondition` proves the reviewed CONTEXT is still current.
 *      Every escalation item carries the facts its before/after behaviour was
 *      derived from: the escalation's status, reason, creator and review; the
 *      review's status, decision round, round pin, setter escalation and the
 *      other causes that keep a second decision required. Attribution items
 *      carry the escalation the creator was taken from. At apply time the
 *      review row (then the escalation row) is locked — the same order every
 *      decision and coding write uses — the facts are recomputed, and any
 *      difference refuses the item as `changed_since_plan` with the names of
 *      the facts that changed (`changedFacts`). No contextual change is
 *      treated as harmless: re-plan and re-approve instead. Help-text items
 *      have no context beyond the stored text, which the compare-and-set
 *      already checks.
 *
 *   3. COMPENSATE (`compensateReconciliationPlan`) undoes exactly what a plan
 *      applied. It uses the before/after values captured in its audit rows,
 *      with the same compare-and-set (only when the record still holds the
 *      applied value), and writes an audit row per record. It never blindly
 *      resets a category.
 *
 * Reading existing records correctly never depends on this job. The read rules
 * keep the pre-change meaning for legacy records (`escalationIndependenceCause`
 * with NULL, `legacyEscalatedStatusForces`) and keep pinned rounds pinned.
 *
 * Categories (see `08-immediate-behaviour` and the reconciliation doc):
 *  - legacy_administrative_escalations — ACTIVE pre-change escalations raised
 *    by a person for a non-integrity reason (NULL). Today they force (legacy
 *    rule). Applying stores `false`: they stop forcing for rounds with no FIRST
 *    decision; pinned rounds stay pinned. SEMANTIC: needs the owner's approval.
 *  - legacy_creatorless_escalations — ACTIVE pre-change escalations with no
 *    creator and a reason that is neither an automatic-sweep nor an integrity
 *    reason (NULL). Today they force (pre-change rule). Same effect and approval.
 *  - legacy_escalated_status — open reviews held in stored status ESCALATED
 *    (not a reviewer disagreement) whose status was set by a pre-change
 *    escalation (NULL). Today the status forces. Applying stores `false` on
 *    THAT escalation (`requires_independent_review`), so the status stops
 *    forcing. SEMANTIC: needs approval.
 *  - legacy_integrity_escalations — integrity reasons with NULL → `true`. No
 *    change in behaviour (they force under every rule).
 *  - escalated_by_backfill — `escalated_by_user_id` NULL → the newest
 *    person-raised escalation's creator. Attribution only.
 *  - seeded_verdict_help_text — coding fields still storing the legacy help
 *    text → the corrected text. Copy only; reads already correct it.
 *  - legacy_escalated_status_unknown (REPORT ONLY) — open ESCALATED reviews
 *    whose setting escalation cannot be identified (no ESCALATED event with an
 *    escalation id). They keep forcing; resolving one needs a normal Review
 *    action by an owner.
 *  - overturned_challenges_before_change (REPORT ONLY) — challenges resolved
 *    OVERTURNED/PARTIAL whose resolution left NO supersede evidence: no
 *    resolution audit row stating what it did to the review (`superseded`)
 *    and no REOPENED / STAGE_CHANGED event referencing the challenge. IR-05
 *    (2026-11-28): decided per challenge, never by a fixed date — the old
 *    behaviour stayed in production until this change is deployed.
 */
import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  AUTOMATIC_SWEEP_ESCALATION_REASONS,
  INTEGRITY_ESCALATION_REASONS,
  REVIEWER_DISAGREEMENT_ESCALATION_REASON,
  escalationIndependenceCause,
} from "@proovra/shared";

import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { requiresSecondReview, roundPinnedToSecondReview } from "../evidence-review/second-review.service.js";
import { LEGACY_VERDICT_HELP_TEXT, VERDICT_HELP_TEXT } from "../reviewer-workspace/coding-schema-defaults.js";

export const REVIEW_REMEDIATION_CATEGORIES = [
  "legacy_administrative_escalations",
  "legacy_creatorless_escalations",
  "legacy_escalated_status",
  "legacy_integrity_escalations",
  "escalated_by_backfill",
  "seeded_verdict_help_text",
  "legacy_escalated_status_unknown",
  "overturned_challenges_before_change",
] as const;
export type ReviewRemediationCategory = (typeof REVIEW_REMEDIATION_CATEGORIES)[number];

export const APPLICABLE_CATEGORIES: ReadonlySet<ReviewRemediationCategory> = new Set([
  "legacy_administrative_escalations",
  "legacy_creatorless_escalations",
  "legacy_escalated_status",
  "legacy_integrity_escalations",
  "escalated_by_backfill",
  "seeded_verdict_help_text",
]);

export const RECONCILE_SERVICE_ACTOR = "ops.review-remediation-reconcile";
const AUDIT_APPLIED = "review.remediation.reconcile.applied";
const AUDIT_COMPENSATED = "review.remediation.reconcile.compensated";

const ACTIVE = ["OPEN", "ACKNOWLEDGED", "REASSIGNED"];
const INTEGRITY = [...INTEGRITY_ESCALATION_REASONS] as string[];
const SWEEP = [...AUTOMATIC_SWEEP_ESCALATION_REASONS] as string[];

type Db = PrismaClient | Prisma.TransactionClient;
type Scalar = string | boolean | null;

export type PlanChange =
  | { table: "review_escalations"; field: "requires_independent_review"; from: boolean | null; to: boolean }
  | { table: "evidence_review_workflows"; field: "escalated_by_user_id"; from: null; to: string }
  | { table: "coding_fields"; field: "help_text"; from: string; to: string };

/**
 * IR-04 — the facts an item's before/after behaviour was derived from. Apply
 * recomputes them under row locks; any difference refuses the item.
 */
export type PlanPrecondition = {
  escalation?: { status: string; reason: string; createdByUserId: string | null; workflowId: string };
  workflow?: {
    status: string;
    decisionRound: number;
    roundPinned: boolean;
    /** The escalation that set the stored ESCALATED status (newest ESCALATED event), if any. */
    setterEscalationId: string | null;
    /** Sorted non-escalation causes: active legal hold, redaction, workspace policy. */
    causes: string[];
    /**
     * The review's OTHER active escalations, by id. Their
     * `requires_independent_review` flag is deliberately not a fact: it is
     * written only when an escalation is created and by this job, so a
     * sibling item of the same plan never makes this item stale. A new
     * escalation, or a sibling's status / reason / creator changing, does.
     */
    otherActiveEscalations: Array<{ id: string; status: string; reason: string; createdByUserId: string | null }>;
  };
  /** escalated_by_backfill: the person-raised escalation the creator is taken from. */
  attribution?: { escalationId: string; createdByUserId: string };
};

export type PlanItem = {
  category: ReviewRemediationCategory;
  /** The record the change targets (escalation / workflow / coding field id). */
  recordId: string;
  teamId: string;
  workflowId: string | null;
  /** null for report-only categories. */
  change: PlanChange | null;
  /** IR-04 — the reviewed context (absent for help text and report-only items). */
  precondition?: PlanPrecondition;
  /** Effective behaviour, for the owner's review (bounded, ids and codes only). */
  effect: {
    before: string;
    after: string;
    /** The review's current round keeps its requirement regardless (pinned FIRST decision). */
    roundPinned?: boolean;
    /** Other causes that keep a second decision required on the review after applying. */
    otherCauses?: string[];
  };
};

export type ReconciliationPlan = {
  kind: "review-remediation-plan";
  /** 2 since IR-04 (preconditions). Version-1 plans are refused: re-plan. */
  version: 2;
  teamId: string | null;
  items: PlanItem[];
};

export type PlanWithHash = ReconciliationPlan & {
  planHash: string;
  generatedAt: string;
  counts: Record<ReviewRemediationCategory, { count: number; applicable: boolean }>;
};

/** Canonical JSON (sorted keys) — the hash never depends on key order. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export function planHashOf(plan: ReconciliationPlan): string {
  return createHash("sha256")
    .update(canonical({ kind: plan.kind, version: plan.version, teamId: plan.teamId, items: plan.items }))
    .digest("hex");
}

/** What an ACTIVE escalation-removal would leave requiring a second decision on the review. */
async function escalationEffect(
  client: Db,
  esc: { id: string; workflowId: string; teamId: string },
): Promise<{ roundPinned: boolean; otherCauses: string[]; workflowStatus: string | null }> {
  const wf = await client.evidenceReviewWorkflow.findUnique({
    where: { id: esc.workflowId },
    select: { id: true, evidenceId: true, status: true, decisionRound: true },
  });
  if (!wf) return { roundPinned: false, otherCauses: [], workflowStatus: null };
  const pinned = await roundPinnedToSecondReview({ workflowId: wf.id, round: wf.decisionRound }, client);
  const [holds, redactions, policy, others] = await Promise.all([
    client.evidenceLegalHold.count({ where: { teamId: esc.teamId, evidenceId: wf.evidenceId, status: "ACTIVE" } }),
    client.evidenceWorkflowVisibilityDecision.count({ where: { evidenceId: wf.evidenceId, requiresRedaction: true } }),
    client.workspaceGovernancePolicy.findUnique({ where: { teamId: esc.teamId }, select: { reviewRequiresIndependentApproval: true } }),
    client.reviewEscalation.findMany({
      where: { workflowId: wf.id, teamId: esc.teamId, status: { in: ACTIVE }, NOT: { id: esc.id } },
      select: { reason: true, createdByUserId: true, requiresIndependentReview: true },
    }),
  ]);
  const otherCauses: string[] = [];
  if (holds > 0) otherCauses.push("active_legal_hold");
  if (redactions > 0) otherCauses.push("redaction_required");
  if (policy?.reviewRequiresIndependentApproval) otherCauses.push("workspace_policy");
  for (const o of others) {
    const c = escalationIndependenceCause(o);
    if (c) otherCauses.push(`other_escalation:${c}`);
  }
  return { roundPinned: pinned !== null, otherCauses, workflowStatus: String(wf.status) };
}

/** IR-04 — the escalation facts an item depends on (null when the row is gone). */
async function escalationFacts(client: Db, escalationId: string): Promise<PlanPrecondition["escalation"] | null> {
  const e = await client.reviewEscalation.findUnique({
    where: { id: escalationId },
    select: { status: true, reason: true, createdByUserId: true, workflowId: true },
  });
  return e ? { status: String(e.status), reason: String(e.reason), createdByUserId: e.createdByUserId, workflowId: e.workflowId } : null;
}

/** IR-04 — the review facts an escalation item depends on (null when the review is gone). */
async function workflowFacts(
  client: Db,
  input: { workflowId: string; teamId: string; excludeEscalationId: string },
): Promise<PlanPrecondition["workflow"] | null> {
  const wf = await client.evidenceReviewWorkflow.findUnique({
    where: { id: input.workflowId },
    select: { id: true, evidenceId: true, status: true, decisionRound: true },
  });
  if (!wf) return null;
  const pinned = await roundPinnedToSecondReview({ workflowId: wf.id, round: wf.decisionRound }, client);
  const [holds, redactions, policy, others] = await Promise.all([
    client.evidenceLegalHold.count({ where: { teamId: input.teamId, evidenceId: wf.evidenceId, status: "ACTIVE" } }),
    client.evidenceWorkflowVisibilityDecision.count({ where: { evidenceId: wf.evidenceId, requiresRedaction: true } }),
    client.workspaceGovernancePolicy.findUnique({ where: { teamId: input.teamId }, select: { reviewRequiresIndependentApproval: true } }),
    client.reviewEscalation.findMany({
      where: { workflowId: wf.id, teamId: input.teamId, status: { in: ACTIVE }, NOT: { id: input.excludeEscalationId } },
      orderBy: { id: "asc" },
      select: { id: true, status: true, reason: true, createdByUserId: true },
    }),
  ]);
  const causes: string[] = [];
  if (holds > 0) causes.push("active_legal_hold");
  if (redactions > 0) causes.push("redaction_required");
  if (policy?.reviewRequiresIndependentApproval) causes.push("workspace_policy");
  const ev = await client.evidenceReviewWorkflowEvent.findFirst({
    where: { workflowId: input.workflowId, eventType: "ESCALATED" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { nextValue: true },
  });
  const setter = (ev?.nextValue as { escalationId?: unknown } | null)?.escalationId;
  return {
    status: String(wf.status),
    decisionRound: wf.decisionRound,
    roundPinned: pinned !== null,
    setterEscalationId: typeof setter === "string" ? setter : null,
    causes: causes.sort(),
    otherActiveEscalations: others.map((o) => ({
      id: o.id,
      status: String(o.status),
      reason: String(o.reason),
      createdByUserId: o.createdByUserId,
    })),
  };
}

/** IR-04 — the escalation the attribution backfill takes its creator from. */
async function attributionFacts(client: Db, workflowId: string): Promise<PlanPrecondition["attribution"] | null> {
  const esc = await client.reviewEscalation.findFirst({
    where: { workflowId, createdByUserId: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdByUserId: true },
  });
  return esc?.createdByUserId ? { escalationId: esc.id, createdByUserId: esc.createdByUserId } : null;
}

/** IR-04 — recompute an item's precondition with the same readers the plan used. */
async function currentPrecondition(client: Db, item: PlanItem): Promise<PlanPrecondition> {
  const want = item.precondition ?? {};
  const now: PlanPrecondition = {};
  if (want.escalation) now.escalation = (await escalationFacts(client, item.recordId)) ?? undefined;
  if (want.workflow && item.workflowId) {
    now.workflow = (await workflowFacts(client, { workflowId: item.workflowId, teamId: item.teamId, excludeEscalationId: item.recordId })) ?? undefined;
  }
  if (want.attribution && item.workflowId) now.attribution = (await attributionFacts(client, item.workflowId)) ?? undefined;
  return now;
}

/** The names of the facts that differ between the planned and the current precondition. */
function changedFacts(planned: PlanPrecondition, now: PlanPrecondition): string[] {
  const out: string[] = [];
  for (const group of ["escalation", "workflow", "attribution"] as const) {
    const a = planned[group] as Record<string, unknown> | undefined;
    if (!a) continue;
    const b = now[group] as Record<string, unknown> | undefined;
    if (!b) {
      out.push(`${group}:missing`);
      continue;
    }
    for (const k of Object.keys(a).sort()) if (canonical(a[k]) !== canonical(b[k])) out.push(`${group}.${k}`);
  }
  return out;
}

function afterText(e: { roundPinned: boolean; otherCauses: string[] }): string {
  if (e.roundPinned) return "the current round stays pinned: its FIRST decision still waits for an independent second decision";
  if (e.otherCauses.length > 0) return "a second decision is still required by the other causes listed";
  return "no second decision is required by this record; the next FIRST decision can finish the review";
}

/**
 * IR-05 — overturned / partially overturned challenges with NO supersede
 * evidence. The supersede behaviour records, in the resolution's transaction,
 * a `reviewer.disagreement.transitioned` audit row whose metadata states
 * what it did to the review (`superseded`: reopen / advance_round /
 * already_superseded) and, for a reopen or a round advance, a REOPENED /
 * STAGE_CHANGED event naming the challenge (`disagreementId`). A challenge
 * resolved by the earlier code has neither, whenever it was resolved.
 */
async function overturnedWithoutSupersede(
  client: Db,
  teamFilter: { teamId?: string },
): Promise<Array<{ id: string; teamId: string; workflowId: string | null; state: string }>> {
  const overturned = await client.reviewerDisagreement.findMany({
    where: { ...teamFilter, state: { in: ["RESOLVED_OVERTURNED", "RESOLVED_PARTIAL"] } },
    orderBy: { id: "asc" },
    select: { id: true, teamId: true, workflowId: true, state: true },
  });
  if (overturned.length === 0) return [];
  const ids = overturned.map((d) => d.id);
  const audits = await client.adminAuditLog.findMany({
    where: { action: "reviewer.disagreement.transitioned", resourceId: { in: ids } },
    select: { resourceId: true, metadata: true },
  });
  const evidenced = new Set<string>();
  for (const a of audits) {
    const m = a.metadata as Record<string, unknown> | null;
    if (a.resourceId && m && typeof m === "object" && "superseded" in m) evidenced.add(a.resourceId);
  }
  const workflowIds = [...new Set(overturned.map((d) => d.workflowId).filter((w): w is string => !!w))];
  if (workflowIds.length > 0) {
    const events = await client.evidenceReviewWorkflowEvent.findMany({
      where: { workflowId: { in: workflowIds }, eventType: { in: ["REOPENED", "STAGE_CHANGED"] } },
      select: { nextValue: true },
    });
    for (const e of events) {
      const id = (e.nextValue as { disagreementId?: unknown } | null)?.disagreementId;
      if (typeof id === "string") evidenced.add(id);
    }
  }
  return overturned.filter((d) => !evidenced.has(d.id)).map((d) => ({ ...d, state: String(d.state) }));
}

/**
 * The complete, read-only plan: every affected record, with exact preconditions
 * and effective behaviour. Nothing is written.
 */
export async function buildReconciliationPlan(input: { teamId?: string | null }, client: Db): Promise<PlanWithHash> {
  const teamFilter = input.teamId ? { teamId: input.teamId } : {};
  const items: PlanItem[] = [];

  // Escalations recorded before the change (NULL).
  const legacy = await client.reviewEscalation.findMany({
    where: { ...teamFilter, requiresIndependentReview: null },
    orderBy: { id: "asc" },
    select: { id: true, teamId: true, workflowId: true, reason: true, status: true, createdByUserId: true },
  });
  for (const e of legacy) {
    const reason = String(e.reason);
    const isIntegrity = INTEGRITY.includes(reason);
    const active = ACTIVE.includes(String(e.status));
    if (isIntegrity) {
      items.push({
        category: "legacy_integrity_escalations",
        recordId: e.id,
        teamId: e.teamId,
        workflowId: e.workflowId,
        change: { table: "review_escalations", field: "requires_independent_review", from: null, to: true },
        precondition: { escalation: (await escalationFacts(client, e.id))! },
        effect: { before: "forces an independent second decision (integrity reason)", after: "unchanged: forces (integrity reason)" },
      });
      continue;
    }
    if (!active) continue; // an inactive non-integrity escalation forces nothing itself (status setters are handled below)
    const category: ReviewRemediationCategory | null =
      e.createdByUserId != null
        ? "legacy_administrative_escalations"
        : SWEEP.includes(reason)
          ? null // automatic sweep: never forced, nothing to change
          : "legacy_creatorless_escalations";
    if (!category) continue;
    const eff = await escalationEffect(client, e);
    const wfFacts = await workflowFacts(client, { workflowId: e.workflowId, teamId: e.teamId, excludeEscalationId: e.id });
    items.push({
      category,
      recordId: e.id,
      teamId: e.teamId,
      workflowId: e.workflowId,
      change: { table: "review_escalations", field: "requires_independent_review", from: null, to: false },
      precondition: { escalation: (await escalationFacts(client, e.id))!, ...(wfFacts ? { workflow: wfFacts } : {}) },
      effect: {
        before: "forces an independent second decision (pre-change rule)",
        after: `stops forcing: ${afterText(eff)}`,
        roundPinned: eff.roundPinned,
        otherCauses: eff.otherCauses,
      },
    });
  }

  // Open reviews held in stored status ESCALATED that is not a reviewer disagreement.
  const escalatedReviews = await client.evidenceReviewWorkflow.findMany({
    where: {
      ...teamFilter,
      status: "ESCALATED",
      OR: [{ escalationReason: null }, { escalationReason: { not: REVIEWER_DISAGREEMENT_ESCALATION_REASON } }],
    },
    orderBy: { id: "asc" },
    select: { id: true, teamId: true, evidenceId: true, decisionRound: true },
  });
  for (const wf of escalatedReviews) {
    if (!wf.teamId) continue;
    const ev = await client.evidenceReviewWorkflowEvent.findFirst({
      where: { workflowId: wf.id, eventType: "ESCALATED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { nextValue: true },
    });
    const setterId = (ev?.nextValue as { escalationId?: unknown } | null)?.escalationId;
    const setter =
      typeof setterId === "string"
        ? await client.reviewEscalation.findFirst({
            where: { id: setterId, workflowId: wf.id, teamId: wf.teamId },
            select: { id: true, requiresIndependentReview: true, reason: true },
          })
        : null;
    if (setter && setter.requiresIndependentReview != null) continue; // a post-change status: forces nothing by itself
    const pinned = (await roundPinnedToSecondReview({ workflowId: wf.id, round: wf.decisionRound }, client)) !== null;
    if (!setter) {
      items.push({
        category: "legacy_escalated_status_unknown",
        recordId: wf.id,
        teamId: wf.teamId,
        workflowId: wf.id,
        change: null,
        effect: {
          before: "the stored ESCALATED status forces an independent second decision (pre-change rule)",
          after: "unchanged (report only): the escalation that set the status cannot be identified",
          roundPinned: pinned,
        },
      });
      continue;
    }
    if (INTEGRITY.includes(String(setter.reason))) continue; // integrity: always forces; the integrity category covers the row
    // One record, one change: an escalation already listed (an ACTIVE legacy
    // escalation that also set this status) carries both effects in its item.
    const listed = items.find((i) => i.recordId === setter.id && i.change);
    if (listed) {
      listed.effect.after += `; it also set review ${wf.id}'s ESCALATED status, which stops forcing by itself`;
      continue;
    }
    const live = await requiresSecondReview({ workflowId: wf.id, teamId: wf.teamId, evidenceId: wf.evidenceId }, client);
    const statusFacts = await workflowFacts(client, { workflowId: wf.id, teamId: wf.teamId, excludeEscalationId: setter.id });
    items.push({
      category: "legacy_escalated_status",
      recordId: setter.id,
      teamId: wf.teamId,
      workflowId: wf.id,
      change: { table: "review_escalations", field: "requires_independent_review", from: null, to: false },
      precondition: { escalation: (await escalationFacts(client, setter.id))!, ...(statusFacts ? { workflow: statusFacts } : {}) },
      effect: {
        before: `the stored ESCALATED status forces an independent second decision (pre-change rule; live cause ${live.reason ?? "none"})`,
        after: `the status stops forcing by itself${pinned ? "; the current round stays pinned" : ""}`,
        roundPinned: pinned,
      },
    });
  }

  // escalated_by backfill.
  const unattributed = await client.evidenceReviewWorkflow.findMany({
    where: { ...teamFilter, escalatedByUserId: null, escalatedAtUtc: { not: null } },
    orderBy: { id: "asc" },
    select: { id: true, teamId: true },
  });
  for (const wf of unattributed) {
    if (!wf.teamId) continue;
    const attribution = await attributionFacts(client, wf.id);
    if (!attribution) continue;
    items.push({
      category: "escalated_by_backfill",
      recordId: wf.id,
      teamId: wf.teamId,
      workflowId: wf.id,
      change: { table: "evidence_review_workflows", field: "escalated_by_user_id", from: null, to: attribution.createdByUserId },
      precondition: { attribution },
      effect: { before: "escalation shown without who raised it", after: "attribution only; no behaviour change" },
    });
  }

  // Seeded help text.
  const helpRows = await client.codingField.findMany({
    where: { ...teamFilter, helpText: LEGACY_VERDICT_HELP_TEXT },
    orderBy: { id: "asc" },
    select: { id: true, teamId: true },
  });
  for (const f of helpRows) {
    items.push({
      category: "seeded_verdict_help_text",
      recordId: f.id,
      teamId: f.teamId,
      workflowId: null,
      change: { table: "coding_fields", field: "help_text", from: LEGACY_VERDICT_HELP_TEXT, to: VERDICT_HELP_TEXT },
      effect: { before: "stored legacy help text (already corrected when read)", after: "stored corrected help text; no behaviour change" },
    });
  }

  // Report only: overturned / partially overturned challenges whose
  // resolution left no supersede evidence (IR-05: per challenge, no date).
  for (const d of await overturnedWithoutSupersede(client, teamFilter)) {
    items.push({
      category: "overturned_challenges_before_change",
      recordId: d.id,
      teamId: d.teamId,
      workflowId: d.workflowId,
      change: null,
      effect: {
        before: `resolved as ${d.state === "RESOLVED_PARTIAL" ? "partially overturned" : "overturned"} without superseding the review (no supersede record)`,
        after: "unchanged (report only): reopen through the normal Reopen action if wanted",
      },
    });
  }

  items.sort((a, b) => (a.category === b.category ? a.recordId.localeCompare(b.recordId) : a.category.localeCompare(b.category)));
  const plan: ReconciliationPlan = { kind: "review-remediation-plan", version: 2, teamId: input.teamId ?? null, items };
  const counts = Object.fromEntries(
    REVIEW_REMEDIATION_CATEGORIES.map((c) => [c, { count: items.filter((i) => i.category === c).length, applicable: APPLICABLE_CATEGORIES.has(c) }]),
  ) as PlanWithHash["counts"];
  return { ...plan, planHash: planHashOf(plan), generatedAt: new Date().toISOString(), counts };
}

export type ApplyItemResult = {
  category: ReviewRemediationCategory;
  recordId: string;
  outcome: "applied" | "already_applied" | "changed_since_plan" | "not_found" | "failed" | "not_selected";
  current?: Scalar;
  /** IR-04 — which reviewed facts changed since planning. */
  changedFacts?: string[];
  error?: string;
};

export type ApplyReport = {
  planHash: string;
  operator: string;
  categories: ReviewRemediationCategory[];
  results: ApplyItemResult[];
  summary: Record<ApplyItemResult["outcome"], number>;
};

export class ReconcilePlanError extends Error {
  constructor(
    public readonly code:
      | "plan_hash_mismatch"
      | "plan_version_unsupported"
      | "category_not_applicable"
      | "unknown_category"
      | "operator_required",
  ) {
    super(code);
  }
}

function summarize(results: ApplyItemResult[]): ApplyReport["summary"] {
  const s = { applied: 0, already_applied: 0, changed_since_plan: 0, not_found: 0, failed: 0, not_selected: 0 };
  for (const r of results) s[r.outcome] += 1;
  return s;
}

async function readCurrent(client: Db, change: PlanChange, recordId: string): Promise<{ found: boolean; value: Scalar }> {
  switch (change.table) {
    case "review_escalations": {
      const r = await client.reviewEscalation.findUnique({ where: { id: recordId }, select: { requiresIndependentReview: true } });
      return { found: !!r, value: r?.requiresIndependentReview ?? null };
    }
    case "evidence_review_workflows": {
      const r = await client.evidenceReviewWorkflow.findUnique({ where: { id: recordId }, select: { escalatedByUserId: true } });
      return { found: !!r, value: r?.escalatedByUserId ?? null };
    }
    case "coding_fields": {
      const r = await client.codingField.findUnique({ where: { id: recordId }, select: { helpText: true } });
      return { found: !!r, value: r?.helpText ?? null };
    }
  }
}

/** Compare-and-set: writes `to` only where the record still holds `from`. Returns rows changed. */
async function casWrite(tx: Prisma.TransactionClient, change: PlanChange, recordId: string, from: Scalar, to: Scalar): Promise<number> {
  switch (change.table) {
    case "review_escalations":
      return (
        await tx.reviewEscalation.updateMany({
          where: { id: recordId, requiresIndependentReview: from as boolean | null },
          data: { requiresIndependentReview: to as boolean | null },
        })
      ).count;
    case "evidence_review_workflows":
      return (
        await tx.evidenceReviewWorkflow.updateMany({
          where: { id: recordId, escalatedByUserId: from as string | null },
          data: { escalatedByUserId: to as string | null },
        })
      ).count;
    case "coding_fields":
      return (
        await tx.codingField.updateMany({ where: { id: recordId, helpText: from as string | null }, data: { helpText: to as string | null } })
      ).count;
  }
}

/** Bounded value for the audit row (help text is at most 800 characters). */
const bounded = (v: Scalar): Scalar => (typeof v === "string" ? v.slice(0, 800) : v);

async function auditChange(
  tx: Prisma.TransactionClient,
  action: string,
  input: { planHash: string; operator: string; item: PlanItem; from: Scalar; to: Scalar },
): Promise<void> {
  const change = input.item.change!;
  await emitTenantAudit(
    {
      action,
      outcome: "success",
      sourceApp: "SYSTEM",
      actorUserId: null,
      serviceActor: RECONCILE_SERVICE_ACTOR,
      workspaceId: input.item.teamId,
      resourceType: change.table,
      resourceId: input.item.recordId,
      correlationId: input.planHash,
      previousState: input.from === null ? "NULL" : String(input.from).slice(0, 64),
      resultingState: input.to === null ? "NULL" : String(input.to).slice(0, 64),
      reasonCode: input.item.category,
      metadata: {
        planHash: input.planHash,
        operator: input.operator.slice(0, 160),
        category: input.item.category,
        table: change.table,
        field: change.field,
        recordId: input.item.recordId,
        workflowId: input.item.workflowId,
        from: bounded(input.from),
        to: bounded(input.to),
      },
    },
    tx as unknown as PrismaClient,
  );
}

async function appliedByPlan(client: Db, planHash: string, recordId: string, action: string): Promise<boolean> {
  return (
    (await client.adminAuditLog.count({
      where: { action, resourceId: recordId, metadata: { path: ["planHash"], equals: planHash } },
    })) > 0
  );
}

function validateApplyInput(plan: ReconciliationPlan, expectedHash: string, categories: ReadonlyArray<string>, operator: string) {
  if (planHashOf(plan) !== expectedHash) throw new ReconcilePlanError("plan_hash_mismatch");
  if (plan.version !== 2) throw new ReconcilePlanError("plan_version_unsupported");
  if (!operator || !operator.trim()) throw new ReconcilePlanError("operator_required");
  for (const c of categories) {
    if (!(REVIEW_REMEDIATION_CATEGORIES as ReadonlyArray<string>).includes(c)) throw new ReconcilePlanError("unknown_category");
    if (!APPLICABLE_CATEGORIES.has(c as ReviewRemediationCategory)) throw new ReconcilePlanError("category_not_applicable");
  }
}

/**
 * Apply the approved categories of a reviewed plan. Only listed records,
 * each in its own transaction (compare-and-set + audit row), never new ones.
 * `hooks.beforeCommit` exists for tests (forced failure inside the transaction).
 */
export async function applyReconciliationPlan(
  input: {
    plan: ReconciliationPlan;
    expectedPlanHash: string;
    categories: ReadonlyArray<string>;
    operator: string;
    hooks?: { beforeCommit?: (item: PlanItem) => Promise<void> | void };
  },
  client: PrismaClient,
): Promise<ApplyReport> {
  validateApplyInput(input.plan, input.expectedPlanHash, input.categories, input.operator);
  const selected = new Set(input.categories as ReviewRemediationCategory[]);
  const results: ApplyItemResult[] = [];
  for (const item of input.plan.items) {
    if (!item.change || !selected.has(item.category)) {
      if (item.change) results.push({ category: item.category, recordId: item.recordId, outcome: "not_selected" });
      continue;
    }
    const change = item.change;
    try {
      const outcome = await client.$transaction(async (tx) => {
        if (item.precondition) {
          // IR-04 — lock the review row first (the order every decision and
          // coding write uses), then the escalation row, and recompute the
          // reviewed facts; any difference refuses the item.
          if (item.workflowId) {
            await tx.$queryRaw`SELECT "id" FROM "evidence_review_workflows" WHERE "id" = ${item.workflowId}::uuid FOR UPDATE`;
          }
          if (change.table === "review_escalations") {
            await tx.$queryRaw`SELECT "id" FROM "review_escalations" WHERE "id" = ${item.recordId}::uuid FOR UPDATE`;
          }
          const diff = changedFacts(item.precondition, await currentPrecondition(tx, item));
          if (diff.length > 0) {
            const cur = await readCurrent(tx, change, item.recordId);
            if (!cur.found) return { outcome: "not_found" as const };
            if (cur.value === change.to && (await appliedByPlan(tx, input.expectedPlanHash, item.recordId, AUDIT_APPLIED))) {
              return { outcome: "already_applied" as const, current: cur.value };
            }
            return { outcome: "changed_since_plan" as const, current: cur.value, changedFacts: diff };
          }
        }
        const n = await casWrite(tx, change, item.recordId, change.from, change.to);
        if (n === 1) {
          await auditChange(tx, AUDIT_APPLIED, { planHash: input.expectedPlanHash, operator: input.operator, item, from: change.from, to: change.to });
          await input.hooks?.beforeCommit?.(item);
          return { outcome: "applied" as const };
        }
        const cur = await readCurrent(tx, change, item.recordId);
        if (!cur.found) return { outcome: "not_found" as const };
        if (cur.value === change.to && (await appliedByPlan(tx, input.expectedPlanHash, item.recordId, AUDIT_APPLIED))) {
          return { outcome: "already_applied" as const, current: cur.value };
        }
        return { outcome: "changed_since_plan" as const, current: cur.value };
      });
      results.push({ category: item.category, recordId: item.recordId, ...outcome });
    } catch (err) {
      results.push({ category: item.category, recordId: item.recordId, outcome: "failed", error: err instanceof Error ? err.message.slice(0, 200) : "error" });
    }
  }
  return { planHash: input.expectedPlanHash, operator: input.operator, categories: [...selected], results, summary: summarize(results) };
}

export type CompensateItemResult = {
  recordId: string;
  outcome: "compensated" | "already_compensated" | "conflict" | "not_found" | "failed";
  current?: Scalar;
  error?: string;
};

/**
 * Undo exactly what this plan applied, from the before/after values its audit
 * rows captured. Compare-and-set on the applied value; an audit row per record.
 */
export async function compensateReconciliationPlan(
  input: { plan: ReconciliationPlan; expectedPlanHash: string; operator: string },
  client: PrismaClient,
): Promise<{ planHash: string; results: CompensateItemResult[] }> {
  if (planHashOf(input.plan) !== input.expectedPlanHash) throw new ReconcilePlanError("plan_hash_mismatch");
  if (!input.operator?.trim()) throw new ReconcilePlanError("operator_required");
  const applied = await client.adminAuditLog.findMany({
    where: { action: AUDIT_APPLIED, metadata: { path: ["planHash"], equals: input.expectedPlanHash } },
    orderBy: { createdAt: "asc" },
    select: { resourceId: true, metadata: true },
  });
  const byRecord = new Map(input.plan.items.filter((i) => i.change).map((i) => [i.recordId, i]));
  const results: CompensateItemResult[] = [];
  for (const row of applied) {
    const recordId = row.resourceId ?? "";
    const item = byRecord.get(recordId);
    const meta = row.metadata as { from?: Scalar; to?: Scalar };
    if (!item?.change) continue;
    const captured = { from: meta.from ?? null, to: meta.to ?? null };
    try {
      const r = await client.$transaction(async (tx) => {
        const n = await casWrite(tx, item.change!, recordId, captured.to, captured.from);
        if (n === 1) {
          await auditChange(tx, AUDIT_COMPENSATED, { planHash: input.expectedPlanHash, operator: input.operator, item, from: captured.to, to: captured.from });
          return { outcome: "compensated" as const };
        }
        const cur = await readCurrent(tx, item.change!, recordId);
        if (!cur.found) return { outcome: "not_found" as const };
        if (cur.value === captured.from && (await appliedByPlan(tx, input.expectedPlanHash, recordId, AUDIT_COMPENSATED))) {
          return { outcome: "already_compensated" as const, current: cur.value };
        }
        return { outcome: "conflict" as const, current: cur.value };
      });
      results.push({ recordId, ...r });
    } catch (err) {
      results.push({ recordId, outcome: "failed", error: err instanceof Error ? err.message.slice(0, 200) : "error" });
    }
  }
  return { planHash: input.expectedPlanHash, results };
}
