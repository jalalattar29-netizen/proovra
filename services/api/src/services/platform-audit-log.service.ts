import type { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
// The canonical client-label maskers — the same two the session inventory uses,
// so "safe preview" has one definition in the product rather than two.
import { maskIpPreview, summariseUserAgent } from "@proovra/shared";
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

/**
 * PHASE 5 — the version of the EVENT CONTRACT, distinct from `chainVersion`.
 *
 * `chainVersion` says how a row was hashed. This says which dimensions the row
 * was written to carry. They move independently: a future change could seal an
 * existing field without adding one, or add one without changing the hash
 * algorithm. Historical rows default to 1 in the database and are read through
 * the legacy fallback rather than being rewritten to claim a contract they
 * never had.
 */
export const ADMIN_AUDIT_EVENT_VERSION = 2;
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
  // PHASE 5 — sealed by V4, so verification has to read them back. A field
  // bound into the hash but absent from the verify projection would make every
  // V4 row fail verification, which is the failure mode worth being explicit
  // about: the chain does not "mostly" work.
  actorType: string | null;
  actorDisplay: string | null;
  actorAuthority: string | null;
  targetDisplay: string | null;
  previousState: string | null;
  requestedState: string | null;
  resultingState: string | null;
  reasonCode: string | null;
  eventVersion: number | null;
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

/**
 * PHASE 5 §12 — THESE TWO FUNCTIONS DID NOTHING.
 *
 * They were named `truncateUa` and `truncateIp` and they capped LENGTH: the
 * user-agent at 512 characters and the address at 45. A real user-agent is
 * about 120 characters and every IPv4 address is at most 15, so in practice
 * neither was ever shortened by a single byte. The audit trail stored the
 * complete raw client string and the complete raw address, under two names
 * that read like data minimisation.
 *
 * The product already decided how this is done: `AuthenticatedSession` stores
 * `uaPreview` and `ipPreview` and never the raw values, using the canonical
 * `summariseUserAgent` and `maskIpPreview` in @proovra/shared. The audit log
 * simply never adopted them. It does now — the same helpers, so there is one
 * definition of what a safe client label is rather than two that can drift.
 *
 * Historical rows keep whatever they already hold. They are not rewritten: an
 * append-only trail does not get edited to look better, and their hashes cover
 * the values they were written with. The READ path masks legacy values on the
 * way out instead (see `projectAuditClientLabels`).
 */
function safeUaPreview(ua: string | undefined): string | null {
  if (!ua) return null;
  const summary = summariseUserAgent(ua);
  return summary.trim().length > 0 ? summary.slice(0, 512) : null;
}

function safeIpPreview(ip: string | undefined): string | null {
  if (!ip) return null;
  const masked = maskIpPreview(ip);
  return masked.trim().length > 0 ? masked.slice(0, 45) : null;
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
   * tenant-audit facade; enable DB-level scope filtering). Bound into V3+. */
  organizationId?: string | null;
  workspaceId?: string | null;
  requestId?: string | null;
  /**
   * PHASE 5 — the identity and transition contract. Populated by the canonical
   * audit facade, which derives what the caller did not state. Bound into V4:
   * an attribution field that verification did not cover would look
   * authoritative while remaining editable.
   */
  actorType?: string | null;
  actorDisplay?: string | null;
  actorAuthority?: string | null;
  targetDisplay?: string | null;
  previousState?: string | null;
  requestedState?: string | null;
  resultingState?: string | null;
  reasonCode?: string | null;
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
    // PHASE 5 — the identity and transition contract, normalised once so the
    // hashed value and the stored value cannot possibly differ.
    const actorType = params.actorType ?? null;
    const actorDisplay = params.actorDisplay ?? null;
    const actorAuthority = params.actorAuthority ?? null;
    const targetDisplay = params.targetDisplay ?? null;
    const previousState = params.previousState ?? null;
    const requestedState = params.requestedState ?? null;
    const resultingState = params.resultingState ?? null;
    const reasonCode = params.reasonCode ?? null;
    const eventVersion = ADMIN_AUDIT_EVENT_VERSION;
    const hash = computeAuditLogChainHash({
      chainVersion: 4,
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
      actorType,
      actorDisplay,
      actorAuthority,
      targetDisplay,
      previousState,
      requestedState,
      resultingState,
      reasonCode,
      eventVersion,
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
        actorType,
        actorDisplay,
        actorAuthority,
        targetDisplay,
        previousState,
        requestedState,
        resultingState,
        reasonCode,
        eventVersion,
        metadata: sanitized,
        ipAddress: safeIpPreview(params.ipAddress ?? undefined),
        userAgent: safeUaPreview(params.userAgent ?? undefined),
        hash,
        prevHash: last?.hash ?? null,
        chainVersion: 4,
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
  version: 1 | 2 | 3 | 4
): string {
  const metadataCanonical = canonicalJsonForAuditHash(row.metadata);

  if (version === 4) {
    return computeAuditLogChainHash({
      chainVersion: 4,
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
      actorType: row.actorType ?? null,
      actorDisplay: row.actorDisplay ?? null,
      actorAuthority: row.actorAuthority ?? null,
      targetDisplay: row.targetDisplay ?? null,
      previousState: row.previousState ?? null,
      requestedState: row.requestedState ?? null,
      resultingState: row.resultingState ?? null,
      reasonCode: row.reasonCode ?? null,
      eventVersion: row.eventVersion ?? ADMIN_AUDIT_EVENT_VERSION,
      metadataCanonical,
      createdAtIso: row.createdAt.toISOString(),
      prevHash: previousHash,
    });
  }

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
      row.chainVersion === 4
        ? 4
        : row.chainVersion === 3
          ? 3
          : row.chainVersion === 2
            ? 2
            : 1
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
    // PHASE 5 — V4 binds these, so verification must read exactly what was
    // hashed. Omitting one here would fail every V4 row rather than a
    // tampered one, which is the kind of break that looks like a compromise.
    actorType: true,
    actorDisplay: true,
    actorAuthority: true,
    targetDisplay: true,
    previousState: true,
    requestedState: true,
    resultingState: true,
    reasonCode: true,
    eventVersion: true,
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
  /**
   * PHASE 5 §11 — investigation filters, all applied DATABASE-side.
   *
   * The alternative — narrowing a fetched page in the route — was already
   * tried once on this endpoint for `source` and had to be corrected: the
   * operator narrowed the view, the backend ignored it, and an export "with
   * filters" carried a different set than the screen. Every filter here goes
   * into the same `where` the list and the export both build.
   */
  actorType?: string | null;
  actorUserId?: string | null;
  workspaceId?: string | null;
  organizationId?: string | null;
  requestId?: string | null;
  occurredFromUtc?: Date | null;
  occurredUntilUtc?: Date | null;
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
    organizationId: string | null;
    workspaceId: string | null;
    requestId: string | null;
    actorType: string;
    actorDisplay: string | null;
    actorAuthority: string | null;
    targetDisplay: string | null;
    previousState: string | null;
    requestedState: string | null;
    resultingState: string | null;
    reasonCode: string | null;
    eventVersion: number | null;
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
    // PHASE 5 §11 — actor, tenant, correlation and time, DB-side.
    ...(params.actorType ? { actorType: params.actorType } : {}),
    ...(params.actorUserId ? { userId: params.actorUserId } : {}),
    ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
    ...(params.organizationId ? { organizationId: params.organizationId } : {}),
    ...(params.requestId ? { requestId: params.requestId.trim().slice(0, 64) } : {}),
    ...(params.occurredFromUtc || params.occurredUntilUtc
      ? {
          createdAt: {
            ...(params.occurredFromUtc ? { gte: params.occurredFromUtc } : {}),
            ...(params.occurredUntilUtc ? { lte: params.occurredUntilUtc } : {}),
          },
        }
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
      actorType: true,
      actorDisplay: true,
      actorAuthority: true,
      targetDisplay: true,
      previousState: true,
      requestedState: true,
      resultingState: true,
      reasonCode: true,
      eventVersion: true,
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
      organizationId: r.organizationId,
      workspaceId: r.workspaceId,
      requestId: r.requestId,
      // PHASE 5 — the identity and transition contract reaches the reader.
      // A field the console cannot see is a field that does not exist for the
      // operator it was written for.
      actorType: r.actorType ?? "UNKNOWN_LEGACY",
      actorDisplay: r.actorDisplay,
      actorAuthority: r.actorAuthority,
      targetDisplay: r.targetDisplay,
      previousState: r.previousState,
      requestedState: r.requestedState,
      resultingState: r.resultingState,
      reasonCode: r.reasonCode,
      eventVersion: r.eventVersion,
      metadata: r.metadata,
      // PHASE 5 §12 — rows written before the writer adopted the canonical
      // maskers hold complete raw addresses and complete raw client strings.
      // They are masked HERE rather than by an UPDATE: rewriting historical
      // audit rows would invalidate hashes that legitimately cover the values
      // those rows were written with. Masking is idempotent, so a row already
      // stored safely passes through unchanged.
      ipAddress: r.ipAddress ? maskIpPreview(r.ipAddress) : null,
      userAgent: r.userAgent ? summariseUserAgent(r.userAgent) : null,
      hash: r.hash,
      prevHash: r.prevHash,
      chainVersion: r.chainVersion,
      createdAt: r.createdAt.toISOString(),
      anchoredAt: r.anchoredAt ? r.anchoredAt.toISOString() : null,
    })),
  };
}