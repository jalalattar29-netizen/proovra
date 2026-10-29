import fs from "node:fs/promises";
import { tsaFailureCategory, type TsaValidationEvidence } from "@proovra/shared";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// Phase O1.5B — bounded TSA spans. Attributes carry provider name,
// outcome, bounded failure code/category and duration only. NEVER the TSA
// token body, message imprint hex digest, or response bytes.
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
import {
  isTsaEnabled,
  validateTsaToken,
  writeCurlCredentialConfig,
  type TsaValidationFailureCode,
} from "./timestamp/validate-tsa-token.js";

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
  return isTsaEnabled(process.env);
}

function timeoutMs(): number {
  const raw = process.env.TSA_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 20000;
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

/**
 * Bounded provider-failure codes (ET-TSA-06/07).
 *
 * Classification reads STRUCTURED facts of the failed subprocess — whether
 * execFile killed it on the deadline, curl's exit code, the HTTP status curl
 * reports — and never substring-matches the whole error message. That message
 * embeds argv (the URL, the digest, temp paths); it used to embed the TSA
 * credentials too, and a digest containing "429" or "403" was classified as a
 * quota or access failure. Credentials now travel in a 0600 curl config file,
 * never in argv.
 */
export type TsaProviderFailureCode =
  | "tsa_provider_quota_exceeded"
  | "tsa_provider_access_restricted"
  | "tsa_provider_auth_failed"
  | "tsa_provider_timeout"
  | "tsa_provider_unreachable"
  | "tsa_provider_http_error"
  | "tsa_unknown_error";

export type TimestampFailureCode =
  | TsaReplyFailureCode
  | TsaProviderFailureCode
  | TsaValidationFailureCode
  | "tsa_token_missing";

const PROVIDER_REASONS: Record<TsaProviderFailureCode, string> = {
  tsa_provider_quota_exceeded: "Trusted timestamp could not be obtained because the provider quota was exceeded.",
  tsa_provider_access_restricted: "Trusted timestamp could not be obtained due to provider access restrictions.",
  tsa_provider_auth_failed: "Trusted timestamp request was not authorized by the provider.",
  tsa_provider_timeout: "Trusted timestamp request timed out while contacting the provider.",
  tsa_provider_unreachable: "Trusted timestamp request failed because the timestamp provider could not be reached.",
  tsa_provider_http_error: "Trusted timestamp provider returned an HTTP error during the request.",
  tsa_unknown_error: "Trusted timestamp could not be obtained due to a timestamp provider error.",
};

/** curl exit codes that mean "never reached a server". */
const CURL_UNREACHABLE = new Set([5, 6, 7, 35, 52, 56]);

export function classifyTsaSubprocessError(error: unknown): {
  code: TsaProviderFailureCode;
  reason: string;
  /** The HTTP status the provider answered with, when curl reported one. */
  httpStatus: number | null;
} {
  const e = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown; stderr?: unknown; stdout?: unknown };
  // `-w "%{http_code}"` writes the status to stdout even when --fail exits 22;
  // the stderr "returned error: NNN" is the fallback. 000 = no response.
  const written = /^\s*([1-5]\d{2})\s*$/.exec(String(e.stdout ?? ""))?.[1];
  const status = written ?? /returned error:\s*(\d{3})/i.exec(String(e.stderr ?? ""))?.[1];
  const httpStatus = status ? Number.parseInt(status, 10) : null;
  const out = (code: TsaProviderFailureCode) => ({ code, reason: PROVIDER_REASONS[code], httpStatus });
  if (e.killed === true || e.code === 28 || e.code === "ETIMEDOUT") return out("tsa_provider_timeout");
  if (typeof e.code === "number" && CURL_UNREACHABLE.has(e.code)) return out("tsa_provider_unreachable");
  if (e.code === 22) {
    if (status === "429") return out("tsa_provider_quota_exceeded");
    if (status === "403") return out("tsa_provider_access_restricted");
    if (status === "401") return out("tsa_provider_auth_failed");
    return out("tsa_provider_http_error");
  }
  return out("tsa_unknown_error");
}

