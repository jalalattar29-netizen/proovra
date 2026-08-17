import type { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  ADMIN_AUDIT_ADVISORY_LOCK_KEY,
  assertMetadataMaxDepth,
  canonicalJsonForAuditHash,
  computeAuditLogChainHash,
  METADATA_MAX_DEPTH_DEFAULT,
} from "../lib/admin-audit-chain.js";
import { prisma } from "../db.js";

/** Legacy sentinel kept in DB for rows created before user_id could be null. */
const LEGACY_PUBLIC_VERIFY_USER_ID = "__public_verify__";

const METADATA_MAX_BYTES = 5120;
const MAX_ACTION_LEN = 128;
const MAX_CATEGORY_LEN = 64;
const MAX_SEVERITY_LEN = 16;
const MAX_SOURCE_LEN = 64;
const MAX_OUTCOME_LEN = 24;
const MAX_RESOURCE_TYPE_LEN = 64;
const MAX_RESOURCE_ID_LEN = 128;
const MAX_REQUEST_ID_LEN = 64;
const VERIFY_TAIL_MAX = 50_000;

type JsonPrimitive = string | number | boolean | null;

type AuditRowForVerify = {
  id: string;
  userId: string | null;
  action: string;
  category: string | null;
  severity: string | null;
  source: string | null;
  outcome: string | null;
  resourceType: string | null;
  resourceId: string | null;
  organizationId: string | null;
  workspaceId: string | null;
  requestId: string | null;
  metadata: Prisma.JsonValue;
  hash: string;
  prevHash: string | null;
  chainVersion: number;
  createdAt: Date;
};

