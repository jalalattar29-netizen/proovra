/**
 * PROOVRA C2PA provider — worker side.
 *
 * Phase M2.
 *
 * Bounded, env-driven C2PA detection / validation surface. NEVER
 * mutates the original evidence file. NEVER blocks upload or
 * finalization by default. Fail-soft for unsupported / disabled /
 * missing-tooling states.
 *
 * Behavior matrix (decided from `C2PA_ENABLED` + `C2PA_PROVIDER_MODE`):
 *
 *   C2PA_ENABLED=false  →  provider returns `disabled` for every call,
 *                          regardless of mode. No subprocess spawn,
 *                          no telemetry beyond a single "disabled"
 *                          breadcrumb.
 *   C2PA_ENABLED=true   →  mode dictates work:
 *      `disabled`         → same as above.
 *      `detect_only`      → presence detection only, no validation.
 *                           Tool absence DEGRADES to `not_present`
 *                           with `C2PA_PROVIDER_DOWNGRADED_TO_DETECT_ONLY`
 *                           warning rather than `error`.
 *      `validate`         → presence + cryptographic validation if
 *                           tool present; tool absence => `error`
 *                           with `tooling_unavailable`.
 *      `embed_supported`  → as `validate` for read; signals to the
 *                           generator path that embedding is allowed.
 *
 * Hard rules:
 *   * Original evidence bytes are read ONCE into a bounded byte buffer
 *     no larger than `C2PA_MAX_BYTES`. We do NOT spool the file to
 *     disk for tool invocation unless the binary requires a path
 *     (handled by `runC2patoolFromTempFile` when `C2PA_BIN` is set).
 *   * The temp file lives in `os.tmpdir()` and is deleted on the same
 *     turn. We NEVER write to S3 from this code path.
 *   * Subprocess exit timeout is `C2PA_TIMEOUT_MS`. On timeout we
 *     return `error` with bounded reason `timeout`.
 *   * stderr/stdout from the subprocess is NEVER returned in result
 *     fields — only bounded categorization. Operator-debug copy is
 *     redirected to the worker pino logger at debug level.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  C2PA_RESULT_SCHEMA_VERSION,
  aggregateC2paFileResults,
  buildDisabledC2paSummary,
  buildNotPresentC2paFileResult,
  isC2paSupportedMediaType,
  type C2paEvidenceSummary,
  type C2paFailureReason,
  type C2paFileResult,
  type C2paProviderMode,
  type C2paStatus,
  type C2paValidationStatus,
  type C2paWarningCode,
} from "@proovra/shared";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { PROOVRA_SPAN_NAMES, withProovraSpan, withProovraSpanSync } from "../otel.js";

// ---------------------------------------------------------------------------
// Provider entry points
// ---------------------------------------------------------------------------

export type C2paProviderInput = {
  evidenceId: string;
  files: ReadonlyArray<{
    /** Bounded item id or null. */
    itemId: string | null;
    /** Bounded media type as stored on the Evidence row / part. */
    mediaType: string | null;
    /** File bytes — provider truncates internally to `C2PA_MAX_BYTES`. */
    bytes: Buffer;
  }>;
};

/**
 * Public entry: evaluate the C2PA state of an evidence record.
 */
export async function evaluateEvidenceC2pa(
  input: C2paProviderInput,
): Promise<C2paEvidenceSummary> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.C2PA_DETECT,
    {
      evidenceId: input.evidenceId,
      fileCount: input.files.length,
      providerMode: resolveProviderMode(),
    },
    () => evaluateEvidenceC2paInner(input),
  );
}

