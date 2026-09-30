import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  parseOtsInfoOutput,
  parseOtsVerifyOutput,
  type OtsInfoOutput,
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

/**
 * ET-OTS-04 — the stamp call itself failed (no proof exists). Bounded code;
 * the underlying error is the `cause` for logs only.
 */
export class OtsStampCallFailed extends Error {
  constructor(
    public readonly code: "binary_missing" | "stamp_call_failed",
    cause: unknown,
  ) {
    super(`ots_${code}`);
    this.name = "OtsStampCallFailed";
    (this as { cause?: unknown }).cause = cause;
  }
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

    // ET-OTS-05 — INITIALIZATION NEVER WRITES ANCHORED. The first upgrade is
    // attempted so the stored proof carries whatever the calendar already has,
    // but the anchor is established only by the upgrade ladder's classifier
    // (hash + block attestation checks). The text-only promotion removed from
    // classifyOtsResult on 2026-09-29 survived here: "timestamp complete" in
    // `ots upgrade` output wrote ANCHORED with no check, and a txid parsed by
    // the generic 64-hex fallback kept the ladder from ever re-checking it.
    //
    // ET-OTS-04 — an upgrade failure here is not about the record: the stamp
    // succeeded and the proof exists. It stays PENDING for the ladder.
    let proofForRecord = proofBase64;
    let upgradedAtUtc: string | null = null;
    try {
      await withProovraSpan(
        PROOVRA_SPAN_NAMES.OTS_UPGRADE,
        { "proovra.operation": "ots_upgrade" },
        async () =>
          execFileAsync(bin, ["upgrade", proofFile], {
            timeout: resolveOtsTimeoutMs(),
            cwd: workDir,
          }),
      );
      upgradedAtUtc = nowIso();
    } catch {
      /* the ladder retries the upgrade; nothing about the record failed */
    }
    try {
      proofForRecord = (await fs.readFile(proofFile)).toString("base64");
    } catch {
      /* keep the stamped proof */
    }

    return {
      status: "PENDING",
      proofBase64: proofForRecord,
      hash: contentHash,
      calendar,
      bitcoinTxid: null,
      anchoredAtUtc: null,
      upgradedAtUtc,
      pendingDetail: "OTS proof created; Bitcoin anchoring is established by the upgrade ladder.",
    };
  } catch (error) {
    // ET-OTS-04 — A STAMP-CALL FAILURE IS THROWN, NEVER RECORDED. Timeouts,
    // DNS, calendar 5xx and a missing binary say nothing about the record;
    // returning FAILED persisted the raw command text (server paths included)
    // as a per-record integrity failure that nothing retried. The initializer
    // wraps the throw in OtsInitializationTransientError, so the retry budget
    // runs and the row stays unset.
    throw new OtsStampCallFailed(isBinaryMissingMessage(normalizeErrorMessage(error)) ? "binary_missing" : "stamp_call_failed", error);
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

/**
 * The ONE place a proof is checked against the chain (`ots verify -d <hash>`),
 * so the verify spans are emitted here. ET-OTS-05 removed their only former
 * emission site, which named an unchecked text match "verified".
 */
export async function verifyOtsProof(
  input: VerifyOtsProofInput,
): Promise<VerifyOtsProofResult> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.OTS_VERIFY,
    { "proovra.operation": "ots_verify" },
    async () => {
      const result = await verifyOtsProofInner(input);
      await withProovraSpan(
        PROOVRA_SPAN_NAMES.INTEGRITY_PUBLIC_ANCHOR_VERIFY,
        {
          "proovra.operation": "integrity_public_anchor_verify",
          "proovra.outcome": result.status === "VERIFIED" ? "verified" : result.status.toLowerCase(),
        },
        () => undefined,
      );
      return result;
    },
  );
}

