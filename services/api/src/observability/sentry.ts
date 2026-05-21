import * as Sentry from "@sentry/node";

let sentryReady = false;

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

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0,
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