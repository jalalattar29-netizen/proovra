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
import type { Permission, PrivilegedAction } from "@proovra/shared";
import type { FastifyRequest } from "fastify";
import { isRequestSessionQuarantined } from "../access-control/adaptive-runtime-gate.service.js";

import { prisma as defaultPrisma } from "../../db.js";
import { CASE_VISIBILITY_SELECT, caseRowVisibleTo } from "../cases/case-visibility.js";
import {
  evaluateAccess,
  evaluateMemberAccess,
  loadMemberAccessSnapshot,
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
  | "case_access_list"
  /** IDENT-019 — allowed by policy, refused because the session is quarantined. */
  | "session_quarantined"
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
  /**
   * F-04 — where a refusal's permission-denied event is written when `client`
   * is a transaction the refusal rolls back (the AUD-0017 eventClient rule).
   */
  options: { eventClient?: PrismaClient } = {},
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
      options,
    );
    if (!decision.allowed) {
      return { allowed: false, internalReason: decision.reason };
    }
    // RESTRICTED-CASE INHERITANCE (members audit ACC-01). Workspace access is
    // necessary, never sufficient: Evidence linked to a restricted Case the
    // caller cannot see is closed to them — OWNER and ADMIN included — and so
    // are its reports, packages and original. The narrowing rule is the one
    // in case-visibility.ts; nothing here restates it.
    const links = await client.caseEvidenceLink.findMany({
      where: { evidenceId: row.id },
      select: { case: { select: CASE_VISIBILITY_SELECT } },
    });
    for (const link of links) {
      if (!caseRowVisibleTo(link.case, input.userId)) {
        return { allowed: false, internalReason: "case_access_list" };
      }
    }
    return { allowed: true };
  } catch {
    return { allowed: false, internalReason: "authorization_unavailable" };
  }
}

/**
 * B5A-F-03 (free audit 0ea0) — WHAT THE CALLER MAY DO TO THIS RECORD, as a
 * read-time projection for the record detail and review workspace (A2-14: a
 * Viewer is offered no write control the server would refuse).
 *
 * The same decision `resolveEvidenceRecordAccess` makes per operation — the
 * personal-owner rule, the canonical role matrix (`evaluateAccess` over the
 * member snapshot) and restricted-case narrowing — but evaluated PURELY: a
 * Viewer opening a record is not four refused writes, so no permission-denied
 * event is written. It never grants anything; every write route still asks
 * `resolveEvidenceRecordAccess` itself. Any failure answers all-false.
 */
export type EvidenceActorCapabilities = {
  updateMetadata: boolean;
  archive: boolean;
  delete: boolean;
  restoreFromTrash: boolean;
  /**
   * PRO-E2-09 (WS-ENT) — "Open original" / "Download original" are offered
   * only to a caller the original download gate accepts. Additive.
   */
  downloadOriginal: boolean;
};

const ACTOR_CAPABILITY_PERMISSIONS = {
  updateMetadata: "evidence.update_metadata",
  archive: "evidence.archive",
  delete: "evidence.delete",
  restoreFromTrash: "evidence.restore_from_trash",
  downloadOriginal: "evidence.download_original",
} as const satisfies Record<keyof EvidenceActorCapabilities, EvidenceRecordPermission>;

const NO_ACTOR_CAPABILITIES: EvidenceActorCapabilities = {
  updateMetadata: false,
  archive: false,
  delete: false,
  restoreFromTrash: false,
  downloadOriginal: false,
};

