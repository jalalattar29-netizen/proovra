/**
 * Appends to the same global admin audit hash chain as the API (shared canonicalization + hash).
 */
import type { Prisma } from "@prisma/client";
import {
  ADMIN_AUDIT_ADVISORY_LOCK_KEY,
  canonicalJsonForAuditHash,
  computeAuditLogChainHash,
} from "./lib/admin-audit-chain.js";
import { prisma } from "./db.js";

function truncateString(
  value: string | null | undefined,
  max: number
): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export async function appendWorkerAuditLog(params: {
  userId: string;
  action: string;
  metadata: Prisma.InputJsonValue;
}): Promise<void> {
  const action = truncateString(params.action, 128);
  if (!action) return;

  const category = "report";
  const severity = "info";
  const source = "worker_report";
  const outcome = "success";
  const resourceType = "evidence_report";

  const metadataObject =
    params.metadata && typeof params.metadata === "object"
      ? (params.metadata as Record<string, unknown>)
      : {};

  const resourceId =
    typeof metadataObject.evidenceId === "string" &&
    metadataObject.evidenceId.trim()
      ? metadataObject.evidenceId.trim().slice(0, 128)
      : null;

  const requestId = null;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_AUDIT_ADVISORY_LOCK_KEY})`;

    const last = await tx.adminAuditLog.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { hash: true },
    });

    const createdAt = new Date();
    const metadataCanonical = canonicalJsonForAuditHash(
      params.metadata as Prisma.JsonValue
    );

    const hash = computeAuditLogChainHash({
      chainVersion: 2,
      userId: params.userId,
      action,
      category,
      severity,
      source,
      outcome,
      resourceType,
      resourceId,
      requestId,
      metadataCanonical,
      createdAtIso: createdAt.toISOString(),
      prevHash: last?.hash ?? null,
    });

    await tx.adminAuditLog.create({
      data: {
        userId: params.userId,
        isPublic: false,
        action,
        category,
        severity,
        source,
        outcome,
        resourceType,
        resourceId,
        requestId,
        metadata: params.metadata,
        ipAddress: null,
        userAgent: "proovra-worker",
        hash,
        prevHash: last?.hash ?? null,
        chainVersion: 2,
        createdAt,
      },
    });
  });
}