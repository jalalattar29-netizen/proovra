/**
 * Track 1B — Case ↔ Evidence relationship CANONICAL AUTHORITY.
 *
 * `CaseEvidenceLink` is the durable relationship + provenance authority
 * for the case ↔ evidence binding — and, since the Track 1B closure,
 * the ONLY truth. The legacy `Evidence.caseId` mirror column was
 * dropped (migration 20271105000000_evidence_case_id_removal): there
 * is no dual-write, no mirror resync, and no legacy-read union. Every
 * relationship read and write in the API flows through this service or
 * through `caseLinks` relation queries. A grep-level authority guard
 * (test/phase-12b-case-evidence-authority.test.ts) enforces that NO
 * evidence-query block anywhere in src contains a legacy `caseId`
 * scalar reference.
 *
 * Invariants:
 *   - Same-workspace only: `evidence.teamId` must strictly equal
 *     `case.teamId` (null === null for personal scope). Cross-workspace
 *     attach throws `cross_workspace_denied`; callers without standing
 *     on the target must surface it as not-found (anti-enumeration).
 *   - At most ONE active link row per (caseId, evidenceId) pair.
 *     Re-attach of an existing pair is a no-op success (idempotent);
 *     a different role never creates a second row.
 *   - Every mutating attach/detach runs in ONE transaction:
 *     link row write + tenant-audit row.
 *   - Idempotent detach: detaching a non-existent binding is a no-op
 *     success with ZERO mutation.
 *   - Denial performs ZERO mutation.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { DomainError } from "../../errors.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { resolveEvidenceRecordAccess } from "../evidence/evidence-record-access.service.js";
import { evaluateCrossTeamAttach } from "./case-permission.service.js";

export type CaseEvidenceAuthorityErrorCode =
  | "case_not_found"
  | "evidence_not_found"
  | "evidence_deleted"
  | "cross_workspace_denied"
  // UC-CASE-001 — the case carries an ACTIVE case-scoped legal hold; its
  // evidence scope may not be reduced.
  | "case_hold_active"
  // UC-CASE-001 — hold state could not be read: fail closed.
  | "hold_state_unavailable";

export class CaseEvidenceAuthorityError extends Error {
  code: CaseEvidenceAuthorityErrorCode;
  constructor(code: CaseEvidenceAuthorityErrorCode) {
    super(code);
    this.code = code;
  }
}

export type CaseEvidenceLinkRoleValue =
  | "PRIMARY"
  | "SUPPORTING"
  | "RELATED"
  | "DUPLICATE"
  | "DERIVED"
  | "CONTEXT";

export type CaseEvidenceLinkSourceValue =
  | "USER"
  | "SYSTEM"
  | "IMPORT"
  | "INTAKE"
  | "WORKFLOW";

export type CaseEvidenceActorContext = {
  /** Human actor; null for pure system reconciliation. */
  actorUserId: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type LinkRow = {
  id: string;
  teamId: string | null;
  caseId: string;
  evidenceId: string;
  role: string;
  source: string;
  linkedByUserId: string | null;
  linkedAtUtc: Date;
  reason: string | null;
};

export type AttachEvidenceToCaseInput = CaseEvidenceActorContext & {
  caseId: string;
  evidenceId: string;
  role?: CaseEvidenceLinkRoleValue;
  source?: CaseEvidenceLinkSourceValue;
  reason?: string | null;
};

export type AttachEvidenceToCaseResult = {
  /** true when a NEW link row was created in this call. */
  created: boolean;
  link: LinkRow;
};

/**
 * UC-CASE-001 — THE preservation gate for any mutation that removes evidence
 * from a case. A CASE-scoped legal hold covers exactly the records linked to
 * the case (the effective-hold evaluator resolves holds through the links), so
 * removing a link silently removes that record from the hold. Refused while an
 * ACTIVE hold (or an ACTIVE historical hold) names this case.
 *
 * Serialised against hold placement on the CASE ROW: this takes the row
 * FOR UPDATE inside the caller's transaction, and a hold insert references the
 * case through its foreign key (FOR KEY SHARE), so a hold placed concurrently
 * either commits first and is seen here, or waits for this unlink to commit.
 * Fails closed: a hold store that cannot be read refuses the unlink.
 */