export async function projectEvidenceActorCapabilities(
  input: { userId: string; evidenceId: string },
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceActorCapabilities> {
  const keys = Object.keys(ACTOR_CAPABILITY_PERMISSIONS) as Array<keyof EvidenceActorCapabilities>;
  const granted = await projectEvidenceRecordPermissions(
    { userId: input.userId, evidenceIds: [input.evidenceId], permissions: keys.map((k) => ACTOR_CAPABILITY_PERMISSIONS[k]) },
    client,
  );
  const set = granted.get(input.evidenceId);
  const out = { ...NO_ACTOR_CAPABILITIES };
  if (!set) return out;
  for (const key of keys) out[key] = set.has(ACTOR_CAPABILITY_PERMISSIONS[key]);
  return out;
}

/**
 * B5B-F-102 (free audit 0ea0) — the caller's package capabilities for a list
 * of records, the same answer EP-0404's `packageAccess` gives one record:
 * `externalDisclosure` = evidence.download_package, `fullForensic` = that AND
 * evidence.download_original (the FULL_FORENSIC package embeds the originals;
 * the download gate refuses it with FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS).
 * Pure and batched (one member snapshot per workspace) for the Reports lists.
 */
export async function projectPackageAccessForRecords(
  input: { userId: string; evidenceIds: readonly string[] },
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, { fullForensic: boolean; externalDisclosure: boolean }>> {
  const granted = await projectEvidenceRecordPermissions(
    { userId: input.userId, evidenceIds: input.evidenceIds, permissions: ["evidence.download_package", "evidence.download_original"] },
    client,
  );
  const out = new Map<string, { fullForensic: boolean; externalDisclosure: boolean }>();
  for (const id of input.evidenceIds) {
    const set = granted.get(id);
    const pkg = set?.has("evidence.download_package") ?? false;
    out.set(id, { fullForensic: pkg && (set?.has("evidence.download_original") ?? false), externalDisclosure: pkg });
  }
  return out;
}

/**
 * The pure, batched form of `resolveEvidenceRecordAccess` for projections:
 * for each record, the subset of `permissions` the caller holds. Same rules
 * (personal-owner rule; canonical role matrix over the LIVE member snapshot;
 * restricted-case narrowing), no permission-denied events. A record that is
 * missing or whose evaluation fails maps to the empty set (fail closed).
 */
export async function projectEvidenceRecordPermissions(
  input: { userId: string; evidenceIds: readonly string[]; permissions: readonly EvidenceRecordPermission[] },
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, Set<EvidenceRecordPermission>>> {
  const out = new Map<string, Set<EvidenceRecordPermission>>();
  const ids = [...new Set(input.evidenceIds)];
  for (const id of ids) out.set(id, new Set());
  if (ids.length === 0) return out;
  try {
    const rows = await client.evidence.findMany({
      where: { id: { in: ids } },
      select: { id: true, teamId: true, ownerUserId: true },
    });
    const links = await client.caseEvidenceLink.findMany({
      where: { evidenceId: { in: ids } },
      select: { evidenceId: true, case: { select: CASE_VISIBILITY_SELECT } },
    });
    const closed = new Set(
      links.filter((link) => !caseRowVisibleTo(link.case, input.userId)).map((link) => link.evidenceId),
    );
    const snapshots = new Map<string, Awaited<ReturnType<typeof loadMemberAccessSnapshot>>>();
    for (const row of rows) {
      const set = out.get(row.id)!;
      if (row.teamId === null) {
        if (row.ownerUserId === input.userId) for (const p of input.permissions) set.add(p);
        continue;
      }
      if (closed.has(row.id)) continue;
      if (!snapshots.has(row.teamId)) {
        snapshots.set(
          row.teamId,
          await loadMemberAccessSnapshot({ teamId: row.teamId, userId: input.userId }, client).catch(() => null),
        );
      }
      const member = snapshots.get(row.teamId);
      if (!member) continue;
      for (const permission of input.permissions) {
        if (
          evaluateAccess(
            { kind: "MEMBER", member },
            { permission, resourceKind: "evidence", resourceId: row.id },
          ).allowed
        ) {
          set.add(permission);
        }
      }
    }
  } catch {
    for (const id of ids) out.set(id, new Set());
  }
  return out;
}

/**
 * D5 — THE RESPONSE CLASS FOR A DENIED OPERATION.
 *
 * Every denial used to be an indistinguishable 404, including for a member who
 * can open the record and simply lacks the right to (for example) generate its
 * report. That is correct for someone who may not know the record exists, and
 * wrong for someone looking at it: telling them it does not exist sends them
 * looking for a bug instead of for the permission they need.
 *
 * So the canonical engine is asked twice, in this order:
 *   1. the OPERATION's permission — allowed means allowed;
 *   2. `evidence.read` — a caller who may read the record gets FORBIDDEN (403),
 *      anyone else gets HIDDEN (404), with the same body as a missing record,
 *      so nothing about existence leaks to an outsider.
 */
export type EvidenceOperationAccess =
  | { allowed: true }
  | {
      allowed: false;
      visibility: "FORBIDDEN" | "HIDDEN";
      internalReason: EvidenceRecordDenyReason;
    };

export async function resolveEvidenceOperationAccess(
  input: {
    userId: string;
    evidenceId: string;
    permission: EvidenceRecordPermission;
    /**
     * IDENT-019 — the signed-in request performing this privileged action.
     * When given, an operation the policy ALLOWS is refused (FORBIDDEN,
     * `session_quarantined`) while that session is quarantined. Asked only
     * after the policy allowed it, so an outsider still gets HIDDEN.
     */
    session?: { req: FastifyRequest; action: PrivilegedAction };
  },
  client: PrismaClient = defaultPrisma,
): Promise<EvidenceOperationAccess> {
  const op = await resolveEvidenceRecordAccess(input, client);
  if (op.allowed) {
    if (!input.session) return { allowed: true };
    const row = await client.evidence.findUnique({ where: { id: input.evidenceId }, select: { teamId: true } });
    const quarantined = await isRequestSessionQuarantined(
      { req: input.session.req, teamId: row?.teamId ?? null, userId: input.userId, action: input.session.action },
      client,
    );
    return quarantined
      ? { allowed: false, visibility: "FORBIDDEN", internalReason: "session_quarantined" }
      : { allowed: true };
  }
  if (input.permission === "evidence.read") {
    return { allowed: false, visibility: "HIDDEN", internalReason: op.internalReason };
  }
  const read = await resolveEvidenceRecordAccess(
    { ...input, permission: "evidence.read" },
    client,
  );
  return {
    allowed: false,
    visibility: read.allowed ? "FORBIDDEN" : "HIDDEN",
    internalReason: op.internalReason,
  };
}
