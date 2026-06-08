import { Job } from "bullmq";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isValidOtsBitcoinTxid, resolveEffectiveOtsStatus } from "@proovra/shared";
import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { appendCustodyEventTx } from "./custody-events.js";
import { recordWorkerIncident } from "./governance/incident-emitter.js";
import { prisma } from "./db.js";
import { enqueueOtsUpgradeJob } from "./queue.js";
import { resolveOtsBin, resolveOtsTimeoutMs, verifyOtsProof } from "./ots.service.js";
import { buildOtsEvidenceUpdateData } from "./ots-state.js";
import { enqueueReportJob } from "./processor.js";
import { logger, withJobContext } from "./logger.js";
import {
  classifyOtsResult,
  parseOtsUpgradeOutput,
  shouldTreatOtsAsAnchored,
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
//   3. **Stuck detection.** When the per-evidence attempt counter
//      reaches a soft ceiling (10) the processor still re-enqueues
//      but the next status read returns `stuck: true` so the queue
//      operations UI can highlight it without waiting for the 30-day
//      hard stop.

export const OTS_FOLLOWUP_JOB_PREFIX = "ots-upgrade-followup-";

/**
 * Stable jobId so BullMQ's `attempts` ceiling is enforced across
 * re-enqueues. The previous timestamp-bearing id reset the counter.
 */
export function buildFollowUpJobId(evidenceId: string): string {
  return `${OTS_FOLLOWUP_JOB_PREFIX}${evidenceId}`;
}

const OTS_GLOBAL_BUDGET_DAYS_DEFAULT = 30;
const OTS_STUCK_ATTEMPT_THRESHOLD_DEFAULT = 10;

function readOtsGlobalBudgetDays(): number {
  const raw = process.env.OTS_GLOBAL_BUDGET_DAYS;
  if (!raw) return OTS_GLOBAL_BUDGET_DAYS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : OTS_GLOBAL_BUDGET_DAYS_DEFAULT;
}

function readOtsStuckThreshold(): number {
  const raw = process.env.OTS_STUCK_ATTEMPT_THRESHOLD;
  if (!raw) return OTS_STUCK_ATTEMPT_THRESHOLD_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0
    ? n
    : OTS_STUCK_ATTEMPT_THRESHOLD_DEFAULT;
}

/**
 * Returns the upper bound for re-enqueue attempts before the global
 * budget gives up. Exported so callers (operations queue UI) can
 * surface the same number in the "stuck OTS" label.
 */
export function getOtsGlobalBudgetMs(): number {
  return readOtsGlobalBudgetDays() * 24 * 60 * 60 * 1000;
}

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
export function isOtsGlobalBudgetExhausted(params: {
  firstAttemptAtUtc: Date | null;
  nowUtc: Date;
  budgetMs?: number;
}): boolean {
  if (!params.firstAttemptAtUtc) return false;
  const budget = params.budgetMs ?? getOtsGlobalBudgetMs();
  return (
    params.nowUtc.getTime() - params.firstAttemptAtUtc.getTime() > budget
  );
}

export async function processOtsUpgrade(job: Job<{ evidenceId: string }>) {
  const { evidenceId } = job.data;
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
    },
  });

  if (!evidence || !evidence.otsProofBase64) {
    logger.warn(
      withJobContext({
        jobId: job.id,
        evidenceId,
        durationMs: Date.now() - startedAt,
        status: "skipped_missing_proof",
      }),
      "ots.upgrade.skipped"
    );
    return;
  }

  const effectiveStatus = resolveEffectiveOtsStatus({
    status: evidence.otsStatus,
    bitcoinTxid: evidence.otsBitcoinTxid,
    anchoredAtUtc: evidence.otsAnchoredAtUtc,
  });
  const hasDefensibleTxid = isValidOtsBitcoinTxid(evidence.otsBitcoinTxid);

  if (effectiveStatus === "ANCHORED" && hasDefensibleTxid) {
    logger.info(
      withJobContext({
        jobId: job.id,
        evidenceId,
        durationMs: Date.now() - startedAt,
        status: "already_anchored",
      }),
      "ots.upgrade.skipped"
    );
    return;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ots-upgrade-"));
  const file = path.join(workDir, "proof.ots");

  try {
    await fs.writeFile(file, Buffer.from(evidence.otsProofBase64, "base64"));

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
      const err = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      stdout = err.stdout ?? "";
      stderr = err.stderr ?? err.message ?? "";
    }

    const parsedUpgrade = parseOtsUpgradeOutput(stdout, stderr);
    const { raw: merged, txid, anchoredOutput, pendingOutput } = parsedUpgrade;
    const updated = await fs.readFile(file);
    const upgradedAt = now();
    const proofBase64 = updated.toString("base64");

    // Phase IA-OTS-hybrid — run `ots verify` against the freshly-upgraded
    // proof. `ots upgrade`'s text output cannot reliably distinguish a
    // fully-anchored proof from one that has a Bitcoin txid but still
    // needs more block confirmations — both emit "Bitcoin transaction"
    // lines. `ots verify` IS deterministic: it emits a
    // "Success! Bitcoin block N attests" line on a complete anchor and
    // "Calendar attestation incomplete" / "Got 0 attestation(s)" on a
    // partial one. We use the verify result as the authoritative signal
    // in the classifier; the legacy heuristic is the documented fallback
    // when verify isn't possible (e.g., missing hash).
    const verifyResult = await verifyOtsProof({
      proofBase64,
      hashHex: evidence.otsHash ?? null,
    });
    const verify =
      verifyResult.status === "VERIFIED" || verifyResult.status === "INCOMPLETE"
        ? verifyResult.verify
        : null;
    const classification: OtsClassification = classifyOtsResult({
      upgrade: parsedUpgrade,
      verify,
      existingTxid: evidence.otsBitcoinTxid,
      commandErrored,
      mergedErrorText: merged,
    });

    // Legal boundary: the OTS proof can be preserved in an anchored state even
    // before a Bitcoin txid or other public receipt is available. The shared
    // trust engine still requires defensible public anchor material before it
    // awards a full 10/10 public-anchoring signal.
// Phase IA-OTS-hybrid — promotion to ANCHORED is now gated on
    // `classification.kind === "FULLY_ANCHORED"`, which requires
    // `ots verify` to succeed (preferred) OR the legacy heuristic to be
    // unambiguous (fallback when verify couldn't run). This eliminates
    // the previous failure mode where a Bitcoin-attested-but-still-
    // pending-confirmations proof was marked PENDING with a recovered
    // txid forever, with no clear path to ANCHORED. Now the classifier
    // returns ANCHOR_MATERIAL_RECOVERED for that case (handled below)
    // and FULLY_ANCHORED only when verify confirms the block.
    if (classification.kind === "FULLY_ANCHORED") {
        const txidRecovered = !hasDefensibleTxid && Boolean(classification.txid);
        // Prefer the verify-extracted anchor time when available; the
        // `existence as of <date>` line is the canonical anchoring
        // timestamp (the time the Bitcoin block was mined). Otherwise
        // fall back to the upgrade clock — never invent.
        const anchoredAtUtc = classification.anchoredAtUtc
          ? new Date(classification.anchoredAtUtc)
          : upgradedAt;
        await prisma.$transaction(async (tx) => {
        await tx.evidence.update({
          where: { id: evidenceId },
          data: buildOtsEvidenceUpdateData({
            status: "ANCHORED",
            proofBase64,
            hash: evidence.otsHash,
            calendar: evidence.otsCalendar,
            bitcoinTxid: classification.txid,
            existingBitcoinTxid: evidence.otsBitcoinTxid,
            anchoredAtUtc,
            upgradedAtUtc: upgradedAt,
          }),
        });

        await appendCustodyEventTx(tx, {
          evidenceId,
          eventType: prismaPkg.CustodyEventType.OTS_APPLIED,
          atUtc: upgradedAt,
          payload: {
            otsStatus: "ANCHORED",
            otsPhase: txidRecovered
              ? "anchor_material_recovered"
              : "anchored",
            bitcoinTxid: classification.txid ?? evidence.otsBitcoinTxid ?? null,
            blockHeight: classification.blockHeight,
            verifyConfirmed: verify !== null,
            verifyStatus: verifyResult.status,
            upgradedAtUtc: upgradedAt.toISOString(),
            anchoredAtUtc: anchoredAtUtc.toISOString(),
            completionSource:
              verify !== null ? "ots_verify" : "ots_upgrade_heuristic",
            classifierReason: classification.reason,
          } as Prisma.InputJsonValue,
        });
      });

      await enqueueReportJob(evidenceId, {
        forceRegenerate: true,
        regenerateReason: "ots_anchored",
      });

      logger.info(
        {
          ...withJobContext({
            jobId: job.id,
            evidenceId,
            durationMs: Date.now() - startedAt,
            status: "anchored",
          }),
          // Phase IA-OTS-hybrid — operator forensic context outside the
          // canonical jobContext schema. `blockHeight` + `verifyStatus`
          // let log queries split "verify-confirmed" anchors from
          // legacy-heuristic anchors at a glance.
          blockHeight: classification.blockHeight,
          verifyStatus: verifyResult.status,
        },
        "ots.upgrade.anchored"
      );

      return;
    }

    // Phase IA-OTS-hybrid — both ANCHOR_MATERIAL_RECOVERED (txid
    // recovered but still pending block confirmations) and STILL_PENDING
    // (no txid yet) flow through the same persistence branch. The
    // classifier already disambiguated; we just pass through to keep
    // the existing transaction shape. The legacy `pendingOutput ||
    // !commandErrored` guard is preserved as the OR so callers without
    // a classifier (e.g., legacy paths) still reach this branch.
    if (
      classification.kind === "ANCHOR_MATERIAL_RECOVERED" ||
      classification.kind === "STILL_PENDING" ||
      pendingOutput ||
      !commandErrored
    ) {
        const shouldPreserveAnchoredState =
      effectiveStatus === "ANCHORED" && !hasDefensibleTxid;
    const txidRecoveredWhileAnchored =
      shouldPreserveAnchoredState && Boolean(txid);
        const pendingReason =
        anchoredOutput && !txid
          ? "OTS upgrade returned completion-like output but no Bitcoin transaction id was detected yet."
          : txid
            ? "OTS upgrade detected a Bitcoin transaction id, but the output still indicates the proof is pending blockchain anchoring."
          : pendingOutput
            ? "OTS upgrade is still pending blockchain anchoring."
            : "OTS proof was refreshed but anchoring is not yet complete.";

      await prisma.$transaction(async (tx) => {
        await tx.evidence.update({
          where: { id: evidenceId },
          data: buildOtsEvidenceUpdateData({
            status: shouldPreserveAnchoredState ? "ANCHORED" : "PENDING",
            proofBase64,
            hash: evidence.otsHash,
            calendar: evidence.otsCalendar,
            bitcoinTxid: txid,
            existingBitcoinTxid: evidence.otsBitcoinTxid,
            anchoredAtUtc: shouldPreserveAnchoredState
              ? evidence.otsAnchoredAtUtc ?? upgradedAt
              : null,
            upgradedAtUtc: upgradedAt,
          }),
        });

        if (!shouldPreserveAnchoredState || txid) {
          await appendCustodyEventTx(tx, {
            evidenceId,
            eventType: prismaPkg.CustodyEventType.OTS_APPLIED,
            atUtc: upgradedAt,
            payload: {
              otsStatus: shouldPreserveAnchoredState ? "ANCHORED" : "PENDING",
              otsPhase: shouldPreserveAnchoredState
                ? txid
                  ? "anchor_material_recovered"
                  : "anchored_no_public_receipt"
                : anchoredOutput && !txid
                  ? "awaiting_txid"
                  : txid
                    ? "txid_detected_pending_confirmation"
                    : pendingOutput
                      ? "pending_confirmation"
                      : "proof_refreshed_pending",
              bitcoinTxid: txid ?? evidence.otsBitcoinTxid ?? null,
              upgradedAtUtc: upgradedAt.toISOString(),
              completionSource: "ots_upgrade",
              note: pendingReason,
              // Phase IA-OTS-hybrid — record what `ots verify` said so
              // the operator can see, per attempt, whether the verify
              // step ran, whether it confirmed the anchor, and which
              // classification the deterministic classifier produced.
              // This is the audit trail that lets ops distinguish a
              // legitimate ANCHOR_MATERIAL_RECOVERED from a regression.
              verifyStatus: verifyResult.status,
              classification: classification.kind,
              classifierPhase: classification.phase,
              classifierReason: classification.reason,
            } as Prisma.InputJsonValue,
          });
        }
      });

      if (txidRecoveredWhileAnchored) {
        await enqueueReportJob(evidenceId, {
          forceRegenerate: true,
          regenerateReason: "ots_anchor_material_recovered",
        });
      } else {
        // Phase Final-Worker-Visibility — global attempt budget. The
        // budget window is anchored on the evidence row's
        // `createdAt` so a permanently broken OTS proof is bounded
        // even if `otsAnchoredAtUtc` is null (never anchored). The
        // typical lifecycle is: evidence created → OTS proof stored
        // within seconds → upgrade attempts start within ~1h.
        const firstAttemptAtUtc = evidence.createdAt;
        if (
          isOtsGlobalBudgetExhausted({
            firstAttemptAtUtc,
            nowUtc: upgradedAt,
          })
        ) {
          // Budget exhausted — stop re-enqueueing. Mark the row
          // FAILED with the dedicated reason so operators see a
          // distinct "OTS gave up" signal vs an active processing
          // failure.
          await prisma.$transaction(async (tx) => {
            await tx.evidence.update({
              where: { id: evidenceId },
              data: buildOtsEvidenceUpdateData({
                status: "FAILED",
                proofBase64,
                hash: evidence.otsHash,
                calendar: evidence.otsCalendar,
                existingBitcoinTxid: evidence.otsBitcoinTxid,
                upgradedAtUtc: upgradedAt,
                failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED",
              }),
            });
            await appendCustodyEventTx(tx, {
              evidenceId,
              eventType: prismaPkg.CustodyEventType.OTS_FAILED,
              atUtc: upgradedAt,
              payload: {
                otsStatus: "FAILED",
                otsPhase: "global_budget_exhausted",
                failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED",
                budgetDays: readOtsGlobalBudgetDays(),
              } as Prisma.InputJsonValue,
            });
          });
          logger.error(
            withJobContext({
              jobId: job.id,
              evidenceId,
              durationMs: Date.now() - startedAt,
              status: "global_budget_exhausted",
            }),
            "ots.upgrade.budget_exhausted",
          );
          // Phase IA-reliability — bridge into OperationalIncident.
          // Global budget exhaustion is TERMINAL: the proof will never
          // anchor on the public chain, and no further upgrade attempts
          // will be made. CRITICAL severity so /v1/me/inbox lifts this
          // to P1.
          try {
            await recordWorkerIncident({
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
            logger.warn(
              { err, evidenceId },
              "worker.ots.incident_bridge_failed",
            );
          }
          return;
        }

        // Stable jobId — see comment block on `buildFollowUpJobId`.
        await enqueueOtsUpgradeJob(evidenceId, {
          delayMs: 60 * 60 * 1000,
          jobId: buildFollowUpJobId(evidenceId),
          excludeJobId: job.id,
        });
      }

      logger.info(
        withJobContext({
          jobId: job.id,
          evidenceId,
          durationMs: Date.now() - startedAt,
          status: txidRecoveredWhileAnchored
            ? "anchor_material_recovered"
            : "pending_rescheduled",
        }),
        "ots.upgrade.pending"
      );

      return;
    }

    const failureReason = merged || "OTS upgrade failed";

    await prisma.$transaction(async (tx) => {
      await tx.evidence.update({
        where: { id: evidenceId },
        data: buildOtsEvidenceUpdateData({
          status: "FAILED",
          proofBase64,
          hash: evidence.otsHash,
          calendar: evidence.otsCalendar,
          existingBitcoinTxid: evidence.otsBitcoinTxid,
          upgradedAtUtc: upgradedAt,
          failureReason,
        }),
      });

      await appendCustodyEventTx(tx, {
        evidenceId,
        eventType: prismaPkg.CustodyEventType.OTS_FAILED,
        atUtc: upgradedAt,
        payload: {
          otsStatus: "FAILED",
          otsPhase: "upgrade_failed",
          failureReason,
        } as Prisma.InputJsonValue,
      });
    });

    logger.error(
      withJobContext({
        jobId: job.id,
        evidenceId,
        durationMs: Date.now() - startedAt,
        status: "failed",
      }),
      "ots.upgrade.failed"
    );

    throw new Error("OTS_UPGRADE_FAILED");
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
