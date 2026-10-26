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

/**
 * IS THIS AN EXPECTED BUSINESS REFUSAL? (members re-audit AUD-05 / defect 19)
 *
 * The same rule the web applies (apps/web/lib/feedback/toSafeUserError.ts,
 * second re-audit N-7): a 4xx with a typed refusal code is the product saying
 * "no" — a seat limit, a permission, a lifecycle state — and has its own copy
 * on screen; a code-less 409 or 422 is a validation / state conflict the route
 * has not typed yet. Neither is an incident.
 * Still reported: a code-less 401 / 403 / 404 (an auth regression, a removed
 * or mistyped route), any other code-less 4xx (400, 405, 413, 415 …), every
 * 5xx, network failures (no status), and anything that is not an API error.
 *
 * THIRD RE-AUDIT N-7 — "code-less" also covers the codes that NEVER mean a
 * business refusal: the transport's placeholders (`API_ERROR` = "the body
 * carried no code", `NETWORK_ERROR`, `PARSE_ERROR`), the canonical
 * unknown-route 404 `ROUTE_NOT_FOUND`, the framework-shaped 405 / 413 / 415
 * codes, the untyped-legacy `REQUEST_REFUSED` and the server-fault codes. Each
 * is classified exactly as a code-less answer of the same status.
 * `NOT_FOUND` (a missing or concealed record), `FORBIDDEN`, `UNAUTHORIZED`,
 * `VALIDATION_ERROR`, `INVALID_INPUT`, `INVALID_REQUEST`, `BAD_REQUEST` and
 * `CONFLICT` stay expected: they are business or auth states (a client cannot
 * tell an auth regression from an expired session).
 *
 * The SAME list and the same UNAUTHORIZED rule as the web
 * (apps/web/lib/feedback/toSafeUserError.ts): an `UNAUTHORIZED` 401 counts as
 * server-typed only when it arrived in the nested `{ error: { code } }`
 * envelope. test/sentry-generic-codes-parity.test.mjs runs both classifiers
 * over every code × status × body shape and fails on any disagreement.
 */
const BUSINESS_REFUSAL_STATUSES: ReadonlySet<number> = new Set([409, 422]);

export const GENERIC_NON_BUSINESS_CODES: ReadonlySet<string> = new Set([
  "API_ERROR",
  "NETWORK_ERROR",
  "PARSE_ERROR",
  "ROUTE_NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "REQUEST_REFUSED",
  "INTERNAL_ERROR",
  "INTERNAL_SERVER_ERROR",
  "DATABASE_ERROR",
  "SCHEMA_NOT_READY",
]);

export function isExpectedBusinessRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    body?: { error?: { code?: unknown } };
  };
  const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
  if (typeof status !== "number" || status < 400 || status >= 500) return false;
  const code = typeof e.code === "string" ? e.code.trim().toUpperCase() : "";
  const nested = e.body?.error?.code;
  const serverTypedUnauthorized = typeof nested === "string" && nested.trim().length > 0;
  if (
    code &&
    !GENERIC_NON_BUSINESS_CODES.has(code) &&
    !(code === "UNAUTHORIZED" && status === 401 && !serverTypedUnauthorized)
  ) {
    return true;
  }
  return BUSINESS_REFUSAL_STATUSES.has(status);
}

/**
 * The hook Sentry calls for EVERY event — including an unhandled rejection
 * that never passed through `captureException` below. Sentry hands the
 * original exception over as `hint.originalException`; a business refusal is
 * dropped here.
 */
export function mobileSentryBeforeSend<T>(
  event: T,
  hint?: { originalException?: unknown },
): T | null {
  if (hint && isExpectedBusinessRefusal(hint.originalException)) return null;
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
  // A typed / business 4xx refusal is the product answering "no", not an incident.
  if (isExpectedBusinessRefusal(err)) return;
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
