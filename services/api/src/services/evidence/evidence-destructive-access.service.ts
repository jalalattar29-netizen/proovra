/**
 * PHASE 1 AUTHORIZATION CLOSURE — final closure pass (2026-07-21).
 *
 * Canonical authorization for the DESTRUCTIVE Evidence surface
 * (archive / unarchive / delete). Replaces the owner-identity rule
 * (`getEvidenceWithOwnerAccess`) on those routes, which allowed the Evidence
 * CREATOR to archive/delete workspace Evidence regardless of membership
 * status, Organization lifecycle, or capability.
 *
 * Decision model (tenant binding is ALWAYS the PERSISTED Evidence row —
 * never a client-supplied workspace id):
 *
 *   * Evidence not found                → deny (`evidence_not_found`).
 *   * Personal-scope Evidence (teamId
 *     null, no workspace binding)       → the Personal-owner rule is
 *                                         retained: only `ownerUserId`.
 *   * Workspace-bound Evidence          → the canonical engine decides:
 *     (PERSONAL / OWNED / ORGANIZATION)   `evaluateMemberAccess(teamId,
 *                                         userId, permission)` — ACTIVE
 *                                         membership + Workspace-kind +
 *                                         CUSTOMER-Organization lifecycle +
 *                                         operation capability + fail-closed
 *                                         + denial audit. Creator identity
 *                                         grants NOTHING here: a SUSPENDED /
 *                                         REVOKED former creator is denied
 *                                         exactly like any non-member.
 *
 * PUBLIC RESPONSE CONTRACT (anti-enumeration): callers MUST map every
 * `allowed: false` result to the single stable public response
 *   404 { error: { code: "not_found" } }
 * so that a truly missing record, an existing cross-tenant record, and a
 * missing/inactive membership are externally indistinguishable. The
 * `internalReason` is for logs/audit only and must never be sent to the
 * client. `PUBLIC_NOT_FOUND_BODY` is exported so routes and tests share one
 * literal.
 */

import type { PrismaClient } from "@prisma/client";
import type { Permission } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  resolveEvidenceRecordAccess,
  type EvidenceRecordDenyReason,
} from "./evidence-record-access.service.js";

export const PUBLIC_NOT_FOUND_BODY = {
  error: { code: "not_found" },
} as const;

export type EvidenceDestructiveDenyReason = EvidenceRecordDenyReason;

export type EvidenceDestructiveAccessResult =
  | { allowed: true }
  | { allowed: false; internalReason: EvidenceDestructiveDenyReason };

/**
 * Destructive façade over the general canonical wrapper
 * (`resolveEvidenceRecordAccess`) — narrows the permission to the two
 * destructive evidence capabilities. Same decision model, one source of
 * truth for the logic.
 */
export async function resolveEvidenceDestructiveAccess(
  input: {
    userId: string;
    evidenceId: string;
    permission: Extract<Permission, "evidence.archive" | "evidence.delete">;
  },
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceDestructiveAccessResult> {
  return resolveEvidenceRecordAccess(input, client);
}
