import type { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  ADMIN_AUDIT_ADVISORY_LOCK_KEY,
  assertMetadataMaxDepth,
  auditLogHashUserSegment,
  canonicalJsonForAuditHash,
  computeAuditLogChainHash,
  METADATA_MAX_DEPTH_DEFAULT,
} from "@proovra/shared";
import { prisma } from "../db.js";

/** Legacy sentinel kept in DB for rows created before user_id could be null. */
const LEGACY_PUBLIC_VERIFY_USER_ID = "__public_verify__";

const METADATA_MAX_BYTES = 5120;
const MAX_ACTION_LEN = 128;

type JsonPrimitive = string | number | boolean | null;

function sanitizeValue(
  value: unknown,
  depth: number
): JsonPrimitive | unknown[] | Record<string, unknown> {
  if (depth > 6) return "[max_depth]";
  if (value === null) return null;
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeValue(v, depth + 1)) as unknown[];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      const key = k.length > 120 ? k.slice(0, 120) : k;
      out[key] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return null;
}

export function sanitizeAuditMetadata(raw: unknown): Prisma.InputJsonValue {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw === "object") {
    assertMetadataMaxDepth(raw, METADATA_MAX_DEPTH_DEFAULT);
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value: sanitizeValue(raw, 0) } as Prisma.InputJsonValue;
  }
  return sanitizeValue(raw, 0) as Prisma.InputJsonValue;
}

export function assertMetadataSize(metadata: Prisma.InputJsonValue): void {
  const size = Buffer.byteLength(JSON.stringify(metadata), "utf8");
  if (size > METADATA_MAX_BYTES) {
    throw new Error("METADATA_TOO_LARGE");
  }
}

function truncateUa(ua: string | undefined, max: number): string | null {
  if (!ua) return null;
  const t = ua.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function truncateIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const t = ip.trim();
  if (!t) return null;
  return t.length > 45 ? t.slice(0, 45) : t;
}

export type AppendPlatformAuditParams = {
  userId: string | null;
  isPublic?: boolean;
  action: string;
  metadata: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  db?: PrismaClient;
};

/**
 * Append-only audit row with global hash chain (advisory lock).
 */
