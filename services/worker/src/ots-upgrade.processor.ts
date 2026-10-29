import { Job } from "bullmq";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { JOB_NAMES, resolveOtsAnchoring, type OtsAnchoring } from "@proovra/shared";
import * as prismaPkg from "@prisma/client";
import { decodeCanonicalJob } from "./canonical-job.js";
import type { Prisma } from "@prisma/client";
import { appendCustodyEventTx } from "./custody-events.js";
import { recordWorkerIncident } from "./governance/incident-emitter.js";
import { prisma } from "./db.js";
import { enqueueOtsUpgradeJob } from "./queue.js";
import { resolveOtsBin, resolveOtsTimeoutMs } from "./ots.service.js";
import { ensureOtsAnchoredReportVersion } from "./ots-anchored-version.js";
import { ensureEvidenceOtsInitialized } from "./ots-lifecycle.js";
import {
  OTS_ROW_SNAPSHOT_SELECT,
  applyOtsTransition,
  decideOtsChainTransition,
  decideOtsTransition,
  decideStoredStatusAlignment,
  hasOtsProofMagic,
  isPermanentOtsProofFailure,
  isTerminalOtsChainOutcome,
  nextOtsChainCheckDelayMs,
  resolveRowOtsAnchoring,
  type OtsObservation,
  type OtsRowSnapshot,
  type OtsTransition,
} from "./ots-state.js";
import { resolveOtsBitcoinVerifierConfig } from "./ots-bitcoin-config.js";
import { checkOtsProofAgainstBitcoin } from "./ots-bitcoin-verifier.js";
import { logger, withJobContext } from "./logger.js";
import { bump } from "@proovra/shared-runtime/ops";

const execFileAsync = promisify(execFile);

function now(): Date {
  return new Date();
}

// Phase Final-Worker-Visibility — OTS upgrade loop control.
//
// Prior to this phase `buildFollowUpJobId` baked the upgrade timestamp
// into the jobId, so every PENDING re-enqueue produced a *new* job with
// `attempts: 20`. The retry budget reset every time, defeating the
// ceiling — a piece of evidence with a permanently broken OTS calendar
// would burn ~24 retry slots per day, forever.
//
// The fix:
//
//   1. **Stable jobId per evidenceId.** Every follow-up job for the
//      same evidence reuses the same id, so BullMQ's attempts ceiling
//      is honored.
//
//   2. **Global attempt budget (30 days).** If the proof's recorded start
//      (`resolveOtsBudgetStart`, 2026-09-29; it was `createdAt`) is older
//      than `OTS_GLOBAL_BUDGET_DAYS` and a CONCLUSIVE check still finds no
//      anchor, the processor marks the row
//      FAILED with reason `OTS_GLOBAL_BUDGET_EXHAUSTED` and stops
//      re-enqueueing. Operators see the stuck row on the canonical
//      OTS status surface (evidence detail / `/operations/queues`).
//
//   3. ~~**Stuck detection.**~~ REMOVED FROM THIS NOTE (2026-09-09) because it
//      described an implementation that no longer exists. There is no
//      per-evidence attempt counter in this processor and nothing returns
//      `stuck: true`; the Point-5 rewrite replaced that idea, and the 30-day
//      global budget below is the only ceiling. A comment describing a
//      mechanism the file does not have reads as coverage.
//
//      The operator-facing middle ground it was reaching for DOES exist now,
//      as `evidence_integrity.ots_pending_aged` — a read-only operational
//      condition on its own 24h/72h window, deliberately separate from the
//      retry budget. See packages/shared-runtime/src/ops/ots-aging.ts.

/**
 * PHASE 12 — POINT 5: the follow-up job id is DELETED, not renamed.
 *
 * There is now exactly one id for an OTS upgrade of a given evidence record —
 * `ots-upgrade-<evidenceId>`, built by `buildCanonicalJobId` from the registry
 * prefix — and the follow-up reuses it. That is what the "stable jobId per
 * evidenceId" note above was reaching for; it just implemented it as a SECOND
 * stable id (`ots-upgrade-followup-<evidenceId>`), which meant a follow-up and
 * an initial upgrade for the same evidence had separate attempt budgets and
 * could both be runnable at once.
 *
 * The 30-day global budget and the stuck-detection counter below are unchanged
 * — they were always the real ceiling, since the happy-path PENDING return
 * never throws and so never consumed a BullMQ attempt.
 */
