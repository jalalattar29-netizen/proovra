/**
 * REPORT-004 — RELEASE: issue a held record's first outputs, once, when the
 * workspace output policy allows them.
 *
 * Called after the things that can change the answer: a workspace governance
 * policy update (every held record of that workspace), and a review decision
 * that approves the record (requireReviewBefore*). An explicit Generate goes
 * through `requestReportGeneration`, which lifts the hold the same way.
 *
 * EXACTLY ONCE. `tryLiftOutputHold` clears the hold with one conditional write,
 * so of any number of concurrent releases one wins; the winner's request is
 * keyed `REPORT:<id>:v0` by the shared writer, so even a repeat collapses onto
 * one row. A failure to issue after the lift is the ordinary first-issuance
 * case the worker's reconciliation already owns (the record is no longer held).
 */
import { workspaceEvidenceWhere } from "@proovra/shared-runtime";
import { bump, setGauge } from "@proovra/shared-runtime/ops";

import { prisma } from "../../db.js";
import { requestReportGeneration } from "../reports/report-generation-authority.service.js";
import { tryLiftOutputHold } from "./output-hold.service.js";

export async function releaseHeldOutputs(evidenceId: string): Promise<"released" | "still_held" | "not_held"> {
  const lift = await tryLiftOutputHold(evidenceId);
  if (lift !== "lifted") return lift;
  await requestReportGeneration({
    evidenceId,
    // The deferred completion fan-out: the first pair the completion would have
    // requested had the policy allowed it then.
    purpose: "evidence_completed",
    requestedByMachineId: "api.output-hold-release",
  });
  return "released";
}

/** Bounded: one page of a workspace's held records per call, oldest first. */
const RELEASE_PAGE = 200;

export async function releaseHeldOutputsForWorkspace(teamId: string): Promise<{ released: number; stillHeld: number }> {
  const held = await prisma.evidence.findMany({
    // The canonical workspace scope (a Personal record may carry a null team).
    where: { AND: [await workspaceEvidenceWhere(teamId, prisma), { outputsHeldAtUtc: { not: null } }] },
    select: { id: true },
    orderBy: [{ outputsHeldAtUtc: "asc" }, { id: "asc" }],
    take: RELEASE_PAGE,
  });
  let released = 0;
  let stillHeld = 0;
  for (const { id } of held) {
    const outcome = await releaseHeldOutputs(id).catch(() => "still_held" as const);
    if (outcome === "released") released += 1;
    else if (outcome === "still_held") stillHeld += 1;
  }
  return { released, stillHeld };
}

// =============================================================================
// THE PERIODIC RELEASE SWEEP (REPORT-004 follow-up, 2026-11-06).
//
// The event triggers above (a policy update, an approving review, an explicit
// request) do not cover a hold set while the policy was UNREADABLE, nor a
// policy that became permissive by a path that fires no event. Without this, such
// a record would stay held forever. The platform-maintenance reconciler runs
// this under its lease, so replicas never overlap.
//
//   SAME RULE      each record goes through `releaseHeldOutputs`: the same
//                  decision, for the same actor, the same single-winner
//                  conditional lift and one REPORT:<id>:v0 request.
//   BOUNDED        one keyset page per tick (oldest-held first within the page
//                  order, cursor kept per process and wrapped at the end), and
//                  at most `maxReleasesPerTick` issued, so a policy flip on a
//                  large workspace drains over several ticks instead of
//                  flooding the report queue.
//   NO CHAIN SPAM  a record still refused is left exactly as it is: no custody
//                  event, and its row is written only if the refusal REASON
//                  changed (tryLiftOutputHold).
//   ALERT          gauges for active and stale holds and the oldest hold's age,
//                  and a warning when any hold is older than the threshold.
// =============================================================================

export const OUTPUT_HOLD_SWEEP_BATCH = 100;
export const OUTPUT_HOLD_SWEEP_MAX_RELEASES = 50;
/** A hold older than this is reported as stale (default one day). */
export const OUTPUT_HOLD_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

let sweepCursor: string | null = null;

/** For tests: forget where the keyset scan is. */
export function resetOutputHoldSweepCursor(): void {
  sweepCursor = null;
}

export type OutputHoldSweepSummary = {
  scanned: number;
  released: number;
  stillHeld: number;
  failed: number;
  active: number;
  stale: number;
  oldestAgeSeconds: number;
};

export async function sweepHeldOutputs(
  options: { batch?: number; maxReleasesPerTick?: number; staleAfterMs?: number; now?: Date } = {},
  deps: { warn?: (obj: Record<string, unknown>, msg: string) => void } = {},
): Promise<OutputHoldSweepSummary> {
  const batch = Math.max(1, Math.min(options.batch ?? OUTPUT_HOLD_SWEEP_BATCH, 500));
  const maxReleases = Math.max(0, options.maxReleasesPerTick ?? OUTPUT_HOLD_SWEEP_MAX_RELEASES);
  const staleAfterMs = options.staleAfterMs ?? OUTPUT_HOLD_STALE_AFTER_MS;
  const now = options.now ?? new Date();

  // TENANT_SCOPE_EXCEPTION: platform_maintenance — a platform-wide sweep under
  // the maintenance lease; every release is decided per record, in its own
  // workspace, by the same authority a request uses.
  const page = await prisma.evidence.findMany({
    where: { outputsHeldAtUtc: { not: null }, ...(sweepCursor ? { id: { gt: sweepCursor } } : {}) },
    select: { id: true },
    orderBy: { id: "asc" },
    take: batch,
  });
  sweepCursor = page.length === batch ? page[page.length - 1]!.id : null;

  let released = 0;
  let stillHeld = 0;
  let failed = 0;
  for (const { id } of page) {
    if (released >= maxReleases) break;
    try {
      const outcome = await releaseHeldOutputs(id);
      if (outcome === "released") released += 1;
      else if (outcome === "still_held") stillHeld += 1;
    } catch {
      failed += 1;
    }
  }
  if (released) bump("output_hold_released_total", released);
  if (failed) bump("output_hold_sweep_failed_total", failed);

  const staleBefore = new Date(now.getTime() - staleAfterMs);
  const [active, stale, oldest] = await Promise.all([
    prisma.evidence.count({ where: { outputsHeldAtUtc: { not: null } } }),
    prisma.evidence.count({ where: { outputsHeldAtUtc: { lt: staleBefore } } }),
    prisma.evidence.findFirst({
      where: { outputsHeldAtUtc: { not: null } },
      orderBy: { outputsHeldAtUtc: "asc" },
      select: { outputsHeldAtUtc: true },
    }),
  ]);
  const oldestAgeSeconds = oldest?.outputsHeldAtUtc
    ? Math.max(0, Math.floor((now.getTime() - oldest.outputsHeldAtUtc.getTime()) / 1000))
    : 0;
  setGauge("output_holds_active", active);
  setGauge("output_holds_stale", stale);
  setGauge("output_hold_oldest_age_seconds", oldestAgeSeconds);
  if (stale > 0) {
    deps.warn?.({ stale, active, oldestAgeSeconds, staleAfterMs }, "output_hold.stale_detected");
  }
  return { scanned: page.length, released, stillHeld, failed, active, stale, oldestAgeSeconds };
}