export async function appendPlatformAuditLog(
  params: AppendPlatformAuditParams
): Promise<void> {
  const action = params.action.trim().slice(0, MAX_ACTION_LEN);
  if (!action) throw new Error("INVALID_ACTION");

  const isPublic = params.isPublic === true;
  const userId = params.userId;
  if (!isPublic && (userId === null || userId === "")) {
    throw new Error("INVALID_USER_ID");
  }

  const db = params.db ?? prisma;
  const sanitized = sanitizeAuditMetadata(params.metadata);
  assertMetadataSize(sanitized);

  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_AUDIT_ADVISORY_LOCK_KEY})`;

    const last = await tx.adminAuditLog.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { hash: true },
    });

    const createdAt = new Date();
    const metadataCanonical = canonicalJsonForAuditHash(sanitized as Prisma.JsonValue);
    const hash = computeAuditLogChainHash({
      userId,
      action,
      metadataCanonical,
      createdAtIso: createdAt.toISOString(),
      prevHash: last?.hash ?? null,
    });

    await tx.adminAuditLog.create({
      data: {
        userId,
        isPublic,
        action,
        metadata: sanitized,
        ipAddress: truncateIp(params.ipAddress ?? undefined),
        userAgent: truncateUa(params.userAgent ?? undefined, 512),
        hash,
        prevHash: last?.hash ?? null,
        createdAt,
      },
    });
  });
}

function verifyOrderedRows(
  rows: Array<{
    id: string;
    userId: string | null;
    action: string;
    metadata: Prisma.JsonValue;
    hash: string;
    prevHash: string | null;
    createdAt: Date;
  }>,
  expectedPrevForFirst: string | null
):
  | { valid: true }
  | { valid: false; brokenAt: string } {
  let previousHash: string | null = expectedPrevForFirst;

  for (const row of rows) {
    if (row.prevHash !== previousHash) {
      return { valid: false, brokenAt: row.id };
    }
    const metadataCanonical = canonicalJsonForAuditHash(row.metadata);
    const expected = computeAuditLogChainHash({
      userId: row.userId,
      action: row.action,
      metadataCanonical,
      createdAtIso: row.createdAt.toISOString(),
      prevHash: previousHash,
    });
    if (expected !== row.hash) {
      return { valid: false, brokenAt: row.id };
    }
    previousHash = row.hash;
  }

  return { valid: true };
}

const VERIFY_TAIL_MAX = 50_000;

export async function verifyAdminAuditChain(options?: {
  db?: PrismaClient;
  tailLimit?: number | null;
}): Promise<
  | { valid: true; partial?: boolean; verifiedCount?: number }
  | { valid: false; brokenAt: string }
> {
  const db = options?.db ?? prisma;
  const rawLimit = options?.tailLimit;
  const tailLimit =
    rawLimit != null && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), VERIFY_TAIL_MAX)
      : null;

  const select = {
    id: true,
    userId: true,
    action: true,
    metadata: true,
    hash: true,
    prevHash: true,
    createdAt: true,
  } as const;

  if (tailLimit == null) {
    const rows = await db.adminAuditLog.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select,
    });
    return verifyOrderedRows(rows, null);
  }

  const tailRowsDesc = await db.adminAuditLog.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: tailLimit,
    select,
  });

  const rows = [...tailRowsDesc].reverse();

  if (rows.length === 0) {
    return { valid: true, partial: true, verifiedCount: 0 };
  }

  const first = rows[0];
  const predecessor = await db.adminAuditLog.findFirst({
    where: {
      OR: [
        { createdAt: { lt: first.createdAt } },
        {
          AND: [{ createdAt: first.createdAt }, { id: { lt: first.id } }],
        },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { hash: true },
  });

  const expectedPrev = predecessor?.hash ?? null;
  const result = verifyOrderedRows(rows, expectedPrev);
  if (!result.valid) return result;
  return { valid: true, partial: true, verifiedCount: rows.length };
}

export async function listAdminAuditLogs(params: {
  limit: number;
  cursorId?: string | null;
  db?: PrismaClient;
}): Promise<{
  items: Array<{
    id: string;
    userId: string | null;
    isPublic: boolean;
    action: string;
    metadata: Prisma.JsonValue;
    ipAddress: string | null;
    userAgent: string | null;
    hash: string;
    prevHash: string | null;
    createdAt: string;
    anchoredAt: string | null;
  }>;
}> {
  const db = params.db ?? prisma;
  const take = Math.min(Math.max(params.limit, 1), 100);

  let cursorRow: { id: string; createdAt: Date } | null = null;
  if (params.cursorId) {
    cursorRow = await db.adminAuditLog.findUnique({
      where: { id: params.cursorId },
      select: { id: true, createdAt: true },
    });
  }

  const where =
    cursorRow !== null
      ? {
          OR: [
            { createdAt: { lt: cursorRow.createdAt } },
            {
              AND: [
                { createdAt: cursorRow.createdAt },
                { id: { lt: cursorRow.id } },
              ],
            },
          ],
        }
      : {};

  const rows = await db.adminAuditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      userId: true,
      isPublic: true,
      action: true,
      metadata: true,
      ipAddress: true,
      userAgent: true,
      hash: true,
      prevHash: true,
      createdAt: true,
      anchoredAt: true,
    },
  });

  return {
    items: rows.map((r) => ({
      id: r.id,
      userId:
        r.userId === LEGACY_PUBLIC_VERIFY_USER_ID ? null : r.userId,
      isPublic: r.isPublic || r.userId === LEGACY_PUBLIC_VERIFY_USER_ID,
      action: r.action,
      metadata: r.metadata,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      hash: r.hash,
      prevHash: r.prevHash,
      createdAt: r.createdAt.toISOString(),
      anchoredAt: r.anchoredAt ? r.anchoredAt.toISOString() : null,
    })),
  };
}
