/**
 * Phase 26.75 — Geo intelligence service.
 *
 * Bounded country-code lookup on top of an operator-selected provider.
 * The cache lives in `geo_intelligence_lookups` keyed by HMAC-SHA256
 * of the source IP — the raw IP is NEVER persisted.
 *
 * Provider strategy:
 *   - GEO_PROVIDER=offline_db (default): a built-in stub that returns
 *     null. The interface is shaped so an operator can wire MaxMind /
 *     IP2Location later without touching callers.
 *   - GEO_PROVIDER=stub: returns null for every lookup. Used in tests.
 *
 * Hard rules:
 *   - Country-code only. No region, no city, no coordinates.
 *   - Lookup is wrapped in a hard timeout (GEO_LOOKUP_TIMEOUT_MS).
 *     Failure modes never break auth — `null` is returned and cached
 *     for a short TTL.
 *   - The raw IP NEVER leaves this module. Callers pass the IP; we
 *     hash it once and forget.
 *   - Cache TTL is 30 days for positive results, 1h for nulls.
 */

import { createHmac } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  GEO_CACHE_NEGATIVE_TTL_HOURS,
  GEO_CACHE_TTL_DAYS,
  GEO_LOOKUP_DEFAULT_TIMEOUT_MS,
  GEO_LOOKUP_MAX_TIMEOUT_MS,
  type GeoLookupResult,
  type GeoProvider,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveSecret } from "../../config/index.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

const IP_HASH_SECRET_ENV = "IDENTITY_SECURITY_HASH_SECRET";

function hashIp(ip: string): string {
  return createHmac("sha256", resolveSecret(IP_HASH_SECRET_ENV))
    .update(ip, "utf8")
    .digest("hex");
}

function resolveProvider(): GeoProvider {
  const raw = (process.env["GEO_PROVIDER"] ?? "OFFLINE_DB").toUpperCase();
  if (raw === "MAXMIND" || raw === "IP2LOCATION" || raw === "STUB") {
    return raw;
  }
  return "OFFLINE_DB";
}

function resolveTimeoutMs(): number {
  const raw = Number(process.env["GEO_LOOKUP_TIMEOUT_MS"]);
  if (!Number.isFinite(raw) || raw <= 0) return GEO_LOOKUP_DEFAULT_TIMEOUT_MS;
  return Math.min(raw, GEO_LOOKUP_MAX_TIMEOUT_MS);
}

function geoEnabled(): boolean {
  return process.env["GEO_INTELLIGENCE_ENABLED"] !== "false";
}

// -----------------------------------------------------------------------------
// Provider interface
//
// Phase 26.75 ships only the OFFLINE_DB stub — it returns null. The
// shape is in place so an operator can wire MaxMind or IP2Location
// later without changing callers. Production deploys flip
// GEO_PROVIDER once the offline database is mounted.
// -----------------------------------------------------------------------------

type ProviderFn = (ip: string) => Promise<string | null>;

const offlineDbProvider: ProviderFn = async () => null;
const stubProvider: ProviderFn = async () => null;

function getProviderFn(provider: GeoProvider): ProviderFn {
  switch (provider) {
    case "MAXMIND":
    case "IP2LOCATION":
    case "OFFLINE_DB":
      return offlineDbProvider;
    case "STUB":
    default:
      return stubProvider;
  }
}

// -----------------------------------------------------------------------------
// Lookup with hard timeout
// -----------------------------------------------------------------------------

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<Promise<T>>([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Public — lookupCountryCode
// -----------------------------------------------------------------------------

export async function lookupCountryCode(
  input: { ip: string | null | undefined; teamId?: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<GeoLookupResult> {
  if (!geoEnabled() || !input.ip) {
    return { countryCode: null, cached: false, provider: resolveProvider() };
  }
  const provider = resolveProvider();
  const ipHash = hashIp(input.ip);

  // Cache hit?
  const cached = await client.geoIntelligenceLookup.findUnique({
    where: { ipHash },
  });
  if (cached && cached.expiresAtUtc.getTime() > Date.now()) {
    // Best-effort touch.
    client.geoIntelligenceLookup
      .update({
        where: { id: cached.id },
        data: {
          hitCount: { increment: 1 },
          lastSeenAtUtc: new Date(),
        },
      })
      .catch(() => null);
    bump("geo_lookup_total");
    bump("geo_lookup_cache_hit_total");
    return {
      countryCode: cached.countryCode,
      cached: true,
      provider: cached.provider as GeoProvider,
    };
  }

  bump("geo_lookup_total");
  const providerFn = getProviderFn(provider);
  let countryCode: string | null = null;
  try {
    countryCode = await withTimeout(providerFn(input.ip), resolveTimeoutMs(), null);
  } catch {
    countryCode = null;
    bump("geo_lookup_failure_total");
    if (input.teamId) {
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "geo_lookup_failed",
        severity: "INFO",
        details: { provider },
      });
    }
  }
  if (countryCode === null) {
    // Cache the null result with a short TTL so we don't pound the
    // provider on repeated lookups for an unresolvable IP.
    bump("geo_lookup_timeout_total");
  }

  const expiresAtUtc = new Date(
    Date.now() +
      (countryCode
        ? GEO_CACHE_TTL_DAYS * 86400_000
        : GEO_CACHE_NEGATIVE_TTL_HOURS * 3600_000),
  );

  try {
    await client.geoIntelligenceLookup.upsert({
      where: { ipHash },
      update: {
        countryCode,
        provider,
        expiresAtUtc,
        lastSeenAtUtc: new Date(),
      },
      create: {
        ipHash,
        countryCode,
        provider,
        expiresAtUtc,
      },
    });
  } catch {
    /* best-effort */
  }

  return { countryCode, cached: false, provider };
}

// -----------------------------------------------------------------------------
// sweepGeoCache — cron-driven cleanup of expired rows.
// -----------------------------------------------------------------------------

export async function sweepGeoCache(
  client: PrismaClient = defaultPrisma,
): Promise<{ swept: number; remaining: number }> {
  const result = await client.geoIntelligenceLookup.deleteMany({
    where: { expiresAtUtc: { lt: new Date() } },
  });
  const remaining = await client.geoIntelligenceLookup.count();
  setGauge("geo_cache_size", remaining);
  const swept = (result as unknown as { count?: number }).count ?? 0;
  return { swept, remaining };
}

// -----------------------------------------------------------------------------
// Geo anomaly emit — convenience helper invoked from the suspicious-
// session detector when we observe a country change. The detector
// itself stays in Phase 26.5; this helper just emits the SecurityEvent.
// -----------------------------------------------------------------------------

export function emitGeoAnomaly(
  input: {
    teamId: string;
    userId: string;
    sessionId: string;
    fromCountryCode: string | null;
    toCountryCode: string;
    minutesApart: number;
  },
): void {
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "geo_anomaly_detected",
    severity: input.minutesApart < 60 ? "HIGH" : "WARNING",
    details: {
      sessionId: input.sessionId,
      subjectUserId: input.userId,
      fromCountryCode: input.fromCountryCode,
      toCountryCode: input.toCountryCode,
      minutesApart: input.minutesApart,
    },
  });
}
