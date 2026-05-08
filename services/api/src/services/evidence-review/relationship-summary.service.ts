import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../../db.js";

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
      caseId: true,
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
      caseId: true,
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
      caseId: linkedEvidence.caseId ?? null,
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

export async function listEvidenceRelationships(
  evidenceId: string
): Promise<EvidenceRelationshipSummary[]> {
  const items = await prisma.evidenceRelationship.findMany({
    where: {
      OR: [{ sourceEvidenceId: evidenceId }, { targetEvidenceId: evidenceId }],
    },
    orderBy: { createdAt: "desc" },
    select: evidenceRelationshipSelect,
  });

  return items.map((item) => mapRelationship(item, evidenceId));
}

export async function createEvidenceRelationship(params: {
  sourceEvidenceId: string;
  targetEvidenceId: string;
  relationshipType: prismaPkg.EvidenceRelationshipType;
  note?: string | null;
  createdByUserId?: string | null;
  teamId?: string | null;
}) {
  if (params.sourceEvidenceId === params.targetEvidenceId) {
    throw new Error("Evidence relationship source and target must differ");
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
