import * as Sentry from "@sentry/node";

let sentryReady = false;

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (sentryReady) return;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0,
  });
  sentryReady = true;
}

export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (!sentryReady) return;
  if (context) {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value);
      }
      Sentry.captureException(err);
    });
    return;
  }
  Sentry.captureException(err);
}
