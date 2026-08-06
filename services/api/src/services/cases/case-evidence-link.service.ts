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
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { evaluateCrossTeamAttach } from "./case-permission.service.js";

export type CaseEvidenceAuthorityErrorCode =
  | "case_not_found"
  | "evidence_not_found"
  | "evidence_deleted"
  | "cross_workspace_denied";

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
    select: { id: true, teamId: true },
  });
  if (!caseRow) throw new CaseEvidenceAuthorityError("case_not_found");

  const evidence = await client.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { id: true, teamId: true, deletedAt: true },
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

  // Any-role lookup: ONE active link per (case, evidence) pair.
  const existing = await client.caseEvidenceLink.findFirst({
    where: { caseId: caseRow.id, evidenceId: evidence.id },
  });
  if (existing) {
    // Already linked — idempotent no-op success.
    return { created: false, link: existing as LinkRow };
  }

  const role = (input.role ?? "PRIMARY") as Prisma.CaseEvidenceLinkCreateInput["role"];
  const source = (input.source ?? "USER") as Prisma.CaseEvidenceLinkCreateInput["source"];

  const link = await client.$transaction(async (tx) => {
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

    return created as LinkRow;
  });

  return { created: true, link };
}

export type DetachEvidenceFromCaseInput = CaseEvidenceActorContext & {
  caseId: string;
  evidenceId: string;
  reason?: string | null;
  /**
   * Legacy UI semantics: the historical detach paths
   * (DELETE /v1/cases/:id/evidence/:evidenceId and the bulk
   * REMOVE_FROM_CASE action) also reset `Evidence.teamId` to null when
   * the evidence leaves its (only) case. Only honoured when no link to
   * any OTHER case remains, so a multi-linked record can never be pulled
   * out of the workspace another case still requires.
   */
  clearEvidenceTeamIdWhenUnlinked?: boolean;
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
    const res = await tx.caseEvidenceLink.deleteMany({
      where: { caseId: caseRow.id, evidenceId: evidence.id },
    });
    const removedLinkCount = res.count;

    // Legacy UI semantics: when the evidence leaves its LAST case and the
    // caller opted in, reset teamId so the record returns to the personal
    // pool. Never honoured while any link to another case remains.
    if (input.clearEvidenceTeamIdWhenUnlinked === true) {
      const remaining = await tx.caseEvidenceLink.findFirst({
        where: { evidenceId: evidence.id, NOT: { caseId: caseRow.id } },
        select: { caseId: true },
      });
      if (!remaining) {
        await tx.evidence.update({
          where: { id: evidence.id },
          data: { teamId: null },
        });
      }
    }

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