async function assertCaseNotHeldForUnlinkTx(tx: Prisma.TransactionClient, caseId: string): Promise<void> {
  let held: number;
  try {
    await tx.$queryRaw`SELECT "id" FROM "cases" WHERE "id" = ${caseId}::uuid FOR UPDATE`;
    held = await tx.evidenceLegalHold.count({
      where: { caseId, status: "ACTIVE", OR: [{ scope: "CASE" }, { historical: true }] },
    });
  } catch {
    throw new CaseEvidenceAuthorityError("hold_state_unavailable");
  }
  if (held > 0) throw new CaseEvidenceAuthorityError("case_hold_active");
}

/**
 * Atomic, idempotent attach. Repeat attach of the same (case, evidence)
 * pair — with ANY role — is a no-op success and never creates a
 * duplicate active link.
 */
export async function attachEvidenceToCase(
  input: AttachEvidenceToCaseInput,
  client: PrismaClient = defaultPrisma,
): Promise<AttachEvidenceToCaseResult> {
  const caseRow = await client.case.findUnique({
    where: { id: input.caseId },
    select: { id: true, teamId: true, ownerUserId: true },
  });
  if (!caseRow) throw new CaseEvidenceAuthorityError("case_not_found");

  const evidence = await client.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, teamId: true, ownerUserId: true, deletedAt: true },
  });
  if (!evidence) throw new CaseEvidenceAuthorityError("evidence_not_found");
  if (evidence.deletedAt) throw new CaseEvidenceAuthorityError("evidence_deleted");

  // Same-workspace validation (strict equality; null === null covers the
  // personal scope). Denied BEFORE any mutation.
  const crossTeam = evaluateCrossTeamAttach({
    caseTeamId: caseRow.teamId,
    evidenceTeamId: evidence.teamId,
  });
  if (!crossTeam.allowed) {
    throw new CaseEvidenceAuthorityError("cross_workspace_denied");
  }

  // ET-SEC-09 / ET-SEC-16 — the tenancy proof lives HERE, in the one link
  // authority, so no caller can skip it. A record with no workspace (legacy
  // personal scope) may only join a case with no workspace that belongs to the
  // SAME owner; null === null alone is not a shared tenant.
  if (caseRow.teamId === null && evidence.ownerUserId !== caseRow.ownerUserId) {
    throw new CaseEvidenceAuthorityError("evidence_not_found");
  }
  // The acting user must be allowed to change this record — decided by the
  // canonical record-access engine (personal-owner rule for personal scope;
  // current membership, role, expiry and organization lifecycle otherwise).
  if (input.actorUserId) {
    const access = await resolveEvidenceRecordAccess(
      { userId: input.actorUserId, evidenceId: evidence.id, permission: "evidence.update_metadata" },
      client,
    );
    if (!access.allowed) throw new CaseEvidenceAuthorityError("evidence_not_found");
  }


  const role = (input.role ?? "PRIMARY") as Prisma.CaseEvidenceLinkCreateInput["role"];
  const source = (input.source ?? "USER") as Prisma.CaseEvidenceLinkCreateInput["source"];

  // UC-CASE-004 — ONE active link per (case, evidence) pair, decided INSIDE the
  // transaction under a per-pair advisory lock: the any-role lookup used to run
  // before the transaction, so two concurrent attaches (even with different
  // roles) both inserted. Concurrent callers now serialise; the loser sees the
  // winner's row and answers the idempotent created:false. (A partial unique
  // index on (case_id, evidence_id) is requested as the DB backstop; a unique
  // violation from it is mapped to the same answer.)
  const outcome = await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`case-evidence-link:${caseRow.id}:${evidence.id}`}))`;
    const existing = await tx.caseEvidenceLink.findFirst({
      where: { caseId: caseRow.id, evidenceId: evidence.id },
    });
    if (existing) return { created: false as const, link: existing as LinkRow };
    const created = await tx.caseEvidenceLink.create({
      data: {
        teamId: caseRow.teamId,
        caseId: caseRow.id,
        evidenceId: evidence.id,
        role,
        source,
        linkedByUserId: input.actorUserId ?? null,
        reason: input.reason ? input.reason.slice(0, 400) : null,
      },
    });

    await emitTenantAudit(
      {
        action: "cases.evidence_linked",
        outcome: "success",
        sourceApp: "API",
        actorUserId: input.actorUserId ?? null,
        workspaceId: caseRow.teamId,
        resourceType: "case_evidence_link",
        resourceId: created.id,
        metadata: {
          caseId: caseRow.id,
          evidenceId: evidence.id,
          role: String(created.role),
          idempotentReuse: false,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
      },
      tx as unknown as PrismaClient,
    );

    return { created: true as const, link: created as LinkRow };
  }).catch(async (err: unknown) => {
    if ((err as { code?: string }).code === "P2002") {
      const winner = await client.caseEvidenceLink.findFirst({
        where: { caseId: caseRow.id, evidenceId: evidence.id },
      });
      if (winner) return { created: false as const, link: winner as LinkRow };
    }
    throw err;
  });

  return outcome;
}

export type DetachEvidenceFromCaseInput = CaseEvidenceActorContext & {
  caseId: string;
  evidenceId: string;
  reason?: string | null;
  /** Audit action override (default "cases.evidence_unlinked"). */
  auditAction?: string;
  auditMetadata?: Record<string, unknown>;
};

export type DetachEvidenceFromCaseResult = {
  /** false = nothing was attached; idempotent no-op with zero mutation. */
  detached: boolean;
  removedLinkCount: number;
};

/** Atomic, idempotent detach. Detaching an unattached pair is a no-op. */
export async function detachEvidenceFromCase(
  input: DetachEvidenceFromCaseInput,
  client: PrismaClient = defaultPrisma,
): Promise<DetachEvidenceFromCaseResult> {
  const caseRow = await client.case.findUnique({
    where: { id: input.caseId },
    select: { id: true, teamId: true },
  });
  if (!caseRow) throw new CaseEvidenceAuthorityError("case_not_found");

  const evidence = await client.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, teamId: true },
  });
  if (!evidence) throw new CaseEvidenceAuthorityError("evidence_not_found");

  const links = await client.caseEvidenceLink.findMany({
    where: { caseId: caseRow.id, evidenceId: evidence.id },
    select: { id: true },
  });

  if (links.length === 0) {
    // Nothing binds this pair — idempotent no-op success, zero mutation.
    return { detached: false, removedLinkCount: 0 };
  }

  const outcome = await client.$transaction(async (tx) => {
    await assertCaseNotHeldForUnlinkTx(tx, caseRow.id);
    const res = await tx.caseEvidenceLink.deleteMany({
      where: { caseId: caseRow.id, evidenceId: evidence.id },
    });
    const removedLinkCount = res.count;

    // ET-SEC-02 — Invariant C: tenant ownership is independent of case
    // linkage. Detaching (even the last) link never changes Evidence.teamId;
    // the former "return to the personal pool" reset moved workspace evidence
    // out of the workspace, escaping workspace/case holds and admin access.

    await emitTenantAudit(
      {
        action: input.auditAction ?? "cases.evidence_unlinked",
        outcome: "success",
        sourceApp: "API",
        actorUserId: input.actorUserId ?? null,
        workspaceId: caseRow.teamId,
        resourceType: "case_evidence_link",
        resourceId: links[0]?.id ?? evidence.id,
        metadata: {
          caseId: caseRow.id,
          evidenceId: evidence.id,
          removedLinkCount,
          attachmentKind: "canonical_link",
          reason: input.reason ? input.reason.slice(0, 400) : null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          ...(input.auditMetadata ?? {}),
        },
      },
      tx as unknown as PrismaClient,
    );

    return { removedLinkCount };
  });

  return {
    detached: true,
    removedLinkCount: outcome.removedLinkCount,
  };
}

export type DetachAllEvidenceFromCaseInput = CaseEvidenceActorContext & {
  caseId: string;
  reason?: string | null;
};

/**
 * Case-deletion support: atomically removes EVERY link row for the case.
 * The link table is the only truth — there is no mirror column to clear.
 */
export async function detachAllEvidenceFromCase(
  input: DetachAllEvidenceFromCaseInput,
  client: PrismaClient = defaultPrisma,
): Promise<{ removedLinkCount: number }> {
  const caseRow = await client.case.findUnique({
    where: { id: input.caseId },
    select: { id: true, teamId: true },
  });
  if (!caseRow) throw new CaseEvidenceAuthorityError("case_not_found");

  return client.$transaction(async (tx) => {
    await assertCaseNotHeldForUnlinkTx(tx, caseRow.id);
    const removed = await tx.caseEvidenceLink.deleteMany({
      where: { caseId: caseRow.id },
    });
    await emitTenantAudit(
      {
        action: "cases.evidence_unlinked_all",
        outcome: "success",
        sourceApp: "API",
        actorUserId: input.actorUserId ?? null,
        workspaceId: caseRow.teamId,
        resourceType: "case",
        resourceId: caseRow.id,
        metadata: {
          caseId: caseRow.id,
          removedLinkCount: removed.count,
          reason: input.reason ? input.reason.slice(0, 400) : null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
      },
      tx as unknown as PrismaClient,
    );
    return { removedLinkCount: removed.count };
  });
}

export type CaseEvidenceRelationshipEntry = {
  caseId: string;
  evidenceId: string;
  role: string | null;
  source: string | null;
  linkedByUserId: string | null;
  linkedAtUtc: Date | null;
  reason: string | null;
};

/** Canonical relationship read for a case (link table only). */
export async function listEvidenceForCase(
  input: { caseId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<CaseEvidenceRelationshipEntry[]> {
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
  const links = await client.caseEvidenceLink.findMany({
    where: { caseId: input.caseId },
    orderBy: { linkedAtUtc: "desc" },
    take: limit,
  });
  return links.map((l) => ({
    caseId: l.caseId,
    evidenceId: l.evidenceId,
    role: String(l.role),
    source: String(l.source),
    linkedByUserId: l.linkedByUserId ?? null,
    linkedAtUtc: l.linkedAtUtc,
    reason: l.reason ?? null,
  }));
}

/** Canonical relationship read for one evidence record (link table only). */
export async function listCasesForEvidence(
  input: { evidenceId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<CaseEvidenceRelationshipEntry[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const links = await client.caseEvidenceLink.findMany({
    where: { evidenceId: input.evidenceId },
    orderBy: { linkedAtUtc: "desc" },
    take: limit,
  });
  return links.map((l) => ({
    caseId: l.caseId,
    evidenceId: l.evidenceId,
    role: String(l.role),
    source: String(l.source),
    linkedByUserId: l.linkedByUserId ?? null,
    linkedAtUtc: l.linkedAtUtc,
    reason: l.reason ?? null,
  }));
}

/**
 * UC-CASE-001 — the ONE HTTP mapping of a preservation refusal, shared by every
 * route that unlinks evidence from a case (case route, case-workspace links,
 * evidence bulk). `null` for any other error.
 */
export function caseUnlinkRefusal(
  err: unknown,
): { status: 409 | 503; body: { code: string; message: string } } | null {
  if (!(err instanceof CaseEvidenceAuthorityError)) return null;
  if (err.code === "case_hold_active") {
    return {
      status: 409,
      body: {
        code: "LEGAL_HOLD_BLOCKED",
        message: "This case is under an active legal hold. Evidence cannot be removed from it until the hold is released.",
      },
    };
  }
  if (err.code === "hold_state_unavailable") {
    return {
      status: 503,
      body: {
        code: "LEGAL_HOLD_STATE_UNAVAILABLE",
        message: "Legal hold status could not be confirmed. Nothing was changed; try again.",
      },
    };
  }
  return null;
}

/** UC-CASE-001 — the same refusal as a DomainError, for service-layer callers. */
export function caseUnlinkRefusalError(err: unknown): DomainError | null {
  const refusal = caseUnlinkRefusal(err);
  if (!refusal) return null;
  return new DomainError(refusal.body.code, {
    httpStatus: refusal.status,
    publicCode: refusal.body.code,
    publicMessage: refusal.body.message,
    reportability: refusal.status === 409 ? "EXPECTED_DENIAL" : "OPERATIONAL_WARNING",
    severity: refusal.status === 409 ? "info" : "warning",
  });
}
