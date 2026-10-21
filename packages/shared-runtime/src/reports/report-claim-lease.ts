/**
 * THE REPORT / PACKAGE CLAIM LEASE (F-06, independent forward audit 2026-10-21).
 *
 * A claimed run holds `claimedAtUtc` (its FENCE: every write it makes names
 * it) and renews `leaseRenewedAtUtc` with a fenced heartbeat while it works.
 * The claim is LIVE while either is within the lease. The lease used to be a
 * fixed window from `claimedAtUtc`, never renewed, so the stranded-request
 * reconciler released a claim whose run was still working; its fenced commit
 * then rolled back and every retry repeated it until the claim ceiling.
 *
 * One definition, read by the worker's claim, the reconciler, and the
 * destruction executor (which refuses to start while an output is in flight,
 * F-09) — never re-derived.
 */
import { getWorkEntryOrThrow, JOB_NAMES } from "@proovra/shared";

export const REPORT_CLAIM_LEASE_MS: number =
  getWorkEntryOrThrow(JOB_NAMES.GENERATE_REPORT).claim?.leaseMs ?? 15 * 60 * 1000;

/** The heartbeat cadence: well inside the lease, so one missed beat is harmless. */
export const REPORT_CLAIM_HEARTBEAT_MS: number = Math.max(30_000, Math.floor(REPORT_CLAIM_LEASE_MS / 5));

/** WHERE a PROCESSING request's claim has EXPIRED (neither stamp within the lease). */
export function reportClaimExpiredWhere(now: Date) {
  const floor = new Date(now.getTime() - REPORT_CLAIM_LEASE_MS);
  return {
    state: "PROCESSING" as const,
    claimedAtUtc: { lt: floor },
    OR: [{ leaseRenewedAtUtc: null }, { leaseRenewedAtUtc: { lt: floor } }],
  };
}

/** WHERE a request holds a LIVE claim (a run is working on it right now). */
export function reportClaimLiveWhere(now: Date) {
  const floor = new Date(now.getTime() - REPORT_CLAIM_LEASE_MS);
  return {
    state: "PROCESSING" as const,
    OR: [{ claimedAtUtc: { gte: floor } }, { leaseRenewedAtUtc: { gte: floor } }],
  };
}

/** The same decision for a row already read. */
export function isReportClaimLive(
  row: { state: string; claimedAtUtc: Date | null; leaseRenewedAtUtc?: Date | null },
  now: Date,
): boolean {
  if (row.state !== "PROCESSING") return false;
  const floor = now.getTime() - REPORT_CLAIM_LEASE_MS;
  return (
    (row.claimedAtUtc !== null && row.claimedAtUtc.getTime() >= floor) ||
    (row.leaseRenewedAtUtc != null && row.leaseRenewedAtUtc.getTime() >= floor)
  );
}
