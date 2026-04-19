import { createHash } from "node:crypto";
import * as prismaPkg from "@prisma/client";
import type {
  Prisma,
  EvidenceCertification,
} from "@prisma/client";
import { CertificationType as PrismaCertificationType, CertificationStatus as PrismaCertificationStatus } from "@prisma/client";
import { prisma } from "../db.js";

type SerializedEvidenceCertification = {
  id: string;
  evidenceId: string;
  declarationType: PrismaCertificationType;
  status: PrismaCertificationStatus;
  version: number;
  requestedByUserId: string | null;
  requestedAtUtc: string | null;
  attestedByUserId: string | null;
  attestedAtUtc: string | null;
  attestorName: string | null;
  attestorTitle: string | null;
  attestorEmail: string | null;
  attestorOrganization: string | null;
  statementMarkdown: string | null;
  statementSnapshot: unknown;
  signatureText: string | null;
  certificationHash: string | null;
  revokedAtUtc: string | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
  createdAt: string;
  updatedAt: string;
};

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim().replace(/\s+/g, " ");
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .map(([key, val]) => `${key}:${canonicalize(val)}`);
    return `{${entries.join(",")}}`;
  }

  return String(value);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function normalizeOptionalText(value: unknown, maxLen?: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (typeof maxLen === "number" && maxLen >= 0) {
    return normalized.slice(0, maxLen);
  }

  return normalized;
}

function buildEvidenceCertificationHash(params: {
  evidenceId: string;
  declarationType: PrismaCertificationType;
  version: number;
  attestorName: string | null;
  attestorTitle: string | null;
  attestorEmail: string | null;
  attestorOrganization: string | null;
  statementMarkdown: string | null;
  statementSnapshot: unknown;
  signatureText: string | null;
}): string {
  const payload = {
    evidenceId: params.evidenceId,
    declarationType: params.declarationType,
    version: params.version,
    attestorName: params.attestorName ?? null,
    attestorTitle: params.attestorTitle ?? null,
    attestorEmail: params.attestorEmail ?? null,
    attestorOrganization: params.attestorOrganization ?? null,
    statementMarkdown: params.statementMarkdown ?? null,
    statementSnapshot: params.statementSnapshot ?? null,
    signatureText: params.signatureText ?? null,
  };

  return sha256Hex(canonicalize(payload));
}