export const OTS_FOLLOWUP_JOB_PREFIX = "ots-upgrade-";

/**
 * THE GLOBAL ANCHORING BUDGET MOVED, AND NOTHING ABOUT IT CHANGED.
 *
 * It used to be declared here, where it decides when this processor STOPS
 * re-enqueueing. The API now needs the same window for a different reading of
 * the same fact — when does a record still PENDING become an operational
 * condition an operator should see — and a second threshold for the second
 * reading would produce a workspace whose Operations page calls a record fine
 * while this processor has already given up on it.
 *
 * So the number and the predicate live in `@proovra/shared-runtime` and both
 * hosts import them. Re-exported under their existing names so every caller
 * here, and the contract test that pins them, is untouched.
 */
import {
  getOtsGlobalBudgetMs,
  isOtsGlobalBudgetExhausted,
  OTS_GLOBAL_BUDGET_DAYS_DEFAULT,
  readOtsGlobalBudgetDays,
  resolveOtsAnchoringStart,
  resolveOtsBudgetStart,
} from "@proovra/shared-runtime";

export {
  getOtsGlobalBudgetMs,
  isOtsGlobalBudgetExhausted,
  OTS_GLOBAL_BUDGET_DAYS_DEFAULT,
  readOtsGlobalBudgetDays,
};

/**
 * Returns the upper bound for re-enqueue attempts before the global
 * budget gives up. Exported so callers (operations queue UI) can
 * surface the same number in the "stuck OTS" label.
 */

/**
 * PHASE 12 — POINT 5.
 *
 * The payload was `{ evidenceId }` — already reference-only, which is why this
 * processor needed no tenancy fix. What it did NOT have was a strict decode:
 * it read `job.data.evidenceId` directly, so a payload carrying extra fields
 * (a `teamId`, a `forceRegenerate`, an unknown schema version) was accepted
 * silently. The reference happened to be the only field it used; nothing
 * enforced that.
 *
 * It now goes through the same decoder as every other chain, which means an
 * unknown field or an unknown version is a counted refusal before the first
 * database read.
 */
/**
 * WHEN THE GLOBAL BUDGET STARTS FOR THIS PROOF — THE shared start
 * (`resolveOtsBudgetStart` / `resolveOtsAnchoringStart` in
 * @proovra/shared-runtime ops/ots-aging.ts), the same instant the operations
 * aging condition measures from.
 *
 * The earliest OTS custody event (moved forward only by a demotion); with NO
 * recorded OTS event at all (rows older than any OTS custody writing), the
 * record's creation (2026-10-29). Such a row used to get a null start, which
 * the budget never failed: it stayed PENDING forever. It now fails at budget
 * like every other proof.
 *
 * `resolveOtsBudgetStart` is re-exported here for the behaviour test.
 */
export { resolveOtsBudgetStart };

const OTS_BUDGET_EVENT_TYPES = [
  prismaPkg.CustodyEventType.OTS_APPLIED,
  prismaPkg.CustodyEventType.OTS_FAILED,
  prismaPkg.CustodyEventType.OTS_ATTEMPT_ERROR,
];

async function loadOtsBudgetStart(evidenceId: string, createdAt: Date): Promise<Date> {
  const events = await prisma.custodyEvent.findMany({
    where: { evidenceId, eventType: { in: OTS_BUDGET_EVENT_TYPES } },
    orderBy: { sequence: "asc" },
    select: { atUtc: true, payload: true },
  });
  return resolveOtsAnchoringStart({ otsBudgetStartUtc: resolveOtsBudgetStart(events), createdAt });
}

