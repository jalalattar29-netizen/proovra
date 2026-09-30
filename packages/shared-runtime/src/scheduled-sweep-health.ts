/**
 * SCHEDULED-SWEEP HEALTH — is a worker sweep actually running? (2026-09-30)
 *
 * Two worker sweeps carry a product commitment and nothing else does their
 * job: the capture reaper (the ONLY authority that expires abandoned capture
 * drafts and evidence reservations since the API sweep was retired, ET-SEC-24)
 * and the integrity recheck (ET-SM-07). Both ran on a bare timer and recorded
 * nothing, so a stopped worker, a disabled flag or a sweep that threw every
 * time looked exactly like a healthy one.
 *
 * They now run under the reconciliation-run authority
 * (`runGovernanceReconciliation`), so every tick leaves a row. This module
 * reads those rows and answers, from OUTSIDE the worker — a sweep that has
 * stopped cannot report its own silence:
 *
 *   OK         the latest finished run succeeded, inside the allowed silence
 *   FAILING    the latest finished run failed (its error is returned)
 *   STALE      no run has succeeded inside the allowed silence
 *   NEVER_RAN  no run of this kind is on record at all
 *
 * `lastRunAtUtc` / `lastSuccessAtUtc` / `lastFailureAtUtc` are the last-run,
 * last-success and failure facts an operator surface shows.
 */
import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

/** Default cadence of the capture reaper (CAPTURE_DRAFT_REAPER_INTERVAL_MS). */
export const CAPTURE_REAPER_DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
/** Default cadence of the integrity-recheck sweep (INTEGRITY_RECHECK_SWEEP_INTERVAL_MS). */
export const INTEGRITY_RECHECK_SWEEP_DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long each sweep may go without a SUCCESSFUL run before it is reported
 * stale: three missed default ticks plus the run-lock lease a crashed run can
 * hold, floored at two hours so a deploy or a slow tick is not an alarm.
 */
export const SCHEDULED_SWEEP_MAX_SILENCE_MS = {
  CAPTURE_REAPER: Math.max(2 * 60 * 60 * 1000, 3 * CAPTURE_REAPER_DEFAULT_INTERVAL_MS),
  INTEGRITY_RECHECK: Math.max(2 * 60 * 60 * 1000, 3 * INTEGRITY_RECHECK_SWEEP_DEFAULT_INTERVAL_MS),
} as const;

export type MonitoredSweepKind = keyof typeof SCHEDULED_SWEEP_MAX_SILENCE_MS;

export type ScheduledSweepHealth = {
  kind: MonitoredSweepKind;
  state: "OK" | "FAILING" | "STALE" | "NEVER_RAN";
  lastRunAtUtc: Date | null;
  lastSuccessAtUtc: Date | null;
  lastFailureAtUtc: Date | null;
  /** The bounded error summary of the latest failed run, when the latest run failed. */
  lastError: string | null;
  /** Milliseconds since the last successful run; null when there never was one. */
  silenceMs: number | null;
  maxSilenceMs: number;
};

type RunReader = Pick<PrismaClient, "governanceReconciliationRun">;

const SUCCEEDED: prismaPkg.GovernanceReconciliationStatus[] = [
  prismaPkg.GovernanceReconciliationStatus.SUCCEEDED,
  prismaPkg.GovernanceReconciliationStatus.PARTIAL,
];

export async function readScheduledSweepHealth(
  client: RunReader,
  kind: MonitoredSweepKind,
  now: Date = new Date(),
): Promise<ScheduledSweepHealth> {
  const maxSilenceMs = SCHEDULED_SWEEP_MAX_SILENCE_MS[kind];
  const runKind = prismaPkg.GovernanceReconciliationKind[kind];
  const [latest, lastSuccess, lastFailure] = await Promise.all([
    client.governanceReconciliationRun.findFirst({
      where: { kind: runKind, status: { not: prismaPkg.GovernanceReconciliationStatus.RUNNING } },
      orderBy: { startedAtUtc: "desc" },
      select: { status: true, startedAtUtc: true, finishedAtUtc: true, errorSummary: true },
    }),
    client.governanceReconciliationRun.findFirst({
      where: { kind: runKind, status: { in: SUCCEEDED } },
      orderBy: { startedAtUtc: "desc" },
      select: { startedAtUtc: true, finishedAtUtc: true },
    }),
    client.governanceReconciliationRun.findFirst({
      where: { kind: runKind, status: prismaPkg.GovernanceReconciliationStatus.FAILED },
      orderBy: { startedAtUtc: "desc" },
      select: { startedAtUtc: true, finishedAtUtc: true },
    }),
  ]);

  const lastRunAtUtc = latest ? (latest.finishedAtUtc ?? latest.startedAtUtc) : null;
  const lastSuccessAtUtc = lastSuccess ? (lastSuccess.finishedAtUtc ?? lastSuccess.startedAtUtc) : null;
  const lastFailureAtUtc = lastFailure ? (lastFailure.finishedAtUtc ?? lastFailure.startedAtUtc) : null;
  const silenceMs = lastSuccessAtUtc ? Math.max(0, now.getTime() - lastSuccessAtUtc.getTime()) : null;
  const base = { kind, lastRunAtUtc, lastSuccessAtUtc, lastFailureAtUtc, silenceMs, maxSilenceMs };

  if (!latest) return { ...base, state: "NEVER_RAN", lastError: null };
  if (latest.status === prismaPkg.GovernanceReconciliationStatus.FAILED) {
    return { ...base, state: "FAILING", lastError: latest.errorSummary ?? "unknown_error" };
  }
  if (silenceMs === null || silenceMs > maxSilenceMs) {
    return { ...base, state: "STALE", lastError: null };
  }
  return { ...base, state: "OK", lastError: null };
}