function truncateString(
  value: string | null | undefined,
  max: number
): string | null {
  if (!value) return null;

  const t = value.trim();
  if (!t) return null;

  return t.length > max ? t.slice(0, max) : t;
}

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
    return value
      .slice(0, 50)
      .map((v) => sanitizeValue(v, depth + 1)) as unknown[];
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
  category?: string | null;
  severity?: string | null;
  source?: string | null;
  outcome?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  /** PHASE 11 — authoritative tenant columns (populated ONLY by the canonical
   * tenant-audit facade; enable DB-level scope filtering). Not part of the hash. */
  organizationId?: string | null;
  workspaceId?: string | null;
  requestId?: string | null;
  metadata: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  db?: PrismaClient;
};

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

  const category = truncateString(params.category, MAX_CATEGORY_LEN);
  const severity = truncateString(params.severity, MAX_SEVERITY_LEN);
  const source = truncateString(params.source, MAX_SOURCE_LEN);
  const outcome = truncateString(params.outcome, MAX_OUTCOME_LEN);
  const resourceType = truncateString(params.resourceType, MAX_RESOURCE_TYPE_LEN);
  const resourceId = truncateString(params.resourceId, MAX_RESOURCE_ID_LEN);
  const requestId = truncateString(params.requestId, MAX_REQUEST_ID_LEN);

  /**
   * PHASE 12 CORRECTIVE PASS — NEW-001 (2026-08-06). NESTED-TRANSACTION FIX.
   *
   * FOUND BY RUNTIME PROBING, NOT BY TESTS. Driving `revokeMember` against a
   * REAL PostgreSQL threw `db.$transaction is not a function`, which means
   * WORKSPACE MEMBER REVOCATION AND SUSPENSION COULD NOT COMPLETE AT ALL:
   *
   *     rbac.revokeMember/suspendMember
   *       -> runAtomically(client, tx => …)              // interactive tx
   *         -> emitMemberAudit(tx, …)
   *           -> emitTenantAudit(env, tx)
   *             -> appendPlatformAuditLog({ …, db: tx }) // db IS the tx
   *               -> db.$transaction(…)                  // TypeError
   *
   * A Prisma interactive-transaction client deliberately exposes no
   * `$transaction` — nesting is not a thing it can do. The entire unit-test
   * estate missed this because those suites inject in-memory fakes whose
   * "transaction" is a plain function call, so the nested call succeeded
   * there and only there.
   *
   * The defect is PRE-EXISTING: the identical chain is present unchanged at
   * `a7863bec`, the audited revision. It is recorded as a new finding rather
   * than folded into SEC-001.
   *
   * THE CORRECTION. When this function is already inside a caller's
   * transaction, it must USE that transaction instead of opening another.
   * That is not merely a workaround — it is the stronger semantic: the audit
   * row now commits ATOMICALLY with the membership change that caused it, so
   * a rolled-back revocation can no longer leave an audit row claiming it
   * happened.
   *
   * `pg_advisory_xact_lock` keeps working identically: it is scoped to the
   * enclosing transaction either way, which is exactly what serialises the
   * hash-chain append. The lock is simply held for the remainder of the
   * caller's transaction rather than for a short nested one — correct, and
   * the reason the chain stays consistent under concurrency.
   */
  const canOpenTransaction =
    typeof (db as { $transaction?: unknown }).$transaction === "function";
  const runInTransaction = async (
    body: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> => {
    if (canOpenTransaction) {
      await (db as PrismaClient).$transaction(body);
      return;
    }
    // Already inside one: `db` IS the transaction client.
    await body(db as unknown as Prisma.TransactionClient);
  };

  await runInTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_AUDIT_ADVISORY_LOCK_KEY})`;

    const last = await tx.adminAuditLog.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { hash: true },
    });

    const createdAt = new Date();
    const metadataCanonical = canonicalJsonForAuditHash(
      sanitized as Prisma.JsonValue
    );

    // PHASE 11 §1 — V3 binds the authoritative tenant scope columns into the
    // hash. V3 is the ONLY new write format; historical V1/V2 rows are untouched.
    const organizationId = params.organizationId ?? null;
    const workspaceId = params.workspaceId ?? null;
    const hash = computeAuditLogChainHash({
      chainVersion: 3,
      userId,
      action,
      category,
      severity,
      source,
      outcome,
      resourceType,
      resourceId,
      organizationId,
      workspaceId,
      requestId,
      metadataCanonical,
      createdAtIso: createdAt.toISOString(),
      prevHash: last?.hash ?? null,
    });

    await tx.adminAuditLog.create({
      data: {
        userId,
        isPublic,
        action,
        category,
        severity,
        source,
        outcome,
        resourceType,
        resourceId,
        requestId,
        metadata: sanitized,
        ipAddress: truncateIp(params.ipAddress ?? undefined),
        userAgent: truncateUa(params.userAgent ?? undefined, 512),
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

function computeExpectedHashForRow(
  row: AuditRowForVerify,
  previousHash: string | null,
  version: 1 | 2 | 3
): string {
  const metadataCanonical = canonicalJsonForAuditHash(row.metadata);

  if (version === 3) {
    return computeAuditLogChainHash({
      chainVersion: 3,
      userId: row.userId,
      action: row.action,
      category: row.category,
      severity: row.severity,
      source: row.source,
      outcome: row.outcome,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      organizationId: row.organizationId ?? null,
      workspaceId: row.workspaceId ?? null,
      requestId: row.requestId,
      metadataCanonical,
      createdAtIso: row.createdAt.toISOString(),
      prevHash: previousHash,
    });
  }

  if (version === 2) {
    return computeAuditLogChainHash({
      chainVersion: 2,
      userId: row.userId,
      action: row.action,
      category: row.category,
      severity: row.severity,
      source: row.source,
      outcome: row.outcome,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      requestId: row.requestId,
      metadataCanonical,
      createdAtIso: row.createdAt.toISOString(),
      prevHash: previousHash,
    });
  }

  return computeAuditLogChainHash({
    chainVersion: 1,
    userId: row.userId,
    action: row.action,
    metadataCanonical,
    createdAtIso: row.createdAt.toISOString(),
    prevHash: previousHash,
  });
}

function verifyOrderedRows(
  rows: AuditRowForVerify[],
  expectedPrevForFirst: string | null
):
  | { valid: true }
  | { valid: false; brokenAt: string } {
  let previousHash: string | null = expectedPrevForFirst;

  for (const row of rows) {
    if (row.prevHash !== previousHash) {
      return { valid: false, brokenAt: row.id };
    }

    const expected = computeExpectedHashForRow(
      row,
      previousHash,
      row.chainVersion === 3 ? 3 : row.chainVersion === 2 ? 2 : 1
    );

    if (expected !== row.hash) {
      return { valid: false, brokenAt: row.id };
    }

    previousHash = row.hash;
  }

  return { valid: true };
}

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
    category: true,
    severity: true,
    source: true,
    outcome: true,
    resourceType: true,
    resourceId: true,
    organizationId: true,
    workspaceId: true,
    requestId: true,
    metadata: true,
    hash: true,
    prevHash: true,
    chainVersion: true,
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

// ---------------------------------------------------------------------------
// PHASE 13 §4 (2026-08-17) — `repairAdminAuditChainVersions` was REMOVED here.
//
// It was preserved as "incident-response repair of the platform admin audit
// hash chain, with a dry-run mode ... the module's own chain-verification reader
// has no other remedy to offer when it reports a break". Reading what it
// actually did shows it was never that remedy.
//
// It repaired a LABEL, not a chain. For each row it recomputed the expected hash
// under chain version 1 and under chain version 2, and when one of them matched
// the STORED hash it corrected the row's `chainVersion` column to say so. A row
// whose `prevHash` did not follow, or whose hash matched neither recomputation
// — that is, an actual break — made it RETURN EARLY with `brokenAt`, repairing
// nothing. It was the v1→v2 migration's one-time backfill of `chain_version`,
// which is why it only knows those two versions.
//
// And that is now the reason it must not be kept: the chain is on version 3.
// `computeExpectedHashForRow` has taken a version-3 branch since v3 shipped and
// `verifyOrderedRows` verifies against it, but this function still tried only 1
// and 2. Run against any current database it would meet the first v3 row, match
// neither recomputation, and report a healthy chain as `brokenAt` — an
// incident-response tool whose failure mode is to manufacture an incident.
//
// The genuine remedy for a reported break is unchanged and is deliberately not
// automated: `verifyAdminAuditChain`, reachable at
// `GET /v1/admin/audit-log/verify` behind `requirePlatformAdmin`, names the row
// where the chain stops. Rewriting audit rows to make a verifier pass is not a
// capability this system should keep loaded; if a chain-version relabel is ever
// needed again it belongs in a migration written against the version in force at
// that time, and that contract is recorded in `docs/architecture/program-ledger.md`.
// ---------------------------------------------------------------------------

export async function listAdminAuditLogs(params: {
  limit: number;
  cursorId?: string | null;
  action?: string | null;
  category?: string | null;
  severity?: string | null;
  outcome?: string | null;
  /**
   * PHASE 12 BATCH A1 — bounded `source` filter.
   *
   * The Admin Audit page has always exposed a source filter and sent it on the
   * list read, but this canonical query accepted no such parameter, so the
   * backend silently ignored it: the operator narrowed the view, the table did
   * not change, and an export "with filters" carried a different set than the
   * screen. Filtering is applied DATABASE-side here, in the same `where` the
   * list and export both build, so the two can never diverge again.
   */
  source?: string | null;
  search?: string | null;
  db?: PrismaClient;
}): Promise<{
  items: Array<{
    id: string;
    userId: string | null;
    isPublic: boolean;
    action: string;
    category: string | null;
    severity: string | null;
    source: string | null;
    outcome: string | null;
    resourceType: string | null;
    resourceId: string | null;
    requestId: string | null;
    metadata: Prisma.JsonValue;
    ipAddress: string | null;
    userAgent: string | null;
    hash: string;
    prevHash: string | null;
    chainVersion: number;
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

  const where: Prisma.AdminAuditLogWhereInput = {
    ...(params.action ? { action: params.action } : {}),
    ...(params.category ? { category: params.category } : {}),
    ...(params.severity ? { severity: params.severity } : {}),
    ...(params.outcome ? { outcome: params.outcome } : {}),
    // PHASE 12 BATCH A1 — bounded, DB-side source narrowing. Trimmed and
    // length-capped so a pathological value can never become an unbounded scan;
    // an unmatched value simply yields an empty page rather than an error.
    ...(params.source && params.source.trim()
      ? { source: params.source.trim().slice(0, 64) }
      : {}),
    ...(params.search
      ? {
          OR: [
            { action: { contains: params.search, mode: "insensitive" } },
            { category: { contains: params.search, mode: "insensitive" } },
            { source: { contains: params.search, mode: "insensitive" } },
            { resourceType: { contains: params.search, mode: "insensitive" } },
            { resourceId: { contains: params.search, mode: "insensitive" } },
            { requestId: { contains: params.search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(cursorRow !== null
      ? {
          AND: [
            {
              OR: [
                { createdAt: { lt: cursorRow.createdAt } },
                {
                  AND: [
                    { createdAt: cursorRow.createdAt },
                    { id: { lt: cursorRow.id } },
                  ],
                },
              ],
            },
          ],
        }
      : {}),
  };

  const rows = await db.adminAuditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      userId: true,
      isPublic: true,
      action: true,
      category: true,
      severity: true,
      source: true,
      outcome: true,
      resourceType: true,
      resourceId: true,
      organizationId: true,
      workspaceId: true,
      requestId: true,
      metadata: true,
      ipAddress: true,
      userAgent: true,
      hash: true,
      prevHash: true,
      chainVersion: true,
      createdAt: true,
      anchoredAt: true,
    },
  });

  return {
    items: rows.map((r) => ({
      id: r.id,
      userId: r.userId === LEGACY_PUBLIC_VERIFY_USER_ID ? null : r.userId,
      isPublic: r.isPublic || r.userId === LEGACY_PUBLIC_VERIFY_USER_ID,
      action: r.action,
      category: r.category,
      severity: r.severity,
      source: r.source,
      outcome: r.outcome,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      requestId: r.requestId,
      metadata: r.metadata,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      hash: r.hash,
      prevHash: r.prevHash,
      chainVersion: r.chainVersion,
      createdAt: r.createdAt.toISOString(),
      anchoredAt: r.anchoredAt ? r.anchoredAt.toISOString() : null,
    })),
  };
}