export async function processOtsUpgrade(job: Job<unknown>) {
  const requestId = randomUUID();
  const decoded = decodeCanonicalJob(JOB_NAMES.UPGRADE_OTS, job, { requestId });
  const evidenceId = decoded.commandId;
  const startedAt = Date.now();

  logger.info(
    withJobContext({
      jobId: job.id,
      evidenceId,
      attempt: job.attemptsMade + 1,
      status: "started",
    }),
    "ots.upgrade.started"
  );

  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      // The budget's start only when the record has NO OTS custody event
      // (resolveOtsAnchoringStart); otherwise incident and log context.
      createdAt: true,
      // Phase IA-reliability — required so the incident bridge can
      // scope the OperationalIncident row to the right workspace.
      teamId: true,
      // A deleted record's lifecycle has ended: no OTS work runs for it.
      deletedAt: true,
      // Every OTS column the transition decides from, the chain fact
      // included; every proof must commit to the fingerprint digest.
      ...OTS_ROW_SNAPSHOT_SELECT,
    },
  });

  if (evidence?.deletedAt) {
    logger.info(
      withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: "skipped_deleted_evidence" }),
      "ots.upgrade.skipped",
    );
    return;
  }

  if (!evidence) {
    logger.warn(
      withJobContext({
        jobId: job.id,
        evidenceId,
        durationMs: Date.now() - startedAt,
        status: "skipped_missing_evidence",
      }),
      "ots.upgrade.skipped"
    );
    return;
  }

  if (!evidence.otsProofBase64) {
    /*
     * ===================================================================
     * NO PROOF YET — INITIALIZE ONE. THIS USED TO BE A DEAD END.
     * ===================================================================
     * This branch returned "skipped_missing_proof", and for a record that
     * would never be stamped it returned that forever. The initial stamp was
     * created inside the REPORT job, so the only records that reached this
     * processor with a proof were those whose plan includes reports. A FREE
     * record could be enqueued here and would be turned away by this very
     * line, permanently — while Pricing promised it OpenTimestamps.
     *
     * Initialization now happens here, which keeps ONE queue, ONE job id
     * (`ots-upgrade-<evidenceId>` — the id is the dedupe) and ONE state
     * machine for the whole lifecycle. The processor's two phases are simply
     * "there is no proof" and "there is one".
     *
     * It returns rather than falling through: the freshly-created proof is
     * seconds old and the calendar cannot have anchored it yet, so upgrading
     * it in the same tick would spend a calendar round trip to learn nothing.
     * The follow-up job carries it forward on the normal cadence, under the
     * same global budget as every other pending proof.
     */
    /*
     * RELIABILITY CLOSURE (2026-09-09) — A TRANSIENT STAMP FAILURE NOW THROWS,
     * AND THIS FUNCTION DELIBERATELY DOES NOT CATCH IT.
     *
     * `ensureEvidenceOtsInitialized` raises `OtsInitializationTransientError`
     * when the calendar call itself failed — an outage, a timeout, a missing
     * binary — and writes no OTS column while doing so. Letting it propagate is
     * the whole point: it is what consumes a BullMQ attempt and schedules the
     * next one under `RETRY_POLICIES.TIMESTAMP_AUTHORITY` (20 attempts,
     * exponential from 60s), which is the budget this queue has always declared
     * and never actually entered.
     *
     * The `workDir` created below is NOT yet allocated at this point, so there
     * is nothing to clean up on the way out.
     */
    const init = await ensureEvidenceOtsInitialized({
      evidenceId,
      requestId,
      jobId: job.id ?? null,
      trigger: "ots_upgrade_job",
    });

    if (init.initialized && init.needsUpgrade) {
      // ET-OTS-01 — this call runs INSIDE the job whose id is the canonical
      // `ots-upgrade-<evidenceId>`. Without selfJobId the enqueue collapses onto
      // the running job and no upgrade is ever scheduled for a new proof.
      await enqueueOtsUpgradeJob(evidenceId, { traceId: requestId, selfJobId: job.id }).catch(
        (error: unknown) => {
          // The record is stamped and durable either way. A follow-up that
          // could not be scheduled is a queue problem, not an integrity one,
          // and the reconciliation path re-enqueues it.
          logger.warn(
            { ...withJobContext({ jobId: job.id, evidenceId }), err: error },
            "ots.init.followup_enqueue_failed",
          );
        },
      );
    }

    logger.info(
      withJobContext({
        jobId: job.id,
        evidenceId,
        durationMs: Date.now() - startedAt,
        status: init.initialized ? "initialized" : `skipped_${init.reason}`,
      }),
      "ots.upgrade.completed"
    );
    return;
  }

  const snapshot: OtsRowSnapshot = {
    otsStatus: evidence.otsStatus,
    otsProofBase64: evidence.otsProofBase64,
    otsHash: evidence.otsHash,
    otsCalendar: evidence.otsCalendar,
    otsBitcoinTxid: evidence.otsBitcoinTxid,
    otsAnchoredAtUtc: evidence.otsAnchoredAtUtc,
    otsUpgradedAtUtc: evidence.otsUpgradedAtUtc,
    otsFailureReason: evidence.otsFailureReason,
    fingerprintHash: evidence.fingerprintHash,
    otsChainVerificationStatus: evidence.otsChainVerificationStatus,
    otsChainCheckedAtUtc: evidence.otsChainCheckedAtUtc,
    otsChainVerifiedAtUtc: evidence.otsChainVerifiedAtUtc,
    otsChainBlockHeight: evidence.otsChainBlockHeight,
    otsChainBlockHash: evidence.otsChainBlockHash,
    otsChainBlockTimeUtc: evidence.otsChainBlockTimeUtc,
    otsChainConfirmations: evidence.otsChainConfirmations,
    otsChainVerifier: evidence.otsChainVerifier,
    otsChainFailureCode: evidence.otsChainFailureCode,
  };
  const current = resolveRowOtsAnchoring(snapshot);

  // A stored status that disagrees with the stored proof is aligned first —
  // a proof already anchored is recorded ANCHORED, a defective one FAILED —
  // without a calendar round trip.
  const alignment = decideStoredStatusAlignment(snapshot, now());
  if (alignment && alignment.kind === "WRITE") {
    await commitOtsTransition({ job, evidenceId, evidence, snapshot, transition: alignment, observedAt: now(), forensic: {}, startedAt });
    return;
  }

  // ANCHORED is terminal for this PROOF (its bytes are never rewritten). What
  // remains for an ANCHORED proof is the independent Bitcoin-chain check of
  // the block it names — carried by this same job, queue and CAS authority.
  if (current.state === "ANCHORED") {
    await verifyAnchoredProofAgainstChain({ job, evidenceId, evidence, snapshot, current, startedAt });
    return;
  }
  // An established proof defect is terminal too. Delayed and duplicate
  // deliveries end here.
  if (current.state === "FAILED" && isPermanentOtsProofFailure(current.failureCode)) {
    logger.info(
      withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: "proof_invalid_terminal" }),
      "ots.upgrade.skipped",
    );
    return;
  }

  bump("ots_upgrade_started_total");
  const storedProof = Buffer.from(evidence.otsProofBase64, "base64");
  let observation: OtsObservation;
  let forensic: Record<string, unknown> = {};

  if (!hasOtsProofMagic(storedProof)) {
    // The resolver already reads such bytes as MALFORMED_PROOF; alignment above
    // recorded it. Reaching here means the row is already FAILED for it.
    observation = { kind: "TRANSIENT_ERROR", reason: "OTS_PROOF_UNREADABLE: the stored proof has no OpenTimestamps header." };
  } else {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ots-upgrade-"));
    const file = path.join(workDir, "proof.ots");
    try {
      await fs.writeFile(file, storedProof);
      let commandErrored = false;
      let errorText = "";
      try {
        await execFileAsync(resolveOtsBin(), ["upgrade", file], {
          timeout: resolveOtsTimeoutMs(),
          cwd: workDir,
        });
      } catch (error) {
        commandErrored = true;
        const err = error as { stderr?: string; message?: string };
        errorText = String(err.stderr ?? err.message ?? "").slice(0, 300);
      }
      const proofBase64 = (await fs.readFile(file)).toString("base64");
      const changed = proofBase64 !== evidence.otsProofBase64;
      forensic = { upgradeCommandErrored: commandErrored, proofChanged: changed };
      // `ots upgrade` exits non-zero while a calendar has nothing new yet; the
      // bytes it leaves behind are what is decided on. Only a command that
      // could not reach a calendar (or run at all) and changed nothing is an
      // attempt error — recorded, retried, never a proof fact.
      observation =
        commandErrored && !changed && isOtsTransportFailure(errorText)
          ? { kind: "TRANSIENT_ERROR", reason: `OTS_CALENDAR_UNAVAILABLE: ${boundedCalendarError(errorText)}` }
          : { kind: "PROOF", proofBase64 };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  const observedAt = now();
  if (observation.kind === "PROOF") {
    // The budget applies only to a proof that is still PENDING after this
    // upgrade, measured from the proof's recorded start.
    const candidate = resolveOtsAnchoring({
      status: "PENDING",
      proofBase64: observation.proofBase64,
      fingerprintHash: evidence.fingerprintHash,
      otsHash: evidence.otsHash,
    });
    forensic = {
      ...forensic,
      candidateState: candidate.state,
      candidateFailureCode: candidate.failureCode,
      candidateProofSha256: candidate.proofSha256,
      bitcoinBlockHeight: candidate.bitcoinBlockHeight,
      pendingCalendars: candidate.pendingCalendars.length,
      validator: candidate.validator,
    };
    if (candidate.state === "PENDING") {
      const budgetStart = await loadOtsBudgetStart(evidenceId, evidence.createdAt);
      if (isOtsGlobalBudgetExhausted({ firstAttemptAtUtc: budgetStart, nowUtc: observedAt })) {
        observation = { kind: "BUDGET_EXHAUSTED" };
      }
    }
  }

  const transition = decideOtsTransition(snapshot, observation, observedAt);

  if (transition.kind === "NO_CHANGE") {
    logger.info(
      {
        ...withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: "no_change" }),
        reason: transition.reason,
      },
      "ots.upgrade.no_change",
    );
    return;
  }

  if (transition.kind === "RECORD_ATTEMPT_ERROR") {
    bump("ots_calendar_failure_total");
    // The ATTEMPT failed, not the proof: the row keeps every established fact,
    // the attempt is recorded, and the job's retry budget brings it back.
    await prisma.$transaction(async (tx) => {
      await appendCustodyEventTx(tx, {
        evidenceId,
        eventType: prismaPkg.CustodyEventType.OTS_ATTEMPT_ERROR,
        atUtc: observedAt,
        payload: {
          otsPhase: "upgrade_attempt_failed",
          otsStatusUnchanged: evidence.otsStatus,
          reason: transition.reason,
          ...forensic,
        } as Prisma.InputJsonValue,
      });
    });
    logger.warn(
      {
        ...withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: "attempt_failed" }),
        reason: transition.reason,
      },
      "ots.upgrade.attempt_failed",
    );
    throw new Error("OTS_UPGRADE_ATTEMPT_FAILED");
  }

  await commitOtsTransition({ job, evidenceId, evidence, snapshot, transition, observedAt, forensic, startedAt });
}

