/**
 * Phase 12 — UploadSession service.
 *
 * Wraps the operations-facing lifecycle of an evidence upload. The
 * existing EvidenceStatus enum remains authoritative for forensic /
 * chain decisions; this service maintains an additive row that
 * surfaces multipart bookkeeping + recovery state (STALLED /
 * ABANDONED / REVIEW_REQUIRED) without mutating any evidence column.
 *
 * Every state-changing call:
 *   - validates the transition against the canonical matrix
 *   - bumps `lastActivityAtUtc`
 *   - is best-effort (failures NEVER bubble up to the caller — the
 *     forensic evidence path stays intact even if the session row is
 *     unreachable for a moment)
 */

import type {
  PrismaClient,
  UploadSession as DbUploadSession,
  UploadSessionStatus as DbUploadSessionStatus,
} from "@prisma/client";
import {
  isAllowedUploadSessionTransition,
  isTerminalUploadSessionStatus,
  type UploadSessionStatus,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export class UploadSessionTransitionError extends Error {
  constructor(
    public readonly from: UploadSessionStatus,
    public readonly to: UploadSessionStatus,
  ) {
    super(`invalid_transition:${from}->${to}`);
    this.name = "UploadSessionTransitionError";
  }
}

// -----------------------------------------------------------------------------
// Create / read
// -----------------------------------------------------------------------------

export type EnsureUploadSessionInput = {
  evidenceId: string;
  teamId: string;
  isMultipart?: boolean;
  expectedPartCount?: number | null;
};

/**
 * Idempotently create the session row for an evidence record. Safe to
 * call repeatedly — returns the existing row if one is already present.
 * Failure is swallowed and `null` is returned so the upload path is
 * never blocked on the operations-mirror table.
 */
export async function ensureUploadSession(
  input: EnsureUploadSessionInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbUploadSession | null> {
  try {
    const existing = await client.uploadSession.findUnique({
      where: { evidenceId: input.evidenceId },
    });
    if (existing) return existing;
    return await client.uploadSession.create({
      data: {
        evidenceId: input.evidenceId,
        teamId: input.teamId,
        isMultipart: input.isMultipart ?? false,
        expectedPartCount: input.expectedPartCount ?? null,
        status: "CREATED",
      },
    });
  } catch {
    return null;
  }
}

export async function getUploadSessionByEvidence(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbUploadSession | null> {
  try {
    return await client.uploadSession.findUnique({
      where: { evidenceId },
    });
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Transitions
// -----------------------------------------------------------------------------

export type TransitionInput = {
  evidenceId: string;
  to: UploadSessionStatus;
  /** Optional human-readable reason — appended to `failureReason` for
   *  FAILED / STALLED / ABANDONED transitions. NEVER store sensitive
   *  data here; it appears in the operations UI. */
  reason?: string | null;
  /** When true, an invalid transition raises instead of returning null. */
  strict?: boolean;
  /** When set, increments `completedPartCount` to this value. */
  completedPartCount?: number;
  /** When set, increments `retryCount` by 1. */
  bumpRetry?: boolean;
  /**
   * The caller must be the ONE writer.
   *
   * By default a self-transition is a harmless no-op (heartbeats rely on it)
   * and a lost race hands back the canonical row (a pipeline step that finds
   * the work already done is content). An OPERATOR action is neither: a
   * second click on "mark abandoned" re-stamped `abandonedAtUtc`, emitted a
   * second security event, and answered 200 — and two operators racing each
   * other both answered 200. With this set, a self-transition and a lost race
   * both return null, so the route reports a refusal and nothing is written
   * or emitted twice.
   */
  exclusive?: boolean;
};

/**
 * Atomic, transition-validated update. Uses `updateMany` with a
 * status-WHERE guard so two concurrent transitions cannot both win.
 *
 * Returns the post-transition row on success, or `null` if the row
 * is missing / the transition is rejected. With `strict: true`, an
 * invalid transition raises `UploadSessionTransitionError`.
 */
export async function transitionUploadSession(
  input: TransitionInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbUploadSession | null> {
  let current: DbUploadSession | null;
  try {
    current = await client.uploadSession.findUnique({
      where: { evidenceId: input.evidenceId },
    });
  } catch {
    return null;
  }
  if (!current) return null;

  const from = current.status as UploadSessionStatus;
  const to = input.to;
  // COMPLETED is never a generic request: only `settleCompletedUploadSession`,
  // which proves completion from the record itself, may write it.
  const completionRequested = to === "COMPLETED" && from !== "COMPLETED";
  if (completionRequested || !isAllowedUploadSessionTransition(from, to) || (input.exclusive && from === to)) {
    if (input.strict) throw new UploadSessionTransitionError(from, to);
    return null;
  }

  const now = new Date();
  const data: Record<string, unknown> = {
    status: to as DbUploadSessionStatus,
    lastActivityAtUtc: now,
  };
  if (input.reason !== undefined) {
    data.failureReason = input.reason?.slice(0, 400) ?? null;
  }
  if (typeof input.completedPartCount === "number") {
    data.completedPartCount = Math.max(0, input.completedPartCount);
  }
  if (input.bumpRetry) data.retryCount = { increment: 1 };
  if (to === "STALLED") data.stalledAtUtc = now;
  if (to === "ABANDONED") data.abandonedAtUtc = now;
  if (to === "COMPLETED") data.completedAtUtc = now;

  try {
    const claim = await client.uploadSession.updateMany({
      where: { evidenceId: input.evidenceId, status: from },
      data,
    });
    if (claim.count !== 1) {
      // Lost the race. An exclusive caller is told so; anyone else gets
      // whatever the canonical state is now.
      if (input.exclusive) return null;
      return await client.uploadSession.findUnique({
        where: { evidenceId: input.evidenceId },
      });
    }
    return await client.uploadSession.findUnique({
      where: { evidenceId: input.evidenceId },
    });
  } catch {
    return null;
  }
}

/** Convenience wrapper — non-strict, swallows errors. */
export async function safeTransitionUploadSession(
  input: TransitionInput,
  client: PrismaClient = defaultPrisma,
): Promise<DbUploadSession | null> {
  return transitionUploadSession({ ...input, strict: false }, client).catch(
    () => null,
  );
}

// -----------------------------------------------------------------------------
// THE ONE WAY A SESSION COMPLETES OUTSIDE THE VERIFYING WINDOW
// -----------------------------------------------------------------------------

/** Record states that ARE canonical finalization: the record was signed. */
const FINALIZED_EVIDENCE = new Set(["SIGNED", "REPORTED"]);
/** Session states that may still be a live shadow of a finalized upload. */
const SETTLEABLE_LIVE = new Set<UploadSessionStatus>(["CREATED", "PRESIGNED", "UPLOADING", "PARTIAL", "STALLED", "VERIFYING"]);
/** Bound on per-part object checks for one settlement. */
const MAX_PART_CHECKS = 500;

export type SettleCompletedUploadOutcome =
  | { outcome: "COMPLETED"; session: DbUploadSession }
  | { outcome: "ALREADY_COMPLETED" }
  | {
      outcome: "REFUSED";
      reason:
        | "session_missing"
        | "session_terminal"
        | "session_held"
        | "record_missing"
        | "record_deleted"
        | "record_not_finalized"
        | "record_not_in_session_workspace"
        | "digest_missing"
        | "parts_incomplete"
        | "object_missing"
        | "object_size_mismatch"
        | "storage_unreadable"
        | "lost_race";
    };

/** The object HEAD the settlement uses; injectable so a test can supply the store. */
export type HeadObjectFn = (p: { bucket: string; key: string; versionId?: string | null }) => Promise<{ sizeBytes: number | null }>;

/**
 * COMPLETE an upload session ONLY when its record proves the upload completed.
 *
 * The generic transition graph reaches COMPLETED from VERIFYING alone — the
 * in-flight finalize window. A session whose best-effort VERIFYING write never
 * landed is still a shadow of a finished upload, and this is the single
 * operation that may close it. It takes NO assertion from its caller: every
 * fact is read here, from the canonical finalization truth —
 *
 *   - the session exists, is live, and is not a deliberate REVIEW_REQUIRED hold;
 *   - its record exists, is not deleted, and is FINALIZED (SIGNED / REPORTED:
 *     finalization verified the digest, the parts and the stored object);
 *   - the record belongs to the session's own workspace;
 *   - the record carries its verified digest;
 *   - every expected part is recorded with its digest (multipart);
 *   - the stored bytes exist now, at the recorded version, at the recorded size.
 *
 * Any failed check REFUSES and writes nothing; the next sweep asks again. The
 * write is a compare-and-set on the status read, so concurrent settlements
 * produce one transition and no contradictory row. Never emits an event: the
 * record's own history already says what happened.
 */
export async function settleCompletedUploadSession(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
  deps: { headObject?: HeadObjectFn } = {},
): Promise<SettleCompletedUploadOutcome> {
  const session = await client.uploadSession.findUnique({ where: { evidenceId } });
  if (!session) return { outcome: "REFUSED", reason: "session_missing" };
  const from = session.status as UploadSessionStatus;
  if (from === "COMPLETED") return { outcome: "ALREADY_COMPLETED" };
  if (from === "REVIEW_REQUIRED") return { outcome: "REFUSED", reason: "session_held" };
  if (!SETTLEABLE_LIVE.has(from)) return { outcome: "REFUSED", reason: "session_terminal" };

  const record = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      status: true,
      deletedAt: true,
      teamId: true,
      fileSha256: true,
      sizeBytes: true,
      storageBucket: true,
      storageKey: true,
      storageVersionId: true,
    },
  });
  if (!record) return { outcome: "REFUSED", reason: "record_missing" };
  if (record.deletedAt) return { outcome: "REFUSED", reason: "record_deleted" };
  if (!FINALIZED_EVIDENCE.has(record.status)) return { outcome: "REFUSED", reason: "record_not_finalized" };
  if (!record.teamId || record.teamId !== session.teamId) {
    return { outcome: "REFUSED", reason: "record_not_in_session_workspace" };
  }
  if (!record.fileSha256) return { outcome: "REFUSED", reason: "digest_missing" };

  const parts = await client.evidencePart.findMany({
    where: { evidenceId },
    select: { storageBucket: true, storageKey: true, storageVersionId: true, sizeBytes: true, sha256: true },
    orderBy: { partIndex: "asc" },
    take: MAX_PART_CHECKS + 1,
  });
  if (parts.length > MAX_PART_CHECKS) return { outcome: "REFUSED", reason: "storage_unreadable" };
  if (session.expectedPartCount != null && parts.length < session.expectedPartCount) {
    return { outcome: "REFUSED", reason: "parts_incomplete" };
  }
  if (parts.some((p) => !p.sha256)) return { outcome: "REFUSED", reason: "parts_incomplete" };

  const objects =
    parts.length > 0
      ? parts.map((p) => ({ bucket: p.storageBucket, key: p.storageKey, versionId: p.storageVersionId, sizeBytes: p.sizeBytes }))
      : record.storageBucket && record.storageKey
        ? [{ bucket: record.storageBucket, key: record.storageKey, versionId: record.storageVersionId, sizeBytes: record.sizeBytes }]
        : [];
  if (objects.length === 0) return { outcome: "REFUSED", reason: "object_missing" };
  const head: HeadObjectFn =
    deps.headObject ?? (async (p) => (await import("../../storage.js")).headObject(p));
  for (const o of objects) {
    let found: { sizeBytes: number | null };
    try {
      found = await head({ bucket: o.bucket, key: o.key, versionId: o.versionId });
    } catch (err) {
      const e = (err ?? {}) as { $metadata?: { httpStatusCode?: number }; name?: string };
      const notFound = e.$metadata?.httpStatusCode === 404 || e.name === "NotFound" || e.name === "NoSuchKey";
      return { outcome: "REFUSED", reason: notFound ? "object_missing" : "storage_unreadable" };
    }
    if (o.sizeBytes != null && found.sizeBytes != null && BigInt(found.sizeBytes) !== BigInt(o.sizeBytes)) {
      return { outcome: "REFUSED", reason: "object_size_mismatch" };
    }
  }

  const now = new Date();
  const claim = await client.uploadSession.updateMany({
    where: { evidenceId, status: from as DbUploadSessionStatus },
    data: { status: "COMPLETED", completedAtUtc: now, lastActivityAtUtc: now, failureReason: "record_finalized" },
  });
  if (claim.count !== 1) {
    const after = await client.uploadSession.findUnique({ where: { evidenceId }, select: { status: true } });
    return after?.status === "COMPLETED" ? { outcome: "ALREADY_COMPLETED" } : { outcome: "REFUSED", reason: "lost_race" };
  }
  const settled = await client.uploadSession.findUniqueOrThrow({ where: { evidenceId } });
  return { outcome: "COMPLETED", session: settled };
}
// -----------------------------------------------------------------------------
// Read helpers — used by the /operations/reliability UI.
// -----------------------------------------------------------------------------

export async function listUploadSessions(
  input: {
    teamId: string;
    status?: UploadSessionStatus;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbUploadSession[]> {
  return client.uploadSession.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status
        ? { status: input.status as DbUploadSessionStatus }
        : {}),
    },
    orderBy: { lastActivityAtUtc: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
}

export type UploadSessionCounts = Record<UploadSessionStatus, number>;

export async function countUploadSessionsByTeam(
  input: { teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<UploadSessionCounts> {
  const rows = await client.uploadSession.groupBy({
    by: ["status"],
    where: { teamId: input.teamId },
    _count: { _all: true },
  });
  const out: UploadSessionCounts = {
    CREATED: 0,
    PRESIGNED: 0,
    UPLOADING: 0,
    PARTIAL: 0,
    VERIFYING: 0,
    COMPLETED: 0,
    FAILED: 0,
    STALLED: 0,
    ABANDONED: 0,
    REVIEW_REQUIRED: 0,
  };
  for (const r of rows) {
    out[r.status as UploadSessionStatus] = r._count._all;
  }
  return out;
}

export function projectUploadSession(row: DbUploadSession): {
  id: string;
  evidenceId: string;
  teamId: string | null;
  status: string;
  isMultipart: boolean;
  expectedPartCount: number | null;
  completedPartCount: number;
  retryCount: number;
  failureReason: string | null;
  lastActivityAtUtc: string;
  stalledAtUtc: string | null;
  abandonedAtUtc: string | null;
  completedAtUtc: string | null;
  isTerminal: boolean;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    evidenceId: row.evidenceId,
    teamId: row.teamId,
    status: row.status,
    isMultipart: row.isMultipart,
    expectedPartCount: row.expectedPartCount,
    completedPartCount: row.completedPartCount,
    retryCount: row.retryCount,
    failureReason: row.failureReason,
    lastActivityAtUtc: row.lastActivityAtUtc.toISOString(),
    stalledAtUtc: row.stalledAtUtc?.toISOString() ?? null,
    abandonedAtUtc: row.abandonedAtUtc?.toISOString() ?? null,
    completedAtUtc: row.completedAtUtc?.toISOString() ?? null,
    isTerminal: isTerminalUploadSessionStatus(row.status as UploadSessionStatus),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Deliberately NOT projected: multipartUploadId (reserved; null in
    // current deployments).
  };
}
