import { Job } from "bullmq";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  JOB_NAMES,
  isValidOtsBitcoinTxid,
  resolveEffectiveOtsStatus,
} from "@proovra/shared";
import * as prismaPkg from "@prisma/client";
import { decodeCanonicalJob } from "./canonical-job.js";
import type { Prisma } from "@prisma/client";
import { appendCustodyEventTx } from "./custody-events.js";
import { recordWorkerIncident } from "./governance/incident-emitter.js";
import { prisma } from "./db.js";
import { enqueueOtsUpgradeJob } from "./queue.js";
import {
  getOtsProofInfo,
  resolveOtsBin,
  resolveOtsTimeoutMs,
  verifyOtsProof,
} from "./ots.service.js";
import { ensureEvidenceOtsInitialized } from "./ots-lifecycle.js";
import {
  applyOtsTransition,
  decideOtsTransition,
  hasOtsProofMagic,
  isCheckedOtsAnchor,
  isPermanentOtsProofFailure,
  type OtsObservation,
  type OtsRowSnapshot,
} from "./ots-state.js";
import { logger, withJobContext } from "./logger.js";
import {
  classifyOtsResult,
  parseOtsUpgradeOutput,
  type OtsClassification,
} from "./ots-upgrade-output.js";

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
//   2. **Global attempt budget (30 days).** If the first OTS
//      submission for this evidence is older than `OTS_GLOBAL_BUDGET_DAYS`
//      and the proof still won't anchor, the processor marks the row
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
 * Decide whether a piece of evidence has exceeded the global budget.
 * The budget is computed from the FIRST observed upgrade attempt for
 * this evidence. We track that by comparing the current job's
 * `upgradedAt` to `evidence.otsAnchoredAtUtc` (the earliest known
 * pinned-upgrade timestamp) or the evidence's `createdAt` as a
 * fallback when no upgrade has ever produced an anchor row.
 *
 * Exported for the contract test.
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
      // Phase Final-Worker-Visibility — `createdAt` is the anchor
      // for the global OTS attempt budget. We use it (not the
      // upgrade timestamp) because `upgradedAt` is the CURRENT
      // run's clock and `otsAnchoredAtUtc` is null for proofs that
      // never anchored.
      createdAt: true,
      // Phase IA-reliability — required so the incident bridge can
      // scope the OperationalIncident row to the right workspace.
      teamId: true,
      otsProofBase64: true,
      otsStatus: true,
      otsHash: true,
      otsCalendar: true,
      otsBitcoinTxid: true,
      otsAnchoredAtUtc: true,
      otsUpgradedAtUtc: true,
      otsFailureReason: true,
      otsAnchorCheck: true,
    },
  });

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
      await enqueueOtsUpgradeJob(evidenceId, { traceId: requestId }).catch(
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
    otsAnchorCheck: evidence.otsAnchorCheck,
  };
  const effectiveStatus = resolveEffectiveOtsStatus({
    status: evidence.otsStatus,
    bitcoinTxid: evidence.otsBitcoinTxid,
    anchoredAtUtc: evidence.otsAnchoredAtUtc,
  });
  const hasDefensibleTxid = isValidOtsBitcoinTxid(evidence.otsBitcoinTxid);

  // Nothing to learn: an anchor whose check is recorded, a legacy anchor with a
  // defensible txid (its claim already reads "not checked"), or a proof already
  // established invalid. Delayed and duplicate deliveries end here.
  if (
    isCheckedOtsAnchor(snapshot) ||
    (effectiveStatus === "ANCHORED" && hasDefensibleTxid) ||
    (effectiveStatus === "FAILED" && isPermanentOtsProofFailure(evidence.otsFailureReason))
  ) {
    logger.info(
      withJobContext({
        jobId: job.id,
        evidenceId,
        durationMs: Date.now() - startedAt,
        status: effectiveStatus === "FAILED" ? "proof_invalid_terminal" : "already_anchored",
      }),
      "ots.upgrade.skipped"
    );
    return;
  }

  const storedProof = Buffer.from(evidence.otsProofBase64, "base64");
  let observation: OtsObservation;
  let forensic: Record<string, unknown> = {};

  if (!hasOtsProofMagic(storedProof)) {
    observation = {
      kind: "PROOF_INVALID",
      code: "MALFORMED_PROOF",
      reason: "The stored proof is not an OpenTimestamps proof (header missing).",
    };
  } else {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ots-upgrade-"));
    const file = path.join(workDir, "proof.ots");
    try {
      await fs.writeFile(file, storedProof);

      let stdout = "";
      let stderr = "";
      let commandErrored = false;
      try {
        const result = await execFileAsync(resolveOtsBin(), ["upgrade", file], {
          timeout: resolveOtsTimeoutMs(),
          cwd: workDir,
        });
        stdout = result.stdout ?? "";
        stderr = result.stderr ?? "";
      } catch (error) {
        commandErrored = true;
        const err = error as { stdout?: string; stderr?: string; message?: string };
        stdout = err.stdout ?? "";
        stderr = err.stderr ?? err.message ?? "";
      }

      const parsedUpgrade = parseOtsUpgradeOutput(stdout, stderr);
      const proofBase64 = (await fs.readFile(file)).toString("base64");

      // `ots verify` checks the Bitcoin attestation against the chain (needs a
      // Bitcoin node); `ots info` reads the proof structure offline. The
      // classifier consumes both; which one established an anchor is RECORDED
      // (evidence.ots_anchor_check), because only the first may be called
      // verified.
      const verifyResult = await verifyOtsProof({
        proofBase64,
        hashHex: evidence.otsHash ?? null,
      });
      const verify =
        verifyResult.status === "VERIFIED" || verifyResult.status === "INCOMPLETE"
          ? verifyResult.verify
          : null;
      const infoResult = await getOtsProofInfo({ proofBase64 });
      const info = infoResult.status === "PARSED" ? infoResult.info : null;
      const expectedHash = evidence.otsHash ? evidence.otsHash.toLowerCase() : null;

      const classification: OtsClassification = classifyOtsResult({
        upgrade: parsedUpgrade,
        verify,
        info,
        expectedFileHashHex: evidence.otsHash ?? null,
        existingTxid: evidence.otsBitcoinTxid,
        commandErrored,
        mergedErrorText: parsedUpgrade.raw,
      });

      forensic = {
        verifyStatus: verifyResult.status,
        verifyConfirmed: verify?.verified === true,
        infoStatus: infoResult.status,
        infoFileHash: info?.fileHash ?? null,
        infoFileHashMatches: info?.fileHash != null && expectedHash != null && info.fileHash === expectedHash,
        infoBlockHeights: info?.bitcoinBlockHeights ?? [],
        infoPendingCalendars: info?.pendingCalendars ?? [],
        classification: classification.kind,
        classifierPhase: classification.phase,
        classifierReason: classification.reason,
        blockHeight: classification.blockHeight,
      };

      if (info?.fileHash != null && expectedHash != null && info.fileHash !== expectedHash) {
        // The proof commits to DIFFERENT data. No upgrade can repair that.
        observation = {
          kind: "PROOF_INVALID",
          code: "PROOF_HASH_MISMATCH",
          reason: "The OpenTimestamps proof commits to a hash other than this record's.",
        };
      } else if (classification.kind === "FULLY_ANCHORED") {
        const verified = verify?.verified === true;
        observation = {
          kind: "ANCHOR_PROVEN",
          proofBase64,
          check: verified ? "BITCOIN_VERIFIED" : "PROOF_STRUCTURE",
          txid: classification.txid,
          // The block time only when the chain check reported it; never invented.
          blockTimeUtc:
            verified && classification.anchoredAtUtc ? new Date(classification.anchoredAtUtc) : null,
          blockHeight: classification.blockHeight,
        };
      } else if (classification.kind === "FAILED") {
        // A hard command error that is not an established proof defect: the
        // attempt failed, the proof did not.
        observation = { kind: "TRANSIENT_ERROR", reason: classification.reason };
      } else {
        observation = { kind: "PENDING", proofBase64, txid: classification.txid };
      }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  const observedAt = now();
  if (
    observation.kind === "PENDING" &&
    effectiveStatus !== "ANCHORED" &&
    isOtsGlobalBudgetExhausted({ firstAttemptAtUtc: evidence.createdAt, nowUtc: observedAt })
  ) {
    observation = { kind: "BUDGET_EXHAUSTED" };
  }

  const transition = decideOtsTransition(snapshot, observation, observedAt);

  if (transition.kind === "NO_CHANGE") {
    logger.info(
      {
        ...withJobContext({
          jobId: job.id,
          evidenceId,
          durationMs: Date.now() - startedAt,
          status: "no_change",
        }),
        reason: transition.reason,
      },
      "ots.upgrade.no_change"
    );
    return;
  }

  if (transition.kind === "RECORD_ATTEMPT_ERROR") {
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
        ...withJobContext({
          jobId: job.id,
          evidenceId,
          durationMs: Date.now() - startedAt,
          status: "attempt_failed",
        }),
        reason: transition.reason,
      },
      "ots.upgrade.attempt_failed"
    );
    throw new Error("OTS_UPGRADE_ATTEMPT_FAILED");
  }

  const applied = await prisma.$transaction(async (tx) => {
    const won = await applyOtsTransition(tx, evidenceId, snapshot, transition);
    if (!won || !transition.material) return won;
    await appendCustodyEventTx(tx, {
      evidenceId,
      eventType:
        transition.status === "FAILED"
          ? prismaPkg.CustodyEventType.OTS_FAILED
          : prismaPkg.CustodyEventType.OTS_APPLIED,
      atUtc: observedAt,
      payload: {
        otsStatus: transition.status,
        otsPhase: transition.phase,
        previousOtsStatus: evidence.otsStatus,
        anchorCheck: transition.data.otsAnchorCheck ?? null,
        bitcoinTxid: (transition.data.otsBitcoinTxid as string | null | undefined) ?? null,
        anchoredAtUtc:
          transition.data.otsAnchoredAtUtc instanceof Date
            ? transition.data.otsAnchoredAtUtc.toISOString()
            : null,
        observedAtUtc: observedAt.toISOString(),
        failureReason: (transition.data.otsFailureReason as string | null | undefined) ?? null,
        ...(transition.phase === "global_budget_exhausted"
          ? { budgetDays: readOtsGlobalBudgetDays() }
          : {}),
        ...forensic,
      } as Prisma.InputJsonValue,
    });
    return true;
  });

  if (!applied) {
    // The row moved on since it was read — a newer job or worker recorded
    // newer OTS facts. This older observation is discarded, not written.
    logger.info(
      withJobContext({
        jobId: job.id,
        evidenceId,
        durationMs: Date.now() - startedAt,
        status: "stale_observation_discarded",
      }),
      "ots.upgrade.stale"
    );
    return;
  }

  /*
   * NO REPORT IS RE-ISSUED BECAUSE A PROOF CHANGED (2026-09-29).
   *
   * An anchor that lands later is a LATER FACT, recorded above and shown by
   * Public Verify and the record as current proof state, while every issued
   * PDF keeps saying what it said. An updated report that documents it is an
   * explicit, authorized "Issue updated report" action — never a side effect.
   */

  if (transition.phase === "global_budget_exhausted") {
    logger.error(
      withJobContext({
        jobId: job.id,
        evidenceId,
        durationMs: Date.now() - startedAt,
        status: "global_budget_exhausted",
      }),
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
        title: `OTS anchoring gave up (${evidenceId.slice(0, 8)})`,
        safeSummary:
          "Global budget exhausted: the OpenTimestamps proof did not anchor on the public chain within the configured retry budget — no further attempts will be made.",
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
    // PHASE 12 — POINT 5. ONE job id per record's OTS upgrade
    // (`ots-upgrade-<evidenceId>`); `selfJobId` keeps this call from collapsing
    // onto the job that is running it, which would leave the record PENDING
    // with no future retry.
    await enqueueOtsUpgradeJob(evidenceId, {
      delayMs: 60 * 60 * 1000,
      traceId: "ots_followup",
      selfJobId: job.id,
    });
  }

  logger.info(
    withJobContext({
      jobId: job.id,
      evidenceId,
      durationMs: Date.now() - startedAt,
      status: transition.phase,
    }),
    transition.status === "ANCHORED"
      ? "ots.upgrade.anchored"
      : transition.status === "FAILED"
        ? "ots.upgrade.proof_invalid"
        : "ots.upgrade.pending"
  );
}