function serializeCertification(
  item: EvidenceCertification
): SerializedEvidenceCertification {
  return {
    id: item.id,
    evidenceId: item.evidenceId,
    declarationType: item.declarationType,
    status: item.status,
    version: item.version,
    requestedByUserId: item.requestedByUserId,
    requestedAtUtc: item.requestedAtUtc?.toISOString() ?? null,
    attestedByUserId: item.attestedByUserId,
    attestedAtUtc: item.attestedAtUtc?.toISOString() ?? null,
    attestorName: item.attestorName,
    attestorTitle: item.attestorTitle,
    attestorEmail: item.attestorEmail,
    attestorOrganization: item.attestorOrganization,
    statementMarkdown: item.statementMarkdown,
    statementSnapshot: item.statementSnapshot,
    signatureText: item.signatureText,
    certificationHash: item.certificationHash,
    revokedAtUtc: item.revokedAtUtc?.toISOString() ?? null,
    revokedByUserId: item.revokedByUserId,
    revokeReason: item.revokeReason,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export async function getLatestEvidenceCertification(
  evidenceId: string,
  declarationType: PrismaCertificationType
) {
  return prisma.evidenceCertification.findFirst({
    where: { evidenceId, declarationType },
    orderBy: [{ version: "desc" }, { updatedAt: "desc" }],
  });
}

export async function listEvidenceCertifications(
  evidenceId: string
): Promise<SerializedEvidenceCertification[]> {
  const items = await prisma.evidenceCertification.findMany({
    where: { evidenceId },
    orderBy: [{ declarationType: "asc" }, { version: "desc" }],
  });
  return items.map(serializeCertification);
}

export async function requestEvidenceCertification(params: {
  evidenceId: string;
  declarationType: PrismaCertificationType;
  requestedByUserId: string;
}): Promise<SerializedEvidenceCertification> {
  const latest = await getLatestEvidenceCertification(
    params.evidenceId,
    params.declarationType
  );

  if (
    latest &&
    (latest.status === PrismaCertificationStatus.REQUESTED ||
      latest.status === PrismaCertificationStatus.ATTESTED)
  ) {
    const error = new Error(
      "A certification request already exists for this declaration type"
    ) as Error & { statusCode?: number };
    error.statusCode = 409;
    throw error;
  }

  const version = latest ? latest.version + 1 : 1;
  const requestedAtUtc = new Date();

  const created = await prisma.evidenceCertification.create({
    data: {
      evidenceId: params.evidenceId,
      declarationType: params.declarationType,
      status: PrismaCertificationStatus.REQUESTED,
      version,
      requestedByUserId: params.requestedByUserId,
      requestedAtUtc,
    },
  });

  return serializeCertification(created);
}

export async function attestEvidenceCertification(params: {
  evidenceId: string;
  declarationType: PrismaCertificationType;
  attestedByUserId: string;
  attestorName: string;
  attestorTitle: string;
  attestorEmail: string;
  attestorOrganization?: string | null;
  statementMarkdown: string;
  statementSnapshot?: unknown | null;
  signatureText: string;
}): Promise<SerializedEvidenceCertification> {
  const latest = await getLatestEvidenceCertification(
    params.evidenceId,
    params.declarationType
  );

  if (!latest) {
    const error = new Error("Certification record not found") as Error & {
      statusCode?: number;
    };
    error.statusCode = 404;
    throw error;
  }

  if (latest.status === PrismaCertificationStatus.REVOKED) {
    const error = new Error("Certification record has been revoked") as Error & {
      statusCode?: number;
    };
    error.statusCode = 409;
    throw error;
  }

  const attestorName = normalizeOptionalText(params.attestorName, 160);
  const attestorTitle = normalizeOptionalText(params.attestorTitle, 160);
  const attestorEmail = normalizeOptionalText(params.attestorEmail, 320);
  const attestorOrganization = normalizeOptionalText(
    params.attestorOrganization,
    180
  );
  const statementMarkdown = normalizeOptionalText(params.statementMarkdown);
  const signatureText = normalizeOptionalText(params.signatureText, 512);
  const statementSnapshot =
    params.statementSnapshot === undefined
      ? undefined
      : params.statementSnapshot === null
      ? prismaPkg.Prisma.JsonNull
      : (params.statementSnapshot as Prisma.InputJsonValue);

  const certificationHash = buildEvidenceCertificationHash({
    evidenceId: latest.evidenceId,
    declarationType: latest.declarationType,
    version: latest.version,
    attestorName,
    attestorTitle,
    attestorEmail,
    attestorOrganization,
    statementMarkdown,
    statementSnapshot,
    signatureText,
  });

  const updated = await prisma.evidenceCertification.update({
    where: { id: latest.id },
    data: {
      status: PrismaCertificationStatus.ATTESTED,
      attestedByUserId: params.attestedByUserId,
      attestedAtUtc: new Date(),
      attestorName,
      attestorTitle,
      attestorEmail,
      attestorOrganization,
      statementMarkdown,
      statementSnapshot,
      signatureText,
      certificationHash,
    },
  });

  return serializeCertification(updated);
}

export async function revokeEvidenceCertification(params: {
  evidenceId: string;
  declarationType: PrismaCertificationType;
  revokedByUserId: string;
  reason: string;
}): Promise<SerializedEvidenceCertification> {
  const latest = await getLatestEvidenceCertification(
    params.evidenceId,
    params.declarationType
  );

  if (!latest) {
    const error = new Error("Certification record not found") as Error & {
      statusCode?: number;
    };
    error.statusCode = 404;
    throw error;
  }

  if (latest.status === PrismaCertificationStatus.REVOKED) {
    const error = new Error("Certification record already revoked") as Error & {
      statusCode?: number;
    };
    error.statusCode = 409;
    throw error;
  }

  const revokeReason = normalizeOptionalText(params.reason, 500);

  const updated = await prisma.evidenceCertification.update({
    where: { id: latest.id },
    data: {
      status: PrismaCertificationStatus.REVOKED,
      revokedByUserId: params.revokedByUserId,
      revokedAtUtc: new Date(),
      revokeReason,
    },
  });

  return serializeCertification(updated);
}
