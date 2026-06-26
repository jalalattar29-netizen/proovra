"use client";

import * as Sentry from "@sentry/browser";
import { hasAnalyticsConsent } from "./consent";
import {
  isSensitiveRoute,
  redactSensitiveText,
  redactSensitiveUrl,
} from "./privacy/redact";

let sentryReady = false;

type AnySentryEvent = {
  message?: unknown;
  request?: {
    url?: string;
    headers?: Record<string, unknown>;
    query_string?: unknown;
    cookies?: unknown;
    data?: unknown;
  };
  breadcrumbs?: Array<AnySentryBreadcrumb> | undefined;
  contexts?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  exception?: unknown;
  user?: Record<string, unknown>;
};

type AnySentryBreadcrumb = {
  type?: string;
  category?: string;
  message?: string | undefined;
  data?: Record<string, unknown> | undefined;
};

const IGNORE_ERRORS = [
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications.",
  "ChunkLoadError",
  "Network Error",
  "Load failed",
  "Non-Error promise rejection captured",
];

function sanitizeRequest(request: AnySentryEvent["request"]): void {
  if (!request) return;
  if (typeof request.url === "string") {
    request.url = redactSensitiveUrl(request.url) ?? "[redacted]";
  }
  if (request.headers && typeof request.headers === "object") {
    request.headers = redactSensitiveText(request.headers) as Record<
      string,
      unknown
    >;
  }
  // Cookies and raw query strings are dropped wholesale — Sentry doesn't need them.
  if (request.cookies !== undefined) request.cookies = "[redacted]";
  if (request.query_string !== undefined) request.query_string = "[redacted]";
  if (request.data !== undefined) {
    request.data = redactSensitiveText(request.data);
  }
}

function sanitizeBreadcrumb(b: AnySentryBreadcrumb): AnySentryBreadcrumb | null {
  const next: AnySentryBreadcrumb = { ...b };
  if (typeof next.message === "string") {
    next.message = redactSensitiveText(next.message) as string;
  }
  if (next.data && typeof next.data === "object") {
    const data = { ...next.data };
    if (typeof data.url === "string") {
      data.url = redactSensitiveUrl(data.url) ?? "[redacted]";
    }
    if (typeof data.to === "string") {
      data.to = redactSensitiveUrl(data.to) ?? "[redacted]";
    }
    if (typeof data.from === "string") {
      data.from = redactSensitiveUrl(data.from) ?? "[redacted]";
    }
    next.data = redactSensitiveText(data) as Record<string, unknown>;
  }

  // Drop navigation/fetch breadcrumbs that reference a sensitive route
  // even after redaction, to avoid any chance of leaking via raw fields.
  const referencedUrl =
    (next.data && typeof next.data.url === "string"
      ? (next.data.url as string)
      : undefined) ?? null;
  if (
    (next.category === "navigation" ||
      next.category === "fetch" ||
      next.category === "xhr") &&
    referencedUrl &&
    /\[redacted\]|\[uuid\]|\[token\]|\[jwt\]|\[email\]/.test(referencedUrl)
  ) {
    // Keep it but with even more aggressive scrubbing.
    next.message = "[redacted]";
    next.data = { url: "[redacted]" };
  }

  return next;
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
    beforeBreadcrumb(breadcrumb) {
      try {
        const cleaned = sanitizeBreadcrumb(
          breadcrumb as unknown as AnySentryBreadcrumb,
        );
        return cleaned as unknown as typeof breadcrumb;
      } catch {
        return null;
      }
    },
    beforeSend(event) {
      try {
        const ev = event as AnySentryEvent;

        // Drop entirely if originating from a route family where we have no
        // safe way to know whether the rest of the payload is clean.
        if (typeof ev.request?.url === "string") {
          const rawUrl = ev.request.url;
          // Extract path part safely.
          let pathPart = rawUrl;
          try {
            if (/^https?:\/\//i.test(rawUrl)) {
              const u = new URL(rawUrl);
              pathPart = u.pathname;
            }
          } catch {
            // ignore
          }
          if (isSensitiveRoute(pathPart)) {
            // Keep the event but strip every potentially identifying field.
            sanitizeRequest(ev.request);
            ev.message = "[redacted: sensitive route error]";
            ev.user = undefined;
            ev.tags = ev.tags ? { route: "sensitive" } : undefined;
            ev.extra = undefined;
            ev.contexts = ev.contexts
              ? (redactSensitiveText(ev.contexts) as Record<string, unknown>)
              : undefined;
            if (Array.isArray(ev.breadcrumbs)) {
              ev.breadcrumbs = ev.breadcrumbs
                .map((b) => sanitizeBreadcrumb(b))
                .filter((b): b is AnySentryBreadcrumb => b !== null);
            }
            return event;
          }
        }

        sanitizeRequest(ev.request);
        if (typeof ev.message === "string") {
          ev.message = redactSensitiveText(ev.message) as string;
        }
        if (ev.contexts) {
          ev.contexts = redactSensitiveText(ev.contexts) as Record<
            string,
            unknown
          >;
        }
        if (ev.extra) {
          ev.extra = redactSensitiveText(ev.extra) as Record<string, unknown>;
        }
        if (ev.tags) {
          ev.tags = redactSensitiveText(ev.tags) as Record<string, unknown>;
        }
        if (ev.user) {
          // Keep only opaque ids; never name/email/ip.
          const id = (ev.user as { id?: unknown }).id;
          ev.user = typeof id === "string" || typeof id === "number"
            ? { id: String(id) }
            : undefined;
        }
        if (Array.isArray(ev.breadcrumbs)) {
          ev.breadcrumbs = ev.breadcrumbs
            .map((b) => sanitizeBreadcrumb(b))
            .filter((b): b is AnySentryBreadcrumb => b !== null);
        }
        return event;
      } catch {
        return event;
      }
    },
  });

  sentryReady = true;
}

export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
) {
  if (!sentryReady) return;
  if (!hasAnalyticsConsent()) return;

  if (context) {
    const safeContext = redactSensitiveText(context) as Record<string, unknown>;
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