/**
 * The upgrade command could not reach a calendar or could not run: DNS,
 * connection, TLS, timeout, a calendar 5xx, a missing binary. "Not yet
 * complete" / "pending confirmation" output is NOT one — that is the proof
 * still awaiting Bitcoin, decided from its bytes.
 */
export function isOtsTransportFailure(text: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOENT|socket hang up|timed? ?out|certificate|SSL|TLS|HTTP Error 5\d\d|\b50[0-4]\b|Could not connect|Connection (?:refused|reset|aborted)|Name or service not known|Temporary failure in name resolution|Killed|SIGKILL|SIGTERM/i.test(
    text,
  );
}

/**
 * A calendar failure as a bounded category: no host, URL, path or raw
 * command output ever reaches the custody chain or Operations.
 */
export function boundedCalendarError(text: string): string {
  if (/ENOENT|not found: ots|command not found/i.test(text)) return "binary_missing";
  if (/ENOTFOUND|EAI_AGAIN|Name or service not known|Temporary failure in name resolution/i.test(text)) return "dns_failure";
  if (/ETIMEDOUT|timed? ?out|Killed|SIGKILL|SIGTERM/i.test(text)) return "timeout";
  if (/HTTP Error 5\d\d|\b50[0-4]\b/i.test(text)) return "calendar_http_5xx";
  if (/certificate|SSL|TLS/i.test(text)) return "tls_failure";
  return "connection_failure";
}

