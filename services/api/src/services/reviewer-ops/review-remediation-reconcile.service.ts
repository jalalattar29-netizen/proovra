/**
 * Review remediation (2026-11-27) — the SCOPED, IDEMPOTENT reconciliation of
 * existing records. Dry run by default: it reports what each category would
 * change and changes nothing. `apply` names the categories an owner approved;
 * every other category is only reported.
 *
 * Reading existing records correctly never depends on this job: the new code
 * reads `requires_independent_review IS NULL` with the legacy rule, corrects
 * the seeded help text at read time, and keeps pinned rounds pinned. This job
 * only changes STORED values, and only for the approved categories.
 *
 * Categories:
 *  - legacy_administrative_escalations (SEMANTIC — needs approval): ACTIVE
 *    escalations recorded before the change by a person for an administrative
 *    reason (requires_independent_review IS NULL, not an integrity reason).
 *    Today they force an independent second decision (legacy rule). Apply →
 *    store `false`: they stop forcing for rounds with no FIRST decision yet. A
 *    round whose FIRST decision was recorded under the requirement stays
 *    pinned (the decision event holds it) — nothing is finalized.
 *    Compensation: set the column back to NULL for the listed ids.
 *  - legacy_integrity_escalations (no semantic change): integrity reasons with
 *    NULL → `true` (they force under every rule). Compensation: back to NULL.
 *  - escalated_by_backfill (F-29, no semantic change): workflows whose
 *    `escalated_by_user_id` is NULL while their newest person-raised
 *    escalation names a creator. Compensation: back to NULL.
 *  - seeded_verdict_help_text (copy): coding fields still storing the legacy
 *    "recorded on closure" help text → the corrected text. Compensation: the
 *    legacy text is exported (LEGACY_VERDICT_HELP_TEXT).
 *  - overturned_challenges_before_change (REPORT ONLY): challenges resolved
 *    OVERTURNED / PARTIAL before 2026-11-27 left the review unchanged; each
 *    needs an owner's decision (reopen through the normal Reopen action).
 *  - administratively_escalated_status (REPORT ONLY): open reviews in stored
 *    status ESCALATED from an administrative Escalate (not a reviewer
 *    disagreement) with no forcing escalation — they no longer require an
 *    independent second decision. Listed for awareness; nothing to apply.
 */
import type { PrismaClient } from "@prisma/client";

import { INTEGRITY_ESCALATION_REASONS, REVIEWER_DISAGREEMENT_ESCALATION_REASON } from "@proovra/shared";

import { LEGACY_VERDICT_HELP_TEXT, VERDICT_HELP_TEXT } from "../reviewer-workspace/coding-schema-defaults.js";

export const REVIEW_REMEDIATION_CATEGORIES = [
  "legacy_administrative_escalations",
  "legacy_integrity_escalations",
  "escalated_by_backfill",
  "seeded_verdict_help_text",
  "overturned_challenges_before_change",
  "administratively_escalated_status",
] as const;
export type ReviewRemediationCategory = (typeof REVIEW_REMEDIATION_CATEGORIES)[number];

const APPLICABLE: ReadonlySet<ReviewRemediationCategory> = new Set([
  "legacy_administrative_escalations",
  "legacy_integrity_escalations",
  "escalated_by_backfill",
  "seeded_verdict_help_text",
]);

/** Challenges resolved before this instant predate the supersede behaviour. */
export const REVIEW_REMEDIATION_CUTOVER = new Date("2026-11-27T00:00:00.000Z");

const ACTIVE = ["OPEN", "ACKNOWLEDGED", "REASSIGNED"];
const OPEN_REVIEW_STATUSES = ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO", "RESPONSE_RECEIVED", "ESCALATED", "REOPENED", "NOT_STARTED"];

export type ReviewRemediationReport = {
  apply: boolean;
  teamId: string | null;
  categories: Record<ReviewRemediationCategory, { count: number; ids: string[]; applied: number; applicable: boolean }>;
};

