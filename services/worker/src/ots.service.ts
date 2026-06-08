import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  parseOtsUpgradeOutput,
  parseOtsVerifyOutput,
  shouldTreatOtsAsAnchored,
  type OtsVerifyOutput,
} from "./ots-upgrade-output.js";
// Phase O1.5B — bounded OTS spans. Attributes carry calendar URL,
// status, and bitcoinTxid presence (boolean). NEVER the proof bytes,
// content bytes, or calendar credentials.
import { PROOVRA_SPAN_NAMES, withProovraSpan } from "./otel.js";

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
      bitcoinTxid: string | null;
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

  // Phase O1.5B — bounded OTS anchor span. Calendar URL is OK (no
  // creds), size only as a bounded number. NEVER content bytes.
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.OTS_ANCHOR,
    {
      "proovra.operation": "ots_anchor",
      "proovra.size_bytes": params.content.length,
    },
    () => createOpenTimestampInner(params),
  );
}

async function createOpenTimestampInner(params: {
  content: Buffer;
  filenameStem?: string;
}): Promise<OtsStampResult> {
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
      // Phase O1.5B — bounded OTS upgrade span. NEVER the proof bytes.
      const { stdout, stderr } = await withProovraSpan(
        PROOVRA_SPAN_NAMES.OTS_UPGRADE,
        { "proovra.operation": "ots_upgrade" },
        async () => {
          const upgradeArgs = ["upgrade", proofFile];
          return execFileAsync(bin, upgradeArgs, {
            timeout: resolveOtsTimeoutMs(),
            cwd: workDir,
          });
        },
      );

      const parsedUpgrade = parseOtsUpgradeOutput(stdout, stderr);
      upgradedAtUtc = nowIso();
      bitcoinTxid = parsedUpgrade.txid;

      const upgradedBuffer = await fs.readFile(proofFile);
      const upgradedProofBase64 = upgradedBuffer.toString("base64");

      // Phase O1.5B — bounded OTS verify + integrity.public_anchor.verify.
      // We treat `shouldTreatOtsAsAnchored` as the verify-step gate.
      const anchored = await withProovraSpan(
        PROOVRA_SPAN_NAMES.OTS_VERIFY,
        {
          "proovra.operation": "ots_verify",
          "proovra.outcome": shouldTreatOtsAsAnchored(parsedUpgrade)
            ? "anchored"
            : "pending",
        },
        async () => {
          const ok = shouldTreatOtsAsAnchored(parsedUpgrade);
          await withProovraSpan(
            PROOVRA_SPAN_NAMES.INTEGRITY_PUBLIC_ANCHOR_VERIFY,
            {
              "proovra.operation": "integrity_public_anchor_verify",
              "proovra.outcome": ok ? "verified" : "pending",
            },
            () => undefined,
          );
          return ok;
        },
      );

      // Legal boundary: an OTS proof can reach an anchored state before we have
      // a defensible public receipt such as a Bitcoin txid. We preserve the
      // anchored proof state here, but downstream trust scoring only awards full
      // public-anchoring credit when additional public anchor material exists.
      if (anchored) {
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

// ===========================================================================
// Phase IA-OTS-hybrid — `ots verify` wrapper.
//
// This is the canonical "is this proof actually anchored?" check. It is
// called by the OTS upgrade processor AFTER `ots upgrade` runs so the
// processor can deterministically distinguish:
//
//   * FULLY_ANCHORED — verify succeeds with a Bitcoin block height
//   * ANCHOR_MATERIAL_RECOVERED — upgrade extracted a txid but verify
//     still says incomplete (calendar attestation pending)
//   * STILL_PENDING — no txid, no anchored signal
//
// We invoke verify with the `-d <hash>` flag so the original content
// file is NOT required (we don't have it in the worker; we only have
// the proof bytes + the canonical SHA-256 hash on the Evidence row).
//
// Hard rules:
//   * NEVER throws — verify failures are always returned as a structured
//     object so the caller can act on them. The processor must not crash
//     because a verify step couldn't run.
//   * NEVER persists. This is read-only and stateless.
//   * Bounded timeout via `resolveOtsTimeoutMs()` — same budget as the
//     stamp / upgrade calls so a hostile calendar cannot stall the
//     worker indefinitely.
// ===========================================================================

export type VerifyOtsProofInput = {
  /** Base64-encoded proof bytes from `Evidence.otsProofBase64`. */
  proofBase64: string;
  /** Canonical SHA-256 hex digest from `Evidence.otsHash`. */
  hashHex: string | null;
};

export type VerifyOtsProofResult =
  | {
      status: "DISABLED";
      verify: null;
      binaryMissing: false;
      error: null;
    }
  | {
      status: "VERIFIED";
      verify: OtsVerifyOutput;
      binaryMissing: false;
      error: null;
    }
  | {
      status: "INCOMPLETE";
      verify: OtsVerifyOutput;
      binaryMissing: false;
      error: null;
    }
  | {
      status: "BINARY_MISSING";
      verify: null;
      binaryMissing: true;
      error: string;
    }
  | {
      status: "ERROR";
      verify: OtsVerifyOutput | null;
      binaryMissing: false;
      error: string;
    };

export async function verifyOtsProof(
  input: VerifyOtsProofInput,
): Promise<VerifyOtsProofResult> {
  if (!enabled()) {
    return { status: "DISABLED", verify: null, binaryMissing: false, error: null };
  }
  const proofBase64 = clean(input.proofBase64);
  if (!proofBase64) {
    return {
      status: "ERROR",
      verify: null,
      binaryMissing: false,
      error: "verifyOtsProof called with an empty proofBase64.",
    };
  }
  const hashHex = clean(input.hashHex);
  // The hash is REQUIRED for the `-d` flag form. If we don't have one,
  // we cannot verify without the original file (which the worker
  // doesn't keep). Surface this as ERROR so the caller falls back to
  // the legacy heuristic rather than silently claiming anchored.
  if (!hashHex || !/^[a-f0-9]{64}$/i.test(hashHex)) {
    return {
      status: "ERROR",
      verify: null,
      binaryMissing: false,
      error: "verifyOtsProof requires a 64-hex SHA-256 hash on Evidence.otsHash.",
    };
  }

  const workDir = await mkWorkDir();
  const proofFile = path.join(workDir, "proof.ots");
  try {
    await fs.writeFile(proofFile, Buffer.from(proofBase64, "base64"));
    let stdout = "";
    let stderr = "";
    let commandErrored = false;
    try {
      const result = await execFileAsync(
        resolveOtsBin(),
        ["verify", "-d", hashHex.toLowerCase(), proofFile],
        { timeout: resolveOtsTimeoutMs() },
      );
      stdout = result.stdout?.toString() ?? "";
      stderr = result.stderr?.toString() ?? "";
    } catch (error) {
      // The OTS client typically exits non-zero on partial / pending
      // proofs and also when the binary is missing. We capture stdout
      // + stderr from the error envelope so the parser sees the same
      // text we'd see on a successful invocation.
      const e = error as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };
      stdout = (e.stdout ?? "").toString();
      stderr = (e.stderr ?? e.message ?? "").toString();
      commandErrored = true;
    }

    const merged = `${stdout}\n${stderr}`;
    if (isBinaryMissingMessage(merged)) {
      return {
        status: "BINARY_MISSING",
        verify: null,
        binaryMissing: true,
        error:
          "OpenTimestamps binary is missing in the worker environment.",
      };
    }

    const parsed = parseOtsVerifyOutput(stdout, stderr);
    if (parsed.verified) {
      return {
        status: "VERIFIED",
        verify: parsed,
        binaryMissing: false,
        error: null,
      };
    }
    if (parsed.incompleteOutput) {
      return {
        status: "INCOMPLETE",
        verify: parsed,
        binaryMissing: false,
        error: null,
      };
    }
    // Defensive: a non-success, non-incomplete, non-binary-missing
    // command-error is reported as ERROR so the caller can fall back
    // to the legacy heuristic.
    if (commandErrored) {
      return {
        status: "ERROR",
        verify: parsed,
        binaryMissing: false,
        error: parsed.raw.slice(0, 380),
      };
    }
    // Edge case: command succeeded but neither parser predicate
    // triggered. Treat as INCOMPLETE so the processor keeps it PENDING.
    return {
      status: "INCOMPLETE",
      verify: parsed,
      binaryMissing: false,
      error: null,
    };
  } catch (error) {
    return {
      status: "ERROR",
      verify: null,
      binaryMissing: false,
      error: normalizeErrorMessage(error).slice(0, 380),
    };
  } finally {
    await cleanup([workDir]);
  }
}
