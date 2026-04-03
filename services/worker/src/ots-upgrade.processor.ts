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
import { enqueueReportJob } from "./queue.js";

const execFileAsync = promisify(execFile);

function parseTxid(text: string): string | null {
  const txidMatch = text.match(/\b[a-f0-9]{64}\b/i);
  return txidMatch?.[0]?.toLowerCase() ?? null;
}

function now(): Date {
  return new Date();
}

export async function processOtsUpgrade(job: Job<{ evidenceId: string }>) {
  const { evidenceId } = job.data;

  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      otsProofBase64: true,
      otsStatus: true,
      otsAnchoredAtUtc: true,
      reportGeneratedAtUtc: true,
    },
  });

  if (!evidence || !evidence.otsProofBase64) return;

  const reportIsOlderThanAnchor =
    evidence.otsAnchoredAtUtc != null &&
    (evidence.reportGeneratedAtUtc == null ||
      evidence.reportGeneratedAtUtc.getTime() <
        evidence.otsAnchoredAtUtc.getTime());

  if (evidence.otsStatus === "ANCHORED") {
    if (reportIsOlderThanAnchor) {
      await enqueueReportJob(evidenceId, {
        forceRegenerate: true,
        regenerateReason: "ots_anchored",
      });
    }
    return;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ots-upgrade-"));
  const file = path.join(workDir, "proof.ots");

  try {
    await fs.writeFile(file, Buffer.from(evidence.otsProofBase64, "base64"));

    const { stdout, stderr } = await execFileAsync("ots", ["upgrade", file]);
    const merged = `${stdout ?? ""}\n${stderr ?? ""}`;
    const txid = parseTxid(merged);

    const updated = await fs.readFile(file);
    const upgradedAt = now();

    if (!txid) {
      await prisma.evidence.update({
        where: { id: evidenceId },
        data: {
          otsProofBase64: updated.toString("base64"),
          otsStatus: "PENDING",
          otsUpgradedAtUtc: upgradedAt,
          otsFailureReason: merged.trim() || "OTS upgrade pending",
        },
      });

      throw new Error("NOT_ANCHORED_YET");
    }

    await prisma.$transaction(async (tx) => {
      await tx.evidence.update({
        where: { id: evidenceId },
        data: {
          otsProofBase64: updated.toString("base64"),
          otsBitcoinTxid: txid,
          otsStatus: "ANCHORED",
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
        } as Prisma.InputJsonValue,
      });
    });

    await enqueueReportJob(evidenceId, {
      forceRegenerate: true,
      regenerateReason: "ots_anchored",
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}