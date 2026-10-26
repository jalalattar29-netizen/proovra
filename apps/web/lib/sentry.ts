"use client";

import * as Sentry from "@sentry/browser";
import {
  scrubTelemetryBreadcrumb,
  scrubTelemetryEvent,
  scrubTelemetryValue,
} from "@proovra/shared/telemetry-scrub";
import { hasAnalyticsConsent } from "./consent";
import { isSensitiveRoute } from "./privacy/redact";
import { isExpectedBusinessRefusal } from "./feedback/toSafeUserError";

let sentryReady = false;

/**
 * AUD-022 — the browser applies the ONE shared scrubber (`@proovra/shared`
 * telemetry-scrub), with identifier redaction on: the web privacy policy
 * (lib/privacy/redact.ts) never lets evidence/case ids, share/intake/portal
 * tokens, emails or JWTs leave the browser through observability.
 *
 * FAIL CLOSED. This used to `catch { return event; }` — a scrubber that threw
 * sent the RAW event. A scrubbing failure now drops the event.
 */
const SCRUB = { identifiers: true } as const;

type AnySentryEvent = {
  message?: unknown;
  request?: { url?: string };
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  user?: unknown;
};

const IGNORE_ERRORS = [
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications.",
  "ChunkLoadError",
  "Network Error",
  "Load failed",
  "Non-Error promise rejection captured",
];

function pathOf(rawUrl: string): string {
  const afterScheme = rawUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  return afterScheme.split(/[?#]/)[0] || "/";
}

export function webSentryBeforeBreadcrumb<T>(breadcrumb: T): T | null {
  return scrubTelemetryBreadcrumb(breadcrumb, SCRUB);
}

/**
 * MEMBERS RE-AUDIT AUD-05 — the expected-refusal filter lives in the hook
 * Sentry itself calls, not only in our `captureException` wrapper.
 *
 * An `ApiError` that escapes as an unhandled rejection, or is captured by
 * an integration, never passes through the wrapper; Sentry hands its original
 * exception to `beforeSend` as `hint.originalException`. A business refusal
 * (a typed 4xx, or a code-less 409/422 — second re-audit N-7) is dropped here; a 5xx, a
 * network failure or anything unexpected is kept.
 */
export function webSentryBeforeSend<T>(
  event: T,
  hint?: { originalException?: unknown },
): T | null {
  try {
    if (hint && isExpectedBusinessRefusal(hint.originalException)) return null;
    const ev = event as AnySentryEvent;
    // A route family that carries a capability in its URL (verify, share,
    // intake, portal, evidence, cases, auth callback): keep the error, but
    // strip every free-form field — there is no safe way to know the rest of
    // the payload is clean.
    const sensitive =
      typeof ev.request?.url === "string" && isSensitiveRoute(pathOf(ev.request.url));
    const scrubbed = scrubTelemetryEvent(event, SCRUB) as AnySentryEvent | null;
    if (!scrubbed) return null;
    if (sensitive) {
      scrubbed.message = "[redacted: sensitive route error]";
      scrubbed.user = undefined;
      scrubbed.extra = undefined;
      scrubbed.tags = { route: "sensitive" };
    }
    return scrubbed as T;
  } catch {
    return null;
  }
}

export function initSentry() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  if (sentryReady) return;
  if (!hasAnalyticsConsent()) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    tracePropagationTargets: [],
    ignoreErrors: IGNORE_ERRORS,
    beforeBreadcrumb: webSentryBeforeBreadcrumb,
    beforeSend: webSentryBeforeSend,
  });

  sentryReady = true;
}

export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
) {
  if (!sentryReady) return;
  if (!hasAnalyticsConsent()) return;
  // A typed 4xx refusal is the product answering "no", not an incident.
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
