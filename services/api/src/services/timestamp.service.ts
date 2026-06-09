import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// Phase O1.5B — bounded TSA spans. Attributes carry provider name +
// status only. NEVER the TSA token body, message imprint hex digest,
// or response bytes.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../observability/otel.js";
import {
  parseTsaReply,
  tsaFailureCodeToReason,
  type TsaReplyFailureCode,
  type TsaReplyWarningCode,
} from "./timestamp/parse-tsa-reply.js";

const execFileAsync = promisify(execFile);

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

function enabled(): boolean {
  return (process.env.TSA_ENABLED ?? "false").toLowerCase() === "true";
}

function timeoutMs(): number {
  const raw = process.env.TSA_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 20000;
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

/**
 * Phase IA-TSA-falseFailed — bounded subprocess-error classifier.
 *
 * Maps an exception thrown by the openssl/curl subprocess chain into one
 * of a fixed set of operator-readable strings. The persisted
 * `tsaFailureReason` text is operator-facing; the classifier name
 * (returned as `code` for log + custody-event context) is the bounded
 * machine-readable label.
 */
export type TsaProviderFailureCode =
  | "tsa_provider_quota_exceeded"
  | "tsa_provider_access_restricted"
  | "tsa_provider_auth_failed"
  | "tsa_provider_timeout"
  | "tsa_provider_unreachable"
  | "tsa_provider_http_error"
  | "tsa_unknown_error";

function classifyTsaSubprocessError(error: unknown): {
  code: TsaProviderFailureCode;
  reason: string;
} {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error ?? "").toLowerCase();

  if (message.includes("quota") || message.includes("rate limit") || message.includes("rate-limit") || message.includes("429")) {
    return {
      code: "tsa_provider_quota_exceeded",
      reason:
        "Trusted timestamp could not be obtained because the provider quota was exceeded.",
    };
  }
  if (message.includes("403") || message.includes("forbidden")) {
    return {
      code: "tsa_provider_access_restricted",
      reason:
        "Trusted timestamp could not be obtained due to provider access restrictions.",
    };
  }
  if (message.includes("401") || message.includes("unauthorized")) {
    return {
      code: "tsa_provider_auth_failed",
      reason: "Trusted timestamp request was not authorized by the provider.",
    };
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return {
      code: "tsa_provider_timeout",
      reason:
        "Trusted timestamp request timed out while contacting the provider.",
    };
  }
  if (
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("network") ||
    message.includes("connection")
  ) {
    return {
      code: "tsa_provider_unreachable",
      reason:
        "Trusted timestamp request failed because the timestamp provider could not be reached.",
    };
  }
  if (
    // curl with --fail prints `curl: (22) The requested URL returned error: 500`
    // and similar. Bucket every HTTP-shaped exit code into one bounded label.
    /\b(?:5\d\d|4\d\d)\b/.test(message) ||
    message.includes("http error") ||
    message.includes("curl: (22)") ||
    message.includes("curl: (52)") || // empty reply from server
    message.includes("curl: (56)") // recv failure
  ) {
    return {
      code: "tsa_provider_http_error",
      reason:
        "Trusted timestamp provider returned an HTTP error during the request.",
    };
  }
  return {
    code: "tsa_unknown_error",
    reason:
      "Trusted timestamp could not be obtained due to a timestamp provider error.",
  };
}

/**
 * Back-compat shim. The previous symbol `normalizeTsaFailureReason` was
 * referenced from elsewhere (tests, in-flight call sites); we keep it
 * delegating to the bounded classifier so any external usage continues
 * to receive the same operator-readable strings.
 */
function normalizeTsaFailureReason(error: unknown): string {
  return classifyTsaSubprocessError(error).reason;
}

