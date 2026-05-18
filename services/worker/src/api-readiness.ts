/**
 * Worker startup — API readiness probe.
 *
 * The worker starts in parallel with the api process. Several startup-
 * triggered tasks (demo follow-up run, retention reconciliation run)
 * make in-cluster HTTP calls to the api. When the worker wins the
 * race, those calls hit `ECONNREFUSED` and the worker was previously
 * emitting `operational.alert` for what was actually a benign startup
 * race.
 *
 * This module:
 *   - polls a public api readiness endpoint with exponential backoff
 *     + jitter
 *   - never emits an operational alert for transient probe failures
 *   - only escalates after `maxAttempts` have elapsed (treated as
 *     sustained unavailability, not a startup race)
 *   - records probe attempts + latency in structured logs so the
 *     orchestration sequence is visible in the log stream
 *
 * Hard rules:
 *   - The probe NEVER blocks the worker's BullMQ consumer init. Job
 *     processing starts immediately; only INTERNAL startup-trigger
 *     calls wait for readiness.
 *   - Probe failure during the startup window is INFO-level, not
 *     ERROR. Sustained failure past `maxAttempts` is ERROR + one
 *     `operational.alert`.
 *   - Probe uses `AbortController` with a per-attempt timeout so a
 *     hung connection doesn't stall the worker forever.
 */

import { randomUUID } from "node:crypto";

import { logger } from "./logger.js";

export type ApiReadinessResult =
  | {
      ready: true;
      attempts: number;
      totalLatencyMs: number;
    }
  | {
      ready: false;
      attempts: number;
      totalLatencyMs: number;
      lastError: string;
    };

export type ApiReadinessOptions = {
  /** Base url of the api process. Resolved from env at the call site. */
  baseUrl: string;
  /** Catalog-bound label for the consumer that's waiting. Used for log
   *  correlation only — does not affect behavior. */
  consumer: string;
  /** Health endpoint path. Defaults to /readyz (which verifies DB) but
   *  callers can fall back to /healthz when a degraded api should
   *  still permit the call (rare). */
  path?: "/readyz" | "/healthz" | "/health";
  /** Max attempts before we declare sustained unavailability and emit
   *  an alert. Default 12 with the default 500ms initial backoff caps
   *  total wait at ~30s. */
  maxAttempts?: number;
  /** Initial backoff in ms. Doubled each attempt with jitter. */
  initialBackoffMs?: number;
  /** Cap on a single backoff sleep. */
  maxBackoffMs?: number;
  /** Per-attempt fetch timeout. */
  attemptTimeoutMs?: number;
  /** Optional readiness gauge bumper — called with the result on exit.
   *  Used to feed the metrics catalog. */
  onResult?: (result: ApiReadinessResult) => void;
  /** Optional alert emitter — only called on sustained failure. The
   *  module never imports the worker's alert helper directly so it
   *  stays testable. */
  onSustainedFailure?: (params: {
    requestId: string;
    consumer: string;
    attempts: number;
    totalLatencyMs: number;
    lastError: string;
  }) => void;
  /** Test seam — override fetch for unit tests. */
  fetchImpl?: typeof fetch;
  /** Test seam — override sleep for unit tests. */
  sleepImpl?: (ms: number) => Promise<void>;
};

const DEFAULTS = {
  maxAttempts: 12,
  initialBackoffMs: 500,
  maxBackoffMs: 5_000,
  attemptTimeoutMs: 2_000,
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextBackoff(
  attempt: number,
  initial: number,
  cap: number,
): number {
  const base = Math.min(cap, initial * 2 ** Math.max(0, attempt - 1));
  // Decorrelated jitter: pick uniformly in [base/2, base]. This keeps
  // the cohort spread out while still respecting the exponential cap.
  const jitterFloor = base / 2;
  const range = base - jitterFloor;
  return Math.floor(jitterFloor + Math.random() * range);
}

function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  impl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return impl(url, {
    method: "GET",
    signal: controller.signal,
    headers: { "x-probe-consumer": "worker" },
  }).finally(() => clearTimeout(timer));
}

/**
 * Block until the api responds 200 on the readiness endpoint, or until
 * `maxAttempts` have elapsed. The startup-triggered consumer should
 * await this BEFORE making its first call into the api.
 *
 * Returns a structured result. The caller decides what to do on
 * `!ready`. The common pattern is: skip the startup invocation, log
 * the skip, and let the cron interval pick up the next tick.
 */
