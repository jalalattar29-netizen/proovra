/**
 * FIRST-ISSUANCE RECONCILIATION (EVIDENCE OUTPUT LIFECYCLE, 2026-09-29).
 *
 * This replaces the old "SIGNED without a report, signed 15 min – 7 days ago,
 * plan includes reports ⇒ generate" sweep. That rule used the CURRENT plan
 * with no notion of confirmed payment, so a Free record signed in the last
 * week was issued a report the moment a trial started, while a record signed
 * eight days earlier was never issued one by anything.
 *
 * THE RULE NOW (Decision A):
 *
 *   FIRST REPORT (+ its package)  for a FINALIZED (SIGNED), ACTIVE, not deleted
 *   record with no report and no live request, when the ONE issuance decision
 *   (`resolveEvidenceOutputIssuance`) says ENTITLED and
 *   `mayIssueHistoricalFirstOutputs` — i.e. a confirmed paid subscription, or
 *   a credit-funded record. A trial, a grace period, a pending checkout or an
 *   unreadable lifecycle schedules nothing.
 *
 *   MISSING PACKAGE  for a REPORTED record whose LATEST report has no package
 *   at that version and no live request, when the decision is ENTITLED with
 *   packages included: a package-only request for exactly that version. It
 *   never renders a new report and never hands out an older package.
 *
 * IDEMPOTENT. Requests are keyed `REPORT:<id>:v0` / `VERIFICATION_PACKAGE:<id>:
 * v<N>` by the shared writer, so a repeat tick, a second replica or a racing
 * user click collapses onto one row. A record whose request went terminal for
 * a technical, integrity or policy reason is NOT retried here — that is an
 * operator's (the writer refuses to supersede it, and the scan skips it).
 *
 * BOUNDED + RESUMABLE. Each tick reads one keyset page per half (ordered by
 * evidence id, cursor kept per process and wrapped at the end), so a large
 * population of Free records cannot starve entitled ones behind them.
 *
 * GATED. Scheduling first issuance for records signed MORE than
 * `RECENT_WINDOW_MS` ago, and package recovery, are production backfills: they
 * run only when `OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED=true` /
 * `OUTPUT_PACKAGE_RECOVERY_ENABLED=true`. Both default OFF so deploying this
 * code starts no backfill; the rollout enables them after a dry run
 * (`services/api/src/scripts/output-reconciliation-dry-run.ts`).
 *
 * NOT GATED (owed work, not backfill): the package a governance gate denied
 * (RG-03 / PRO-W1-01), and — closure 2, PRO-W1-04 — the package of a report a
 * request COMMITTED before it went FAILED_TERMINAL for a technical reason
 * (rested 30 minutes). See the MISSING PACKAGE pass.
 */
import * as prismaPkg from "@prisma/client";
import { classifyTerminalReason } from "@proovra/shared";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { enqueueReportGenerationRequest } from "./queue.js";
import {
  OWED_TECHNICAL_RETRY_BACKOFF_MS,
  requestReportGenerationFromWorker,
} from "./report-generation-authority.js";
import { resolveEvidenceOutputIssuance } from "./output-issuance.js";
import { packageRebuildFitsStorage } from "./workspace-billing.js";

/** Records signed at least this long ago; younger ones belong to finalize. */
const MIN_SIGNED_AGE_MS = 15 * 60 * 1000;
/** Within this window first issuance needs no backfill flag (the old default). */
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BATCH = 200;
const MAX_BATCH = 1000;
/**
 * ACTIVATION-DRIVEN FIRST ISSUANCE (2026-09-29). Subjects whose paid
 * subscription was provider-confirmed within this window are served FIRST each
 * tick, whatever the age of their records — the global keyset scan below walks
 * every signed record in the product and could take hours to reach one newly
 * paying customer. Re-running inside the window is harmless: a record with a
 * live request is skipped and the durable writer collapses duplicate intent.
 */
const ACTIVATION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVATION_SUBJECTS_PER_TICK = 50;

