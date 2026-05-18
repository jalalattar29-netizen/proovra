/**
 * Phase 26.75 — Session quarantine.
 *
 * A quarantined session retains READ access (so an operator can finish
 * an investigation) but the adaptive-auth gate refuses any privileged
 * action. This is the soft alternative to a hard revoke.
 *
 * Hard rules:
 *   - Quarantine NEVER hard-revokes. Read paths stay open.
 *   - Release can be manual or automatic at `quarantine_release_at_utc`.
 *   - Every transition is audited + bumps a metric.
 *   - Emergency org-wide revoke is a separate, harder action that
 *     calls the existing Phase 19 `revokeAllSessionsForUser` for every
 *     user with at least one active session.
 */

import type {
  PrismaClient,
  AuthenticatedSession as DbSession,
} from "@prisma/client";
import {
  SESSION_QUARANTINE_DEFAULT_HOURS,
  SESSION_QUARANTINE_MAX_HOURS,
  type SessionQuarantineReason,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { revokeAllSessionsForUser } from "../identity-security/session-revocation.service.js";

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export type QuarantineProjection = {
  sessionId: string;
  teamId: string | null;
  userId: string;
  quarantinedAtUtc: string;
  quarantinedByUserId: string | null;
  quarantineReason: string;
  quarantineReleaseAtUtc: string | null;
};

function projectQuarantine(row: DbSession): QuarantineProjection | null {
  if (!row.quarantinedAtUtc) return null;
  return {
    sessionId: row.id,
    teamId: row.teamId,
    userId: row.userId,
    quarantinedAtUtc: row.quarantinedAtUtc.toISOString(),
    quarantinedByUserId: row.quarantinedByUserId,
    quarantineReason: row.quarantineReason ?? "MANUAL_OPERATOR",
    quarantineReleaseAtUtc: row.quarantineReleaseAtUtc?.toISOString() ?? null,
  };
}

// -----------------------------------------------------------------------------
// Quarantine + release
// -----------------------------------------------------------------------------

export type QuarantineInput = {
  teamId: string;
  sessionId: string;
  reason: SessionQuarantineReason;
  actorUserId: string | null;
  /** Hours until automatic release. Bounded by SESSION_QUARANTINE_MAX_HOURS. */
  releaseHours?: number;
};

export async function quarantineSession(
  input: QuarantineInput,
  client: PrismaClient = defaultPrisma,
): Promise<QuarantineProjection | null> {
  const row = await client.authenticatedSession.findFirst({
    where: { id: input.sessionId, teamId: input.teamId },
  });
  if (!row) return null;
  // Idempotent: if already quarantined, refresh the release window only.
  const hours = Math.min(
    Math.max(input.releaseHours ?? SESSION_QUARANTINE_DEFAULT_HOURS, 1),
    SESSION_QUARANTINE_MAX_HOURS,
  );
  const now = new Date();
  const releaseAt = new Date(now.getTime() + hours * 3600_000);
  const updated = await client.authenticatedSession.update({
    where: { id: row.id },
    data: {
      quarantinedAtUtc: row.quarantinedAtUtc ?? now,
      quarantinedByUserId: input.actorUserId,
      quarantineReason: input.reason.slice(0, 96),
      quarantineReleaseAtUtc: releaseAt,
    },
  });
  bump("quarantined_session_total");
  await refreshQuarantineGauge(input.teamId, client);
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "session_quarantined",
    severity: "WARNING",
    details: {
      sessionId: row.id,
      subjectUserId: row.userId,
      reason: input.reason,
      actorUserId: input.actorUserId,
      releaseHours: hours,
    },
  });
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "session.quarantine",
    category: "identity",
    severity: "warning",
    source: "session_quarantine",
    outcome: "success",
    resourceType: "authenticated_session",
    resourceId: row.id,
    metadata: {
      teamId: input.teamId,
      reason: input.reason,
      releaseHours: hours,
    },
    db: client,
  });
  return projectQuarantine(updated);
}

export async function releaseQuarantine(
  input: {
    teamId: string;
    sessionId: string;
    actorUserId: string | null;
    note?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const row = await client.authenticatedSession.findFirst({
    where: { id: input.sessionId, teamId: input.teamId },
  });
  if (!row || !row.quarantinedAtUtc) return false;
  await client.authenticatedSession.update({
    where: { id: row.id },
    data: {
      quarantinedAtUtc: null,
      quarantinedByUserId: null,
      quarantineReason: null,
      quarantineReleaseAtUtc: null,
    },
  });
  bump("quarantine_release_total");
  await refreshQuarantineGauge(input.teamId, client);
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "session_quarantine_released",
    severity: "INFO",
    details: {
      sessionId: row.id,
      subjectUserId: row.userId,
      actorUserId: input.actorUserId,
    },
  });
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "session.quarantine_released",
    category: "identity",
    severity: "info",
    source: "session_quarantine",
    outcome: "success",
    resourceType: "authenticated_session",
    resourceId: row.id,
    metadata: { teamId: input.teamId, note: input.note ?? null },
    db: client,
  });
  return true;
}

