import type { Prisma } from "@prisma/client";
import {
  ADMIN_AUDIT_ADVISORY_LOCK_KEY,
  canonicalJsonForAuditHash,
  computeAuditLogChainHash,
} from "./lib/admin-audit-chain.js";
import { prisma } from "./db.js";

/**
 * PHASE 12 POINT 3 — this appender wrote `chainVersion: 2` and never bound
 * tenant scope, because the worker's copy of `lib/admin-audit-chain.ts` was an
 * older fork that had no V3 variant at all. Every worker-originated audit row
 * was therefore a NEW V2 write, and carried NULL organization/workspace columns
 * that the V3 hash is supposed to bind.
 *
 * The chain library is now synced with the API's, and this writer emits V3.
 * `organizationId` / `workspaceId` are supplied by the caller from the
 * PERSISTED row it is auditing (evidence.organizationId / evidence.teamId) —
 * never inferred from an actor or ambient context. When a worker action
 * genuinely has no tenant subject the columns stay NULL and are hashed as the
 * explicit null-scope sentinel, which is an honest "unscoped", not a guess.
 */
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
  /** Authoritative persisted tenant scope of the audited row. */
  organizationId?: string | null;
  workspaceId?: string | null;
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
  const organizationId = params.organizationId ?? null;
  const workspaceId = params.workspaceId ?? null;

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
      chainVersion: 3,
      userId: params.userId ?? null,
      action,
      category,
      severity,
      source,
      outcome,
      resourceType,
      resourceId,
      requestId,
      organizationId,
      workspaceId,
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
        chainVersion: 3,
        organizationId,
        workspaceId,
        createdAt,
      },
    });
  });
}