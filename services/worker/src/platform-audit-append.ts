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

export async function appendWorkerAuditLog(params: {
  userId: string;
  action: string;
  metadata: Prisma.InputJsonValue;
}): Promise<void> {
  const action = params.action.trim().slice(0, 128);
  if (!action) return;

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
      userId: params.userId,
      action,
      metadataCanonical,
      createdAtIso: createdAt.toISOString(),
      prevHash: last?.hash ?? null,
    });

    await tx.adminAuditLog.create({
      data: {
        userId: params.userId,
        isPublic: false,
        action,
        metadata: params.metadata,
        ipAddress: null,
        userAgent: "proovra-worker",
        hash,
        prevHash: last?.hash ?? null,
        createdAt,
      },
    });
  });
}
