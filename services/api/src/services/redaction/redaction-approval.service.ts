/**
 * PROOVRA Phase 3A — Redaction approval service.
 *
 * Bounded approver verdicts on a version that is IN_REVIEW. The
 * verdict choice ties to a downstream state transition:
 *
 *   APPROVE           → version IN_REVIEW → APPROVED
 *   REJECT            → version IN_REVIEW → REJECTED
 *   REQUEST_CHANGES   → version IN_REVIEW → DRAFT (approver sent back)
 *   DEFER             → no state change; recorded for audit
 *
 * Hard rules:
 *   * REJECT and REQUEST_CHANGES require a non-empty rationale.
 *   * Approver MUST be a distinct user from the version author —
 *     enforced server-side here, never UI-only.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  REDACTION_APPROVAL_VERDICTS,
  type RedactionApprovalVerdict,
  type RedactionDenialReason,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitRedactionActivity } from "./redaction-activity.service.js";
import { transitionRedactionVersion } from "./redaction-project.service.js";

export type RecordApprovalInput = {
  prisma?: PrismaClient;
  teamId: string;
  versionId: string;
  verdict: RedactionApprovalVerdict;
  approverUserId: string;
  rationale?: string | null;
};

export type RecordApprovalResult =
  | { ok: true; approvalId: string }
  | { ok: false; denial: RedactionDenialReason };

export async function recordRedactionApproval(
  input: RecordApprovalInput,
): Promise<RecordApprovalResult> {
  if (
    !(REDACTION_APPROVAL_VERDICTS as ReadonlyArray<string>).includes(
      input.verdict,
    )
  ) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (
    (input.verdict === "REJECT" || input.verdict === "REQUEST_CHANGES") &&
    (!input.rationale || input.rationale.trim().length < 6)
  ) {
    return { ok: false, denial: "RATIONALE_REQUIRED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const version = await prisma.redactionVersion.findFirst({
    where: { id: input.versionId, teamId: input.teamId },
    select: {
      id: true,
      state: true,
      projectId: true,
      authoredByUserId: true,
    },
  });
  if (!version) return { ok: false, denial: "VERSION_NOT_FOUND" };
  if (version.state !== "IN_REVIEW") {
    return { ok: false, denial: "INVALID_TRANSITION" };
  }
  if (version.authoredByUserId === input.approverUserId) {
    // Server-side separation of duties — approver must differ from author.
    return { ok: false, denial: "NOT_PERMITTED" };
  }

  /*
   * PRO-094 (FEATURES-12) — THE VERDICT AND THE TRANSITION IT DRIVES COMMIT
   * TOGETHER, OR NEITHER DOES.
   *
   * The approval row was inserted first and the transition's result ignored,
   * so two concurrent verdicts on one IN_REVIEW version both recorded an
   * approval and the later transition overwrote the earlier: rows
   * [REQUEST_CHANGES, APPROVE], version in DRAFT. The row is now written inside
   * the transition's transaction, after its state compare-and-swap; the losing
   * verdict writes nothing and is refused (INVALID_TRANSITION, 409). DEFER
   * moves no state, so it holds the version row IN_REVIEW for its insert.
   */
  const toState =
    input.verdict === "APPROVE"
      ? ("APPROVED" as const)
      : input.verdict === "REJECT"
        ? ("REJECTED" as const)
        : input.verdict === "REQUEST_CHANGES"
          ? ("DRAFT" as const)
          : null;
  let created: { id: string } | null = null;
  const insertApproval = async (tx: Prisma.TransactionClient) => {
    created = await tx.redactionApproval.create({
      data: {
        teamId: input.teamId,
        versionId: input.versionId,
        verdict: input.verdict,
        rationale: input.rationale?.slice(0, 600) ?? null,
        approverUserId: input.approverUserId,
      },
      select: { id: true },
    });
  };
  if (toState) {
    const moved = await transitionRedactionVersion({
      prisma,
      teamId: input.teamId,
      versionId: input.versionId,
      toState,
      actorUserId: input.approverUserId,
      rationale: input.rationale ?? null,
      withinTransition: insertApproval,
    });
    if (!moved.ok) return { ok: false, denial: moved.denial };
  } else {
    const held = await prisma.$transaction(async (tx) => {
      const still = await tx.redactionVersion.updateMany({
        where: { id: input.versionId, teamId: input.teamId, state: "IN_REVIEW" },
        data: { state: "IN_REVIEW" },
      });
      if (still.count !== 1) return false;
      await insertApproval(tx);
      return true;
    });
    if (!held) return { ok: false, denial: "INVALID_TRANSITION" };
  }
  const approval = created as { id: string } | null;
  if (!approval) return { ok: false, denial: "INVALID_TRANSITION" };
  const code =
    input.verdict === "APPROVE"
      ? "APPROVAL_GRANTED"
      : input.verdict === "REJECT"
      ? "APPROVAL_DENIED"
      : input.verdict === "REQUEST_CHANGES"
      ? "APPROVAL_CHANGES_REQUESTED"
      : "APPROVAL_REQUESTED";
  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: version.projectId,
    versionId: input.versionId,
    code,
    actorUserId: input.approverUserId,
    payload: {
      approvalId: approval.id,
      verdict: input.verdict,
      rationalePreview: input.rationale?.slice(0, 80) ?? null,
    },
  });
  return { ok: true, approvalId: approval.id };
}

export async function listApprovalsForVersion(input: {
  prisma?: PrismaClient;
  teamId: string;
  versionId: string;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionApproval.findMany({
    where: { teamId: input.teamId, versionId: input.versionId },
    orderBy: { decidedAtUtc: "asc" },
  });
}
