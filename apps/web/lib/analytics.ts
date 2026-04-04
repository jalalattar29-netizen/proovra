import { apiFetch } from "./api";

type AnalyticsMetadataValue = string | number | boolean | null;
type AnalyticsMetadata = Record<string, AnalyticsMetadataValue>;

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

function getRouteType(pathname: string): string {
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/auth")) return "auth";
  if (pathname.startsWith("/api")) return "api";
  if (pathname.startsWith("/app")) return "app";
  return "public";
}

function humanizeEventType(eventType: string): string {
  return eventType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildDefaultMetadata(
  eventType: string,
  extra?: AnalyticsMetadata
): AnalyticsMetadata {
  const pathname =
    typeof window !== "undefined" ? window.location.pathname : "/";

  return {
    routeType: getRouteType(pathname),
    displayLabel: humanizeEventType(eventType),
    eventClass:
      eventType === "page_view"
        ? "navigation"
        : eventType === "login_completed"
        ? "auth"
        : eventType === "evidence_created"
        ? "evidence"
        : eventType === "report_generated"
        ? "report"
        : "custom",
    severity: "info",
    ...extra,
  };
}

export async function trackEvent(
  eventType: string,
  metadata?: AnalyticsMetadata
): Promise<void> {
  try {
    await apiFetch("/v1/analytics/track", {
      method: "POST",
      body: JSON.stringify({
        eventType,
        visitorId: getVisitorId(),
        sessionId: getSessionId(),
        path:
          typeof window !== "undefined"
            ? window.location.pathname
            : null,
        referrer:
          typeof document !== "undefined"
            ? document.referrer
            : null,
        metadata: buildDefaultMetadata(eventType, metadata),
      }),
    });
  } catch (e) {
    console.error("Analytics error", e);
  }
}