export type TimestampResult = {
  /** What the validation established (STAMPED only); recorded in custody. */
  validationEvidence?: TsaValidationEvidence | null;
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
  /**
   * ET-TSA-03: the imprint READ FROM THE TOKEN (null when the reply carried
   * none). Never the digest we sent — that is `requestDigestHex` — so a
   * read-side comparison of the two compares two different sources.
   */
  messageImprint: string | null;
  /** The digest this platform sent to the authority. */
  requestDigestHex: string;
  hashAlgorithm: string;
  status: "STAMPED" | "FAILED";
  failureReason: string | null;
  /**
   * Phase IA-TSA-falseFailed — bounded machine-readable failure code.
   * null on success. The persisted `tsaFailureReason` column gets the
   * operator-readable `failureReason` string above; downstream log /
   * custody event payloads also include `failureCode` for triage.
   */
  failureCode: TimestampFailureCode | null;
  /**
   * ET-TSA-01: set only when validate-tsa-token.ts validated the token
   * (signature, chain to the configured anchor, signer validity at genTime,
   * imprint, nonce, policy). `status === "STAMPED"` implies it is set.
   */
  validatedAtUtc: Date | null;
  signerCertSha256: string | null;
  policyOid: string | null;
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
  /**
   * (2026-10-29) Wall-clock milliseconds of the whole RFC 3161 round-trip —
   * query, transport, reply parse and validation — on every outcome. Recorded
   * in the TIMESTAMP_APPLIED / TIMESTAMP_FAILED custody payload and the
   * `tsa.timestamp.*` log line, so a slow or timed-out provider is visible.
   */
  durationMs: number;
};

/** The bounded log events one TSA request emits (exactly one per request). */
export const TSA_LOG_EVENTS = Object.freeze({
  STAMPED: "tsa.timestamp.stamped",
  FAILED: "tsa.timestamp.failed",
  ERROR: "tsa.timestamp.error",
} as const);

/** Where a FAILED request stopped. */
type TsaStage = "transport" | "reply" | "validation" | "complete";

type TsaDiagnostics = { stage: TsaStage; httpStatus: number | null };

/**
 * The provider LABEL as logged: the operator-chosen TSA_PROVIDER name, bounded
 * to a plain identifier. Anything else (a URL pasted into the label, a value
 * with credentials) is never echoed.
 */
function providerLogLabel(provider: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(provider) ? provider : "UNRECOGNISED_LABEL";
}

function httpStatusClass(status: number | null): string | null {
  return status === null ? null : `${Math.floor(status / 100)}xx`;
}

/**
 * ONE structured line per TSA request, emitted in every environment (the API
 * logger's info/warn are silent in production, so this writes the console
 * directly, like the other operator diagnostics). Bounded facts only: never
 * the TSA URL, username or password, the provider's response body, the token
 * or the digest.
 */
function logTsaOutcome(
  result: TimestampResult,
  diag: TsaDiagnostics,
  inputKind: string | null,
): void {
  const stamped = result.status === "STAMPED";
  const line = JSON.stringify({
    level: stamped ? "info" : "warn",
    event: stamped ? TSA_LOG_EVENTS.STAMPED : TSA_LOG_EVENTS.FAILED,
    provider: providerLogLabel(result.provider),
    outcome: result.status,
    category: stamped ? null : tsaFailureCategory(result.failureCode, true),
    failureCode: result.failureCode,
    stage: stamped ? "complete" : diag.stage,
    inputKind,
    durationMs: result.durationMs,
    httpStatusClass: httpStatusClass(diag.httpStatus),
    replyKept: result.tokenBase64.length > 0,
    parseWarnings: result.warnings.length,
  });
  // eslint-disable-next-line no-console
  if (stamped) console.info(line);
  // eslint-disable-next-line no-console
  else console.warn(line);
}

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

