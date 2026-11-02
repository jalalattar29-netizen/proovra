/**
 * THE ONE ANSWER to "does this record need an approved destruction, and does it
 * have one?", and the one switch that stops destruction.
 *
 * The executor refuses to guess this. It reads the verdict itself, inside its
 * decision transaction, so no caller can vouch for an approval; before GOV-001
 * two API callers passed a literal `destructionApproved: true`, which is how a
 * request of one workspace could destroy a record of another.
 *
 * THE RULE
 * ---------------------------------------------------------------------------
 * WORKSPACE-scoped evidence always requires an approved destruction record.
 * PERSONAL-scope evidence never does.
 *
 * That is a deliberate choice of the conservative reading over a configurable
 * one. There is no "destruction requires approval" column on
 * `WorkspaceGovernancePolicy`, and inventing one would mean every existing
 * workspace defaults to SOME value on the day the migration lands — and the
 * only safe default is "required", which is what this rule already says without
 * a schema change. A workspace that wants a record destroyed goes through the
 * destruction-review pipeline it already has; there is no configuration under
 * which an unreviewed automatic sweep may destroy another organisation's
 * evidence.
 *
 * Personal-scope evidence is excluded because there is no second party to
 * approve to: the owner asked for it, the owner is the workspace, and every
 * other boundary (trash grace, retention, Object Lock, legal hold) still
 * applies to it in full.
 *
 * WHAT COUNTS AS APPROVED (GOV-002, GOV-003)
 * ---------------------------------------------------------------------------
 * A review counts only once a person has asked for execution: APPROVED is a
 * reversible decision and reaches no storage on its own. A request counts only
 * while it is EXECUTING, in the record's own workspace, naming this record, with
 * every listed approver signed and the requester not among them. Any named
 * governance record that fails this refuses the destruction, whatever the record
 * itself would otherwise allow.
 */

import type { PrismaClient } from "@prisma/client";

import { resolveEvidenceWorkspaceId } from "../workspace-scope.js";

export interface DestructionApprovalVerdict {
  required: boolean;
  approved: boolean;
  /** The approving record, when there is one. Recorded in the certificate. */
  destructionReviewId: string | null;
  /** The people who signed, for the certificate. */
  approvedByUserIds?: string[];
  /** True when the caller named a governance record that does not authorise this. */
  refusedNamedRecord?: boolean;
}

type ApprovalClient = Pick<PrismaClient, "destructionReview" | "destructionRequest" | "team">;

/**
 * `DESTRUCTION_EXECUTION_ENABLED` — THE switch (GOV-002, OPS-002). Off unless it
 * says otherwise, because what it guards cannot be undone: the only thing the
 * default can cost is a typed refusal. The API, the sweep and the executor all
 * read this one function; the executor's read is the one no caller can skip.
 */
export function destructionExecutionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(env.DESTRUCTION_EXECUTION_ENABLED ?? "").trim().toLowerCase(),
  );
}

type ApproverEntry = { userId: string; approvedAtUtc: string | null };

function readApprovers(value: unknown): ApproverEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const e = entry as { userId?: unknown; approvedAtUtc?: unknown } | null;
    return typeof e?.userId === "string"
      ? [{ userId: e.userId, approvedAtUtc: typeof e.approvedAtUtc === "string" ? e.approvedAtUtc : null }]
      : [];
  });
}

async function verdictForRequest(
  prisma: ApprovalClient,
  input: { evidenceId: string; teamId: string | null; ownerUserId?: string | null; destructionRequestId: string },
): Promise<DestructionApprovalVerdict> {
  const refused: DestructionApprovalVerdict = {
    required: true,
    approved: false,
    destructionReviewId: null,
    refusedNamedRecord: true,
  };
  const request = await prisma.destructionRequest.findUnique({
    where: { id: input.destructionRequestId },
    select: { teamId: true, state: true, evidenceIds: true, approverUserIds: true, requestedByUserId: true },
  });
  if (!request || request.state !== "EXECUTING") return refused;
  const workspaceId = await resolveEvidenceWorkspaceId(
    { teamId: input.teamId, ownerUserId: input.ownerUserId ?? null },
    prisma,
  );
  if (!workspaceId || workspaceId !== request.teamId) return refused;
  if (!Array.isArray(request.evidenceIds) || !request.evidenceIds.includes(input.evidenceId)) return refused;
  const chain = readApprovers(request.approverUserIds);
  const signed =
    chain.length > 0 &&
    chain.every((e) => e.approvedAtUtc !== null) &&
    !chain.some((e) => e.userId === request.requestedByUserId);
  if (!signed) return refused;
  return {
    required: true,
    approved: true,
    destructionReviewId: null,
    approvedByUserIds: chain.map((e) => e.userId),
  };
}

/**
 * Approval is satisfied by a DestructionReview for THIS evidence in this team
 * that has reached APPROVED, has an execution request, and has not been
 * withdrawn; or by the Phase 4B request named by the caller.
 *
 * FAIL-CLOSED: a lookup failure reports "required and not approved". This
 * function's output gates an irreversible operation, so the failure mode has to
 * be a refused destruction, never an unreviewed one.
 */
export async function resolveDestructionApproval(
  prisma: ApprovalClient,
  input: {
    evidenceId: string;
    teamId: string | null;
    ownerUserId?: string | null;
    destructionReviewId?: string | null;
    destructionRequestId?: string | null;
  },
): Promise<DestructionApprovalVerdict> {
  const named = Boolean(input.destructionReviewId || input.destructionRequestId);
  if (!input.teamId && !named) {
    return { required: false, approved: false, destructionReviewId: null };
  }
  try {
    if (input.destructionRequestId) {
      return await verdictForRequest(prisma, { ...input, destructionRequestId: input.destructionRequestId });
    }
    const review = input.teamId
      ? await prisma.destructionReview.findFirst({
          where: {
            ...(input.destructionReviewId ? { id: input.destructionReviewId } : {}),
            evidenceId: input.evidenceId,
            teamId: input.teamId,
            status: "APPROVED",
            executionRequestedAtUtc: { not: null },
          },
          orderBy: { decidedAtUtc: "desc" },
          select: { id: true, decidedByUserId: true },
        })
      : null;
    return {
      required: true,
      approved: review !== null,
      destructionReviewId: review?.id ?? null,
      approvedByUserIds: review?.decidedByUserId ? [review.decidedByUserId] : [],
      ...(named && review === null ? { refusedNamedRecord: true } : {}),
    };
  } catch {
    return {
      required: true,
      approved: false,
      destructionReviewId: null,
      ...(named ? { refusedNamedRecord: true } : {}),
    };
  }
}
