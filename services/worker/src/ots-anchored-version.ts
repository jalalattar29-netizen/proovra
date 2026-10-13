/**
 * ONE AUTOMATIC REPORT VERSION WHEN A PROOF BECOMES ANCHORED (2026-10-13).
 *
 * A report issued while its OpenTimestamps proof was PENDING says "Bitcoin
 * anchoring — Pending". When that proof later resolves to ANCHORED, exactly one
 * new report + package version is requested through the existing versioning
 * (`createReportGenerationRequest`): the previous versions stay as issued,
 * nothing is charged (the worker never consumes credits), and the request is
 * idempotent per proof.
 *
 *   no report yet                 nothing — v1 will state ANCHORED itself
 *   latest report stated ANCHORED nothing — e.g. ANCHORED before v1
 *   a report is being generated   nothing now — when it commits, the
 *                                 commit re-runs this decision against what
 *                                 it stated (`reconcileOtsAnchoredReportVersion`)
 *   otherwise                     one request, key `ots-anchored:<proof sha>`
 *
 * The decision reads the canonical state the report STATED
 * (`anchorSnapshot.otsState`); a legacy report without it is eligible once.
 */
import { createReportGenerationRequest } from "@proovra/shared-runtime/reports";
import {
  OTS_ANCHORING_RECORD_SELECT,
  isTerminalJobExecutionState,
  parseOtsState,
  resolveRecordOtsAnchoring,
  type OtsAnchoring,
} from "@proovra/shared";

import { prisma } from "./db.js";
import { enqueueReportGenerationRequest } from "./queue.js";

export type OtsAnchoredVersionOutcome =
  | "not_anchored"
  | "no_report_yet"
  | "latest_report_anchored"
  | "report_in_flight"
  | "requested"
  | "already_requested"
  | "refused";

export const OTS_ANCHORED_MACHINE_ID = "worker.ots-anchored";

/** The idempotency key: one automatic version per anchored proof. */
export function otsAnchoredRequestKey(proofSha256: string): string {
  return `ots-anchored:${proofSha256.toLowerCase().slice(0, 64)}`;
}

/** The state a report stated, read from its anchor snapshot; null for a legacy report. */
export function reportStatedOtsState(anchorSnapshot: unknown): ReturnType<typeof parseOtsState> | null {
  if (!anchorSnapshot || typeof anchorSnapshot !== "object") return null;
  const raw = (anchorSnapshot as Record<string, unknown>).otsState;
  return raw == null ? null : parseOtsState(raw);
}

export async function ensureOtsAnchoredReportVersion(input: {
  evidenceId: string;
  anchoring: Pick<OtsAnchoring, "state" | "proofSha256">;
  /** Dry run: decide, write nothing. */
  dryRun?: boolean;
}): Promise<{ outcome: OtsAnchoredVersionOutcome; requestId?: string; reason?: string }> {
  const { evidenceId, anchoring } = input;
  if (anchoring.state !== "ANCHORED" || !anchoring.proofSha256) return { outcome: "not_anchored" };

  const latest = await prisma.report.findFirst({
    where: { evidenceId },
    orderBy: { version: "desc" },
    select: { version: true, anchorSnapshot: true },
  });
  if (!latest) return { outcome: "no_report_yet" };
  if (reportStatedOtsState(latest.anchorSnapshot) === "ANCHORED") return { outcome: "latest_report_anchored" };

  const key = otsAnchoredRequestKey(anchoring.proofSha256);
  const prior = await prisma.reportGenerationRequest.findFirst({
    where: { evidenceId, clientRequestKey: key },
    select: { id: true },
  });
  if (prior) return { outcome: "already_requested", requestId: prior.id };

  // A report generation already running renders the current (anchored) state;
  // its commit re-runs this decision.
  const inFlight = await prisma.reportGenerationRequest.findFirst({
    where: { evidenceId, artifactType: "REPORT", state: { in: ["QUEUED", "PROCESSING", "FAILED_RETRYABLE"] } },
    select: { id: true },
  });
  if (inFlight) return { outcome: "report_in_flight", requestId: inFlight.id };

  if (input.dryRun) return { outcome: "requested" };

  const persisted = await createReportGenerationRequest(prisma, {
    evidenceId,
    purpose: "ots_upgrade_completed",
    artifactType: "REPORT",
    intent: "NEW_VERSION",
    forceRegenerate: true,
    regenerateReason: "ots_anchored",
    clientRequestKey: key,
    requestedByMachineId: OTS_ANCHORED_MACHINE_ID,
  });
  if (!persisted.created) return { outcome: "refused", reason: persisted.reason };
  if (persisted.replayed) return { outcome: "already_requested", requestId: persisted.requestId };
  if (!isTerminalJobExecutionState(persisted.state)) {
    await enqueueReportGenerationRequest(persisted.requestId);
  }
  return { outcome: "requested", requestId: persisted.requestId };
}

/**
 * Re-run the decision from the record as stored — after a report commits, and
 * from the reconcile script. Idempotent.
 */
export async function reconcileOtsAnchoredReportVersion(evidenceId: string, opts: { dryRun?: boolean } = {}) {
  const row = await prisma.evidence.findUnique({ where: { id: evidenceId }, select: OTS_ANCHORING_RECORD_SELECT });
  if (!row) return { outcome: "not_anchored" as const };
  return ensureOtsAnchoredReportVersion({ evidenceId, anchoring: resolveRecordOtsAnchoring(row), dryRun: opts.dryRun });
}
