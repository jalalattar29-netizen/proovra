import type { Prisma } from "@prisma/client";
import {
  ADMIN_AUDIT_ADVISORY_LOCK_KEY,
  canonicalJsonForAuditHash,
  computeAuditLogChainHash,
} from "./lib/admin-audit-chain.js";
import { prisma } from "./db.js";

export async function appendWorkerAuditLog(params: {
  userId: string | null;
  action: string;
  category?: string | null;
  severity?: "info" | "warning" | "critical" | null;
  source?: string | null;
  outcome?: "success" | "failure" | "blocked" | null;
  resourceType?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  const action = params.action.trim().slice(0, 128);
  if (!action) return;

  const category = params.category?.trim().slice(0, 64) || null;
  const severity = params.severity ?? "info";
  const source = params.source?.trim().slice(0, 64) || "worker";
  const outcome = params.outcome ?? "success";
  const resourceType = params.resourceType?.trim().slice(0, 64) || null;
  const resourceId = params.resourceId?.trim().slice(0, 128) || null;
  const requestId = params.requestId?.trim().slice(0, 64) || null;
  const metadata = (params.metadata ?? {}) as Prisma.InputJsonValue;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(${ADMIN_AUDIT_ADVISORY_LOCK_KEY})
    `;

    const last = await tx.adminAuditLog.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { hash: true },
    });

    const createdAt = new Date();
    const metadataCanonical = canonicalJsonForAuditHash(
      metadata as Prisma.JsonValue
    );

    const hash = computeAuditLogChainHash({
      chainVersion: 2,
      userId: params.userId ?? null,
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
        userId: params.userId ?? null,
        isPublic: false,
        action,
        category,
        severity,
        source,
        outcome,
        resourceType,
        resourceId,
        requestId,
        metadata,
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