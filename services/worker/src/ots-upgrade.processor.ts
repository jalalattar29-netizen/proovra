import { Job } from "bullmq";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { appendCustodyEventTx } from "./custody-events.js";
import { prisma } from "./db.js";
import { enqueueReportJob } from "./processor.js";

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
  return lower.includes("success! timestamp complete");
}

function isPendingOutput(text: string): boolean {
  const lower = text.toLowerCase();

  return (
    lower.includes("pending confirmation in bitcoin blockchain") ||
    lower.includes("waiting for 6 confirmations") ||
    lower.includes("timestamp not complete")
  );
}

export async function processOtsUpgrade(job: Job<{ evidenceId: string }>) {
  const { evidenceId } = job.data;

  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      otsProofBase64: true,
      otsStatus: true,
    },
  });

  if (!evidence || !evidence.otsProofBase64) return;
  if (evidence.otsStatus === "ANCHORED") return;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ots-upgrade-"));
  const file = path.join(workDir, "proof.ots");

  try {
    await fs.writeFile(file, Buffer.from(evidence.otsProofBase64, "base64"));

    let stdout = "";
    let stderr = "";

    try {
      const result = await execFileAsync("ots", ["upgrade", file]);
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

    if (isAnchoredOutput(merged)) {
      await prisma.$transaction(async (tx) => {
        await tx.evidence.update({
          where: { id: evidenceId },
          data: {
            otsProofBase64: updated.toString("base64"),
            otsStatus: "ANCHORED",
            otsBitcoinTxid: txid,
            otsAnchoredAtUtc: upgradedAt,
            otsUpgradedAtUtc: upgradedAt,
            otsFailureReason: null,
          },
        });

        await appendCustodyEventTx(tx, {
          evidenceId,
          eventType: prismaPkg.CustodyEventType.OTS_APPLIED,
          atUtc: upgradedAt,
          payload: {
            otsStatus: "ANCHORED",
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

      return;
    }

    if (isPendingOutput(merged)) {
      await prisma.evidence.update({
        where: { id: evidenceId },
        data: {
          otsProofBase64: updated.toString("base64"),
          otsStatus: "PENDING",
          otsBitcoinTxid: txid,
          otsUpgradedAtUtc: upgradedAt,
          otsFailureReason: null,
        },
      });

      throw new Error("NOT_ANCHORED_YET");
    }

    await prisma.$transaction(async (tx) => {
      await tx.evidence.update({
        where: { id: evidenceId },
        data: {
          otsProofBase64: updated.toString("base64"),
          otsStatus: "FAILED",
          otsBitcoinTxid: txid,
          otsUpgradedAtUtc: upgradedAt,
          otsFailureReason: merged || "OTS upgrade failed",
        },
      });

      await appendCustodyEventTx(tx, {
        evidenceId,
        eventType: prismaPkg.CustodyEventType.OTS_FAILED,
        atUtc: upgradedAt,
        payload: {
          failureReason: merged || "OTS upgrade failed",
        } as Prisma.InputJsonValue,
      });
    });

    throw new Error("OTS_UPGRADE_FAILED");
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
