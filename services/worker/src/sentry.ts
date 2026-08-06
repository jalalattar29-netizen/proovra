import * as Sentry from "@sentry/node";
// Phase P2.0B — Sentry profiling on the worker. Same env knobs as
// the api so a single deployment env-block controls both.
import { nodeProfilingIntegration } from "@sentry/profiling-node";

let sentryReady = false;

/**
 * Phase O1.3 — Sentry / OTEL coexistence.
 *
 * Mirror of the API-side helper. When `OTEL_ENABLED=true`, the
 * worker's `otel-bootstrap.ts` has already registered the global
 * TracerProvider / ContextManager / Propagator. Sentry MUST NOT
 * register them again, otherwise the @opentelemetry/api emits:
 *
 *     Attempted duplicate registration of API: trace / propagation / context
 *
 * in production. `skipOpenTelemetrySetup: true` is the bounded
 * Sentry v10 escape hatch that keeps error reporting + scrubbing +
 * sample rates while skipping the duplicate global registration.
 *
 * NEVER read / log the env var into output — only use it as a
 * boolean gate.
 */
function isOtelEnabled(): boolean {
  return (process.env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true";
}

function readSampleRate(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw.length === 0) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (
      value.toLowerCase().includes("bearer ") ||
      value.toLowerCase().includes("token") ||
      value.toLowerCase().includes("secret") ||
      value.toLowerCase().includes("password")
    ) {
      return "[REDACTED]";
    }
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const lowered = key.toLowerCase();
      if (
        lowered.includes("token") ||
        lowered.includes("secret") ||
        lowered.includes("password") ||
        lowered.includes("authorization") ||
        lowered.includes("cookie")
      ) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactValue(val);
      }
    }
    return out;
  }

  return value;
}

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || sentryReady) return;
  // Phase P2.0B — env-driven sample rates + release tag.
  const tracesSampleRate = readSampleRate(
    "SENTRY_TRACES_SAMPLE_RATE",
    0.2,
  );
  const profilesSampleRate = readSampleRate(
    "SENTRY_PROFILES_SAMPLE_RATE",
    0.1,
  );
  const environment =
    (process.env.SENTRY_ENVIRONMENT ?? "").trim() ||
    process.env.NODE_ENV ||
    "development";
  const release =
    (process.env.SENTRY_RELEASE ?? "").trim() ||
    (process.env.APP_RELEASE_SHA ?? "").trim() ||
    (process.env.GIT_SHA ?? "").trim() ||
    undefined;

  // Phase O1.3 — gate Sentry's internal OTEL setup behind
  // OTEL_ENABLED so the worker has exactly one global provider
  // registration path (`otel-bootstrap.ts`).
  const skipOtelSetup = isOtelEnabled();

  Sentry.init({
    dsn,
    environment,
    release,
    serverName: "proovra-worker",
    tracesSampleRate,
    profilesSampleRate,
    // Phase O1.3 — see `isOtelEnabled()` JSDoc. Skips ONLY the
    // OTEL provider/propagator/context global registration; error
    // reporting, beforeSend, beforeSendTransaction, sample rates,
    // and serverName are unaffected.
    skipOpenTelemetrySetup: skipOtelSetup,
    integrations: [nodeProfilingIntegration()],
    beforeSendTransaction(event) {
      if (event.request?.headers) {
        const h = event.request.headers as Record<string, unknown>;
        for (const key of Object.keys(h)) {
          const k = key.toLowerCase();
          if (
            k.includes("authorization") ||
            k.includes("cookie") ||
            k.includes("token") ||
            k.includes("secret") ||
            k.includes("api-key")
          ) {
            h[key] = "[REDACTED]";
          }
        }
      }
      return event;
    },
    beforeSend(event, hint) {
      // Phase 32.6.1 — suppress transient Redis ECONNREFUSED.
      //
      // Background: production Redis container restarts (during
      // deploys, scaling, image updates) momentarily refuse
      // connections. ioredis tolerates this transparently and
      // workers resume cleanly. But every retry attempt was firing
      // a Sentry "high" alert, drowning genuine outages in noise.
      //
      // This filter drops Sentry events whose error message
      // contains the bounded `connect ECONNREFUSED` signature
      // (Node net layer). The bounded `redis.connection.error`
      // log line in queue.ts still records the event for SRE
      // visibility; we just don't escalate to Sentry.
      //
      // Sustained outages still surface because:
      //   1. The runtime-readiness probe pings Redis directly and
      //      transitions to CRITICAL after the configured timeout.
      //   2. BullMQ job failures (which throw a different error
      //      class) continue to alert as before.
      const err = hint?.originalException;
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "";
      //
      // Phase 32.6.5 — also suppress "Stream isn't writeable and
      // enableOfflineQueue options is false". This ioredis error is
      // emitted by the readiness ping client on the api side when
      // its 500ms connect window expires. The signal is already
      // carried by the readiness CRITICAL response and the bounded
      // `redis.connection.error` log line; the duplicate Sentry
      // alert was pure noise.
      if (
        message.includes("ECONNREFUSED") ||
        message.includes("Connection is closed") ||
        message.includes("Connection lost") ||
        message.includes("Stream isn't writeable")
      ) {
        return null;
      }
      return event;
    },
  });

  sentryReady = true;
}

