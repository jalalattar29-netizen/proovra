import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

type AppendWorkerAnalyticsParams = {
  eventType: string;
  userId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  severity?: string | null;
  metadata?: Record<string, unknown>;
};

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

function toInputJsonValue(
  value: Record<string, unknown> | undefined
): Prisma.InputJsonValue {
  const normalized = JSON.parse(
    JSON.stringify(value ?? {}, (_key, currentValue) => {
      if (typeof currentValue === "bigint") {
        return currentValue.toString();
      }
      return currentValue;
    })
  ) as Prisma.InputJsonValue;

  return normalized;
}

export async function appendWorkerAnalyticsEvent(
  params: AppendWorkerAnalyticsParams
): Promise<void> {
  const userId = params.userId ?? null;
  const stableActor = userId ?? "anonymous";

  await prisma.analyticsEvent.create({
    data: {
      eventType: params.eventType,
      userId,
      sessionId: `system:${params.eventType}:${stableActor}`,
      visitorId: `system:${stableActor}`,
      path: null,
      referrer: null,
      country: null,
      countryCode: null,
      city: null,
      cityNormalized: null,
      region: null,
      routeType: "api",
      eventClass: classifyEventClass(params.eventType),
      displayLabel: humanizeEventType(params.eventType),
      entityType: params.entityType ?? null,
      entityId: params.entityId ?? null,
      severity: params.severity ?? "info",
      device: "proovra-worker",
      browser: "proovra-worker",
      metadata: toInputJsonValue(params.metadata),
    },
  });
}