async function verifyOtsProofInner(
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
  // doesn't keep). Surface this as ERROR: the caller then relies on the
  // offline `ots info` reading, and never on command text (the text-only
  // "legacy heuristic" was removed 2026-09-29).
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
    // command-error is reported as ERROR; the caller then relies on the
    // offline `ots info` reading (no text-only heuristic exists any more).
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

// ===========================================================================
// Phase IA-OTS-info-fallback — `ots info` wrapper.
//
// `ots info <proof.ots>` reads the proof bytes and prints a deterministic
// dump of the contained merkle tree + attestations. It does NOT require
// a Bitcoin RPC, a calendar HTTP call, or any other network access.
// This makes it the canonical "is this proof already bound to a Bitcoin
// block?" signal in containerized deployments where `ots verify -d`
// fails because `Could not connect to Bitcoin node: /home/app/.bitcoin/
// .cookie missing`.
//
// Hard rules (mirroring `verifyOtsProof`):
//   * NEVER throws — info failures are always returned as a structured
//     object so the processor can act on them without crashing.
//   * NEVER persists.
//   * Bounded timeout via `resolveOtsTimeoutMs()`.
//   * The parsed output is exposed verbatim via `parseOtsInfoOutput` so
//     callers can inspect block heights / pending calendars / file hash
//     / txid independently.
// ===========================================================================

export type GetOtsProofInfoInput = {
  /** Base64-encoded proof bytes from `Evidence.otsProofBase64`. */
  proofBase64: string;
};

export type GetOtsProofInfoResult =
  | {
      status: "DISABLED";
      info: null;
      binaryMissing: false;
      error: null;
    }
  | {
      status: "PARSED";
      info: OtsInfoOutput;
      binaryMissing: false;
      error: null;
    }
  | {
      status: "BINARY_MISSING";
      info: null;
      binaryMissing: true;
      error: string;
    }
  | {
      status: "ERROR";
      info: OtsInfoOutput | null;
      binaryMissing: false;
      error: string;
      /**
       * ET-OTS-06 — `ots info` is OFFLINE: it only reads the proof bytes. A
       * failure that is not a timeout / kill / environment fault will repeat
       * identically for the same bytes, so it says something about the proof.
       */
      deterministic: boolean;
    };

export async function getOtsProofInfo(
  input: GetOtsProofInfoInput,
): Promise<GetOtsProofInfoResult> {
  if (!enabled()) {
    return {
      status: "DISABLED",
      info: null,
      binaryMissing: false,
      error: null,
    };
  }
  const proofBase64 = clean(input.proofBase64);
  if (!proofBase64) {
    return {
      status: "ERROR",
      info: null,
      binaryMissing: false,
      error: "getOtsProofInfo called with an empty proofBase64.",
      deterministic: false,
    };
  }

  const workDir = await mkWorkDir();
  const proofFile = path.join(workDir, "proof.ots");
  try {
    await fs.writeFile(proofFile, Buffer.from(proofBase64, "base64"));
    let stdout = "";
    let stderr = "";
    let commandErrored = false;
    let interrupted = false;
    try {
      const result = await execFileAsync(
        resolveOtsBin(),
        ["info", proofFile],
        { timeout: resolveOtsTimeoutMs() },
      );
      stdout = result.stdout?.toString() ?? "";
      stderr = result.stderr?.toString() ?? "";
    } catch (error) {
      const e = error as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
        killed?: boolean;
        signal?: string | null;
        code?: string | number;
      };
      stdout = (e.stdout ?? "").toString();
      stderr = (e.stderr ?? e.message ?? "").toString();
      commandErrored = true;
      interrupted =
        e.killed === true ||
        Boolean(e.signal) ||
        e.code === "ETIMEDOUT" ||
        /timed? ?out/i.test(e.message ?? "");
    }

    const merged = `${stdout}\n${stderr}`;
    if (isBinaryMissingMessage(merged)) {
      return {
        status: "BINARY_MISSING",
        info: null,
        binaryMissing: true,
        error:
          "OpenTimestamps binary is missing in the worker environment.",
      };
    }

    const parsed = parseOtsInfoOutput(stdout, stderr);
    // PARSED requires the file-hash line to be present — without it
    // we cannot make the security comparison against evidence.otsHash.
    // Some `ots info` invocations on a corrupt proof print empty
    // structure with the file hash; we still return PARSED in that
    // case so the classifier sees `info` with the hash but no block
    // heights, and the rule "no block attestation → not anchored"
    // applies.
    if (parsed.fileHash !== null) {
      return {
        status: "PARSED",
        info: parsed,
        binaryMissing: false,
        error: null,
      };
    }
    if (commandErrored) {
      return {
        status: "ERROR",
        info: parsed,
        binaryMissing: false,
        error: parsed.raw.slice(0, 380),
        deterministic: !interrupted,
      };
    }
    // Edge case: the command succeeded but emitted no file-hash line.
    // Treat as ERROR with the parsed body so the processor can fall
    // back to the verify/upgrade signals.
    return {
      status: "ERROR",
      info: parsed,
      binaryMissing: false,
      error: "ots info returned no `File sha256 hash` line.",
      deterministic: true,
    };
  } catch (error) {
    return {
      status: "ERROR",
      info: null,
      binaryMissing: false,
      error: normalizeErrorMessage(error).slice(0, 380),
      deterministic: false,
    };
  } finally {
    await cleanup([workDir]);
  }
}
