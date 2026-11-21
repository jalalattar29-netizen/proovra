/**
 * MATRIX-M626 (owner decision I, 2026-11-21) — the approval path for a SEALED
 * legacy record stored with team_id NULL.
 *
 * `resolveDestructionApproval` (shared-runtime) requires an explicit approval
 * before the executor, the trash-grace reconciler or the purge job may destroy
 * such a record. A workspace record gets it from its workspace's destruction
 * review (Enterprise: the governed two-person path; a self-serve workspace: its
 * owner, DEC-05). A team-less record has no workspace a review could live in,
 * and none is fabricated, so its own owner approves here:
 *
 *   - ONE record per call, by its owner only (never another member, never an
 *     operator, never a bulk call, never a backfill);
 *   - only while the record is in the Trash, the Retention Archive or a
 *     destruction claim (it has a `deleted_at`), and only for that trash cycle:
 *     a restore and a later trash need a new approval;
 *   - only for a SEALED record (an unsealed abandoned upload expires on its own
 *     lifecycle and needs no approval);
 *   - withdrawable until the record is destroyed.
 *
 * The approval satisfies the approval requirement ONLY. Trash grace,
 * application retention (the eight-year platform period), Object Lock, legal
 * hold and the destruction switches still decide, in the executor, as before.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

const UNSEALED = new Set(["CREATED", "UPLOADING"]);

export type OwnerDestructionApprovalRefusal =
  /** Not the caller's record, or no such record: indistinguishable on purpose. */
  | "NOT_FOUND"
  /** A workspace record: its workspace's destruction review decides. */
  | "WORKSPACE_RECORD_USES_REVIEW"
  /** An unsealed upload: it expires on its own lifecycle. */
  | "UNSEALED_RECORD"
  /** Not in the Trash / archive (no deleted_at), or already destroyed. */
  | "NOT_IN_TRASH"
  | "ALREADY_DESTROYED";

export type OwnerDestructionApprovalResult =
  | { ok: true; approvalId: string; evidenceDeletedAtUtc: Date; changed: boolean }
  | { ok: false; refusal: OwnerDestructionApprovalRefusal };

type Client = Pick<PrismaClient, "evidence" | "evidenceOwnerDestructionApproval" | "$transaction">;

async function eligibleRecord(
  client: Pick<PrismaClient, "evidence">,
  evidenceId: string,
  actorUserId: string,
): Promise<{ ok: true; deletedAt: Date } | { ok: false; refusal: OwnerDestructionApprovalRefusal }> {
  const record = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: { teamId: true, ownerUserId: true, status: true, deletedAt: true, lifecycleState: true, destroyedAtUtc: true },
  });
  if (!record || record.ownerUserId !== actorUserId) return { ok: false, refusal: "NOT_FOUND" };
  if (record.teamId) return { ok: false, refusal: "WORKSPACE_RECORD_USES_REVIEW" };
  if (UNSEALED.has(String(record.status))) return { ok: false, refusal: "UNSEALED_RECORD" };
  if (record.destroyedAtUtc || record.lifecycleState === "DESTROYED") return { ok: false, refusal: "ALREADY_DESTROYED" };
  if (!record.deletedAt) return { ok: false, refusal: "NOT_IN_TRASH" };
  return { ok: true, deletedAt: record.deletedAt };
}

/** The owner approves destroying their own team-less sealed record (this trash cycle). */
export async function approveOwnRecordDestruction(
  input: { evidenceId: string; actorUserId: string; requestId?: string | null; now?: Date },
  client: Client = defaultPrisma,
): Promise<OwnerDestructionApprovalResult> {
  const now = input.now ?? new Date();
  return client.$transaction(async (txClient) => {
    const tx = txClient as unknown as PrismaClient;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.evidenceId}))`;
    const eligible = await eligibleRecord(tx, input.evidenceId, input.actorUserId);
    if (!eligible.ok) return eligible;
    const existing = await tx.evidenceOwnerDestructionApproval.findUnique({
      where: {
        evidenceId_evidenceDeletedAtUtc: { evidenceId: input.evidenceId, evidenceDeletedAtUtc: eligible.deletedAt },
      },
      select: { id: true, withdrawnAtUtc: true, ownerUserId: true },
    });
    if (existing && existing.withdrawnAtUtc === null && existing.ownerUserId === input.actorUserId) {
      return { ok: true as const, approvalId: existing.id, evidenceDeletedAtUtc: eligible.deletedAt, changed: false };
    }
    const row = existing
      ? await tx.evidenceOwnerDestructionApproval.update({
          where: { id: existing.id },
          data: {
            ownerUserId: input.actorUserId,
            approvedAtUtc: now,
            withdrawnAtUtc: null,
            requestId: input.requestId ?? null,
          },
          select: { id: true },
        })
      : await tx.evidenceOwnerDestructionApproval.create({
          data: {
            evidenceId: input.evidenceId,
            ownerUserId: input.actorUserId,
            evidenceDeletedAtUtc: eligible.deletedAt,
            approvedAtUtc: now,
            requestId: input.requestId ?? null,
          },
          select: { id: true },
        });
    return { ok: true as const, approvalId: row.id, evidenceDeletedAtUtc: eligible.deletedAt, changed: true };
  });
}

/** The owner withdraws their approval (until the record is destroyed). */
export async function withdrawOwnRecordDestructionApproval(
  input: { evidenceId: string; actorUserId: string; now?: Date },
  client: Client = defaultPrisma,
): Promise<{ ok: true; withdrawn: number } | { ok: false; refusal: OwnerDestructionApprovalRefusal }> {
  const now = input.now ?? new Date();
  return client.$transaction(async (txClient) => {
    const tx = txClient as unknown as PrismaClient;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.evidenceId}))`;
    const record = await tx.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { ownerUserId: true, teamId: true, destroyedAtUtc: true, lifecycleState: true },
    });
    if (!record || record.ownerUserId !== input.actorUserId) return { ok: false as const, refusal: "NOT_FOUND" as const };
    if (record.teamId) return { ok: false as const, refusal: "WORKSPACE_RECORD_USES_REVIEW" as const };
    if (record.destroyedAtUtc || record.lifecycleState === "DESTROYED") {
      return { ok: false as const, refusal: "ALREADY_DESTROYED" as const };
    }
    const { count } = await tx.evidenceOwnerDestructionApproval.updateMany({
      where: { evidenceId: input.evidenceId, ownerUserId: input.actorUserId, withdrawnAtUtc: null },
      data: { withdrawnAtUtc: now },
    });
    return { ok: true as const, withdrawn: count };
  });
}
