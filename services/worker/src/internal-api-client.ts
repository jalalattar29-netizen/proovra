/**
 * Wave 5 — Worker → API internal callback client.
 *
 * The worker Docker image (services/worker/Dockerfile, Phase 31.22)
 * deliberately does NOT copy `services/api/src` — only
 * `services/api/prisma` is copied for tool-time `prisma generate`.
 * That means the worker CANNOT statically (or dynamically) import
 * from `../../api/src/...`: the tsconfig.build.json rootDir is
 * `services/worker/src`, so cross-package paths are out-of-rootDir
 * (TS refuses to emit), AND at runtime the container has no
 * `/app/services/api/src` directory for `import()` to resolve against.
 *
 * The fix is the same pattern the reviewer-ops worker already uses
 * (services/worker/src/reviewer-ops/reviewer-reconciliation.worker.ts):
 * the worker speaks to the API over HTTP via the global `fetch`
 * (Node 18+). Authentication is a bearer-style internal-service
 * token (`X-Internal-Service-Token`), constant-time-compared on the
 * API side.
 *
 * Hard contract for this client:
 *
 *   - NEVER throws on a 2xx response — returns `{ success, ... }`.
 *   - NEVER throws on a 4xx response — returns
 *     `{ success: false, error: 'bad_request_<status>' }`. 4xx is
 *     a permanent failure for our shape (malformed body, missing
 *     evidence, unauthorized) — retrying will not change the result.
 *   - DOES throw on:
 *       * 5xx HTTP — transient server error; BullMQ retries with
 *         backoff.
 *       * network error / DNS / connection refused — transient.
 *       * AbortError (timeout) — transient.
 *     The worker branch catches these throws ONLY if the producer
 *     wants no-retry (it doesn't; see the processor). For the OCR /
 *     transcript branches, the throw bubbles to BullMQ which applies
 *     the queue's exponential backoff.
 *   - NEVER logs the token. The Authorization header value never
 *     reaches a log line.
 *   - Bounded timeout: 300 seconds. Azure DI on a multi-page PDF
 *     takes 60-120s; Deepgram on long-form audio can take 30-90s.
 *     300s gives generous headroom without letting a stuck remote
 *     hang the queue indefinitely.
 */

import { logger } from "./logger.js";

export type CallInternalMediaIntelligenceExtractInput = {
  teamId: string;
  evidenceId: string;
  kind: "ocr_azure" | "transcript_deepgram";
  runId?: string | null;
};

export type CallInternalMediaIntelligenceExtractResult = {
  success: boolean;
  partsProcessed: number;
  recordsCreated: number;
  extractedTextChars: number;
  error?: string;
};

const INTERNAL_API_EXTRACT_PATH = "/v1/internal/media-intelligence/extract";

// 300 seconds. Provider operations are slow by nature; the BullMQ
// job-level lock duration is configured elsewhere — this is the
// per-HTTP-call ceiling.
const DEFAULT_TIMEOUT_MS = 300_000;

function apiBaseUrl(): string {
  const v =
    process.env.INTERNAL_API_URL?.trim() ||
    process.env.INTERNAL_API_BASE_URL?.trim() ||
    process.env.API_BASE_URL?.trim() ||
    "";
  return v.replace(/\/+$/, "");
}

function internalServiceToken(): string {
  // Read on every call so a hot rotation via secret manager picks
  // up without a worker restart.
  return process.env.INTERNAL_SERVICE_TOKEN?.trim() || "";
}

function boundedString(v: unknown, max: number, fallback: string): string {
  if (typeof v === "string") return v.slice(0, max);
  return fallback;
}

function toNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Invoke the API's internal extract endpoint.
 *
 * Throws on transient HTTP errors (5xx, network, timeout) — BullMQ
 * applies exponential backoff. Returns `{ success: false, error }`
 * on permanent failures (4xx, evidence not found, provider refused
 * by budget/policy) so the worker can mark the run FAILED without
 * letting BullMQ infinitely retry a structural problem.
 */
export async function callInternalMediaIntelligenceExtract(
  input: CallInternalMediaIntelligenceExtractInput,
  options: { timeoutMs?: number } = {},
): Promise<CallInternalMediaIntelligenceExtractResult> {
  const baseUrl = apiBaseUrl();
  const token = internalServiceToken();

  if (!baseUrl) {
    // Configuration error — treat as permanent for this job. The
    // worker should not infinitely retry while the operator fixes
    // the env. The run gets marked FAILED with a bounded reason.
    return {
      success: false,
      partsProcessed: 0,
      recordsCreated: 0,
      extractedTextChars: 0,
      error: "internal_api_url_not_configured",
    };
  }
  if (!token) {
    return {
      success: false,
      partsProcessed: 0,
      recordsCreated: 0,
      extractedTextChars: 0,
      error: "internal_service_token_not_configured",
    };
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${baseUrl}${INTERNAL_API_EXTRACT_PATH}`;
  const body = JSON.stringify({
    teamId: input.teamId,
    evidenceId: input.evidenceId,
    kind: input.kind,
    runId: input.runId ?? null,
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": token,
      },
      body,
      signal: controller.signal,
    });

    if (response.status >= 500) {
      // Transient — throw so BullMQ retries with exponential backoff.
      throw new Error(
        `internal_extract_http_${response.status}`,
      );
    }

    let payload: Record<string, unknown> | null = null;
    try {
      const text = await response.text();
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }

    if (response.status >= 400) {
      // 4xx — permanent for this shape. Do NOT throw.
      const errMsg =
        payload && typeof payload.error === "string"
          ? payload.error
          : `bad_request_${response.status}`;
      return {
        success: false,
        partsProcessed: 0,
        recordsCreated: 0,
        extractedTextChars: 0,
        error: boundedString(errMsg, 240, "bad_request"),
      };
    }

    if (!payload) {
      return {
        success: false,
        partsProcessed: 0,
        recordsCreated: 0,
        extractedTextChars: 0,
        error: "internal_extract_empty_response",
      };
    }

    const success = payload.success === true;
    const result: CallInternalMediaIntelligenceExtractResult = {
      success,
      partsProcessed: toNumber(payload.partsProcessed),
      recordsCreated: toNumber(payload.recordsCreated),
      extractedTextChars: toNumber(payload.extractedTextChars),
    };
    if (!success) {
      result.error = boundedString(
        payload.error,
        240,
        "extraction_failed",
      );
    }
    return result;
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      // Bounded log — never include the token.
      logger.warn(
        {
          teamId: input.teamId,
          evidenceId: input.evidenceId,
          kind: input.kind,
          timeoutMs,
        },
        "internal_api_client.extract_timeout",
      );
      // Transient — throw so BullMQ retries.
      throw new Error("internal_extract_timeout");
    }
    // Re-throw network / 5xx errors for BullMQ backoff. Bounded log only.
    const msg = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    logger.warn(
      {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        kind: input.kind,
        err: msg,
      },
      "internal_api_client.extract_transient_error",
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