export function captureException(
  err: unknown,
  context?: Record<string, unknown>
) {
  if (!sentryReady) return;

  if (context) {
    const safeContext = redactValue(context) as Record<string, unknown>;
    // PHASE 12 — POINT 7 (2026-08-05): a BACKGROUND failure gets its OWN trace.
    //
    // Both production worker incidents were filed under the transaction
    // `GET /health`. The tags were right — `withScope` already isolated those,
    // and `jobKind` here is the queue the failing worker instance serves — but
    // the TRANSACTION was whatever span happened to be active in the process,
    // and on a mostly-idle worker that is the health prober's. An exception
    // raised by a queue job was therefore attributed to an HTTP request that
    // had nothing to do with it, which is how a purge stack came to be filed
    // under a health check and sent the first reading of these events wrong.
    //
    // `startNewTrace` detaches from the ambient trace, `withIsolationScope`
    // stops anything set here leaking into the next capture, and the explicit
    // transaction name says which queue it actually was.
    Sentry.startNewTrace(() =>
    Sentry.withIsolationScope((scope) => {
      const jobKindTag = safeContext.jobKind;
      const queueTag = safeContext.queueName;
      if (typeof jobKindTag === "string" || typeof queueTag === "string") {
        const queue = typeof queueTag === "string" ? queueTag : jobKindTag;
        scope.setTransactionName(`queue.${String(queue).slice(0, 64)}`);
      }
      for (const [key, value] of Object.entries(safeContext)) {
        scope.setExtra(key, value);
      }
      // Phase Y — promote a handful of well-known correlation fields
      // to first-class tags so the Sentry UI groups + searches by
      // them. Tags are bounded-length strings; extras carry the rest.
      const correlationId = safeContext.correlationId;
      if (typeof correlationId === "string" && correlationId.length > 0) {
        scope.setTag("correlation_id", correlationId.slice(0, 64));
      }
      const workerId = safeContext.workerId;
      if (typeof workerId === "string" && workerId.length > 0) {
        scope.setTag("worker_id", workerId.slice(0, 64));
      }
      const jobKind = safeContext.jobKind;
      if (typeof jobKind === "string" && jobKind.length > 0) {
        scope.setTag("job_kind", jobKind.slice(0, 64));
      }
      const queueName = safeContext.queueName;
      if (typeof queueName === "string" && queueName.length > 0) {
        scope.setTag("queue_name", queueName.slice(0, 64));
      }
      Sentry.captureException(err);
    }),
    );
    return;
  }

  Sentry.captureException(err);
}

/**
 * Phase Y — register correlation IDs on the current Sentry scope BEFORE
 * any exception is thrown. Useful for long-running operations where
 * unhandled rejections later in the call stack still need the tag.
 *
 * Safe to call when Sentry is not initialized (no-op).
 */
