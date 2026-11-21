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
 * A SEALED team-less record requires its owner's approval (MATRIX-M626 below);
 * only an UNSEALED team-less record (an abandoned upload) requires none.
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
 * MATRIX-M626 (owner decision I, 2026-11-21) — a NULL team_id is NOT an
 * exemption. A SEALED record stored with team_id NULL (a legacy personal
 * record) requires its own owner's explicit approval for that record
 * (`EvidenceOwnerDestructionApproval`); no workspace is fabricated for it and
 * nothing approves old records in bulk. Only an UNSEALED record (an abandoned
 * upload) keeps no approval requirement — its expiry is a separate lifecycle.
 * Every other boundary (trash grace, retention, Object Lock, legal hold) still
 * applies in full whatever the approval says.
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

type ApprovalClient = Pick<
  PrismaClient,
  "destructionReview" | "destructionRequest" | "team" | "evidence" | "evidenceOwnerDestructionApproval"
>;

/**
 * The statuses of a record that was never sealed (an abandoned upload, a
 * discarded draft). Their expiry is a separate lifecycle (reservation release,
 * trash grace) with its own server-authoritative retention protections; the
 * owner-approval requirement is about SEALED records only.
 */
const UNSEALED_STATUSES: ReadonlySet<string> = new Set(["CREATED", "UPLOADING"]);

/**
 * MATRIX-M626 (owner decision I, 2026-11-21) — a record stored with team_id
 * NULL (a legacy personal record).
 *
 *   - UNSEALED (CREATED / UPLOADING): no approval requirement, exactly as
 *     before — the safe expiry of abandoned uploads is its own lifecycle.
 *   - SEALED (anything else, including an unknown status): an explicit
 *     approval is REQUIRED, and only the record's own owner can give it, for
 *     that one record, in its current trash cycle
 *     (`EvidenceOwnerDestructionApproval`, not withdrawn, bound to the record's
 *     current `deleted_at`). No workspace is invented for the record.
 *
 * The approval satisfies the approval requirement and nothing else: trash
 * grace, application retention (the eight-year platform period), Object Lock,
 * legal hold and the executor's switches are decided by the authority as
 * before. FAIL-CLOSED: a lookup failure or a missing record is "required, not
 * approved".
 */
async function verdictForTeamlessRecord(
  prisma: ApprovalClient,
  evidenceId: string,
): Promise<DestructionApprovalVerdict> {
  const refused: DestructionApprovalVerdict = { required: true, approved: false, destructionReviewId: null };
  try {
    const record = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { teamId: true, ownerUserId: true, status: true, deletedAt: true },
    });
    if (!record || record.teamId) return refused;
    if (UNSEALED_STATUSES.has(String(record.status))) {
      return { required: false, approved: false, destructionReviewId: null };
    }
    if (!record.deletedAt || !record.ownerUserId) return refused;
    const approval = await prisma.evidenceOwnerDestructionApproval.findFirst({
      where: {
        evidenceId,
        ownerUserId: record.ownerUserId,
        evidenceDeletedAtUtc: record.deletedAt,
        withdrawnAtUtc: null,
      },
      select: { id: true },
    });
    if (!approval) return refused;
    return {
      required: true,
      approved: true,
      destructionReviewId: null,
      approvedByUserIds: [record.ownerUserId],
    };
  } catch {
    return refused;
  }
}

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
    // MATRIX-M626 — a missing team_id is not a policy; the record decides.
    return verdictForTeamlessRecord(prisma, input.evidenceId);
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