export async function createEvidenceTimestamp(params: {
  digestHex: string;
  /**
   * What the digest is (FILE_SHA256 | CANONICAL_PACKAGE_SHA256) — for the log
   * line only; the persisted tsaInputKind is written by the finalizer.
   */
  inputKind?: string | null;
}): Promise<TimestampResult | null> {
  if (!enabled()) return null;
  const providerLabel = (process.env.TSA_PROVIDER ?? "UNSPECIFIED_TSA").trim() || "UNSPECIFIED_TSA";
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.TSA_TIMESTAMP_REQUEST,
    {
      "proovra.operation": "tsa_timestamp_request",
      "proovra.provider": providerLabel,
    },
    async (span) => {
      const startedAt = performance.now();
      const diag: TsaDiagnostics = { stage: "transport", httpStatus: null };
      const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
      let result: TimestampResult;
      try {
        result = { ...(await createEvidenceTimestampInner(params, diag)), durationMs: elapsed() };
      } catch (err) {
        // Configuration or input errors (TSA_URL unset, a malformed digest):
        // the request never reached a provider. Bounded: the error's name only.
        // eslint-disable-next-line no-console
        console.warn(
          JSON.stringify({
            level: "warn",
            event: TSA_LOG_EVENTS.ERROR,
            provider: providerLogLabel(providerLabel),
            errorName: err instanceof Error ? err.name.slice(0, 40) : "unknown",
            inputKind: params.inputKind ?? null,
            durationMs: elapsed(),
          }),
        );
        throw err;
      }
      logTsaOutcome(result, diag, params.inputKind ?? null);
      // Outcome + duration on the request span (bounded codes, no digest/URL).
      span.setAttribute("proovra.tsa.outcome", result.status);
      span.setAttribute("proovra.tsa.duration_ms", result.durationMs);
      if (result.failureCode) {
        span.setAttribute("proovra.tsa.failure_code", result.failureCode);
        span.setAttribute("proovra.tsa.failure_category", tsaFailureCategory(result.failureCode, true) ?? "UNSPECIFIED");
      }
      return result;
    },
  );
}

