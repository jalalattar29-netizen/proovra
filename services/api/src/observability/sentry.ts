import * as Sentry from "@sentry/node";
// Phase P2.0B — Sentry profiling integration. The profiling sample
// rate is governed by SENTRY_PROFILES_SAMPLE_RATE (default 0.1) so
// production never accidentally profiles at 100%.
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { ZodError } from "zod";
import { isAppError } from "../errors.js";
import { readFastifyClientError } from "./fastify-client-error.js";

let sentryReady = false;

/**
 * Phase O1.3 — Sentry / OTEL coexistence.
 *
 * When our own OTEL runtime owns the global API providers
 * (TracerProvider / ContextManager / Propagator) — which it does
 * whenever `OTEL_ENABLED=true` — Sentry MUST NOT re-register them.
 * Otherwise the @opentelemetry/api emits:
 *
 *     Attempted duplicate registration of API: trace / propagation / context
 *
 * in production and silently invalidates one of the two providers.
 *
 * `skipOpenTelemetrySetup: true` is the bounded Sentry v10 escape
 * hatch documented at https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/custom-setup/
 * that keeps:
 *   - error/event reporting (`Sentry.captureException`, the DSN
 *     transport, the worker's exception pipeline),
 *   - `beforeSend` / `beforeSendTransaction` scrubbing,
 *   - sample-rate env handling,
 *   - per-service `serverName` pinning,
 * while skipping the global OTEL provider / propagator / context
 * registration that our `observability/otel-bootstrap.ts` owns.
 *
 * When `OTEL_ENABLED` is false, Sentry behaves normally (registers
 * its own minimal OTEL provider) so local dev / non-OTEL deployments
 * keep current behaviour.
 *
 * NEVER read / log the env var directly into output — only use it as
 * a boolean gate.
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
  // Phase P2.0B — performance + profiling are now first-class. Sample
  // rates come from env so prod / staging can tune independently.
  // Defaults: traces 0.2, profiles 0.1. The traces sampling drives
  // the parent transaction rate; profiles are only captured for
  // sampled transactions, so the EFFECTIVE profile rate is the
  // product of the two.
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
  // OTEL_ENABLED so there is exactly one global provider
  // registration path (our `observability/otel-bootstrap.ts`).
  const skipOtelSetup = isOtelEnabled();

  Sentry.init({
    dsn,
    environment,
    release,
    serverName: "proovra-api",
    tracesSampleRate,
    profilesSampleRate,
    // Phase O1.3 — see `isOtelEnabled()` JSDoc. Skips ONLY the
    // OTEL provider/propagator/context global registration; error
    // reporting, beforeSend, beforeSendTransaction, sample rates,
    // and serverName are unaffected.
    skipOpenTelemetrySetup: skipOtelSetup,
    integrations: [nodeProfilingIntegration()],
    beforeSendTransaction(event) {
      // Scrub authorization-bearing headers from transaction
      // payloads before they leave the process. Transactions can
      // carry inbound request headers under
      // `event.request.headers`; we redact bounded names.
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
      // Mirrors the worker's beforeSend filter. See
      // services/worker/src/sentry.ts for the full justification.
      //
      // Phase 32.6.5 — also suppress "Stream isn't writeable and
      // enableOfflineQueue options is false". This ioredis error is
      // emitted by the readiness ping client when its 500ms connect
      // window expires (the ping is intentionally fast-fail per
      // Phase 32.6.1). The readiness response already conveys the
      // same signal as `redis: CRITICAL` with `redis_unreachable`
      // reasonCode; the duplicate Sentry alert was pure noise.
      //
      // Sustained outages still surface because the readiness probe
      // continues to report CRITICAL and the bounded
      // `redis.connection.error` log in worker queue.ts retains SRE
      // visibility. We are NOT silencing the underlying signal —
      // only suppressing the duplicate Sentry alert that the
      // readiness response already carries.
      const err = hint?.originalException;

      // Phase CAPTURE-HARDENING — client-input validation failures
      // are HTTP 4xx business outcomes, never server-side bugs.
      // The Fastify error handler already returns 400 + warn-log for
      // ZodError / AppError without explicitly calling
      // captureException, but a future code path (a stray try/catch,
      // an integration default-handler, a renamed wrapper) could
      // accidentally surface one. This belt-and-braces filter
      // guarantees they never reach Sentry as high-priority alerts.
      if (err instanceof ZodError) {
        return null;
      }
      if (isAppError(err) && err.statusCode >= 400 && err.statusCode < 500) {
        return null;
      }
      // Phase 400-CLIENT-ERROR-HARDENING — Fastify's own client-input
      // errors (FST_ERR_CTP_INVALID_JSON_BODY when a body claims JSON
      // and isn't, FST_ERR_CTP_BODY_TOO_LARGE, FST_ERR_CTP_INVALID_MEDIA_TYPE,
      // FST_ERR_VALIDATION, etc.) are HTTP 4xx client outcomes —
      // typically bot/scanner traffic — not server-side bugs. The
      // Fastify error handler already returns the canonical 4xx wire
      // shape without calling captureException, but a future code path
      // (a stray try/catch, an integration default-handler) could
      // re-route one here. This belt-and-braces filter guarantees they
      // never reach Sentry as high-priority alerts. Shares the same
      // duck-typed detector the setErrorHandler uses.
      if (readFastifyClientError(err) !== null) {
        return null;
      }

      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "";
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
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(safeContext)) {
        scope.setExtra(key, value);
      }
      Sentry.captureException(err);
    });
    return;
  }

  Sentry.captureException(err);
}