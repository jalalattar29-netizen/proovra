import type { FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";
import {
  classifyRouteType,
  normalizeRoutePath,
} from "../lib/route-classification.js";

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const value = headers[name];

  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeDecodeMojibake(value: string | null): string | null {
  if (!value) return null;

  try {
    if (/[ÃÂÐÑØÙÚÛÜÝÞß]/.test(value)) {
      return Buffer.from(value, "latin1").toString("utf8");
    }
  } catch {
    // noop
  }

  return value;
}

export function normalizeCountryCode(value: string | null): string | null {
  if (!value) return null;

  const v = value.trim().toUpperCase();
  if (!v) return null;

  return v.slice(0, 8);
}

export function normalizeCity(value: string | null): string | null {
  const decoded = safeDecodeMojibake(value);
  if (!decoded) return null;

  const normalized = decoded
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 160);

  return normalized || null;
}

export function cleanDisplayCity(value: string | null): string | null {
  const decoded = safeDecodeMojibake(value);
  return decoded?.trim() ? decoded.trim() : null;
}

const NAVIGATION_EVENTS = new Set<string>([
  "page_view",
  "pricing_page_viewed",
  "billing_overview_viewed",
  "dashboard_viewed",
  "admin_dashboard_viewed",
]);

const AUTH_EVENTS = new Set<string>([
  "login_completed",
  "register_completed",
  "password_reset_completed",
  "logout_completed",
]);

const EVIDENCE_EVENTS = new Set<string>([
  "evidence_created",
  "evidence_uploaded",
  "evidence_completed",
  "evidence_locked",
  "evidence_archived",
  "evidence_restored",
  "evidence_deleted",
  "evidence_delete_restored",
]);

const REPORT_EVENTS = new Set<string>([
  "report_generated",
  "report_downloaded",
  "verification_package_generated",
  "verification_package_downloaded",
]);

const BILLING_EVENTS = new Set<string>([
  "billing_checkout_started",
  "billing_checkout_redirected",
  "billing_checkout_completed",
  "billing_payment_succeeded",
  "billing_payment_failed",
  "billing_payment_refunded",
  "billing_subscription_created",
  "billing_subscription_updated",
  "billing_subscription_canceled",
  "billing_plan_changed",
  "billing_credits_added",
  "billing_credits_consumed",
  "team_plan_activated",
  "team_plan_canceled",
  "team_seat_limit_reached",
  "workspace_storage_limit_reached",
  "workspace_storage_near_limit",
]);

const TEAM_EVENTS = new Set<string>([
  "team_plan_activated",
  "team_plan_canceled",
  "team_seat_limit_reached",
  "team_member_invited",
  "team_member_joined",
  "team_member_removed",
]);

const WARNING_EVENTS = new Set<string>([
  "workspace_storage_near_limit",
  "billing_payment_failed",
  "billing_subscription_canceled",
]);

const CRITICAL_EVENTS = new Set<string>([
  "workspace_storage_limit_reached",
  "team_seat_limit_reached",
]);

const EVENT_LABELS: Record<string, string> = {
  page_view: "Page View",
  pricing_page_viewed: "Pricing Page Viewed",
  billing_overview_viewed: "Billing Overview Viewed",
  login_completed: "Login Completed",
  register_completed: "Registration Completed",
  evidence_created: "Evidence Created",
  evidence_uploaded: "Evidence Uploaded",
  evidence_completed: "Evidence Completed",
  evidence_locked: "Evidence Locked",
  evidence_archived: "Evidence Archived",
  evidence_restored: "Evidence Restored",
  evidence_deleted: "Evidence Deleted",
  evidence_delete_restored: "Evidence Restored From Trash",
  report_generated: "Report Generated",
  report_downloaded: "Report Downloaded",
  verification_package_generated: "Verification Package Generated",
  verification_package_downloaded: "Verification Package Downloaded",
  billing_checkout_started: "Billing Checkout Started",
  billing_checkout_redirected: "Billing Checkout Redirected",
  billing_checkout_completed: "Billing Checkout Completed",
  billing_payment_succeeded: "Billing Payment Succeeded",
  billing_payment_failed: "Billing Payment Failed",
  billing_payment_refunded: "Billing Payment Refunded",
  billing_subscription_created: "Subscription Created",
  billing_subscription_updated: "Subscription Updated",
  billing_subscription_canceled: "Subscription Canceled",
  billing_plan_changed: "Plan Changed",
  billing_credits_added: "Credits Added",
  billing_credits_consumed: "Credits Consumed",
  team_plan_activated: "Team Plan Activated",
  team_plan_canceled: "Team Plan Canceled",
  team_seat_limit_reached: "Team Seat Limit Reached",
  workspace_storage_limit_reached: "Workspace Storage Limit Reached",
  workspace_storage_near_limit: "Workspace Storage Near Limit",
};

