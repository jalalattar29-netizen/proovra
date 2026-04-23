import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  parseOtsUpgradeOutput,
  shouldTreatOtsAsAnchored,
} from "./ots-upgrade-output.js";

const execFileAsync = promisify(execFile);

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function enabled(): boolean {
  return (process.env.OTS_ENABLED ?? "false").trim().toLowerCase() === "true";
}

export function resolveOtsBin(): string {
  return clean(process.env.OTS_BIN) ?? "ots";
}

export function resolveOtsTimeoutMs(): number {
  const raw = clean(process.env.OTS_TIMEOUT_MS);
  const parsed = raw ? Number.parseInt(raw, 10) : 30000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

function calendarUrl(): string | null {
  return clean(process.env.OTS_CALENDAR_URL);
}

async function mkWorkDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ots-"));
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (p) => {
      try {
        await fs.rm(p, { force: true, recursive: true });
      } catch {
        // ignore cleanup errors
      }
    })
  );
}

export type OtsStampResult =
  | {
      status: "DISABLED";
      proofBase64: null;
      hash: null;
      calendar: null;
      bitcoinTxid: null;
      anchoredAtUtc: null;
      upgradedAtUtc: null;
      failureReason: null;
    }
  | {
      status: "PENDING";
      proofBase64: string;
      hash: string;
      calendar: string | null;
      bitcoinTxid: null;
      anchoredAtUtc: null;
      upgradedAtUtc: string | null;
      pendingDetail: string | null;
    }
  | {
      status: "ANCHORED";
      proofBase64: string;
      hash: string;
      calendar: string | null;
      bitcoinTxid: string;
      anchoredAtUtc: string;
      upgradedAtUtc: string;
      failureReason: null;
    }
  | {
      status: "FAILED";
      proofBase64: string | null;
      hash: string | null;
      calendar: string | null;
      bitcoinTxid: null;
      anchoredAtUtc: null;
      upgradedAtUtc: null;
      failureReason: string;
    };

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "OTS_OPERATION_FAILED";

  return raw.replace(/\s+/g, " ").trim();
}

function isBinaryMissingMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("not found") &&
    (m.includes("ots") || m.includes("opentimestamps"))
  );
}

function isPendingLikeUpgradeMessage(message: string): boolean {
  const m = message.toLowerCase();

  return (
    m.includes("pending confirmations") ||
    m.includes("pending confirmation in bitcoin blockchain") ||
    m.includes("still waiting") ||
    m.includes("timestamp not complete") ||
    m.includes("not complete") ||
    m.includes("not yet anchored") ||
    m.includes("waiting for") ||
    m.includes("cannot be greater than available calendar") ||
    m.includes("available calendar")
  );
}

/**
 * Stamps real content bytes, not a text file containing a hex digest.
 */
export async function createOpenTimestamp(params: {
  content: Buffer;
  filenameStem?: string;
}): Promise<OtsStampResult> {
  if (!Buffer.isBuffer(params.content) || params.content.length === 0) {
    throw new Error("createOpenTimestamp: content must be a non-empty Buffer");
  }

  if (!enabled()) {
    return {
      status: "DISABLED",
      proofBase64: null,
      hash: null,
      calendar: null,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc: null,
      failureReason: null,
    };
  }

  const bin = resolveOtsBin();
  const calendar = calendarUrl();
  const workDir = await mkWorkDir();
  const stem =
    clean(params.filenameStem)?.replace(/[^a-zA-Z0-9._-]+/g, "_") ||
    "fingerprint";
  const inputFile = path.join(workDir, `${stem}.json`);
  const proofFile = `${inputFile}.ots`;
  const contentHash = sha256Hex(params.content);

  try {
    await fs.writeFile(inputFile, params.content);

const stampArgs = [
  "stamp",
  ...(calendar ? ["-c", calendar, "-m", "1"] : []),
  inputFile,
];

    await execFileAsync(bin, stampArgs, {
      timeout: resolveOtsTimeoutMs(),
      cwd: workDir,
    });

    const proofBuffer = await fs.readFile(proofFile);
    const proofBase64 = proofBuffer.toString("base64");

    let upgradedAtUtc: string | null = null;
    let anchoredAtUtc: string | null = null;
    let bitcoinTxid: string | null = null;

    try {
      const upgradeArgs = ["upgrade", proofFile];
      const { stdout, stderr } = await execFileAsync(bin, upgradeArgs, {
        timeout: resolveOtsTimeoutMs(),
        cwd: workDir,
      });

      const parsedUpgrade = parseOtsUpgradeOutput(stdout, stderr);
      upgradedAtUtc = nowIso();
      bitcoinTxid = parsedUpgrade.txid;

      const upgradedBuffer = await fs.readFile(proofFile);
      const upgradedProofBase64 = upgradedBuffer.toString("base64");

      if (shouldTreatOtsAsAnchored(parsedUpgrade) && bitcoinTxid) {
        anchoredAtUtc = upgradedAtUtc;

        return {
          status: "ANCHORED",
          proofBase64: upgradedProofBase64,
          hash: contentHash,
          calendar,
          bitcoinTxid,
          anchoredAtUtc,
          upgradedAtUtc,
          failureReason: null,
        };
      }

        return {
          status: "PENDING",
          proofBase64: upgradedProofBase64,
          hash: contentHash,
          calendar,
          bitcoinTxid: null,
          anchoredAtUtc: null,
          upgradedAtUtc,
          pendingDetail: "OTS proof created but not yet anchored on Bitcoin.",
        };
    } catch (upgradeError) {
      const message = normalizeErrorMessage(upgradeError);

      try {
        const latestProofBuffer = await fs.readFile(proofFile);
        const latestProofBase64 = latestProofBuffer.toString("base64");

        if (isPendingLikeUpgradeMessage(message)) {
          return {
            status: "PENDING",
            proofBase64: latestProofBase64,
            hash: contentHash,
            calendar,
            bitcoinTxid: null,
            anchoredAtUtc: null,
            upgradedAtUtc: null,
            pendingDetail: message,
          };
        }

        return {
          status: "FAILED",
          proofBase64: latestProofBase64,
          hash: contentHash,
          calendar,
          bitcoinTxid: null,
          anchoredAtUtc: null,
          upgradedAtUtc: null,
          failureReason: message,
        };
      } catch {
        if (isPendingLikeUpgradeMessage(message)) {
          return {
            status: "PENDING",
            proofBase64,
            hash: contentHash,
            calendar,
            bitcoinTxid: null,
            anchoredAtUtc: null,
            upgradedAtUtc: null,
            pendingDetail: message,
          };
        }

        return {
          status: "FAILED",
          proofBase64,
          hash: contentHash,
          calendar,
          bitcoinTxid: null,
          anchoredAtUtc: null,
          upgradedAtUtc: null,
          failureReason: message,
        };
      }
    }
  } catch (error) {
    const message = normalizeErrorMessage(error);

    if (isBinaryMissingMessage(message)) {
      return {
        status: "FAILED",
        proofBase64: null,
        hash: contentHash,
        calendar,
        bitcoinTxid: null,
        anchoredAtUtc: null,
        upgradedAtUtc: null,
        failureReason:
          "OpenTimestamps binary is missing in the worker environment.",
      };
    }

    return {
      status: "FAILED",
      proofBase64: null,
      hash: contentHash,
      calendar,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc: null,
      failureReason: message,
    };
  } finally {
    await cleanup([workDir]);
  }
}