async function commitOtsTransition(input: {
  job: Job<unknown>;
  evidenceId: string;
  evidence: { otsStatus: string | null; teamId: string | null };
  snapshot: OtsRowSnapshot;
  transition: Extract<OtsTransition, { kind: "WRITE" }>;
  observedAt: Date;
  forensic: Record<string, unknown>;
  startedAt: number;
}): Promise<void> {
  const { job, evidenceId, evidence, snapshot, transition, observedAt, forensic, startedAt } = input;
  const applied = await prisma.$transaction(async (tx) => {
    const won = await applyOtsTransition(tx, evidenceId, snapshot, transition);
    if (!won || !transition.material) return won;
    await appendCustodyEventTx(tx, {
      evidenceId,
      eventType:
        transition.status === "FAILED" ? prismaPkg.CustodyEventType.OTS_FAILED : prismaPkg.CustodyEventType.OTS_APPLIED,
      atUtc: observedAt,
      payload: {
        otsStatus: transition.status,
        otsState: transition.anchoring.state,
        // The canonical verification the record states after this write:
        // CHAIN_VERIFIED only from an independent Bitcoin-chain check.
        otsVerification: transition.anchoring.verification,
        otsPhase: transition.phase,
        previousOtsStatus: evidence.otsStatus,
        proofSha256: transition.anchoring.proofSha256,
        bitcoinBlockHeight: transition.anchoring.state === "ANCHORED" ? transition.anchoring.bitcoinBlockHeight : null,
        bitcoinTxid: transition.anchoring.state === "ANCHORED" ? transition.anchoring.bitcoinTxid : null,
        validator: transition.anchoring.validator,
        observedAtUtc: observedAt.toISOString(),
        failureReason: (transition.data.otsFailureReason as string | null | undefined) ?? null,
        ...(transition.phase.startsWith("chain_") ? { chain: chainCustodyFacts(transition.anchoring) } : {}),
        ...(transition.phase === "global_budget_exhausted" ? { budgetDays: readOtsGlobalBudgetDays() } : {}),
        ...forensic,
      } as Prisma.InputJsonValue,
    });
    return true;
  });

  if (!applied) {
    // The row moved on since it was read — a newer job or worker recorded
    // newer OTS facts. This older observation is discarded, not written.
    logger.info(
      withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: "stale_observation_discarded" }),
      "ots.upgrade.stale",
    );
    return;
  }

  if (transition.phase.startsWith("chain_")) {
    if (transition.material) {
      const counter = (
        {
          chain_verified: "ots_chain_verified_total",
          chain_confirmations_pending: "ots_chain_confirmations_pending_total",
          chain_verification_unavailable: "ots_chain_verification_unavailable_total",
          chain_verification_failed: "ots_chain_verification_failed_total",
          chain_reorged: "ots_chain_reorged_total",
        } as const
      )[transition.phase as "chain_verified"];
      if (counter) bump(counter);
    }
    // The derivative version follows an independent chain verification only.
    if (transition.anchoring.verification === "CHAIN_VERIFIED") {
      await requestChainVerifiedReportVersion(evidenceId, transition.anchoring, job.id ?? null);
    }
    await scheduleNextChainCheck(evidenceId, transition.anchoring, job.id ?? null);
    logger.info(
      {
        ...withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: transition.phase }),
        verification: transition.anchoring.verification,
        chainFailureCode: transition.anchoring.chain?.failureCode ?? null,
      },
      "ots.chain.checked",
    );
    return;
  }

  if (transition.material) {
    if (transition.status === "ANCHORED") {
      bump("ots_anchored_total");
      bump("ots_upgrade_succeeded_total");
    } else if (transition.status === "FAILED") {
      bump("ots_upgrade_failed_total");
      bump(
        transition.data.otsFailureReason === "OTS_GLOBAL_BUDGET_EXHAUSTED" ? "ots_budget_exhausted_total" : "ots_proof_integrity_failed_total",
      );
    }
  }

  if (transition.status === "ANCHORED") {
    // The proof now NAMES a block. The independent chain check runs on the
    // next delivery of this same job (one queue, one id, one CAS authority);
    // no derivative version is requested for an unchecked attestation.
    await scheduleNextChainCheck(evidenceId, transition.anchoring, job.id ?? null, OTS_CHAIN_FIRST_CHECK_DELAY_MS);
  }

  if (transition.phase === "global_budget_exhausted") {
    logger.error(
      withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: "global_budget_exhausted" }),
      "ots.upgrade.budget_exhausted",
    );
    // Budget exhaustion is TERMINAL: no further upgrade attempts. CRITICAL so
    // /v1/me/inbox lifts it to P1.
    try {
      await recordWorkerIncident({
        sourceId: "evidence_integrity.ots_budget_exhausted",
        teamId: evidence.teamId ?? null,
        category: "WORKER",
        severity: "CRITICAL",
        fingerprint: `OTS:${evidenceId}:GLOBAL_BUDGET_EXHAUSTED`,
        message: {
          code: "ops.evidence_integrity.ots_budget_exhausted",
          params: { recordRef: evidenceId.slice(0, 8) },
        },
        relatedEvidenceId: evidenceId,
        relatedJobId: job.id,
        metadata: {
          queueName: "ots-upgrade",
          failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED",
          budgetDays: readOtsGlobalBudgetDays(),
        },
      });
    } catch (err) {
      logger.warn({ err, evidenceId }, "worker.ots.incident_bridge_failed");
    }
    return;
  }

  if (transition.status === "PENDING") {
    bump("ots_upgrade_pending_total");
    // PHASE 12 — POINT 5. ONE job id per record's OTS upgrade
    // (`ots-upgrade-<evidenceId>`); `selfJobId` keeps this call from collapsing
    // onto the job that is running it.
    await enqueueOtsUpgradeJob(evidenceId, {
      delayMs: 60 * 60 * 1000,
      traceId: "ots_followup",
      selfJobId: job.id,
    });
  }

  logger.info(
    withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: transition.phase }),
    transition.status === "ANCHORED"
      ? "ots.upgrade.anchored"
      : transition.status === "FAILED"
        ? "ots.upgrade.proof_invalid"
        : "ots.upgrade.pending",
  );
}

