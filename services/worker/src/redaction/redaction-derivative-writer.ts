/**
 * PHASE 12B WAVE 2A — the ONE redaction-derivative completion authority.
 *
 * READY/FAILED transitions happen HERE and only here (the API's user-session
 * mark-ready/mark-failed routes + service writers were deleted; requesting and
 * quarantining stay API-side). Direct internal transition — no HTTP callback,
 * no shared secret surface, no replay window: the worker owns the claim and the
 * completion inside one process, with the DB state machine as the arbiter.
 *
 * State machine guards (Correction 5/6):
 *   - claimForRender: atomic QUEUED→RENDERING (updateMany count===1). Only a
 *     claim holder may complete; a replayed/duplicate job loses the claim race
 *     and exits without touching anything.
 *   - markReady: atomic RENDERING→READY (stale/replayed completion → count 0 →
 *     rejected). Requires confirmed storage object digest+size+key. Refuses a
 *     storage key colliding with the ORIGINAL Evidence object (immutability).
 *   - markFailed: atomic RENDERING→FAILED with bounded safe error metadata
 *     (never evidence content).
 *   - Every transition appends a redaction activity row (operator timeline).
 */

import { getWorkEntryOrThrow, JOB_NAMES } from "@proovra/shared";
import { evaluateDerivedProductionEligibility } from "@proovra/shared-runtime";

import { prisma } from "../db.js";

/**
 * ET-Q-04 — THE RENDER LEASE the registry declares (20 minutes), now enforced.
 *
 * A RENDERING row whose worker crashed, or whose transient failure rethrew for
 * a BullMQ retry, used to stay RENDERING forever: the retry's claim required
 * QUEUED, the reconciler scanned QUEUED, the API re-request resets only
 * FAILED/PENDING, and versionId is unique so no new derivative could be made.
 */
export const REDACTION_RENDER_LEASE_MS =
  getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_DERIVATIVE).claim?.leaseMs ?? 20 * 60 * 1000;

/**
 * WORKERS-05 — THE CLAIM TOKEN. The `renderStartedAt` this claim stamped.
 *
 * `state = 'RENDERING'` alone does not identify a claim: after a stale-lease
 * takeover the row is RENDERING again, held by a different worker, and the
 * original worker's late release or terminal write would still match. Every
 * write below therefore also matches on the instant THIS claim stamped (the
 * same fencing contract as the media-intelligence run tracker's attempt
 * generation), so only the current holder can release, complete or fail it.
 */
export type DerivativeClaimToken = Date;

export async function claimDerivativeForRender(
  derivativeId: string,
): Promise<
  | { claimed: true; teamId: string; versionId: string; claimedAt: DerivativeClaimToken }
  | { claimed: false; reason: "not_found" | "not_queued" }
> {
  const row = await prisma.redactionDerivative.findUnique({
    where: { id: derivativeId },
    select: { id: true, teamId: true, versionId: true, state: true },
  });
  if (!row) return { claimed: false, reason: "not_found" };
  // QUEUED, or a RENDERING claim whose lease expired (its holder is gone).
  const now = new Date();
  const res = await prisma.redactionDerivative.updateMany({
    where: {
      id: derivativeId,
      OR: [
        { state: "QUEUED" },
        { state: "RENDERING", renderStartedAt: { lt: new Date(now.getTime() - REDACTION_RENDER_LEASE_MS) } },
      ],
    },
    data: { state: "RENDERING", renderStartedAt: now },
  });
  if (res.count !== 1) return { claimed: false, reason: "not_queued" };
  await emitActivity(row.teamId, row.versionId, "DERIVATIVE_RENDER_STARTED", {
    derivativeId,
  });
  return { claimed: true, teamId: row.teamId, versionId: row.versionId, claimedAt: now };
}

/**
 * ET-Q-04 — give a claim back after a TRANSIENT failure, so the BullMQ retry
 * (which follows within seconds, long before the lease) can claim it again.
 * Conditional on still holding THIS claim (WORKERS-05); never touches
 * READY/FAILED, and a worker whose claim was taken over releases nothing.
 */
export async function releaseDerivativeClaim(
  derivativeId: string,
  claimedAt: DerivativeClaimToken,
): Promise<boolean> {
  const res = await prisma.redactionDerivative.updateMany({
    where: { id: derivativeId, state: "RENDERING", renderStartedAt: claimedAt },
    data: { state: "QUEUED", renderStartedAt: null },
  });
  return res.count === 1;
}