// -----------------------------------------------------------------------------
// Auto-release sweep — invoked by reconcile or on-demand by routes.
// -----------------------------------------------------------------------------

export async function sweepQuarantineReleases(
  input: { teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ released: number }> {
  const now = new Date();
  const due = await client.authenticatedSession.findMany({
    where: {
      teamId: input.teamId,
      quarantinedAtUtc: { not: null },
      quarantineReleaseAtUtc: { not: null, lte: now },
    },
    select: { id: true, userId: true },
    take: 200,
  });
  for (const r of due) {
    await client.authenticatedSession.update({
      where: { id: r.id },
      data: {
        quarantinedAtUtc: null,
        quarantinedByUserId: null,
        quarantineReason: null,
        quarantineReleaseAtUtc: null,
      },
    });
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "session_quarantine_released",
      severity: "INFO",
      details: {
        sessionId: r.id,
        subjectUserId: r.userId,
        actorUserId: null,
        auto: true,
      },
    });
  }
  if (due.length > 0) bump("quarantine_release_total", due.length);
  await refreshQuarantineGauge(input.teamId, client);
  return { released: due.length };
}

// -----------------------------------------------------------------------------
// Predicate — used by the adaptive auth engine.
// -----------------------------------------------------------------------------

export async function isSessionQuarantined(
  input: { teamId: string; sessionId: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const row = await client.authenticatedSession.findFirst({
    where: { id: input.sessionId, teamId: input.teamId },
    select: { quarantinedAtUtc: true, quarantineReleaseAtUtc: true },
  });
  if (!row || !row.quarantinedAtUtc) return false;
  // Auto-release window already passed? Then it's not effectively
  // quarantined. The cron sweep will clean up the row.
  if (
    row.quarantineReleaseAtUtc &&
    row.quarantineReleaseAtUtc.getTime() <= Date.now()
  ) {
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------------

export async function listQuarantinedSessions(
  input: { teamId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<QuarantineProjection>> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await client.authenticatedSession.findMany({
    where: {
      teamId: input.teamId,
      quarantinedAtUtc: { not: null },
    },
    orderBy: { quarantinedAtUtc: "desc" },
    take: limit,
  });
  return rows
    .map(projectQuarantine)
    .filter((x): x is QuarantineProjection => x !== null);
}

// -----------------------------------------------------------------------------
// Emergency org-wide revoke — hard revoke for every active user.
// -----------------------------------------------------------------------------

export async function emergencyOrgRevoke(
  input: { teamId: string; actorUserId: string; reason: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ usersRevoked: number; sessionsAffected: number }> {
  const activeUsers = await client.authenticatedSession.findMany({
    where: {
      teamId: input.teamId,
      revokedAtUtc: null,
      expiresAtUtc: { gt: new Date() },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  let sessionsAffected = 0;
  for (const u of activeUsers) {
    try {
      await revokeAllSessionsForUser(
        {
          teamId: input.teamId,
          userId: u.userId,
          reason: "OPERATOR_REVOKED",
          actorUserId: input.actorUserId,
        },
        client,
      );
      const upd = await client.authenticatedSession.updateMany({
        where: {
          teamId: input.teamId,
          userId: u.userId,
          revokedAtUtc: null,
        },
        data: {
          revokedAtUtc: new Date(),
          revokedByUserId: input.actorUserId,
          revokedReason: "EMERGENCY_ORG_WIDE",
        },
      });
      sessionsAffected += upd.count;
    } catch {
      /* best-effort */
    }
  }
  bump("emergency_org_revoke_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "emergency_org_session_revoke",
    severity: "HIGH",
    details: {
      actorUserId: input.actorUserId,
      usersRevoked: activeUsers.length,
      sessionsAffected,
      reason: input.reason.slice(0, 200),
    },
  });
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "session.emergency_org_revoke",
    category: "identity",
    severity: "critical",
    source: "session_quarantine",
    outcome: "success",
    resourceType: "team",
    resourceId: input.teamId,
    metadata: {
      usersRevoked: activeUsers.length,
      sessionsAffected,
      reason: input.reason,
    },
    db: client,
  });
  return { usersRevoked: activeUsers.length, sessionsAffected };
}

// -----------------------------------------------------------------------------
// Gauge refresh helper
// -----------------------------------------------------------------------------

async function refreshQuarantineGauge(
  teamId: string,
  client: PrismaClient,
): Promise<void> {
  const count = await client.authenticatedSession.count({
    where: { teamId, quarantinedAtUtc: { not: null } },
  });
  setGauge("quarantined_sessions_open", count);
}