/**
 * THE DOWNSTREAM VERSION DECISION, after a proof is independently VERIFIED
 * against the Bitcoin main chain. Never throws: the verification is committed
 * either way, and the decision is idempotent (ots-anchored-version.ts:
 * one request per proof + block), so a later delivery — every recheck of a
 * VERIFIED record calls it again — or the reconcile script recovers a
 * decision lost to a restart or to a failed in-flight report.
 */
async function requestChainVerifiedReportVersion(evidenceId: string, anchoring: OtsAnchoring, jobId: string | null): Promise<void> {
  try {
    const decision = await ensureOtsAnchoredReportVersion({ evidenceId, anchoring });
    logger.info({ evidenceId, jobId, decision: decision.outcome }, "ots.chain_verified.version_decision");
  } catch (err) {
    logger.warn({ evidenceId, jobId, err }, "ots.chain_verified.version_decision_failed");
  }
}

/** The first chain check after a proof becomes ANCHORED. */
export const OTS_CHAIN_FIRST_CHECK_DELAY_MS = 60 * 1000;

/** Re-enqueue the same `ots-upgrade-<evidenceId>` job when another chain check is due. */
async function scheduleNextChainCheck(evidenceId: string, anchoring: OtsAnchoring, jobId: string | null, overrideDelayMs?: number): Promise<void> {
  if (resolveOtsBitcoinVerifierConfig().kind === "disabled") return;
  const delayMs = overrideDelayMs ?? nextOtsChainCheckDelayMs(anchoring);
  if (delayMs == null) return;
  await enqueueOtsUpgradeJob(evidenceId, { delayMs, traceId: "ots_chain_check", selfJobId: jobId ?? undefined }).catch((err: unknown) => {
    // Not an integrity problem: the reconciler re-enqueues an unchecked ANCHORED record.
    logger.warn({ evidenceId, jobId, err }, "ots.chain.followup_enqueue_failed");
  });
}

