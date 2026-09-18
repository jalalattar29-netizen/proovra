import * as Sentry from "@sentry/react-native";

let sentryReady = false;

/** Redact anything that could carry a token / evidence-sensitive value. */
const REDACT_KEY = /(authorization|token|secret|password|cookie|session|bearer|api[-_]?key)/i;

function scrubUrl(url: unknown): unknown {
  if (typeof url !== "string") return url;
  try {
    const u = new URL(url);
    // Drop the query/hash entirely — intake tokens, capture ids and auth codes
    // ride there. Keep only origin + path for diagnosis.
    return `${u.origin}${u.pathname}`;
  } catch {
    // Non-URL string: strip an inline query if present.
    return url.split("?")[0];
  }
}

function scrubObject(obj: Record<string, unknown> | undefined): void {
  if (!obj) return;
  for (const key of Object.keys(obj)) {
    if (REDACT_KEY.test(key)) obj[key] = "[redacted]";
  }
}

/**
 * Crash telemetry. No-op (never throws) when EXPO_PUBLIC_SENTRY_DSN is unset, so
 * a missing/optional telemetry config can never itself crash the app. Scrubs
 * URLs (query strings), auth headers and evidence-sensitive keys before send.
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
      // Never attach request/response bodies or captured screen content.
      beforeBreadcrumb(breadcrumb) {
        if (breadcrumb?.data && typeof breadcrumb.data === "object") {
          const data = breadcrumb.data as Record<string, unknown>;
          if ("url" in data) data.url = scrubUrl(data.url);
          scrubObject(data);
        }
        return breadcrumb;
      },
      beforeSend(event) {
        try {
          if (event.request) {
            if (event.request.url) event.request.url = scrubUrl(event.request.url) as string;
            scrubObject(event.request.headers as Record<string, unknown> | undefined);
            delete event.request.data; // never ship request bodies
            delete event.request.cookies;
          }
          if (Array.isArray(event.breadcrumbs)) {
            for (const b of event.breadcrumbs) {
              if (b?.data && typeof b.data === "object") {
                const data = b.data as Record<string, unknown>;
                if ("url" in data) data.url = scrubUrl(data.url);
                scrubObject(data);
              }
            }
          }
        } catch {
          /* scrubbing must never block a crash report */
        }
        return event;
      },
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