export function classifyEventClass(eventType: string): string {
  const normalized = eventType.trim().toLowerCase();

  if (NAVIGATION_EVENTS.has(normalized)) return "navigation";
  if (AUTH_EVENTS.has(normalized)) return "auth";
  if (EVIDENCE_EVENTS.has(normalized)) return "evidence";
  if (REPORT_EVENTS.has(normalized)) return "report";
  if (TEAM_EVENTS.has(normalized)) return "team";
  if (BILLING_EVENTS.has(normalized)) return "billing";

  return "custom";
}

export function classifySeverity(eventType: string): string {
  const normalized = eventType.trim().toLowerCase();

  if (CRITICAL_EVENTS.has(normalized)) return "critical";
  if (WARNING_EVENTS.has(normalized)) return "warning";
  return "info";
}

export function humanizeEventType(eventType: string): string {
  const normalized = eventType.trim().toLowerCase();

  if (EVENT_LABELS[normalized]) {
    return EVENT_LABELS[normalized];
  }

  return normalized
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function readRequestPath(req?: FastifyRequest): string | null {
  if (!req) return null;

  const url = req.url || "";
  const qIndex = url.indexOf("?");

  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

function readGeoFromRequest(req?: FastifyRequest): {
  countryRaw: string | null;
  countryCode: string | null;
  city: string | null;
  cityNormalized: string | null;
  region: string | null;
  userAgent: string | null;
} {
  if (!req) {
    return {
      countryRaw: null,
      countryCode: null,
      city: null,
      cityNormalized: null,
      region: null,
      userAgent: null,
    };
  }

  const countryRaw =
    readHeader(req.headers, "cf-ipcountry") ??
    readHeader(req.headers, "x-vercel-ip-country");

  const cityRaw =
    readHeader(req.headers, "cf-ipcity") ??
    readHeader(req.headers, "x-vercel-ip-city");

  const region =
    readHeader(req.headers, "cf-region") ??
    readHeader(req.headers, "cf-region-code") ??
    readHeader(req.headers, "x-vercel-ip-country-region");

  const userAgent = readHeader(req.headers, "user-agent");

  return {
    countryRaw,
    countryCode: normalizeCountryCode(countryRaw),
    city: cleanDisplayCity(cityRaw),
    cityNormalized: normalizeCity(cityRaw),
    region,
    userAgent,
  };
}

async function upsertAnalyticsSession(params: {
  db: PrismaClient;
  sessionId: string;
  visitorId: string;
  userId: string | null;
  path: string | null;
  routeType: string;
  countryRaw: string | null;
  countryCode: string | null;
  city: string | null;
  cityNormalized: string | null;
  userAgent: string | null;
}) {
  const existing = await params.db.analyticsSession.findUnique({
    where: { id: params.sessionId },
    select: {
      id: true,
      userId: true,
      country: true,
      countryCode: true,
      city: true,
      cityNormalized: true,
      routeType: true,
      landingPath: true,
      device: true,
      browser: true,
    },
  });

  if (!existing) {
    await params.db.analyticsSession.create({
      data: {
        id: params.sessionId,
        visitorId: params.visitorId,
        userId: params.userId,
        country: params.countryRaw,
        countryCode: params.countryCode,
        city: params.city,
        cityNormalized: params.cityNormalized,
        routeType: params.routeType,
        landingPath: params.path,
        device: params.userAgent,
        browser: params.userAgent,
      },
    });

    return;
  }

  await params.db.analyticsSession.update({
    where: { id: params.sessionId },
    data: {
      lastSeenAt: new Date(),
      ...(existing.userId ? {} : { userId: params.userId ?? undefined }),
      ...(existing.country ? {} : { country: params.countryRaw ?? undefined }),
      ...(existing.countryCode
        ? {}
        : { countryCode: params.countryCode ?? undefined }),
      ...(existing.city ? {} : { city: params.city ?? undefined }),
      ...(existing.cityNormalized
        ? {}
        : { cityNormalized: params.cityNormalized ?? undefined }),
      ...(!existing.routeType || existing.routeType === "unknown"
        ? { routeType: params.routeType }
        : {}),
      ...(!existing.landingPath ? { landingPath: params.path ?? undefined } : {}),
      ...(existing.device ? {} : { device: params.userAgent ?? undefined }),
      ...(existing.browser ? {} : { browser: params.userAgent ?? undefined }),
    },
  });
}

type AnalyticsMetadataInput =
  | Prisma.InputJsonValue
  | Record<string, unknown>
  | typeof Prisma.JsonNull
  | typeof Prisma.DbNull
  | null
  | undefined;

function toCreateMetadata(
  value: AnalyticsMetadataInput
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  if (value === Prisma.JsonNull) return Prisma.JsonNull;
  if (value === Prisma.DbNull) return Prisma.DbNull;

  return JSON.parse(
    JSON.stringify(value, (_key, currentValue) => {
      if (typeof currentValue === "bigint") {
        return currentValue.toString();
      }
      return currentValue;
    })
  ) as Prisma.InputJsonValue;
}

export type WriteAnalyticsEventParams = {
  eventType: string;
  userId?: string | null;
  sessionId?: string | null;
  visitorId?: string | null;
  path?: string | null;
  referrer?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  severity?: string | null;
  metadata?: AnalyticsMetadataInput;
  req?: FastifyRequest;
  db?: PrismaClient;
  skipSessionUpsert?: boolean;
};

export async function writeAnalyticsEvent(
  params: WriteAnalyticsEventParams
): Promise<void> {
  const db = params.db ?? prisma;
  const geo = readGeoFromRequest(params.req);
  const normalizedPath = normalizeRoutePath(
    params.path ?? readRequestPath(params.req)
  );
  const routeType = classifyRouteType(normalizedPath);
  const sessionId = params.sessionId ?? null;
  const visitorId = params.visitorId ?? null;

  if (sessionId && visitorId && !params.skipSessionUpsert) {
    await upsertAnalyticsSession({
      db,
      sessionId,
      visitorId,
      userId: params.userId ?? null,
      path: normalizedPath,
      routeType,
      countryRaw: geo.countryRaw,
      countryCode: geo.countryCode,
      city: geo.city,
      cityNormalized: geo.cityNormalized,
      userAgent: geo.userAgent,
    });
  }

  await db.analyticsEvent.create({
    data: {
      eventType: params.eventType,
      userId: params.userId ?? null,
      sessionId: sessionId ?? `system_${params.eventType}`,
      visitorId: visitorId ?? `system_${params.userId ?? "anonymous"}`,
      path: normalizedPath,
      referrer: params.referrer ?? null,
      country: geo.countryRaw,
      countryCode: geo.countryCode,
      city: geo.city,
      cityNormalized: geo.cityNormalized,
      region: geo.region,
      routeType,
      eventClass: classifyEventClass(params.eventType),
      displayLabel: humanizeEventType(params.eventType),
      entityType: params.entityType ?? null,
      entityId: params.entityId ?? null,
      severity: params.severity ?? classifySeverity(params.eventType),
      device: geo.userAgent,
      browser: geo.userAgent,
      metadata: toCreateMetadata(params.metadata),
    },
  });
}