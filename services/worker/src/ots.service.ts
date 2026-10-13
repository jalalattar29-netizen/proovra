import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
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

let otsClientIdentityCache: Promise<string | null> | null = null;

/**
 * The OpenTimestamps client this worker runs, e.g. "opentimestamps-client 0.7.2"
 * (2026-10-12) — recorded with the proof material it produced. Null when the
 * binary cannot report it; never guessed.
 */
export function otsClientIdentity(): Promise<string | null> {
  otsClientIdentityCache ??= execFileAsync(resolveOtsBin(), ["--version"], { timeout: 10_000 })
    .then((r) => {
      const v = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().replace(/^v/i, "");
      return /^d+.d+(.d+)?/.test(v) ? `opentimestamps-client ${v}` : null;
    })
    .catch(() => null);
  return otsClientIdentityCache;
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
