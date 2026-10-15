import * as Sentry from "@sentry/react-native";
import {
  scrubTelemetryBreadcrumb,
  scrubTelemetryEvent,
  scrubTelemetryValue,
} from "@proovra/shared";

let sentryReady = false;

/**
 * AUD-022 — the app applies the ONE shared scrubber (`@proovra/shared`
 * telemetry-scrub) with the client identifier policy, the same one the web
 * applies. It used to scrub only request URLs/headers and breadcrumb DATA, so a
 * breadcrumb message, `extra`, `user`, an exception value or the context passed
 * to `captureException` reached Sentry verbatim. A scrubbing failure now drops
 * the event instead of sending it raw.
 */
const SCRUB = { identifiers: true } as const;

export function mobileSentryBeforeBreadcrumb<T>(breadcrumb: T): T | null {
  return scrubTelemetryBreadcrumb(breadcrumb, SCRUB);
}

export function mobileSentryBeforeSend<T>(event: T): T | null {
  return scrubTelemetryEvent(event, SCRUB);
}

/**
 * Crash telemetry. No-op (never throws) when EXPO_PUBLIC_SENTRY_DSN is unset, so
 * a missing/optional telemetry config can never itself crash the app.
 */
export function initSentry() {
  try {
    const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    if (!dsn || sentryReady) return;
    Sentry.init({
      dsn,
      environment: process.env.EXPO_PUBLIC_ENV ?? process.env.NODE_ENV ?? "production",
      release: process.env.EXPO_PUBLIC_RELEASE,
      tracesSampleRate: 0,
      // Never attach IP, cookies, request bodies or captured screen content.
      sendDefaultPii: false,
      beforeBreadcrumb: mobileSentryBeforeBreadcrumb,
      beforeSend: mobileSentryBeforeSend,
    });
    sentryReady = true;
  } catch {
    // Telemetry setup failure must not take the app down.
    sentryReady = false;
  }
}

export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (!sentryReady) return;
  if (context) {
    const safeContext = scrubTelemetryValue(context, SCRUB) as Record<string, unknown>;
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
