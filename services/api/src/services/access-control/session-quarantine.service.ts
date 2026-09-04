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
import {
  keysetAfter,
  keysetPage,
  type KeysetKey,
} from "../pagination/keyset-cursor.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
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
  await emitTenantAudit({
    action: "session.quarantine",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    actorAuthority: "WORKSPACE_IDENTITY_ADMIN",
    workspaceId: input.teamId,
    resourceType: "authenticated_session",
    resourceId: row.id,
    /*
     * PHASE 5 §3 (family C) — THE OPERATOR IS NOT THE SUBJECT.
     *
     * `actorUserId` is the identity admin who quarantined; `row.userId` is
     * whose session it was. Conflating them is the specific confusion this
     * family exists to prevent — an audit that names one person for both
     * roles reads as somebody locking themselves out.
     *
     * The label uses the session's stored PREVIEW, never the raw client
     * string. `uaPreview` is what the product persists precisely so that a
     * fingerprint never has to be shown to describe a session.
     */
    targetDisplay: row.uaPreview
      ? `Session — ${row.uaPreview}`
      : "Session (client not recorded)",
    previousState: row.quarantinedAtUtc ? "QUARANTINED" : "ACTIVE",
    requestedState: "QUARANTINED",
    resultingState: updated.quarantinedAtUtc ? "QUARANTINED" : "ACTIVE",
    // The canonical reason the operator chose, from the closed enum the route
    // validates — not free text, so it stays a filterable code.
    reasonCode: input.reason,
    metadata: {
      reason: input.reason,
      releaseHours: hours,
      // The SUBJECT, recorded explicitly and separately from the actor.
      subjectUserId: row.userId,
      releaseAtUtc: releaseAt ? releaseAt.toISOString() : null,
    },
  }, client);
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
  await emitTenantAudit({
    action: "session.quarantine_released",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    actorAuthority: "WORKSPACE_IDENTITY_ADMIN",
    workspaceId: input.teamId,
    resourceType: "authenticated_session",
    resourceId: row.id,
    targetDisplay: row.uaPreview
      ? `Session — ${row.uaPreview}`
      : "Session (client not recorded)",
    previousState: "QUARANTINED",
    requestedState: "ACTIVE",
    resultingState: "ACTIVE",
    // A release is an operator decision, distinct from the scheduled sweep
    // that releases a quarantine when its window simply expires.
    reasonCode: "OPERATOR_RELEASED",
    metadata: { note: input.note ?? null, subjectUserId: row.userId },
  }, client);
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

export type QuarantineInventoryPage = {
  items: QuarantineProjection[];
  /** Opaque continuation, `null` on the last page. */
  nextCursor: string | null;
  /** The server's own answer — not an inference from the row count. */
  hasMore: boolean;
};

/**
 * One page of held sessions, most recently quarantined first.
 *
 * Keyset over `quarantinedAtUtc desc, id desc` — see
 * services/pagination/keyset-cursor.ts for why the id tiebreaker is part of
 * the order and not an optimisation.
 */
export async function listQuarantinedSessions(
  input: { teamId: string; limit?: number; after?: KeysetKey | null },
  client: PrismaClient = defaultPrisma,
): Promise<QuarantineInventoryPage> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const filters = {
    teamId: input.teamId,
    quarantinedAtUtc: { not: null },
  };
  const rows = await client.authenticatedSession.findMany({
    where: input.after
      ? { AND: [filters, keysetAfter("quarantinedAtUtc", input.after)] }
      : filters,
    orderBy: [{ quarantinedAtUtc: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = keysetPage(rows, limit, (r) => ({
    // Non-null by the `not: null` predicate above; the fallback only keeps
    // the type honest.
    at: r.quarantinedAtUtc ?? new Date(0),
    id: r.id,
  }));
  return {
    items: page.rows
      .map(projectQuarantine)
      .filter((x): x is QuarantineProjection => x !== null),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
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
  // PHASE 5 §4 — the loop below is best-effort by design: one stuck user must
  // not stop the rest of the estate going dark. That is right, and it is also
  // why the outcome cannot be a constant — a run that reached four of five
  // users and a run that reached all five are different facts, and the count
  // of SESSIONS cannot tell them apart because one user may hold several.
  let usersFailed = 0;
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
      // Best-effort, but COUNTED. Swallowing the failure silently is what made
      // a partial sweep indistinguishable from a complete one.
      usersFailed += 1;
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
  await emitTenantAudit({
    /*
     * PHASE 5 §4 — FOUR OUTCOMES, BECAUSE THERE ARE FOUR THINGS THAT HAPPEN.
     *
     *   no_op   — there was nobody signed in. A valid request that caused no
     *             transition; calling it `success` tells an operator the
     *             estate went dark when nothing was signed out.
     *   error   — there were users and not one could be reached.
     *   partial — some users were reached and some were not. "Everyone is
     *             signed out" and "most people are" cannot share a label, and
     *             during an incident that difference is the whole message.
     *   success — every user found was revoked.
     *
     * Measured in USERS, not sessions: one person may hold several sessions,
     * so a session count cannot distinguish a complete sweep from a partial
     * one.
     */
    action: "session.emergency_org_revoke",
    outcome:
      activeUsers.length === 0
        ? "no_op"
        : usersFailed === activeUsers.length
          ? "error"
          : usersFailed > 0
            ? "partial"
            : "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    actorAuthority: "WORKSPACE_IDENTITY_ADMIN",
    workspaceId: input.teamId,
    resourceType: "team",
    resourceId: input.teamId,
    targetDisplay: "All active sessions in this workspace",
    // Both sides counted in USERS, so the two numbers are comparable at a
    // glance; the session total stays in metadata where it is detail.
    requestedState: `REVOKE_${activeUsers.length}_USERS`,
    resultingState: `REVOKED_${activeUsers.length - usersFailed}_USERS`,
    reasonCode: "EMERGENCY_ORG_WIDE",
    metadata: {
      usersRevoked: activeUsers.length,
      sessionsAffected,
      reason: input.reason,
    },
  }, client);
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