async function createEvidenceTimestampInner(
  params: { digestHex: string },
  diag: TsaDiagnostics,
): Promise<Omit<TimestampResult, "durationMs">> {
  const tsaUrl = must("TSA_URL");
  // UC-TRUST-006 — credentials are OPTIONAL (many authorities are
  // unauthenticated); requiring them threw and blocked completion.
  const tsaUsername = optional("TSA_USERNAME");
  const tsaPassword = optional("TSA_PASSWORD");
  const provider = optional("TSA_PROVIDER") ?? "UNSPECIFIED_TSA";
  const hashAlgorithm = optional("TSA_HASH_ALGORITHM") ?? "sha256";

  const digestHex = params.digestHex.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digestHex)) {
    throw new Error("createEvidenceTimestamp: digestHex must be a sha256 hex string");
  }

  const workDir = await mkWorkDir();
  const requestFile = path.join(workDir, "request.tsq");
  const responseFile = path.join(workDir, "response.tsr");
  const curlConfig = path.join(workDir, "curl.cfg");

  const base = {
    provider,
    url: tsaUrl,
    requestDigestHex: digestHex,
    hashAlgorithm,
  };
  const failed = (
    code: TimestampFailureCode,
    reason: string,
    extra: Partial<TimestampResult> = {},
  ): Omit<TimestampResult, "durationMs"> => ({
    ...base,
    serialNumber: null,
    genTimeUtc: null,
    tokenBase64: "",
    messageImprint: null,
    status: "FAILED",
    failureReason: reason,
    failureCode: code,
    warnings: [],
    validatedAtUtc: null,
    signerCertSha256: null,
    policyOid: null,
    ...extra,
  });

  try {
    // 1. Transport. A failure here never reached a token.
    try {
      await execFileAsync(
        "openssl",
        ["ts", "-query", "-digest", digestHex, `-${hashAlgorithm}`, "-cert", "-out", requestFile],
        { timeout: timeoutMs() },
      );
      let credentialArgs: string[] = [];
      if (tsaUsername && tsaPassword) {
        await writeCurlCredentialConfig(curlConfig, tsaUsername, tsaPassword);
        credentialArgs = [
          "-K",
          curlConfig,
        ];
      }
      const transport = await execFileAsync(
        "curl",
        [
          "-sS",
          "--fail",
          ...credentialArgs,
          "-H",
          "Content-Type: application/timestamp-query",
          "--data-binary",
          `@${requestFile}`,
          "-o",
          responseFile,
          // The HTTP status alone on stdout (the body goes to responseFile).
          "-w",
          "%{http_code}",
          tsaUrl,
        ],
        { timeout: timeoutMs() },
      );
      const httpCode = /^\s*(\d{3})\s*$/.exec(String(transport.stdout ?? ""))?.[1];
      diag.httpStatus = httpCode ? Number.parseInt(httpCode, 10) : null;
    } catch (error) {
      const classified = classifyTsaSubprocessError(error);
      diag.httpStatus = classified.httpStatus;
      return failed(classified.code, classified.reason);
    }

    // 2. The reply. An empty body (curl leaves no file for one) is a reply
    //    that carries nothing — not a token, and not a crash of completion.
    diag.stage = "reply";
    const replyBytes = await fs.stat(responseFile).then((s) => s.size, () => 0);
    if (replyBytes === 0) {
      return failed("tsa_response_parse_failed", "Trusted timestamp provider returned an empty response.");
    }

    // The reply bytes are KEPT on every later failure, so a token can be
    // triaged — and validated later once an anchor is configured — without
    // re-contacting the authority (which the no-retry invariant forbids).
    const tokenBase64 = (await fs.readFile(responseFile)).toString("base64");

    //    Read it. A granted status without a token (ET-TSA-02) makes openssl
    //    refuse the structure outright.
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "openssl",
        ["ts", "-reply", "-in", responseFile, "-text"],
        { timeout: timeoutMs() },
      ));
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").toLowerCase();
      return stderr.includes("token not present")
        ? failed("tsa_token_missing", "Trusted timestamp provider granted the request but returned no timestamp token.", { tokenBase64 })
        : failed("tsa_response_parse_failed", tsaFailureCodeToReason("tsa_response_parse_failed"), { tokenBase64 });
    }

    const parsed = await withProovraSpan(
      PROOVRA_SPAN_NAMES.TSA_TIMESTAMP_VERIFY,
      { "proovra.operation": "tsa_timestamp_verify", "proovra.provider": provider },
      async () => parseTsaReply(stdout, digestHex),
    );
    const fromReply = {
      tokenBase64,
      serialNumber: parsed.serialNumber,
      genTimeUtc: parsed.genTimeUtc,
      messageImprint: parsed.messageImprintHex,
      policyOid: parsed.policyOid,
    };
    if (!parsed.granted) {
      return failed(
        parsed.failureCode ?? "tsa_response_parse_failed",
        parsed.failureReason ?? tsaFailureCodeToReason("tsa_response_parse_failed"),
        fromReply,
      );
    }

    // 3. Validate the token. Only this makes it a timestamp.
    diag.stage = "validation";
    const validation = await validateTsaToken({
      responseFile,
      queryFile: requestFile,
      workDir,
      genTimeUtc: parsed.genTimeUtc,
      policyOid: parsed.policyOid,
    });
    await withProovraSpan(
      PROOVRA_SPAN_NAMES.INTEGRITY_TIMESTAMP_VERIFY,
      {
        "proovra.operation": "integrity_timestamp_verify",
        "proovra.outcome": validation.ok ? "validated" : validation.code,
      },
      () => undefined,
    );
    if (!validation.ok) return failed(validation.code, validation.reason, fromReply);

    return {
      ...base,
      ...fromReply,
      status: "STAMPED",
      failureReason: null,
      failureCode: null,
      warnings: parsed.warnings,
      validatedAtUtc: validation.validatedAtUtc,
      signerCertSha256: validation.signerCertSha256,
      validationEvidence: validation.evidence,
      policyOid: validation.policyOid,
    };
  } finally {
    await cleanup([workDir]);
  }
}