export type TimestampResult = {
  provider: string;
  url: string;
  serialNumber: string | null;
  genTimeUtc: Date | null;
  /**
   * Phase IA-TSA-falseFailed — token bytes are now PRESERVED on the
   * parser-side failure modes (tsa_response_parse_failed,
   * tsa_message_imprint_mismatch) so the offline repair tool
   * (`repair-tsa-failed-with-token.ts`) can re-parse the same TSR
   * without calling the provider again. Provider-side failure paths
   * (HTTP error, timeout, auth) still write "".
   */
  tokenBase64: string;
  messageImprint: string;
  hashAlgorithm: string;
  status: "STAMPED" | "FAILED";
  failureReason: string | null;
  /**
   * Phase IA-TSA-falseFailed — bounded machine-readable failure code.
   * null on success. The persisted `tsaFailureReason` column gets the
   * operator-readable `failureReason` string above; downstream log /
   * custody event payloads also include `failureCode` for triage.
   */
  failureCode: TsaReplyFailureCode | TsaProviderFailureCode | null;
  /**
   * Phase IA-digest-policy-hard-invariant — bounded soft-issue warnings
   * surfaced on STAMPED rows whose response was granted + imprint
   * matched the request but where the parser couldn't extract one of
   * the optional fields (serial number, genTime, embedded imprint
   * dump). Empty on a fully-parsed STAMPED row. Empty on FAILED rows
   * — failures use `failureCode` instead.
   *
   * Per the hard invariant: a Granted token + matching imprint MUST
   * NOT be persisted as FAILED, even when the parser reports warnings.
   * Operators see the warnings in the custody event payload + log
   * line; the repair tool can fill in the missing columns later.
   */
  warnings: TsaReplyWarningCode[];
};

async function mkWorkDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tsa-"));
}

async function cleanup(files: string[]): Promise<void> {
  await Promise.all(
    files.map(async (f) => {
      try {
        await fs.rm(f, { force: true, recursive: true });
      } catch {
        // ignore cleanup errors
      }
    })
  );
}

// Phase IA-TSA-falseFailed — the previous `parseOpenSslReplyText` was a
// single regex pair; the new parser lives in `./timestamp/parse-tsa-reply.ts`
// and handles double-space dates, multi-line message imprint dumps, and
// returns a bounded failure code on every failure mode. This helper
// stays only as a thin wrapper for back-compat with any external import.
function parseOpenSslReplyText(text: string): {
  serialNumber: string | null;
  genTimeUtc: Date | null;
} {
  const r = parseTsaReply(text);
  return { serialNumber: r.serialNumber, genTimeUtc: r.genTimeUtc };
}

export async function createEvidenceTimestamp(params: {
  digestHex: string;
}): Promise<TimestampResult | null> {
  if (!enabled()) return null;
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.TSA_TIMESTAMP_REQUEST,
    {
      "proovra.operation": "tsa_timestamp_request",
      "proovra.provider": (process.env.TSA_PROVIDER ?? "UNSPECIFIED_TSA").trim() || "UNSPECIFIED_TSA",
    },
    () => createEvidenceTimestampInner(params),
  );
}