export function setSentryCorrelationContext(input: {
  correlationId?: string | null;
  workerId?: string | null;
  jobKind?: string | null;
  queueName?: string | null;
}): void {
  // Deliberately NOT gated on `sentryReady`: setting a tag on a scope is local
  // bookkeeping with no transport behind it, and gating it would mean the
  // isolation property can only be observed in a process that has a live DSN.
  // PHASE 12 — POINT 7 (2026-08-05): writes to the CURRENT scope, which is
  // only safe INSIDE `runJobWithTelemetryContext`. Left unscoped it is the
  // defect described there: tags outlive the job that set them.
  const scope = Sentry.getCurrentScope();
  if (input.correlationId) {
    scope.setTag("correlation_id", input.correlationId.slice(0, 64));
  }
  if (input.workerId) {
    scope.setTag("worker_id", input.workerId.slice(0, 64));
  }
  if (input.jobKind) {
    scope.setTag("job_kind", input.jobKind.slice(0, 64));
  }
  if (input.queueName) {
    scope.setTag("queue_name", input.queueName.slice(0, 64));
  }
}

/**
 * PHASE 12 — POINT 7 (2026-08-05): run ONE job inside its OWN telemetry
 * context.
 *
 * WHAT THE TWO PRODUCTION WORKER EVENTS ACTUALLY SHOWED
 * ---------------------------------------------------------------------------
 * Both carried a `processPurgeDeletedEvidence` stack. One was tagged
 * `job_kind=graph-reconcile`, the other `job_kind=evidence-purge`, and BOTH
 * were filed under the transaction `GET /health`. Read literally that says the
 * health endpoint ran a purge, which is not a thing that can happen.
 *
 * Exactly one half of that is bleed, and it matters which:
 *
 *   * The TAG is sound. It comes from `captureException(err, { jobKind })` in
 *     the `failed` handler, where `jobKind` is the closure naming the queue
 *     that worker instance serves, captured inside `withScope`. It is not
 *     inherited from an earlier job.
 *   * The TRANSACTION is not set by that path at all — it is whatever span was
 *     active in the process, and on a mostly-idle worker that is the last
 *     health probe. A queue failure ends up owned by an unrelated HTTP request.
 *
 * This function closes the second half for anything captured WHILE a job runs:
 * `withIsolationScope` gives each job a fresh scope discarded when it returns,
 * and the span named here owns what is raised inside it. The `failed`-handler
 * capture happens after the job has returned, so `captureException` above
 * carries the matching fix (`startNewTrace` + an explicit transaction name).
 *
 * It is wired at ONE place: `wrapJobHandlerWithOtelContext`, the seam every
 * BullMQ handler in this worker passes through.
 */
export async function runJobWithTelemetryContext<T>(
  input: {
    jobKind: string;
    queueName: string;
    jobId?: string | null;
    correlationId?: string | null;
    workerId?: string | null;
  },
  run: () => Promise<T>,
): Promise<T> {
  // No `sentryReady` short-circuit. Scope isolation is pure context
  // management — it costs nothing when the SDK has no transport, and gating it
  // on initialisation would mean the property this function exists to provide
  // is the one thing a test could never observe.
  return Sentry.withIsolationScope(async (isolation) => {
    // The tags go on the ISOLATION scope, not the current one. An exception
    // raised deep inside a handler — or by a listener the handler started —
    // carries the isolation scope's data; a tag written to the forked current
    // scope would be gone by then, which is how a job's identity used to be
    // missing from exactly the events that needed it.
    isolation.setTag("job_kind", input.jobKind.slice(0, 64));
    isolation.setTag("queue_name", input.queueName.slice(0, 64));
    if (input.jobId) isolation.setTag("job_id", String(input.jobId).slice(0, 64));
    if (input.correlationId) {
      isolation.setTag("correlation_id", input.correlationId.slice(0, 64));
    }
    if (input.workerId) {
      isolation.setTag("worker_id", input.workerId.slice(0, 64));
    }
    return Sentry.startSpan(
      {
        name: `queue.${input.queueName}/${input.jobKind}`,
        op: "queue.process",
        forceTransaction: true,
      },
      () => run(),
    );
  });
}