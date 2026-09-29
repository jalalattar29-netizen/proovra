import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../../db.js";
import { inputRefusal } from "../../errors.js";

const evidenceRelationshipSelect = {
  id: true,
  sourceEvidenceId: true,
  targetEvidenceId: true,
  relationshipType: true,
  note: true,
  createdAt: true,
  updatedAt: true,
  createdBy: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
  sourceEvidence: {
    select: {
      id: true,
      title: true,
      displayFileName: true,
      originalFileName: true,
      status: true,
      caseLinks: {
        orderBy: { linkedAtUtc: "asc" },
        select: { caseId: true },
        take: 1,
      },
      teamId: true,
    },
  },
  targetEvidence: {
    select: {
      id: true,
      title: true,
      displayFileName: true,
      originalFileName: true,
      status: true,
      caseLinks: {
        orderBy: { linkedAtUtc: "asc" },
        select: { caseId: true },
        take: 1,
      },
      teamId: true,
    },
  },
} satisfies Prisma.EvidenceRelationshipSelect;

type EvidenceRelationshipRecord = Prisma.EvidenceRelationshipGetPayload<{
  select: typeof evidenceRelationshipSelect;
}>;

export type EvidenceRelationshipSummary = {
  id: string;
  relationshipType: prismaPkg.EvidenceRelationshipType;
  note: string | null;
  direction: "outbound" | "inbound";
  createdAt: string;
  updatedAt: string;
  linkedEvidence: {
    id: string;
    title: string;
    status: string;
    caseId: string | null;
    teamId: string | null;
  };
  createdBy:
    | {
        id: string;
        email: string | null;
        displayName: string | null;
      }
    | null;
};

function mapRelationship(
  item: EvidenceRelationshipRecord,
  evidenceId: string
): EvidenceRelationshipSummary {
  const isSource = item.sourceEvidenceId === evidenceId;
  const linkedEvidence = isSource ? item.targetEvidence : item.sourceEvidence;

  return {
    id: item.id,
    relationshipType: item.relationshipType,
    note: item.note ?? null,
    direction: isSource ? "outbound" : "inbound",
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    linkedEvidence: {
      id: linkedEvidence.id,
      title:
        linkedEvidence.title ??
        linkedEvidence.displayFileName ??
        linkedEvidence.originalFileName ??
        "Untitled evidence",
      status: linkedEvidence.status,
      caseId: linkedEvidence.caseLinks[0]?.caseId ?? null,
      teamId: linkedEvidence.teamId ?? null,
    },
    createdBy:
      item.createdBy != null
        ? {
            id: item.createdBy.id,
            email: item.createdBy.email ?? null,
            displayName: item.createdBy.displayName ?? null,
          }
        : null,
  };
}

/**
 * THE RELATIONSHIP WORKSPACE BOUNDARY (ET-SEC-07, 2026-09-29).
 *
 * A relationship joins two records of ONE workspace: the same Team, or — for a
 * personal record with no Team — the same owner. A link across workspaces
 * exposed the other record's title, status and case to every reader of this
 * one, so it is refused on write and never listed on read (rows written before
 * the boundary existed stay stored but are invisible).
 */
type RelationshipScopeRecord = { teamId: string | null; ownerUserId: string };

export function sameRelationshipWorkspace(a: RelationshipScopeRecord, b: RelationshipScopeRecord): boolean {
  if (a.teamId || b.teamId) return a.teamId === b.teamId;
  return a.ownerUserId === b.ownerUserId;
}

function relationshipScopeWhere(anchor: RelationshipScopeRecord): Prisma.EvidenceWhereInput {
  return anchor.teamId ? { teamId: anchor.teamId } : { teamId: null, ownerUserId: anchor.ownerUserId };
}

export async function listEvidenceRelationships(
  evidenceId: string
): Promise<EvidenceRelationshipSummary[]> {
  const anchor = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { teamId: true, ownerUserId: true },
  });
  if (!anchor) return [];
  const scope = relationshipScopeWhere(anchor);
  const items = await prisma.evidenceRelationship.findMany({
    where: {
      OR: [
        { sourceEvidenceId: evidenceId, targetEvidence: scope },
        { targetEvidenceId: evidenceId, sourceEvidence: scope },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: evidenceRelationshipSelect,
  });

  return items.map((item) => mapRelationship(item, evidenceId));
}

export async function createEvidenceRelationship(params: {
  sourceEvidenceId: string;
  targetEvidenceId: string;
  /** Both records' scope; the caller has already authorized each of them. */
  source: RelationshipScopeRecord;
  target: RelationshipScopeRecord;
  relationshipType: prismaPkg.EvidenceRelationshipType;
  note?: string | null;
  createdByUserId?: string | null;
  teamId?: string | null;
}) {
  if (params.sourceEvidenceId === params.targetEvidenceId) {
    // PV-DEFECT-001 — a rejected INPUT, answered as one. This was a bare
    // Error, which the central handler can only read as a crash: 500, a
    // Sentry capture and a critical page for an operator's typo. Checked
    // before any write, so nothing is created.
    throw inputRefusal({
      code: "EVIDENCE_RELATIONSHIP_SELF_LINK",
      message: "A record can't be linked to itself. Enter a different evidence record ID.",
      developerMessage: "Evidence relationship source and target must differ",
    });
  }

  if (!sameRelationshipWorkspace(params.source, params.target)) {
    // Answered exactly like an unreadable target: the other workspace's
    // record is not confirmed to exist.
    const err: Error & { statusCode?: number } = new Error("Evidence not found");
    err.statusCode = 404;
    throw err;
  }

  const relationship = await prisma.evidenceRelationship.create({
    data: {
      sourceEvidenceId: params.sourceEvidenceId,
      targetEvidenceId: params.targetEvidenceId,
      relationshipType: params.relationshipType,
      note: params.note ?? null,
      createdByUserId: params.createdByUserId ?? null,
      teamId: params.teamId ?? null,
    },
  });

  return relationship;
}

export async function updateEvidenceRelationship(params: {
  relationshipId: string;
  relationshipType?: prismaPkg.EvidenceRelationshipType;
  note?: string | null;
}) {
  return prisma.evidenceRelationship.update({
    where: { id: params.relationshipId },
    data: {
      relationshipType: params.relationshipType,
      note: params.note,
    },
  });
}

export async function deleteEvidenceRelationship(relationshipId: string) {
  return prisma.evidenceRelationship.delete({
    where: { id: relationshipId },
  });
}

export async function summarizeEvidenceRelationships(evidenceId: string): Promise<{
  count: number;
  items: EvidenceRelationshipSummary[];
}> {
  const items = await listEvidenceRelationships(evidenceId);
  return {
    count: items.length,
    items,
  };
}
