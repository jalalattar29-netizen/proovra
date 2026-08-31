import type { AnalyticsEventName } from "@proovra/shared";

import { apiFetch } from "./api";
import { hasAnalyticsConsent } from "./consent";
import { initSentry } from "./sentry";

type AnalyticsMetadataValue = string | number | boolean | null;
export type AnalyticsMetadata = Record<string, AnalyticsMetadataValue>;

let analyticsInitialized = false;

function getVisitorId(): string {
  if (typeof window === "undefined") return "server";

  let id = localStorage.getItem("visitor_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("visitor_id", id);
  }
  return id;
}

function getSessionId(): string {
  if (typeof window === "undefined") return "server";

  let id = sessionStorage.getItem("session_id");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("session_id", id);
  }
  return id;
}

function normalizePath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const value = pathname.trim();
  if (!value) return null;
  return value.startsWith("/") ? value : `/${value}`;
}

function getRouteType(pathname: string | null | undefined): string {
  const path = normalizePath(pathname);
  if (!path) return "unknown";

  if (path.startsWith("/admin")) return "admin";
  if (path.startsWith("/auth")) return "auth";
  if (path.startsWith("/api")) return "api";

  if (
    path === "/home" ||
    path.startsWith("/capture") ||
    path.startsWith("/cases") ||
    path.startsWith("/teams") ||
    path.startsWith("/reports") ||
    path.startsWith("/billing") ||
    path.startsWith("/settings")
  ) {
    return "app";
  }

  return "public";
}

function humanizeEventType(eventType: string): string {
  return eventType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function classifyEventClass(eventType: string): string {
  if (eventType === "page_view") return "navigation";
  if (eventType === "login_completed" || eventType === "register_completed") {
    return "auth";
  }
  if (eventType === "evidence_created") return "evidence";
  if (eventType === "report_generated") return "report";
  return "custom";
}

function buildDefaultMetadata(
  eventType: string,
  pathname: string | null,
  extra?: AnalyticsMetadata
): AnalyticsMetadata {
  return {
    routeType: getRouteType(pathname),
    displayLabel: humanizeEventType(eventType),
    eventClass: classifyEventClass(eventType),
    severity: "info",
    ...extra,
  };
}

export async function initAnalytics(): Promise<void> {
  if (typeof window === "undefined") return;
  if (analyticsInitialized) return;
  if (!hasAnalyticsConsent()) return;

  analyticsInitialized = true;

  try {
    initSentry();
    console.info("[analytics] optional services initialized");
  } catch (error) {
    console.warn("[analytics] initialization failed", error);
  }
}

/**
 * Send one analytics event, if — and only if — the visitor consented.
 *
 * `eventType` is typed against the SHARED ingest allowlist rather than
 * `string`, and that is the whole point of the type. This function used to
 * take any string, so `trackEvent("page_view")` compiled cleanly while the
 * API's `z.enum(ANALYTICS_EVENT_NAMES)` answered 422 — the two ends of one
 * contract disagreeing with nothing in between to notice. Now the client
 * cannot name an event the route would refuse, because it is the same list.
 */
export async function trackEvent(
  eventType: AnalyticsEventName,
  metadata?: AnalyticsMetadata,
  options?: { pathname?: string | null; referrer?: string | null }
): Promise<void> {
  if (!hasAnalyticsConsent()) return;

  try {
    const pathname = normalizePath(
      options?.pathname ?? (typeof window !== "undefined" ? window.location.pathname : null)
    );

    const referrer =
      options?.referrer ?? (typeof document !== "undefined" ? document.referrer : null);

    await apiFetch("/v1/analytics/track", {
      method: "POST",
      body: JSON.stringify({
        eventType,
        visitorId: getVisitorId(),
        sessionId: getSessionId(),
        path: pathname,
        referrer: referrer || null,
        metadata: buildDefaultMetadata(eventType, pathname, metadata),
      }),
    });
  } catch (e) {
    console.error("Analytics error", e);
  }
}