export async function reconcileReviewRemediation(
  input: { apply?: ReadonlyArray<ReviewRemediationCategory>; teamId?: string | null; sampleIds?: number },
  client: PrismaClient,
): Promise<ReviewRemediationReport> {
  const applySet = new Set(input.apply ?? []);
  const teamFilter = input.teamId ? { teamId: input.teamId } : {};
  const sample = input.sampleIds ?? 50;
  const out = {} as ReviewRemediationReport["categories"];
  const integrity = [...INTEGRITY_ESCALATION_REASONS] as string[];

  // 1 + 2 — legacy escalations.
  const legacyAdmin = await client.reviewEscalation.findMany({
    where: {
      ...teamFilter,
      status: { in: ACTIVE },
      requiresIndependentReview: null,
      createdByUserId: { not: null },
      reason: { notIn: integrity },
    },
    select: { id: true },
  });
  const legacyIntegrity = await client.reviewEscalation.findMany({
    where: { ...teamFilter, requiresIndependentReview: null, reason: { in: integrity } },
    select: { id: true },
  });
  // 3 — escalated_by backfill.
  const unattributed = await client.evidenceReviewWorkflow.findMany({
    where: { ...teamFilter, escalatedByUserId: null, escalatedAtUtc: { not: null } },
    select: { id: true },
  });
  const backfill: Array<{ id: string; userId: string }> = [];
  for (const wf of unattributed) {
    const esc = await client.reviewEscalation.findFirst({
      where: { workflowId: wf.id, createdByUserId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { createdByUserId: true },
    });
    if (esc?.createdByUserId) backfill.push({ id: wf.id, userId: esc.createdByUserId });
  }
  // 4 — seeded help text.
  const helpRows = await client.codingField.findMany({
    where: { ...teamFilter, helpText: LEGACY_VERDICT_HELP_TEXT },
    select: { id: true },
  });
  // 5 — overturned challenges before the change.
  const overturned = await client.reviewerDisagreement.findMany({
    where: {
      ...teamFilter,
      state: { in: ["RESOLVED_OVERTURNED", "RESOLVED_PARTIAL"] },
      resolvedAtUtc: { lt: REVIEW_REMEDIATION_CUTOVER },
    },
    select: { id: true },
  });
  // 6 — administratively escalated stored status.
  const escalatedStatus = await client.evidenceReviewWorkflow.findMany({
    where: {
      ...teamFilter,
      status: "ESCALATED",
      // NULL reasons included explicitly: a SQL NOT on a nullable column
      // would silently drop them, and they are exactly the legacy rows.
      OR: [
        { escalationReason: null },
        { escalationReason: { not: REVIEWER_DISAGREEMENT_ESCALATION_REASON } },
      ],
    },
    select: { id: true },
  });

  const found: Record<ReviewRemediationCategory, string[]> = {
    legacy_administrative_escalations: legacyAdmin.map((r) => r.id),
    legacy_integrity_escalations: legacyIntegrity.map((r) => r.id),
    escalated_by_backfill: backfill.map((r) => r.id),
    seeded_verdict_help_text: helpRows.map((r) => r.id),
    overturned_challenges_before_change: overturned.map((r) => r.id),
    administratively_escalated_status: escalatedStatus.map((r) => r.id),
  };

  for (const category of REVIEW_REMEDIATION_CATEGORIES) {
    let applied = 0;
    if (applySet.has(category) && APPLICABLE.has(category)) {
      applied = await client.$transaction(async (tx) => {
        switch (category) {
          case "legacy_administrative_escalations":
            return (
              await tx.reviewEscalation.updateMany({
                where: { id: { in: found[category] }, requiresIndependentReview: null },
                data: { requiresIndependentReview: false },
              })
            ).count;
          case "legacy_integrity_escalations":
            return (
              await tx.reviewEscalation.updateMany({
                where: { id: { in: found[category] }, requiresIndependentReview: null },
                data: { requiresIndependentReview: true },
              })
            ).count;
          case "escalated_by_backfill": {
            let n = 0;
            for (const b of backfill) {
              n += (
                await tx.evidenceReviewWorkflow.updateMany({
                  where: { id: b.id, escalatedByUserId: null },
                  data: { escalatedByUserId: b.userId },
                })
              ).count;
            }
            return n;
          }
          case "seeded_verdict_help_text":
            return (
              await tx.codingField.updateMany({
                where: { id: { in: found[category] }, helpText: LEGACY_VERDICT_HELP_TEXT },
                data: { helpText: VERDICT_HELP_TEXT },
              })
            ).count;
          default:
            return 0;
        }
      });
    }
    out[category] = {
      count: found[category].length,
      ids: found[category].slice(0, sample),
      applied,
      applicable: APPLICABLE.has(category),
    };
  }
  return { apply: applySet.size > 0, teamId: input.teamId ?? null, categories: out };
}

/** Exported for the report: open review statuses the job considers. */
export const REVIEW_REMEDIATION_OPEN_STATUSES = OPEN_REVIEW_STATUSES;
