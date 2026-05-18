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
    });
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
  if (!sentryReady) return;
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