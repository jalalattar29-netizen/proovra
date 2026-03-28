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