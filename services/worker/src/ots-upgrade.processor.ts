import { Job } from "bullmq";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveEffectiveOtsStatus } from "@proovra/shared";
import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { appendCustodyEventTx } from "./custody-events.js";
import { prisma } from "./db.js";
import { enqueueOtsUpgradeJob } from "./queue.js";
import { resolveOtsBin, resolveOtsTimeoutMs } from "./ots.service.js";
import { buildOtsEvidenceUpdateData } from "./ots-state.js";
import { enqueueReportJob } from "./processor.js";
import { logger, withJobContext } from "./logger.js";

const execFileAsync = promisify(execFile);

function parseTxid(text: string): string | null {
  const txidMatch = text.match(/\b[a-f0-9]{64}\b/i);
  return txidMatch?.[0]?.toLowerCase() ?? null;
}

function now(): Date {
  return new Date();
}

function normalizeOutput(stdout?: string, stderr?: string): string {
  return `${stdout ?? ""}\n${stderr ?? ""}`.trim();
}

function isAnchoredOutput(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("success! timestamp complete") ||
    lower.includes("timestamp complete") ||
    lower.includes("bitcoin transaction")
  );
}

function isPendingOutput(text: string): boolean {
  const lower = text.toLowerCase();

  return (
    lower.includes("pending confirmation in bitcoin blockchain") ||
    lower.includes("pending confirmations") ||
    lower.includes("still waiting") ||
    lower.includes("waiting for 6 confirmations") ||
    lower.includes("timestamp not complete") ||
    lower.includes("not yet anchored") ||
    lower.includes("available calendar")
  );
}

function buildFollowUpJobId(evidenceId: string, upgradedAt: Date): string {
  return `ots-upgrade-${evidenceId}-${upgradedAt.getTime()}`;
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
  if (
    resolveEffectiveOtsStatus({
      status: evidence.otsStatus,
      bitcoinTxid: evidence.otsBitcoinTxid,
      anchoredAtUtc: evidence.otsAnchoredAtUtc,
    }) === "ANCHORED"
  ) {
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

    try {
      const result = await execFileAsync(resolveOtsBin(), ["upgrade", file], {
        timeout: resolveOtsTimeoutMs(),
        cwd: workDir,
      });
      stdout = result.stdout ?? "";
      stderr = result.stderr ?? "";
    } catch (error) {
      const err = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      stdout = err.stdout ?? "";
      stderr = err.stderr ?? err.message ?? "";
    }

    const merged = normalizeOutput(stdout, stderr);
    const txid = parseTxid(merged);
    const updated = await fs.readFile(file);
    const upgradedAt = now();

    if (txid && isAnchoredOutput(merged)) {
      await prisma.$transaction(async (tx) => {
        await tx.evidence.update({
          where: { id: evidenceId },
          data: buildOtsEvidenceUpdateData({
            status: "ANCHORED",
            proofBase64: updated.toString("base64"),
            hash: evidence.otsHash,
            calendar: evidence.otsCalendar,
            bitcoinTxid: txid,
            anchoredAtUtc: upgradedAt,
            upgradedAtUtc: upgradedAt,
          }),
        });

        await appendCustodyEventTx(tx, {
          evidenceId,
          eventType: prismaPkg.CustodyEventType.OTS_APPLIED,
          atUtc: upgradedAt,
          payload: {
            otsStatus: "ANCHORED",
            otsPhase: "anchored",
            bitcoinTxid: txid,
            upgradedAtUtc: upgradedAt.toISOString(),
            anchoredAtUtc: upgradedAt.toISOString(),
            completionSource: "ots_upgrade",
          } as Prisma.InputJsonValue,
        });
      });

      await enqueueReportJob(evidenceId, {
        forceRegenerate: true,
        regenerateReason: "ots_anchored",
      });

      logger.info(
        withJobContext({
          jobId: job.id,
          evidenceId,
          durationMs: Date.now() - startedAt,
          status: "anchored",
        }),
        "ots.upgrade.anchored"
      );

      return;
    }

    if (isPendingOutput(merged)) {
      await prisma.evidence.update({
        where: { id: evidenceId },
        data: buildOtsEvidenceUpdateData({
          status: "PENDING",
          proofBase64: updated.toString("base64"),
          hash: evidence.otsHash,
          calendar: evidence.otsCalendar,
          upgradedAtUtc: upgradedAt,
        }),
      });

      await enqueueOtsUpgradeJob(evidenceId, {
        delayMs: 6 * 60 * 60 * 1000,
        jobId: buildFollowUpJobId(evidenceId, upgradedAt),
        excludeJobId: job.id,
      });

      logger.info(
        withJobContext({
          jobId: job.id,
          evidenceId,
          durationMs: Date.now() - startedAt,
          status: "pending_rescheduled",
        }),
        "ots.upgrade.pending"
      );

      return;
    }

    await prisma.$transaction(async (tx) => {
      const failureReason =
        isAnchoredOutput(merged) && !txid
          ? "OTS upgrade reported completion but no Bitcoin transaction id was detected."
          : merged || "OTS upgrade failed";

      await tx.evidence.update({
        where: { id: evidenceId },
        data: buildOtsEvidenceUpdateData({
          status: "FAILED",
          proofBase64: updated.toString("base64"),
          hash: evidence.otsHash,
          calendar: evidence.otsCalendar,
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
