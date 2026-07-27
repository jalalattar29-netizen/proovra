/**
 * Phase 19 — Trusted device service.
 *
 * Tracks per-user trusted devices. The "device cookie" value is set
 * by the auth layer on first sign-in (a long random string); we
 * NEVER store it raw — only the HMAC-SHA256 hash. The cookie itself
 * is not the auth token; it's a long-lived correlation identifier
 * that allows us to recognise the device without persistent server
 * state in the session token.
 *
 * Operations:
 *   - markTrusted: persist (or refresh) the trusted-device row.
 *   - revokeTrustedDevice: operator action — flips status to REVOKED,
 *     audits, and emits a SecurityEvent.
 *   - revokeAllForUser: bulk revoke after a suspicious event.
 *   - isCurrentlyTrusted: pure check used by the risk evaluator + the
 *     step-up middleware.
 *
 * Privacy:
 *   - The cookie value is never persisted raw.
 *   - The IP is masked + hashed (HMAC) — the raw never lands in the
 *     row.
 *   - The UA is summarised ("Chrome on macOS") — the full string is
 *     never persisted.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  TRUSTED_DEVICE_TTL_DAYS_DEFAULT,
  TRUSTED_DEVICE_TTL_DAYS_MAX,
  isValidDeviceCookieValue,
  maskIpPreview,
  summariseUserAgent,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { hashDeviceCookieValue, hashIpAddress } from "./risk.service.js";

// -----------------------------------------------------------------------------
// markTrusted
// -----------------------------------------------------------------------------

export type MarkTrustedInput = {
  teamId: string;
  userId: string;
  deviceCookieValue: string;
  ip?: string | null;
  userAgent?: string | null;
  ttlDays?: number | null;
  actorUserId?: string | null;
  ipAddressForAudit?: string | null;
  userAgentForAudit?: string | null;
};

export async function markDeviceTrusted(
  input: MarkTrustedInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.TrustedDevice | null> {
  if (!isValidDeviceCookieValue(input.deviceCookieValue)) return null;
  const deviceIdHash = hashDeviceCookieValue(input.deviceCookieValue);
  const ipHash = input.ip ? hashIpAddress(input.ip) : null;
  const ipPreview = input.ip ? maskIpPreview(input.ip) : null;
  const uaPreview = input.userAgent ? summariseUserAgent(input.userAgent) : null;
  const ttl = clampTtlDays(input.ttlDays ?? null);
  const trustedUntil = new Date(Date.now() + ttl * 24 * 3600 * 1000);

  const existing = await client.trustedDevice.findFirst({
    where: {
      teamId: input.teamId,
      userId: input.userId,
      deviceIdHash,
    },
  });

  const row = existing
    ? await client.trustedDevice.update({
        where: { id: existing.id },
        data: {
          status: prismaPkg.TrustedDeviceStatus.ACTIVE,
          uaPreview: uaPreview ?? existing.uaPreview,
          ipPreview: ipPreview ?? existing.ipPreview,
          ipHash: ipHash ?? existing.ipHash,
          trustedUntilUtc: trustedUntil,
          lastSeenAtUtc: new Date(),
          revokedAtUtc: null,
          revokedByUserId: null,
          revokedReason: null,
        },
      })
    : await client.trustedDevice.create({
        data: {
          teamId: input.teamId,
          userId: input.userId,
          deviceIdHash,
          uaPreview,
          ipPreview,
          ipHash,
          trustedUntilUtc: trustedUntil,
        },
      });

  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "trusted_device_added",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId ?? input.userId,
        subjectUserId: input.userId,
        deviceIdHash,
        ttlDays: ttl,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity_security.trusted_device.add",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId ?? input.userId,
    workspaceId: input.teamId,
    resourceType: "trusted_device",
    resourceId: row.id,
    metadata: {
      subjectUserId: input.userId,
      ipPreview,
      uaPreview,
      ttlDays: ttl,
    },
  }, client);
  return row;
}

function clampTtlDays(value: number | null): number {
  if (value === null) return TRUSTED_DEVICE_TTL_DAYS_DEFAULT;
  if (!Number.isFinite(value) || value < 1) return TRUSTED_DEVICE_TTL_DAYS_DEFAULT;
  return Math.min(TRUSTED_DEVICE_TTL_DAYS_MAX, Math.floor(value));
}

// -----------------------------------------------------------------------------
// isCurrentlyTrusted
// -----------------------------------------------------------------------------

export async function isCurrentlyTrusted(
  input: { teamId: string; userId: string; deviceCookieValue: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  if (!isValidDeviceCookieValue(input.deviceCookieValue)) return false;
  const deviceIdHash = hashDeviceCookieValue(input.deviceCookieValue);
  const row = await client.trustedDevice.findFirst({
    where: {
      teamId: input.teamId,
      userId: input.userId,
      deviceIdHash,
      status: prismaPkg.TrustedDeviceStatus.ACTIVE,
      trustedUntilUtc: { gt: new Date() },
    },
    select: { id: true },
  });
  return Boolean(row);
}

// -----------------------------------------------------------------------------
// revokeTrustedDevice
// -----------------------------------------------------------------------------

export type RevokeTrustedDeviceInput = {
  teamId: string;
  deviceId: string;
  actorUserId: string;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function revokeTrustedDevice(
  input: RevokeTrustedDeviceInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.TrustedDevice | null> {
  const existing = await client.trustedDevice.findFirst({
    where: { id: input.deviceId, teamId: input.teamId },
  });
  if (!existing) return null;
  const updated = await client.trustedDevice.update({
    where: { id: existing.id },
    data: {
      status: prismaPkg.TrustedDeviceStatus.REVOKED,
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId,
      revokedReason: input.reason?.slice(0, 400) ?? null,
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "trusted_device_revoked",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        deviceId: existing.id,
        subjectUserId: existing.userId,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity_security.trusted_device.revoke",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "trusted_device",
    resourceId: existing.id,
    metadata: {
      subjectUserId: existing.userId,
      reason: input.reason ?? null,
    },
  }, client);
  return updated;
}

export async function listTrustedDevicesForUser(
  input: { teamId: string; userId: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.TrustedDevice[]> {
  return client.trustedDevice.findMany({
    where: { teamId: input.teamId, userId: input.userId },
    orderBy: { lastSeenAtUtc: "desc" },
  });
}

export async function listTrustedDevicesForTeam(
  input: { teamId: string; activeOnly?: boolean },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.TrustedDevice[]> {
  return client.trustedDevice.findMany({
    where: {
      teamId: input.teamId,
      ...(input.activeOnly
        ? { status: prismaPkg.TrustedDeviceStatus.ACTIVE }
        : {}),
    },
    orderBy: { lastSeenAtUtc: "desc" },
    take: 500,
  });
}

// -----------------------------------------------------------------------------
// Trusted-device projection (safe for /security-center)
// -----------------------------------------------------------------------------

export function projectTrustedDevice(d: prismaPkg.TrustedDevice): {
  id: string;
  userId: string;
  uaPreview: string | null;
  ipPreview: string | null;
  status: string;
  trustedUntilUtc: string;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  revokedAtUtc: string | null;
} {
  return {
    id: d.id,
    userId: d.userId,
    uaPreview: d.uaPreview,
    ipPreview: d.ipPreview,
    status: d.status,
    trustedUntilUtc: d.trustedUntilUtc.toISOString(),
    firstSeenAtUtc: d.firstSeenAtUtc.toISOString(),
    lastSeenAtUtc: d.lastSeenAtUtc.toISOString(),
    revokedAtUtc: d.revokedAtUtc?.toISOString() ?? null,
    // Deliberately NOT returned: deviceIdHash, ipHash.
  };
}
