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
        metadata: metadata ?? undefined,
      }),
    });
  } catch (e) {
    console.error("Analytics error", e);
  }
}