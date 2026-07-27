/**
 * PHASE 1 AUTHORIZATION CLOSURE — final caller classification (2026-07-21).
 *
 * Canonical per-record Evidence access for BOTH read and non-destructive /
 * destructive mutations. This is the general wrapper the narrower
 * `resolveEvidenceDestructiveAccess` (archive/delete semantics) delegates to;
 * routes that are NOT destructive use this one directly so the semantics and
 * naming stay honest.
 *
 * Decision model (tenant binding is ALWAYS the PERSISTED Evidence row —
 * never a client-supplied workspace id):
 *
 *   * Evidence not found              → deny (`evidence_not_found`).
 *   * Personal-scope Evidence
 *     (teamId null — no workspace
 *     binding exists)                 → Personal-owner rule: `ownerUserId`.
 *   * Workspace-bound Evidence        → canonical engine decides:
 *     (PERSONAL / OWNED /               `evaluateMemberAccess(persisted
 *     ORGANIZATION)                     teamId, userId, permission)` —
 *                                       ACTIVE membership + Workspace-kind +
 *                                       CUSTOMER-Organization lifecycle +
 *                                       the operation-specific capability +
 *                                       fail-closed + denial audit. Creator
 *                                       identity grants NOTHING: a
 *                                       SUSPENDED / REVOKED former creator
 *                                       is denied like any non-member.
 *
 * Callers MUST collapse every `allowed: false` to one public 404 (the
 * `internalReason` is for logs/audit only) so missing, cross-tenant, and
 * inactive-membership outcomes stay externally indistinguishable.
 */

import type { PrismaClient } from "@prisma/client";
import type { Permission } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  evaluateMemberAccess,
  type AccessDenyReason,
} from "../identity/access-policy.service.js";

/** Any evidence-domain capability from the canonical vocabulary. */
export type EvidenceRecordPermission = Extract<
  Permission,
  `evidence.${string}`
>;

export type EvidenceRecordDenyReason =
  | "evidence_not_found"
  | "not_personal_owner"
  | "authorization_unavailable"
  | AccessDenyReason;

export type EvidenceRecordAccessResult =
  | { allowed: true }
  | { allowed: false; internalReason: EvidenceRecordDenyReason };

export async function resolveEvidenceRecordAccess(
  input: {
    userId: string;
    evidenceId: string;
    permission: EvidenceRecordPermission;
  },
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceRecordAccessResult> {
  // Minimum metadata only — enough to determine the owning Workspace.
  const row = await client.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, teamId: true, ownerUserId: true },
  });
  if (!row) {
    return { allowed: false, internalReason: "evidence_not_found" };
  }

  if (row.teamId === null) {
    // Personal-scope Evidence (no workspace binding) — Personal-owner rule.
    return row.ownerUserId === input.userId
      ? { allowed: true }
      : { allowed: false, internalReason: "not_personal_owner" };
  }

  // Workspace-bound Evidence — canonical decision against the PERSISTED
  // teamId. Fail closed on any evaluation error.
  try {
    const decision = await evaluateMemberAccess(
      {
        teamId: row.teamId,
        userId: input.userId,
        permission: input.permission,
        resourceKind: "evidence",
        resourceId: row.id,
      },
      client,
    );
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, internalReason: decision.reason };
  } catch {
    return { allowed: false, internalReason: "authorization_unavailable" };
  }
}