export async function waitForApiReadiness(
  options: ApiReadinessOptions,
): Promise<ApiReadinessResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const initialBackoffMs =
    options.initialBackoffMs ?? DEFAULTS.initialBackoffMs;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? DEFAULTS.attemptTimeoutMs;
  const path = options.path ?? "/readyz";
  const url = `${options.baseUrl.replace(/\/+$/, "")}${path}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const correlationId = randomUUID();
  const probeStartedAt = Date.now();
  let lastError = "no_attempt_made";

  logger.info(
    {
      requestId: correlationId,
      consumer: options.consumer,
      url,
      maxAttempts,
    },
    "worker.api_readiness.probe_started",
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      const response = await fetchWithTimeout(
        url,
        attemptTimeoutMs,
        fetchImpl,
      );
      const attemptLatencyMs = Date.now() - attemptStartedAt;
      if (response.ok) {
        const totalLatencyMs = Date.now() - probeStartedAt;
        logger.info(
          {
            requestId: correlationId,
            consumer: options.consumer,
            attempt,
            attemptLatencyMs,
            totalLatencyMs,
          },
          "worker.api_readiness.probe_ready",
        );
        const result: ApiReadinessResult = {
          ready: true,
          attempts: attempt,
          totalLatencyMs,
        };
        options.onResult?.(result);
        return result;
      }
      lastError = `non_ok_status_${response.status}`;
      logger.info(
        {
          requestId: correlationId,
          consumer: options.consumer,
          attempt,
          attemptLatencyMs,
          status: response.status,
        },
        "worker.api_readiness.probe_pending",
      );
    } catch (err) {
      const attemptLatencyMs = Date.now() - attemptStartedAt;
      lastError = err instanceof Error ? err.message : String(err);
      logger.info(
        {
          requestId: correlationId,
          consumer: options.consumer,
          attempt,
          attemptLatencyMs,
          // NOTE: deliberately INFO — startup-race probe failures are
          // expected. Sustained failure (post-maxAttempts) is the only
          // ERROR.
          probeError: lastError,
        },
        "worker.api_readiness.probe_pending",
      );
    }

    if (attempt < maxAttempts) {
      const backoff = nextBackoff(
        attempt,
        initialBackoffMs,
        maxBackoffMs,
      );
      await sleepImpl(backoff);
    }
  }

  const totalLatencyMs = Date.now() - probeStartedAt;
  const result: ApiReadinessResult = {
    ready: false,
    attempts: maxAttempts,
    totalLatencyMs,
    lastError,
  };
  logger.error(
    {
      requestId: correlationId,
      consumer: options.consumer,
      attempts: maxAttempts,
      totalLatencyMs,
      lastError,
    },
    "worker.api_readiness.probe_exhausted",
  );
  options.onResult?.(result);
  options.onSustainedFailure?.({
    requestId: correlationId,
    consumer: options.consumer,
    attempts: maxAttempts,
    totalLatencyMs,
    lastError,
  });
  return result;
}

// -----------------------------------------------------------------------------
// Process-level singleton — once the api is confirmed ready once, all
// subsequent startup-triggered consumers can short-circuit. The
// scheduler INTERVAL ticks still re-probe per call if they want to be
// defensive, but the startup-race window only matters once.
// -----------------------------------------------------------------------------

type ReadinessState =
  | { kind: "unknown" }
  | { kind: "checking"; awaitedBy: Array<() => void> }
  | { kind: "ready"; firstReadyAtMs: number }
  | { kind: "failed"; lastError: string };

let processReadinessState: ReadinessState = { kind: "unknown" };

export type EnsureApiReadyOnceInput = Omit<
  ApiReadinessOptions,
  "consumer" | "onResult" | "onSustainedFailure"
> & {
  consumer: string;
  onResult?: ApiReadinessOptions["onResult"];
  onSustainedFailure?: ApiReadinessOptions["onSustainedFailure"];
};

/**
 * Coalesces concurrent readiness probes across startup-triggered
 * consumers. The first caller runs the probe; subsequent callers
 * arriving while the probe is in flight wait on the same promise.
 * Once the api is ready, future callers short-circuit immediately.
 */
export async function ensureApiReadyOnce(
  input: EnsureApiReadyOnceInput,
): Promise<ApiReadinessResult> {
  if (processReadinessState.kind === "ready") {
    return {
      ready: true,
      attempts: 0,
      totalLatencyMs: 0,
    };
  }
  if (processReadinessState.kind === "checking") {
    await new Promise<void>((resolve) => {
      if (processReadinessState.kind === "checking") {
        processReadinessState.awaitedBy.push(resolve);
      } else {
        resolve();
      }
    });
    return ensureApiReadyOnce(input);
  }
  const awaitedBy: Array<() => void> = [];
  processReadinessState = { kind: "checking", awaitedBy };
  try {
    const result = await waitForApiReadiness(input);
    processReadinessState = result.ready
      ? { kind: "ready", firstReadyAtMs: Date.now() }
      : {
          kind: "failed",
          lastError: result.ready ? "" : result.lastError,
        };
    return result;
  } finally {
    for (const resolve of awaitedBy) resolve();
  }
}

/** Test-only — reset the process singleton between unit tests. */
export function __resetProcessReadinessForTests(): void {
  processReadinessState = { kind: "unknown" };
}

/** Read-only accessor for diagnostics. */
export function getProcessReadinessState(): "unknown" | "checking" | "ready" | "failed" {
  return processReadinessState.kind;
}