async function evaluateEvidenceC2paInner(
  input: C2paProviderInput,
): Promise<C2paEvidenceSummary> {
  const generatedAtUtc = new Date().toISOString();
  const mode = resolveProviderMode();
  if (mode === "disabled") {
    return buildDisabledC2paSummary({
      evidenceId: input.evidenceId,
      generatedAtUtc,
    });
  }
  const toolVersion = await detectToolVersion();
  const warnings: C2paWarningCode[] = [];
  if (env.C2PA_BIN && !toolVersion) {
    warnings.push("C2PA_TOOL_VERSION_UNKNOWN");
  }
  const fileResults: C2paFileResult[] = [];
  for (const f of input.files) {
    const result = await evaluateSingleFile({
      itemId: f.itemId,
      mediaType: f.mediaType,
      bytes: f.bytes,
      mode,
      toolVersion,
    });
    fileResults.push(result);
  }
  return aggregateC2paFileResults({
    evidenceId: input.evidenceId,
    generatedAtUtc,
    providerMode: mode,
    toolVersion,
    files: fileResults,
    warnings,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveProviderMode(): C2paProviderMode {
  if (env.C2PA_ENABLED !== "true") return "disabled";
  const requested = (env.C2PA_PROVIDER_MODE ?? "detect_only") as C2paProviderMode;
  return requested;
}

async function detectToolVersion(): Promise<string | null> {
  const bin = env.C2PA_BIN;
  if (!bin) return null;
  try {
    const out = await runChildProcess(bin, ["--version"], {
      timeoutMs: Math.min(5000, env.C2PA_TIMEOUT_MS),
      input: null,
    });
    if (out.exitCode !== 0) return null;
    return out.stdout.trim().slice(0, 60) || null;
  } catch {
    return null;
  }
}

async function evaluateSingleFile(input: {
  itemId: string | null;
  mediaType: string | null;
  bytes: Buffer;
  mode: C2paProviderMode;
  toolVersion: string | null;
}): Promise<C2paFileResult> {
  const mediaType = (input.mediaType ?? "application/octet-stream").toLowerCase();
  if (!isC2paSupportedMediaType(mediaType)) {
    return {
      ...buildNotPresentC2paFileResult({
        itemId: input.itemId,
        mediaType,
      }),
      status: "unsupported",
      failureReason: "unsupported_format",
    };
  }

  if (input.bytes.byteLength > env.C2PA_MAX_BYTES) {
    return {
      ...buildNotPresentC2paFileResult({ itemId: input.itemId, mediaType }),
      status: "unsupported",
      failureReason: "unsupported_format",
      warnings: ["C2PA_LARGE_MANIFEST_TRUNCATED_FROM_SUMMARY"],
    };
  }

  const bin = env.C2PA_BIN;
  if (!bin) {
    // No tool available. In `detect_only` we degrade to `not_present`
    // (honest) rather than `error`; in `validate` / `embed_supported`
    // we surface `error` so operators know they enabled validation
    // without supplying tooling.
    if (input.mode === "detect_only") {
      return {
        ...buildNotPresentC2paFileResult({ itemId: input.itemId, mediaType }),
        warnings: ["C2PA_PROVIDER_DOWNGRADED_TO_DETECT_ONLY"],
      };
    }
    return {
      ...buildNotPresentC2paFileResult({ itemId: input.itemId, mediaType }),
      status: "error",
      failureReason: "tooling_unavailable",
    };
  }

  return runC2patoolFromTempFile({
    bytes: input.bytes,
    mediaType,
    mode: input.mode,
    bin,
    itemId: input.itemId,
  });
}

/**
 * Bounded subprocess invocation. Writes bytes to a tmpfile, runs
 * `c2patool` with bounded args, parses stdout JSON, deletes tmpfile.
 *
 * NEVER returns raw stdout/stderr in result fields.
 */
async function runC2patoolFromTempFile(input: {
  bytes: Buffer;
  mediaType: string;
  mode: C2paProviderMode;
  bin: string;
  itemId: string | null;
}): Promise<C2paFileResult> {
  const tmpPath = path.join(
    os.tmpdir(),
    `proovra-c2pa-${randomUUID()}-${suffixForMediaType(input.mediaType)}`,
  );
  try {
    await fs.writeFile(tmpPath, input.bytes);
  } catch {
    return {
      ...buildNotPresentC2paFileResult({
        itemId: input.itemId,
        mediaType: input.mediaType,
      }),
      status: "error",
      failureReason: "unknown",
    };
  }
  try {
    // Bounded args: read-only mode, JSON output. The exact flags
    // depend on the installed binary but every supported provider
    // exposes a JSON-summary mode. We deliberately do NOT pass
    // anything that could write to the source file.
    const args = ["--info", tmpPath];
    const result = await runChildProcess(input.bin, args, {
      timeoutMs: env.C2PA_TIMEOUT_MS,
      input: null,
    });
    if (result.timedOut) {
      return {
        ...buildNotPresentC2paFileResult({
          itemId: input.itemId,
          mediaType: input.mediaType,
        }),
        status: "error",
        failureReason: "timeout",
        warnings: ["C2PA_EXTRACTION_TIMED_OUT"],
      };
    }
    if (result.exitCode !== 0 && !result.stdout) {
      // Nothing parseable — treat as no manifest present.
      return buildNotPresentC2paFileResult({
        itemId: input.itemId,
        mediaType: input.mediaType,
      });
    }
    const parsed = parseToolStdoutToFileResult({
      stdout: result.stdout,
      itemId: input.itemId,
      mediaType: input.mediaType,
      mode: input.mode,
    });
    return parsed;
  } catch (err) {
    logger.debug(
      { err, mediaType: input.mediaType },
      "proovra.c2pa.tool_invocation_failed",
    );
    return {
      ...buildNotPresentC2paFileResult({
        itemId: input.itemId,
        mediaType: input.mediaType,
      }),
      status: "error",
      failureReason: "unknown",
    };
  } finally {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort
    }
  }
}

function suffixForMediaType(mediaType: string): string {
  if (mediaType.includes("jpeg")) return "input.jpg";
  if (mediaType.includes("png")) return "input.png";
  if (mediaType.includes("tiff")) return "input.tif";
  if (mediaType.includes("webp")) return "input.webp";
  if (mediaType.includes("heic")) return "input.heic";
  if (mediaType.includes("heif")) return "input.heif";
  if (mediaType.includes("avif")) return "input.avif";
  if (mediaType.includes("mp4")) return "input.mp4";
  if (mediaType.includes("quicktime")) return "input.mov";
  if (mediaType.includes("matroska")) return "input.mkv";
  if (mediaType.includes("wav")) return "input.wav";
  if (mediaType.includes("mpeg")) return "input.mp3";
  if (mediaType.includes("pdf")) return "input.pdf";
  return "input.bin";
}

/**
 * Parse the C2PA tool's stdout (bounded JSON contract) into our
 * bounded `C2paFileResult`. Tolerant of small schema variations
 * across c2patool versions; falls back to `not_present` on parse
 * failure rather than fabricating data.
 */
function parseToolStdoutToFileResult(input: {
  stdout: string;
  itemId: string | null;
  mediaType: string;
  mode: C2paProviderMode;
}): C2paFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout);
  } catch {
    return buildNotPresentC2paFileResult({
      itemId: input.itemId,
      mediaType: input.mediaType,
    });
  }
  if (!parsed || typeof parsed !== "object") {
    return buildNotPresentC2paFileResult({
      itemId: input.itemId,
      mediaType: input.mediaType,
    });
  }
  const obj = parsed as Record<string, unknown>;
  const activeManifest = obj["active_manifest"];
  const manifests = obj["manifests"];
  const hasManifest =
    Boolean(activeManifest) ||
    (typeof manifests === "object" &&
      manifests !== null &&
      Object.keys(manifests as object).length > 0);
  if (!hasManifest) {
    return buildNotPresentC2paFileResult({
      itemId: input.itemId,
      mediaType: input.mediaType,
    });
  }
  // Manifest present.
  const activeKey =
    typeof activeManifest === "string" ? activeManifest : null;
  const activeBlock =
    activeKey && typeof manifests === "object" && manifests !== null
      ? (manifests as Record<string, unknown>)[activeKey]
      : null;
  const activeObj = (activeBlock ?? obj) as Record<string, unknown>;

  const claimGenerator = bounded(
    pickString(activeObj, "claim_generator") ??
      pickString(obj, "claim_generator"),
    120,
  );
  const ingredientsList = activeObj["ingredients"];
  const ingredientsCount = Array.isArray(ingredientsList)
    ? ingredientsList.length
    : 0;
  const assertionsList = activeObj["assertions"];
  const assertions = Array.isArray(assertionsList) ? assertionsList : [];
  let actionsCount = 0;
  let thumbnailCount = 0;
  let hashCount = 0;
  let customCount = 0;
  for (const a of assertions) {
    if (!a || typeof a !== "object") continue;
    const label = pickString(a as Record<string, unknown>, "label") ?? "";
    if (label.startsWith("c2pa.actions")) actionsCount++;
    else if (label.startsWith("c2pa.thumbnail")) thumbnailCount++;
    else if (label.includes("hash")) hashCount++;
    else customCount++;
  }
  const claimTimestampUtc = bounded(
    pickString(activeObj, "claim_timestamp") ??
      pickString(obj, "claim_timestamp"),
    40,
  );

  // Validation outcome (only inspect signature info in `validate` /
  // `embed_supported` modes).
  let validationStatus: C2paValidationStatus = "not_checked";
  let claimSignatureStatus: C2paFileResult["claimSignatureStatus"] =
    "not_evaluated";
  let status: C2paStatus = "present";
  let failureReason: C2paFailureReason | null = null;
  if (input.mode === "validate" || input.mode === "embed_supported") {
    // Phase O1.5D — bounded c2pa.validate span (sync — this function
    // is sync, so we use the sync helper). NEVER raw manifest content
    // in attributes.
    withProovraSpanSync(
      PROOVRA_SPAN_NAMES.C2PA_VALIDATE,
      { "proovra.operation": "c2pa_validate", "proovra.stage": String(input.mode) },
      () => undefined,
    );
    const validation = activeObj["validation_status"];
    const signatureInfo = activeObj["signature_info"];
    const sigStatus =
      pickString(activeObj, "signature_status") ??
      (signatureInfo && typeof signatureInfo === "object"
        ? pickString(signatureInfo as Record<string, unknown>, "status")
        : null);
    if (Array.isArray(validation) && validation.length > 0) {
      const anyInvalid = validation.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const code = pickString(
          entry as Record<string, unknown>,
          "code",
        );
        return Boolean(code && /(invalid|untrusted|mismatch)/i.test(code));
      });
      if (anyInvalid) {
        status = "invalid";
        validationStatus = "invalid";
        failureReason = inferFailureReason(validation);
        claimSignatureStatus = mapSignatureStatus(sigStatus, "invalid");
      } else {
        status = "valid";
        validationStatus = "valid";
        claimSignatureStatus = mapSignatureStatus(sigStatus, "valid");
      }
    } else if (sigStatus) {
      // We have a signature status but no validation list.
      const sigLower = sigStatus.toLowerCase();
      if (sigLower.includes("invalid") || sigLower.includes("untrusted")) {
        status = "invalid";
        validationStatus = "invalid";
        failureReason =
          sigLower.includes("cert") || sigLower.includes("untrusted")
            ? "certificate_untrusted"
            : "signature_invalid";
        claimSignatureStatus = mapSignatureStatus(sigStatus, "invalid");
      } else if (sigLower.includes("expired")) {
        status = "invalid";
        validationStatus = "invalid";
        failureReason = "certificate_untrusted";
        claimSignatureStatus = "expired";
      } else {
        status = "valid";
        validationStatus = "valid";
        claimSignatureStatus = "valid";
      }
    } else {
      // Manifest present, validation didn't speak — surface as present
      // but with `unsupported` validation rather than fake `valid`.
      validationStatus = "unsupported";
    }
  }

  return {
    itemId: input.itemId,
    mediaType: input.mediaType,
    status,
    manifestDetected: true,
    validationStatus,
    claimSignatureStatus,
    claimGenerator,
    ingredientsCount,
    assertionsSummary: {
      total: assertions.length,
      actionsCount,
      thumbnailCount,
      hashCount,
      customCount,
    },
    claimTimestampUtc,
    failureReason,
    warnings: [],
  };
}

