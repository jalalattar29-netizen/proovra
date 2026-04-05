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

export function classifyEventClass(eventType: string): string {
  if (eventType === "page_view") return "navigation";
  if (eventType === "login_completed" || eventType === "register_completed") {
    return "auth";
  }
  if (eventType === "evidence_created") return "evidence";
  if (eventType === "report_generated") return "report";

  return "custom";
}

export function classifySeverity(_eventType: string): string {
  return "info";
}

export function humanizeEventType(eventType: string): string {
  return eventType
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