export async function markDerivativeReadyWorker(input: {
  derivativeId: string;
  teamId: string;
  storageBucket: string;
  storageKey: string;
  storageRegion?: string | null;
  byteSize: number;
  fileSha256: string;
  contentType: string;
  renderEngine: string;
  /** The claim this completion belongs to (WORKERS-05). */
  claimedAt: DerivativeClaimToken;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await prisma.redactionDerivative.findFirst({
    where: { id: input.derivativeId, teamId: input.teamId },
    select: {
      id: true,
      versionId: true,
      version: { select: { projectId: true, project: { select: { evidenceId: true } } } },
    },
  });
  if (!row) return { ok: false, reason: "not_found" };
  // IMMUTABILITY — never point the derivative at the original object.
  const evidence = await prisma.evidence.findFirst({
    where: { id: row.version.project.evidenceId, teamId: input.teamId },
    select: { storageKey: true, storageBucket: true },
  });
  if (
    evidence &&
    evidence.storageBucket === input.storageBucket &&
    evidence.storageKey === input.storageKey
  ) {
    return { ok: false, reason: "original_object_collision" };
  }
  // WORKERS-11 — a record that has left service (trashed, destruction-bound,
  // destroyed) gains no derived bytes, re-checked at the completion write so a
  // record trashed while the render ran is not published as READY.
  const leftService = await derivedProductionRefusal(row.version.project.evidenceId);
  if (leftService) return { ok: false, reason: leftService };
  const res = await prisma.redactionDerivative.updateMany({
    where: { id: input.derivativeId, state: "RENDERING", renderStartedAt: input.claimedAt },
    data: {
      state: "READY",
      storageBucket: input.storageBucket,
      storageKey: input.storageKey,
      storageRegion: input.storageRegion ?? null,
      byteSize: BigInt(input.byteSize),
      fileSha256: input.fileSha256,
      contentType: input.contentType,
      renderEngine: input.renderEngine,
      renderedAtUtc: new Date(),
      failureReason: null,
      lastErrorPreview: null,
    },
  });
  if (res.count !== 1) return { ok: false, reason: "stale_transition" };
  await emitActivity(input.teamId, row.versionId, "DERIVATIVE_RENDER_COMPLETED", {
    derivativeId: input.derivativeId,
    renderEngine: input.renderEngine,
    fileSha256: input.fileSha256,
    byteSize: input.byteSize,
  });
  return { ok: true };
}

export async function markDerivativeFailedWorker(input: {
  derivativeId: string;
  teamId: string;
  failureReason: string;
  errorPreview?: string;
  /**
   * The claim this failure belongs to (WORKERS-05). Absent only for a
   * structurally unrenderable row that was never claimed: such a write may
   * fail a QUEUED row and nothing else.
   */
  claimedAt?: DerivativeClaimToken;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await prisma.redactionDerivative.findFirst({
    where: { id: input.derivativeId, teamId: input.teamId },
    select: { id: true, versionId: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  const res = await prisma.redactionDerivative.updateMany({
    // A structurally-unrenderable QUEUED row may fail without a claim; a
    // RENDERING row only by the worker holding the current claim.
    where: input.claimedAt
      ? { id: input.derivativeId, state: "RENDERING", renderStartedAt: input.claimedAt }
      : { id: input.derivativeId, state: "QUEUED" },
    data: {
      state: "FAILED",
      failureReason: input.failureReason.slice(0, 120),
      lastErrorPreview: input.errorPreview?.slice(0, 400) ?? null,
    },
  });
  if (res.count !== 1) return { ok: false, reason: "stale_transition" };
  await emitActivity(input.teamId, row.versionId, "DERIVATIVE_RENDER_FAILED", {
    derivativeId: input.derivativeId,
    failureReason: input.failureReason.slice(0, 120),
  });
  return { ok: true };
}

/**
 * WORKERS-11 — the derived-production lifecycle rule, applied to redaction.
 *
 * Returns the refusal reason when the record has left service, else null.
 * Only the lifecycle half of the shared rule is applied: whether a redaction
 * may start from an unsealed record is decided API-side when the project is
 * opened, and the render already binds to the sealed digest it reads.
 */
export async function derivedProductionRefusal(evidenceId: string): Promise<string | null> {
  const eligibility = await evaluateDerivedProductionEligibility(evidenceId, prisma);
  if (eligibility.eligible || eligibility.reason === "evidence_not_sealed") return null;
  return `evidence_ineligible:${eligibility.reason}`;
}

async function emitActivity(
  teamId: string,
  versionId: string,
  code: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const version = await prisma.redactionVersion.findUnique({
      where: { id: versionId },
      select: { projectId: true },
    });
    if (!version) return;
    await prisma.redactionActivity.create({
      data: {
        projectId: version.projectId,
        teamId,
        versionId,
        actorUserId: null, // machine transition — no user session
        code,
        payload: payload as never,
      },
    });
  } catch {
    // The operator timeline is best-effort; the state transition is the truth.
  }
}