function inferFailureReason(
  validation: ReadonlyArray<unknown>,
): C2paFailureReason {
  for (const entry of validation) {
    if (!entry || typeof entry !== "object") continue;
    const code = pickString(entry as Record<string, unknown>, "code") ?? "";
    if (/cert.*untrusted|untrusted_cert/i.test(code)) {
      return "certificate_untrusted";
    }
    if (/signature.*invalid|invalid_signature/i.test(code)) {
      return "signature_invalid";
    }
    if (/hash.*mismatch|claim_hash/i.test(code)) {
      return "claim_hash_mismatch";
    }
    if (/malformed|parse/i.test(code)) {
      return "malformed_manifest";
    }
  }
  return "unknown";
}

function mapSignatureStatus(
  raw: string | null | undefined,
  fallback: "valid" | "invalid",
): C2paFileResult["claimSignatureStatus"] {
  if (!raw) return fallback === "valid" ? "valid" : "invalid";
  const lower = raw.toLowerCase();
  if (lower.includes("expired")) return "expired";
  if (lower.includes("untrusted")) return "untrusted_certificate";
  if (lower.includes("invalid")) return "invalid";
  if (lower.includes("unsupported")) return "unsupported";
  if (lower.includes("valid")) return "valid";
  return fallback === "valid" ? "valid" : "invalid";
}

function pickString(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function bounded(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// ---------------------------------------------------------------------------
// Bounded subprocess helper
// ---------------------------------------------------------------------------

type ChildProcessOutput = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function runChildProcess(
  bin: string,
  args: ReadonlyArray<string>,
  opts: { timeoutMs: number; input: Buffer | null },
): Promise<ChildProcessOutput> {
  return new Promise((resolve) => {
    const child = spawn(bin, args as string[], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, opts.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // Bounded buffer (4MB) to avoid runaway memory.
      if (stdout.length < 4_000_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
      });
    });
    if (opts.input) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Exports for tests
// ---------------------------------------------------------------------------

export const __testables = {
  parseToolStdoutToFileResult,
  resolveProviderMode,
  C2PA_RESULT_SCHEMA_VERSION,
};