const LIVE_REQUEST_STATES = ["QUEUED", "PROCESSING", "FAILED_RETRYABLE"] as const;

let firstIssueCursor: string | null = null;
let packageCursor: string | null = null;

/** For tests: forget where the keyset scans are. */
export function resetFirstIssuanceCursors(): void {
  firstIssueCursor = null;
  packageCursor = null;
}

function flag(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

export type FirstIssuanceSummary = {
  /** Records reached through a recently confirmed paid subscription. */
  activationScanned: number;
  firstIssueScanned: number;
  firstIssueScheduled: number;
  firstIssueSkippedNotEntitled: number;
  firstIssueSkippedHistoricalGate: number;
  packageScanned: number;
  packageScheduled: number;
  packageSkippedNotEntitled: number;
  /** B5B-F-402 — latest package request was storage-refused and it still would not fit. */
  packageSkippedStorageRefused: number;
  /**
   * Closure 2 (PRO-W1-04) — packages OWED by a run that committed their report
   * and then went FAILED_TERMINAL for a technical reason, re-asked with the
   * backfill flag off.
   */
  packageOwedRecovered: number;
  /** Owed, but its technical terminal has not yet rested OWED_TECHNICAL_RETRY_BACKOFF_MS. */
  packageOwedResting: number;
  /** Owed by a committed report whose run ended on an integrity / policy / commercial reason: an operator's. */
  packageOwedNotTechnical: number;
  unresolved: number;
  failed: number;
};

export async function runFirstIssuanceReconciliation(options: {
  trigger?: string;
  batchSize?: number;
  now?: Date;
  /** Read-only: decide, count and log, schedule nothing. */
  dryRun?: boolean;
} = {}): Promise<FirstIssuanceSummary> {
  const trigger = options.trigger ?? "manual";
  const now = options.now ?? new Date();
  const batch = Math.min(Math.max(1, options.batchSize ?? DEFAULT_BATCH), MAX_BATCH);
  const historicalEnabled = flag("OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED");
  const packageRecoveryEnabled = flag("OUTPUT_PACKAGE_RECOVERY_ENABLED");
  const summary: FirstIssuanceSummary = {
    activationScanned: 0,
    firstIssueScanned: 0,
    firstIssueScheduled: 0,
    firstIssueSkippedNotEntitled: 0,
    firstIssueSkippedHistoricalGate: 0,
    packageScanned: 0,
    packageScheduled: 0,
    packageSkippedNotEntitled: 0,
    packageSkippedStorageRefused: 0,
    packageOwedRecovered: 0,
    packageOwedResting: 0,
    packageOwedNotTechnical: 0,
    unresolved: 0,
    failed: 0,
  };

  // ---- FIRST REPORT ---------------------------------------------------------
  const signedBefore = new Date(now.getTime() - MIN_SIGNED_AGE_MS);
  const recentFloor = new Date(now.getTime() - RECENT_WINDOW_MS);
  const firstIssueWhere = {
    status: prismaPkg.EvidenceStatus.SIGNED,
    deletedAt: null,
    lifecycleState: { in: ["ACTIVE", "UNDER_REVIEW", "ON_HOLD", "RETENTION_LOCKED"] as prismaPkg.EvidenceLifecycleState[] },
    signedAtUtc: { lte: signedBefore },
    reports: { none: {} },
    // REPORT-004 — a record whose first outputs the workspace output policy
    // holds is not issued here; the api releases it when the policy allows.
    outputsHeldAtUtc: null,
  } satisfies prismaPkg.Prisma.EvidenceWhereInput;

  const busyAmong = async (ids: string[]): Promise<Set<string>> =>
    ids.length
      ? new Set(
          (
            await prisma.reportGenerationRequest.findMany({
              where: { evidenceId: { in: ids }, state: { in: [...LIVE_REQUEST_STATES] } },
              select: { evidenceId: true },
            })
          ).map((r) => r.evidenceId),
        )
      : new Set<string>();

  /** One candidate: the per-record decision both passes share. */
  const issueFirst = async (ev: {
    id: string;
    ownerUserId: string;
    teamId: string | null;
    signedAtUtc: Date | null;
  }): Promise<void> => {
    try {
      const issuance = await resolveEvidenceOutputIssuance({
        id: ev.id,
        ownerUserId: ev.ownerUserId,
        teamId: ev.teamId ?? null,
      });
      if (issuance.decision === "UNRESOLVED") {
        summary.unresolved++;
        return;
      }
      if (
        issuance.decision !== "ENTITLED" ||
        !issuance.reportsIncluded ||
        !issuance.mayIssueHistoricalFirstOutputs
      ) {
        summary.firstIssueSkippedNotEntitled++;
        return;
      }
      const recent = ev.signedAtUtc != null && ev.signedAtUtc >= recentFloor;
      if (!recent && !historicalEnabled) {
        summary.firstIssueSkippedHistoricalGate++;
        return;
      }
      if (options.dryRun) {
        summary.firstIssueScheduled++;
        return;
      }
      const res = await requestReportGenerationFromWorker({
        evidenceId: ev.id,
        purpose: recent ? "lifecycle_recovery" : "first_issuance",
        machineId: "worker.first-issuance",
        // RG-03 (PRO-W1-04) — an entitled first issuance is owed.
        owed: true,
        enqueue: (requestId) => enqueueReportGenerationRequest(requestId),
      });
      if (res.requestId && res.reason !== "already_terminal") summary.firstIssueScheduled++;
    } catch (err) {
      summary.failed++;
      logger.error({ err, evidenceId: ev.id, trigger }, "first_issuance.report.failed");
    }
  };

  // ---- (a) SUBJECTS WHOSE PAID SUBSCRIPTION WAS JUST CONFIRMED -------------
  // Provider-confirmed only (`activatedAtUtc` is stamped when the provider
  // first reports ACTIVE); an unapproved checkout attempt never has it, and a
  // credit purchase is not a subscription at all. The per-record entitlement
  // below is still the authority — this pass only decides WHO is served first.
  const handled = new Set<string>();
  const activated = await prisma.subscription.findMany({
    where: {
      activatedAtUtc: { gte: new Date(now.getTime() - ACTIVATION_LOOKBACK_MS) },
      status: { in: ["ACTIVE", "PAST_DUE"] },
    },
    select: { userId: true, teamId: true },
    orderBy: { activatedAtUtc: "desc" },
    take: ACTIVATION_SUBJECTS_PER_TICK,
  });
  if (activated.length > 0) {
    const userIds = [...new Set(activated.filter((a) => !a.teamId).map((a) => a.userId))];
    const teamIds = [...new Set(activated.map((a) => a.teamId).filter((t): t is string => !!t))];
    const subjectRecords = await prisma.evidence.findMany({
      where: {
        ...firstIssueWhere,
        OR: [
          ...(userIds.length ? [{ ownerUserId: { in: userIds } }] : []),
          ...(teamIds.length ? [{ teamId: { in: teamIds } }] : []),
        ],
      },
      select: { id: true, ownerUserId: true, teamId: true, signedAtUtc: true },
      // Oldest first: a resumed tick continues where the last one stopped.
      orderBy: [{ signedAtUtc: "asc" }, { id: "asc" }],
      take: batch,
    });
    summary.activationScanned = subjectRecords.length;
    const busySubject = await busyAmong(subjectRecords.map((e) => e.id));
    for (const ev of subjectRecords) {
      handled.add(ev.id);
      if (busySubject.has(ev.id)) continue;
      await issueFirst(ev);
    }
  }

  // ---- (b) THE GLOBAL KEYSET SCAN ------------------------------------------
  const firstIssue = await prisma.evidence.findMany({
    where: {
      // Usable records only: never a trashed, archived, destruction-bound or
      // destroyed one. A legal hold does not block a FIRST issuance — it
      // replaces nothing.
      ...firstIssueWhere,
      ...(firstIssueCursor ? { id: { gt: firstIssueCursor } } : {}),
    },
    select: { id: true, ownerUserId: true, teamId: true, signedAtUtc: true },
    orderBy: { id: "asc" },
    take: batch,
  });
  firstIssueCursor = firstIssue.length === batch ? firstIssue[firstIssue.length - 1].id : null;
  summary.firstIssueScanned = firstIssue.length;

  const busy = await busyAmong(firstIssue.map((e) => e.id));

  for (const ev of firstIssue) {
    if (busy.has(ev.id) || handled.has(ev.id)) continue;
    await issueFirst(ev);
  }

  // ---- MISSING PACKAGE FOR THE LATEST REPORT --------------------------------
  // RG-03 (PRO-W1-01) — the historical sweep stays behind its flag, but a
  // package a run OWNED and the governance gate denied (a hold, recorded in
  // verificationPackageMetadata.blocked) is re-asked regardless: it is owed by
  // a request that did not complete, not historical backfill. While the
  // blocker stands the writer collapses onto the blocked head (no new row).
  //
  // Closure 2 (PRO-W1-04) — THE SAME FOR A RUN THAT COMMITTED ITS REPORT AND
  // THEN DIED. A report request that reached stage REPORT_COMMITTED for the
  // latest version and then went FAILED_TERMINAL (an outage longer than its
  // retry budget) still owes that version's package. Nothing re-asked it while
  // OUTPUT_PACKAGE_RECOVERY_ENABLED was off (the default, and an unknown value
  // in production), so the record stayed REPORTED without its package until a
  // person acted. It is re-asked now regardless of the flag — package-only, for
  // exactly that version, never a new report — but only when that run's terminal
  // reason is TECHNICAL (integrity, policy and commercial terminals stay an
  // operator's) and it has rested OWED_TECHNICAL_RETRY_BACKOFF_MS. Eligibility,
  // holds, the output-policy hold, storage and entitlement are decided exactly as
  // for every other package request below and by the writer; the writer's key
  // VERIFICATION_PACKAGE:<id>:v<N> makes a repeat tick or a second replica
  // collapse onto one request.
  {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        owner_user_id: string;
        team_id: string | null;
        version: number;
        gate_blocked: boolean;
        owed_reason: string | null;
        owed_completed_at: Date | null;
      }>
    >`
      SELECT e.id, e.owner_user_id, e.team_id, r.version,
             COALESCE(e.verification_package_metadata->>'blocked', 'false') = 'true' AS gate_blocked,
             owed.terminal_reason_code AS owed_reason,
             owed.completed_at_utc AS owed_completed_at
        FROM evidence e
        JOIN reports r
          ON r.evidence_id = e.id
         AND r.version = (SELECT max(r2.version) FROM reports r2 WHERE r2.evidence_id = e.id)
        LEFT JOIN verification_packages vp
          ON vp.evidence_id = e.id AND vp.version = r.version
         AND vp.state = 'PUBLISHED'
         AND (vp.disclosure_profile IS NULL OR vp.disclosure_profile = 'FULL_FORENSIC')
        LEFT JOIN LATERAL (
              SELECT q.terminal_reason_code, q.completed_at_utc
                FROM report_generation_requests q
               WHERE q.evidence_id = e.id
                 AND q.artifact_type = 'REPORT'
                 AND q.stage = 'REPORT_COMMITTED'
                 AND q.report_version = r.version
                 AND q.state = 'FAILED_TERMINAL'
               ORDER BY q.created_at_utc DESC
               LIMIT 1) owed ON TRUE
       WHERE e.status = 'REPORTED'
         AND e.deleted_at IS NULL
         AND e.lifecycle_state IN ('ACTIVE','UNDER_REVIEW','ON_HOLD','RETENTION_LOCKED')
         AND vp.id IS NULL
         AND (${packageRecoveryEnabled || options.dryRun === true}
              OR COALESCE(e.verification_package_metadata->>'blocked', 'false') = 'true'
              OR owed.completed_at_utc IS NOT NULL)
         AND (${packageCursor}::uuid IS NULL OR e.id > ${packageCursor}::uuid)
         AND NOT EXISTS (
               SELECT 1 FROM report_generation_requests q
                WHERE q.evidence_id = e.id
                  AND q.state IN ('QUEUED','PROCESSING','FAILED_RETRYABLE'))
       ORDER BY e.id
       LIMIT ${batch}
    `;
    packageCursor = rows.length === batch ? rows[rows.length - 1].id : null;
    summary.packageScanned = rows.length;
    for (const row of rows) {
      try {
        const issuance = await resolveEvidenceOutputIssuance({
          id: row.id,
          ownerUserId: row.owner_user_id,
          teamId: row.team_id,
        });
        if (issuance.decision === "UNRESOLVED") {
          summary.unresolved++;
          continue;
        }
        if (issuance.decision !== "ENTITLED" || !issuance.verificationPackageIncluded) {
          summary.packageSkippedNotEntitled++;
          continue;
        }
        // B5B-F-402 (free audit 0ea0) — the storage gate already refused this
        // version's package (its latest request settled NOT_APPLICABLE_STORAGE_
        // LIMIT). The writer supersedes a NOT_APPLICABLE head with no budget, so
        // re-asking every tick rebuilt both ZIP profiles only to be refused
        // again, growing the chain without bound. It is re-asked only once the
        // allowance would now admit it (storage freed or added).
        const latestForVersion = await prisma.reportGenerationRequest.findFirst({
          where: { evidenceId: row.id, reportVersion: row.version },
          orderBy: { createdAtUtc: "desc" },
          select: { state: true, terminalReasonCode: true },
        });
        if (
          latestForVersion?.state === "NOT_APPLICABLE" &&
          latestForVersion.terminalReasonCode === "NOT_APPLICABLE_STORAGE_LIMIT" &&
          !(await packageRebuildFitsStorage({
            ownerUserId: row.owner_user_id,
            teamId: row.team_id,
            evidenceId: row.id,
            version: row.version,
          }))
        ) {
          summary.packageSkippedStorageRefused++;
          continue;
        }
        // Closure 2 (PRO-W1-04) — owed by a committed report's dead run.
        let owedByCommittedReport = false;
        if (row.owed_completed_at) {
          if (classifyTerminalReason(row.owed_reason) !== "TECHNICAL") {
            if (!packageRecoveryEnabled && !row.gate_blocked && !options.dryRun) {
              summary.packageOwedNotTechnical++;
              continue;
            }
          } else if (now.getTime() - new Date(row.owed_completed_at).getTime() < OWED_TECHNICAL_RETRY_BACKOFF_MS) {
            if (!packageRecoveryEnabled && !row.gate_blocked && !options.dryRun) {
              summary.packageOwedResting++;
              continue;
            }
          } else {
            owedByCommittedReport = true;
          }
        }
        if (options.dryRun || (!packageRecoveryEnabled && !row.gate_blocked && !owedByCommittedReport)) {
          summary.packageScheduled++;
          continue;
        }
        const res = await requestReportGenerationFromWorker({
          evidenceId: row.id,
          purpose: "package_recovery",
          machineId: "worker.package-recovery",
          owed: true,
          packageForReportVersion: row.version,
          enqueue: (requestId) => enqueueReportGenerationRequest(requestId),
        });
        if (res.requestId && res.reason !== "already_terminal") {
          summary.packageScheduled++;
          if (owedByCommittedReport && !packageRecoveryEnabled && !row.gate_blocked) summary.packageOwedRecovered++;
        }
      } catch (err) {
        summary.failed++;
        logger.error({ err, evidenceId: row.id, trigger }, "first_issuance.package.failed");
      }
    }
  }

  logger.info({ ...summary, trigger, dryRun: options.dryRun === true }, "first_issuance.completed");
  return summary;
}
