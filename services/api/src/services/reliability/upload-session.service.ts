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
  if (!isAllowedUploadSessionTransition(from, to) || (input.exclusive && from === to)) {
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