async function createEvidenceTimestampInner(params: {
  digestHex: string;
}): Promise<TimestampResult | null> {
  const tsaUrl = must("TSA_URL");
  const tsaUsername = must("TSA_USERNAME");
  const tsaPassword = must("TSA_PASSWORD");
  const provider = optional("TSA_PROVIDER") ?? "UNSPECIFIED_TSA";
  const hashAlgorithm = optional("TSA_HASH_ALGORITHM") ?? "sha256";

  const digestHex = params.digestHex.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digestHex)) {
    throw new Error("createEvidenceTimestamp: digestHex must be a sha256 hex string");
  }

  const workDir = await mkWorkDir();
  const requestFile = path.join(workDir, "request.tsq");
  const responseFile = path.join(workDir, "response.tsr");

  try {
    await execFileAsync(
      "openssl",
      [
        "ts",
        "-query",
        "-digest",
        digestHex,
        `-${hashAlgorithm}`,
        "-cert",
        "-out",
        requestFile,
      ],
      { timeout: timeoutMs() }
    );

    await execFileAsync(
      "curl",
      [
        "-sS",
        "--fail",
        "-u",
        `${tsaUsername}:${tsaPassword}`,
        "-H",
        "Content-Type: application/timestamp-query",
        "--data-binary",
        `@${requestFile}`,
        "-o",
        responseFile,
        tsaUrl,
      ],
      { timeout: timeoutMs() }
    );

    const { stdout } = await execFileAsync(
      "openssl",
      ["ts", "-reply", "-in", responseFile, "-text"],
      { timeout: timeoutMs() }
    );

// Phase IA-TSA-falseFailed — delegate parsing to the bounded parser.
// The parser handles Granted. / Granted / GrantedWithMods, the double-
// space day formatting (Jun  9), and the multi-line message-imprint
// dump. It returns a structured result; we then DECIDE persistence
// based on the bounded failure code and PRESERVE the token bytes on
// parser-side failures so the offline repair tool can reuse them.
const parsed = await withProovraSpan(
  PROOVRA_SPAN_NAMES.TSA_TIMESTAMP_VERIFY,
  {
    "proovra.operation": "tsa_timestamp_verify",
    "proovra.provider": provider,
  },
  async () => {
    const result = parseTsaReply(stdout, digestHex);
    await withProovraSpan(
      PROOVRA_SPAN_NAMES.INTEGRITY_TIMESTAMP_VERIFY,
      {
        "proovra.operation": "integrity_timestamp_verify",
        "proovra.outcome": result.granted ? "granted" : "rejected",
      },
      () => undefined,
    );
    return result;
  },
);

    // The response file was written by curl on a 2xx; read it eagerly
    // so we can preserve the token bytes even on parser-side failures
    // (so the repair tool can re-parse later without re-hitting the
    // provider). If the file is missing we treat that as a hard
    // subprocess failure handled by the catch block below.
    const tokenBuffer = await fs.readFile(responseFile);
    const tokenBase64 = tokenBuffer.toString("base64");

    if (parsed.granted) {
      // Phase IA-digest-policy-hard-invariant — STAMPED is the only
      // correct outcome here, regardless of soft parser warnings
      // (missing serial / missing genTime / missing imprint dump).
      // The token bytes + the verified imprint == request digest are
      // the authoritative trust chain. Warnings are surfaced for
      // operator visibility and the repair tool's queue.
      return {
        provider,
        url: tsaUrl,
        serialNumber: parsed.serialNumber,
        genTimeUtc: parsed.genTimeUtc,
        tokenBase64,
        messageImprint: digestHex,
        hashAlgorithm,
        status: "STAMPED",
        failureReason: null,
        failureCode: null,
        warnings: parsed.warnings,
      };
    }

    // Parser-side failure paths (the response shape was understandable
    // but did not pass our validation — non-granted status, or the
    // imprint disagrees with the digest we sent). Token bytes ARE
    // preserved so the offline repair tool can re-parse with a future
    // fix without calling the provider again. Failure code surfaces in
    // `tsaFailureReason` for operator triage.
    return {
      provider,
      url: tsaUrl,
      serialNumber: parsed.serialNumber,
      genTimeUtc: parsed.genTimeUtc,
      tokenBase64,
      messageImprint: digestHex,
      hashAlgorithm,
      status: "FAILED",
      failureReason: parsed.failureReason,
      failureCode: parsed.failureCode,
      warnings: [],
    };
  } catch (error) {
    // Subprocess / network / unrecoverable parser-not-reached failure.
    // Token bytes are NOT available here — we never reached the
    // tokenBuffer read OR the read itself failed.
    const classified = classifyTsaSubprocessError(error);
    return {
      provider,
      url: tsaUrl,
      serialNumber: null,
      genTimeUtc: null,
      tokenBase64: "",
      messageImprint: digestHex,
      hashAlgorithm,
      status: "FAILED",
      failureReason: classified.reason,
      failureCode: classified.code,
      warnings: [],
    };
  } finally {
    await cleanup([requestFile, responseFile, workDir]);
  }
}