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

import { prisma } from "../db.js";

export async function claimDerivativeForRender(
  derivativeId: string,
): Promise<
  | { claimed: true; teamId: string; versionId: string }
  | { claimed: false; reason: "not_found" | "not_queued" }
> {
  const row = await prisma.redactionDerivative.findUnique({
    where: { id: derivativeId },
    select: { id: true, teamId: true, versionId: true, state: true },
  });
  if (!row) return { claimed: false, reason: "not_found" };
  const res = await prisma.redactionDerivative.updateMany({
    where: { id: derivativeId, state: "QUEUED" },
    data: { state: "RENDERING", renderStartedAt: new Date() },
  });
  if (res.count !== 1) return { claimed: false, reason: "not_queued" };
  await emitActivity(row.teamId, row.versionId, "DERIVATIVE_RENDER_STARTED", {
    derivativeId,
  });
  return { claimed: true, teamId: row.teamId, versionId: row.versionId };
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
  const res = await prisma.redactionDerivative.updateMany({
    where: { id: input.derivativeId, state: "RENDERING" },
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
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await prisma.redactionDerivative.findFirst({
    where: { id: input.derivativeId, teamId: input.teamId },
    select: { id: true, versionId: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  const res = await prisma.redactionDerivative.updateMany({
    // A structurally-unrenderable QUEUED row may fail without a claim.
    where: { id: input.derivativeId, state: { in: ["RENDERING", "QUEUED"] } },
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