/** Bounded, credential-free chain facts for the custody event. */
function chainCustodyFacts(anchoring: OtsAnchoring): Record<string, unknown> {
  const c = anchoring.chain;
  return c
    ? {
        status: c.status,
        failureCode: c.failureCode,
        blockHeight: c.blockHeight,
        blockHash: c.blockHash,
        blockTimeUtc: c.blockTimeUtc,
        confirmations: c.confirmations,
        minConfirmations: c.minConfirmations,
        checkedAtUtc: c.checkedAtUtc,
        verifiedAtUtc: c.verifiedAtUtc,
        verifier: c.verifier,
      }
    : { status: null };
}

/**
 * THE INDEPENDENT CHAIN CHECK of an ANCHORED proof. Writes only the chain
 * columns, compare-and-set against the full OTS snapshot (a stale job never
 * overwrites a newer chain outcome), appends one custody event when the
 * outcome changed, and schedules the next check. A disabled verifier changes
 * nothing; the record keeps stating an unchecked attestation.
 */
async function verifyAnchoredProofAgainstChain(input: {
  job: Job<unknown>;
  evidenceId: string;
  evidence: { otsStatus: string | null; teamId: string | null };
  snapshot: OtsRowSnapshot;
  current: OtsAnchoring;
  startedAt: number;
}): Promise<void> {
  const { job, evidenceId, evidence, snapshot, current, startedAt } = input;
  const config = resolveOtsBitcoinVerifierConfig();
  if (config.kind === "disabled") {
    logger.info(withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: "chain_verification_disabled" }), "ots.chain.skipped");
    return;
  }
  if (isTerminalOtsChainOutcome(snapshot)) {
    logger.info(withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: "chain_outcome_terminal" }), "ots.chain.skipped");
    return;
  }
  // A VERIFIED record that is already final only re-asks the (idempotent) version decision.
  if (current.verification === "CHAIN_VERIFIED" && nextOtsChainCheckDelayMs(current) === null) {
    await requestChainVerifiedReportVersion(evidenceId, current, job.id ?? null);
    return;
  }
  const check = await checkOtsProofAgainstBitcoin(current, { config });
  const transition = decideOtsChainTransition(snapshot, check, {
    minConfirmations: config.kind === "enabled" ? config.policy.minConfirmations : 0,
  });
  if (transition.kind !== "WRITE") {
    if (current.verification === "CHAIN_VERIFIED") await requestChainVerifiedReportVersion(evidenceId, current, job.id ?? null);
    await scheduleNextChainCheck(evidenceId, current, job.id ?? null);
    logger.info(
      {
        ...withJobContext({ jobId: job.id, evidenceId, durationMs: Date.now() - startedAt, status: "chain_no_change" }),
        reason: transition.kind === "NO_CHANGE" ? transition.reason : null,
      },
      "ots.chain.no_change",
    );
    return;
  }
  const forensic: Record<string, unknown> =
    check.kind === "DECIDED"
      ? { chainTipHeight: check.tip.height, chainRejected: check.decision.rejected }
      : check.kind === "UNAVAILABLE"
        ? { chainUnavailableCode: check.code }
        : {};
  await commitOtsTransition({ job, evidenceId, evidence, snapshot, transition, observedAt: check.kind === "DISABLED" ? now() : check.checkedAtUtc, forensic, startedAt });
}
