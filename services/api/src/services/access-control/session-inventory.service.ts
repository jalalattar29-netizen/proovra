/**
 * Phase 26 — Session governance: active session inventory.
 *
 * Sits on top of the new `authenticated_sessions` table + the existing
 * Phase 17 / 19 `RevokedSession` registry. Every successful login in
 * the API layer calls `recordAuthenticatedSession()`; the admin
 * inventory query reads from this table for fast O(1) listing.
 *
 * Hard rules:
 *   - The hashed sid (HMAC of the JWT jti) is the lookup key — never
 *     the raw jti.
 *   - Revocation goes through the existing Phase 19 `revokeSession()`
 *     which writes RevokedSession; we then mirror the revoked_at_utc
 *     pointer into `authenticated_sessions` so the inventory UI does
 *     not have to join.
 *   - IP / UA previews are display-only; never persists raw values.
 *   - Auto-revocation of expired rows is the operator's responsibility
 *     via a cron sweep (Phase 27 follow-up).
 */

import type {
  Prisma,
  PrismaClient,
  AuthenticatedSession as DbSession,
} from "@prisma/client";
import { createHash } from "node:crypto";

import type { SessionRevocationReason } from "@proovra/shared";
import {
  SESSION_HEARTBEAT_DEFAULT_SAMPLE_SECONDS,
  SESSION_STALE_DEFAULT_MINUTES,
  isSessionStale,
  shouldWriteHeartbeat,
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
import { isSelfServeAccountForOrganization } from "../security/enterprise-account-linking.service.js";
import {
  hashSessionId,
  revokeAllSessionsForUser,
  revokeSession,
} from "../identity-security/session-revocation.service.js";

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export type ActiveSessionProjection = {
  id: string;
  teamId: string | null;
  userId: string;
  ssoConnectionId: string | null;
  issuedAtUtc: string;
  expiresAtUtc: string;
  lastSeenAtUtc: string;
  ipPreview: string | null;
  uaPreview: string | null;
  /** True when the row is in RevokedSession OR our denormalised pointer is set. */
  revoked: boolean;
  revokedAtUtc: string | null;
  revokedReason: string | null;
  /**
   * True while the session is held for review.
   *
   * Carried on the session row itself because the inventory is paged: the
   * console used to derive it by intersecting the sessions list with the
   * quarantine list, which only works while both lists are complete. Twenty-
   * five sessions against twenty-five quarantines says nothing about the
   * twenty-sixth of either.
   */
  quarantined: boolean;
};

function projectSession(row: DbSession): ActiveSessionProjection {
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.userId,
    ssoConnectionId: row.ssoConnectionId,
    issuedAtUtc: row.issuedAtUtc.toISOString(),
    expiresAtUtc: row.expiresAtUtc.toISOString(),
    lastSeenAtUtc: row.lastSeenAtUtc.toISOString(),
    ipPreview: row.ipPreview,
    uaPreview: row.uaPreview,
    revoked: row.revokedAtUtc != null,
    revokedAtUtc: row.revokedAtUtc?.toISOString() ?? null,
    revokedReason: row.revokedReason,
    quarantined:
      row.quarantinedAtUtc != null &&
      (row.quarantineReleaseAtUtc == null ||
        row.quarantineReleaseAtUtc.getTime() > Date.now()),
  };
}

// -----------------------------------------------------------------------------
// Insert on login
//
// Called from the auth route layer after successful sign-in (email +
// password, OAuth provider, or SSO callback). The route is responsible
// for generating the `sid` claim that goes into the JWT and passing it
// here (raw — we hash it).
// -----------------------------------------------------------------------------

/**
 * THE SESSION'S DEVICE FINGERPRINT, one rule for every way in.
 *
 * Best-effort, from the user agent and accept-language, hashed with the key
 * the trusted-device service uses. SAML and OIDC sign-ins always recorded it;
 * password and social sign-ins did not, and once IDENT-019 scored those
 * sessions too, `UNKNOWN_DEVICE_ANOMALY` fired on every repeat sign-in from
 * the same browser and opened a "Suspicious session detected" condition in
 * the person's workspace. Null only when the request carries no user agent,
 * which is what that signal is for.
 */
export function requestDeviceIdHash(headers: {
  "user-agent"?: string | string[] | undefined;
  "accept-language"?: string | string[] | undefined;
}): string | null {
  const ua = headers["user-agent"];
  const lang = headers["accept-language"];
  if (typeof ua !== "string" || ua.length === 0) return null;
  const raw = `${ua}|${typeof lang === "string" ? lang : ""}`;
  const secret = process.env["IDENTITY_SECURITY_HASH_SECRET"] || "phase26-dev";
  return createHash("sha256").update(secret + ":" + raw).digest("hex");
}

export type RecordAuthenticatedSessionInput = {
  userId: string;
  teamId: string | null;
  /** Raw `sid` claim — hashed before insert. */
  sid: string;
  /** JWT issued-at unix seconds. */
  iat: number;
  /** JWT expiry unix seconds. */
  exp: number;
  ssoConnectionId?: string | null;
  ipPreview?: string | null;
  uaPreview?: string | null;
  deviceIdHash?: string | null;
  /**
   * 2026-10-28 — how this session was authenticated (PASSWORD, SAML, OIDC, …)
   * and, for an IdP sign-in, the context identifier the IdP asserted
   * (AuthnContextClassRef / acr — never the assertion or token) and the IdP's
   * own authentication instant (AuthnInstant / auth_time). Written once, at
   * creation; a later upsert of the same session never rewrites them.
   */
  authMethod?: string | null;
  authnContext?: string | null;
  idpAuthAtUtc?: Date | null;
};

export async function recordAuthenticatedSession(
  input: RecordAuthenticatedSessionInput,
  client: PrismaClient = defaultPrisma,
): Promise<ActiveSessionProjection> {
  const sessionIdHash = hashSessionId(input.sid);
  const row = await client.authenticatedSession.upsert({
    where: {
      userId_sessionIdHash: {
        userId: input.userId,
        sessionIdHash,
      },
    },
    update: {
      lastSeenAtUtc: new Date(),
      expiresAtUtc: new Date(input.exp * 1000),
    },
    create: {
      userId: input.userId,
      teamId: input.teamId,
      sessionIdHash,
      ssoConnectionId: input.ssoConnectionId ?? null,
      issuedAtUtc: new Date(input.iat * 1000),
      expiresAtUtc: new Date(input.exp * 1000),
      ipPreview: input.ipPreview ?? null,
      uaPreview: input.uaPreview ?? null,
      deviceIdHash: input.deviceIdHash ?? null,
      authMethod: input.authMethod ? input.authMethod.slice(0, 16) : null,
      authnContext: input.authnContext ? input.authnContext.slice(0, 256) : null,
      idpAuthAtUtc:
        input.idpAuthAtUtc && Number.isFinite(input.idpAuthAtUtc.getTime())
          ? input.idpAuthAtUtc
          : null,
    },
  });
  return projectSession(row);
}

// PHASE 13 §4 (2026-08-17) — `touchAuthenticatedSession` was REMOVED here.
//
// Its docblock read "called by the auth middleware on permission check to
// update lastSeenAtUtc", and the auth middleware did not call it. What the
// middleware calls is `recordHeartbeat` below, which writes the SAME column
// (plus `lastHeartbeatAtUtc`), is self-throttled to one write per session per
// sample window, and is behind the `SESSION_HEARTBEAT_ENABLED` kill switch.
//
// So `lastSeenAtUtc` is not an unwritten field — it has a live writer, and this
// was a second, unthrottled one that nothing reached. An unthrottled twin of a
// hot-row heartbeat is the more dangerous half of the pair: wired as its
// docblock described, it would have written the row on EVERY authenticated
// request. `recordHeartbeat` is the single last-seen authority for
// `authenticated_sessions`.

// -----------------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------------

export type ListSessionsInput = {
  teamId: string;
  includeRevoked?: boolean;
  includeExpired?: boolean;
  limit?: number;
  userId?: string;
  /** Decoded keyset cursor — rows strictly after this (lastSeenAtUtc, id). */
  after?: KeysetKey | null;
};

export type SessionInventoryPage = {
  sessions: ActiveSessionProjection[];
  /** Opaque continuation, `null` on the last page. */
  nextCursor: string | null;
  /** The server's own answer — not an inference from the row count. */
  hasMore: boolean;
};

/**
 * Sessions a workspace administrator answers for: those that started here, and
 * those of its members. A session is global and can enter any workspace its
 * owner belongs to, so the workspace recorded at login is not the set of
 * sessions that can reach this workspace (IDENT-001).
 */
export async function sessionsOfWorkspaceWhere(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<Prisma.AuthenticatedSessionWhereInput> {
  // A suspended member's session is still the workspace's to end: the person
  // is still its member, and may be restored.
  //
  // B7A-F-001 (free-audit 0ea0) — a REMOVED or DEPARTED member (REVOKED row)
  // is not. Their row is kept as history, and it used to keep them in this
  // predicate, so a former colleague with admin rights here kept listing,
  // signing out and quarantining the person's GLOBAL sessions — including
  // sessions started later, in their own Personal Space — with no time bound.
  // Removal ends the workspace's authority over the person: what remains is
  // only the sessions that STARTED in this workspace (the `teamId` leg).
  //
  // PRO-A2-04 (DEC-08) — and a CURRENT member's account-global sessions are
  // the workspace's only when the Organization governs that identity (its
  // directory or IdP originated it). For an independent (self-serve) member
  // the workspace answers for what it issued: sessions that started here and
  // sessions signed in through its Organization's SSO — never the person's
  // Personal-Space or other-workspace sessions.
  const scope = await workspaceSessionAuthority(teamId, client);
  const members = await client.teamMember.findMany({
    where: { teamId, status: { in: ["ACTIVE", "SUSPENDED"] } },
    select: { userId: true },
  });
  const managed: string[] = [];
  if (scope.organizationId) {
    const verdicts = await Promise.all(
      members.map(async (m) => ({
        userId: m.userId,
        selfServe: await isSelfServeAccountForOrganization(
          { userId: m.userId, organizationId: scope.organizationId as string },
          client,
        ).catch(() => true),
      })),
    );
    for (const v of verdicts) if (!v.selfServe) managed.push(v.userId);
  }
  const legs: Prisma.AuthenticatedSessionWhereInput[] = [{ teamId }];
  if (managed.length > 0) legs.push({ userId: { in: managed } });
  if (scope.ssoConnectionIds.length > 0) {
    legs.push({
      ssoConnectionId: { in: scope.ssoConnectionIds },
      userId: { in: members.map((m) => m.userId) },
    });
  }
  return { OR: legs };
}

/** The workspace's Organization and the SSO connections that Organization owns. */
async function workspaceSessionAuthority(
  teamId: string,
  client: PrismaClient,
): Promise<{ organizationId: string | null; ssoConnectionIds: string[] }> {
  const team = await client.team.findUnique({ where: { id: teamId }, select: { organizationId: true } });
  const organizationId = team?.organizationId ?? null;
  if (!organizationId) return { organizationId: null, ssoConnectionIds: [] };
  const connections = await client.ssoConnection.findMany({
    where: { organizationId },
    select: { id: true },
  });
  return { organizationId, ssoConnectionIds: connections.map((c) => c.id) };
}

export const SESSION_INVENTORY_DEFAULT_LIMIT = 100;
export const SESSION_INVENTORY_MAX_LIMIT = 500;

/**
 * One page of the inventory, ordered by last activity.
 *
 * KEYSET, NOT OFFSET. The order is `lastSeenAtUtc desc, id desc` — the id is
 * the tiebreaker that makes the order total, so "after (at, id)" names one
 * position and a heartbeat landing mid-read cannot re-show or skip a stable
 * row. A session whose own heartbeat fires between two pages moves to the
 * top and is simply not on the later page, which is the honest answer: it
 * was seen more recently than anything the reader has scrolled past.
 */
export async function listActiveSessions(
  input: ListSessionsInput,
  client: PrismaClient = defaultPrisma,
): Promise<SessionInventoryPage> {
  const limit = Math.min(
    Math.max(input.limit ?? SESSION_INVENTORY_DEFAULT_LIMIT, 1),
    SESSION_INVENTORY_MAX_LIMIT,
  );
  const now = new Date();
  const filters = {
    ...(await sessionsOfWorkspaceWhere(input.teamId, client)),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.includeRevoked ? {} : { revokedAtUtc: null }),
    ...(input.includeExpired ? {} : { expiresAtUtc: { gt: now } }),
  };
  const rows = await client.authenticatedSession.findMany({
    where: input.after
      ? { AND: [filters, keysetAfter("lastSeenAtUtc", input.after)] }
      : filters,
    orderBy: [{ lastSeenAtUtc: "desc" }, { id: "desc" }],
    // One past the page: the extra row is the proof of a next page.
    take: limit + 1,
  });
  bump("session_inventory_viewed_total");
  setGauge(
    "active_sessions_total",
    await client.authenticatedSession.count({
      where: {
        teamId: input.teamId,
        revokedAtUtc: null,
        expiresAtUtc: { gt: now },
      },
    }),
  );
  const page = keysetPage(rows, limit, (r) => ({ at: r.lastSeenAtUtc, id: r.id }));
  return {
    sessions: page.rows.map(projectSession),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

// -----------------------------------------------------------------------------
// Revocation — single + bulk
// -----------------------------------------------------------------------------

export async function revokeActiveSession(
  input: {
    teamId: string;
    sessionId: string;
    actorUserId: string;
    reason?: SessionRevocationReason;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<
  | { ok: true; projection: ActiveSessionProjection }
  | { ok: false; reason: "not_found" | "already_revoked" }
> {
  // PHASE 12B C4 — LIVE-STATE CHECK.
  //
  // This previously matched on (id, teamId) alone, so revoking an
  // already-revoked session succeeded again: it wrote a SECOND RevokedSession
  // entry, emitted a second security event, bumped the metric twice, and — the
  // real damage — overwrote `revokedAtUtc` / `revokedByUserId`, so the audit
  // trail attributed the revocation to whoever called LAST rather than to the
  // operator who actually cut the session.
  //
  // The existence probe stays separate from the liveness probe so the caller can
  // distinguish "no such session in this workspace" (404, anti-enumeration —
  // identical to a cross-Organization id) from "already revoked" (409, a
  // bounded conflict the operator can act on).
  const row = await client.authenticatedSession.findFirst({
    where: { id: input.sessionId, ...(await sessionsOfWorkspaceWhere(input.teamId, client)) },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.revokedAtUtc !== null) {
    return { ok: false, reason: "already_revoked" };
  }
  const now = new Date();
  // Write the canonical RevokedSession entry so the JWT middleware
  // rejects subsequent requests immediately.
  await revokeSession(
    {
      teamId: row.teamId,
      userId: row.userId,
      sessionIdHash: row.sessionIdHash,
      reason: input.reason ?? "OPERATOR_REVOKED",
      actorUserId: input.actorUserId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    client,
  );
  // Mirror into the active-session ledger for fast inventory.
  const updated = await client.authenticatedSession.update({
    where: { id: row.id },
    data: {
      revokedAtUtc: now,
      revokedByUserId: input.actorUserId,
      revokedReason: (input.reason ?? "OPERATOR_REVOKED").slice(0, 64),
    },
  });
  bump("session_revoked_admin_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "session_revoked_admin",
    severity: "WARNING",
    details: {
      sessionId: row.id,
      subjectUserId: row.userId,
      actorUserId: input.actorUserId,
      reason: input.reason ?? "OPERATOR_REVOKED",
    },
  });
  await emitTenantAudit({
    action: "session.revoke.single",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "authenticated_session",
    resourceId: row.id,
    metadata: {
      subjectUserId: row.userId,
      reason: input.reason ?? "OPERATOR_REVOKED",
    },
  }, client);
  return { ok: true, projection: projectSession(updated) };
}

/**
 * PRO-A2-04 / PRO-A2C-04 (DEC-08) — end one person's sessions within the
 * workspace's authority over them, with the inventory mirror in the SAME
 * scope as the revocation. Shared by admin revoke-all and emergency revoke.
 */
export async function revokeUserSessionsInWorkspaceScope(
  input: {
    teamId: string;
    userId: string;
    actorUserId: string;
    reason?: SessionRevocationReason;
    mirrorReason?: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ count: number; scope: "ACCOUNT" | "WORKSPACE" }> {
  const now = new Date();
  const reason = input.reason ?? "OPERATOR_REVOKED";
  /*
   * PRO-A2-04 / PRO-A2C-04 (DEC-08) — the revocation and its inventory mirror
   * have ONE scope, the workspace's authority over this person:
   *   - an identity the Organization originated: every session of the account
   *     (ALL_FOR_USER) — and every inventory row is marked, not only the ones
   *     that started in this workspace, so the count is the truth;
   *   - an independent account: only the sessions this workspace answers for
   *     (started here, or signed in through its Organization's SSO), each
   *     ended by its own id. Their Personal Space is not signed out.
   */
  const scope = await workspaceSessionAuthority(input.teamId, client);
  const managed = scope.organizationId
    ? !(await isSelfServeAccountForOrganization(
        { userId: input.userId, organizationId: scope.organizationId },
        client,
      ).catch(() => true))
    : false;
  let result: { count: number };
  if (managed) {
    const unrevoked = await client.authenticatedSession.count({
      where: { userId: input.userId, revokedAtUtc: null },
    });
    await revokeAllSessionsForUser(
      { teamId: input.teamId, userId: input.userId, reason, actorUserId: input.actorUserId },
      client,
    );
    // revokeAllSessionsForUser marks the live rows; every remaining
    // unrevoked row of the account is marked too, and the count is the rows
    // that were unrevoked before.
    await client.authenticatedSession.updateMany({
      where: { userId: input.userId, revokedAtUtc: null },
      data: { revokedAtUtc: now, revokedByUserId: input.actorUserId, revokedReason: (input.mirrorReason ?? reason).slice(0, 64) },
    });
    result = { count: unrevoked };
  } else {
    const legs: Prisma.AuthenticatedSessionWhereInput[] = [{ teamId: input.teamId }];
    if (scope.ssoConnectionIds.length > 0) legs.push({ ssoConnectionId: { in: scope.ssoConnectionIds } });
    const rows = await client.authenticatedSession.findMany({
      where: { userId: input.userId, revokedAtUtc: null, OR: legs },
      select: { id: true, sessionIdHash: true, teamId: true },
    });
    for (const row of rows) {
      await revokeSession(
        { teamId: row.teamId, userId: input.userId, sessionIdHash: row.sessionIdHash, reason, actorUserId: input.actorUserId },
        client,
      );
    }
    result = await client.authenticatedSession.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, revokedAtUtc: null },
      data: { revokedAtUtc: now, revokedByUserId: input.actorUserId, revokedReason: (input.mirrorReason ?? reason).slice(0, 64) },
    });
  }
  return { count: result.count, scope: managed ? "ACCOUNT" : "WORKSPACE" };
}

export async function revokeAllSessionsForUserAdmin(
  input: {
    teamId: string;
    userId: string;
    actorUserId: string;
    reason?: SessionRevocationReason;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ revokedCount: number }> {
  const { count } = await revokeUserSessionsInWorkspaceScope(input, client);
  const result = { count };
  bump("session_revoked_admin_total", result.count);
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "all_sessions_revoked_admin",
    severity: "WARNING",
    details: {
      subjectUserId: input.userId,
      actorUserId: input.actorUserId,
      revokedCount: result.count,
    },
  });
  await emitTenantAudit({
    action: "session.revoke.all",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "user",
    resourceId: input.userId,
    metadata: {
      revokedCount: result.count,
      reason: input.reason ?? "OPERATOR_REVOKED",
    },
  }, client);
  return { revokedCount: result.count };
}

/**
 * AUD-020 — a person ending THEIR OWN session: web/mobile sign-out and the
 * extension's revoke. Exactly one session, by its own hash:
 *
 *   1. `revokeSession` (SINGLE_SESSION) — the authority `requireAuth` consults,
 *      so the token is refused from the next request on;
 *   2. the inventory row is ended (`revokedAtUtc`), so the Security page stops
 *      listing it and the auth middleware's mirror check agrees.
 *
 * Never ALL_FOR_USER: that scope invalidates every token issued before it,
 * which would sign the person out of their other devices. "Sign out all
 * devices" is a separate, explicit action. Throws on any store failure — the
 * caller must not report a sign-out that did not happen.
 */
export async function endOwnSession(
  input: {
    userId: string;
    /** HMAC of the session id (`hashSessionId(sid)`), never the raw sid. */
    sessionIdHash: string;
    reason: SessionRevocationReason;
    /** Bounded inventory label (e.g. USER_LOGOUT, EXTENSION_SIGN_OUT). */
    inventoryReason: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ sessionIdHash: string }> {
  const { sessionIdHash } = input;
  const row = await client.authenticatedSession.findFirst({
    where: { userId: input.userId, sessionIdHash },
    select: { teamId: true },
  });
  await revokeSession(
    {
      userId: input.userId,
      sessionIdHash,
      teamId: row?.teamId ?? null,
      reason: input.reason,
      actorUserId: input.userId,
    },
    client,
  );
  await client.authenticatedSession.updateMany({
    where: { userId: input.userId, sessionIdHash, revokedAtUtc: null },
    data: {
      revokedAtUtc: new Date(),
      revokedByUserId: input.userId,
      revokedReason: input.inventoryReason.slice(0, 64),
    },
  });
  return { sessionIdHash };
}

// -----------------------------------------------------------------------------
// Phase 26.5 — Sampled heartbeat
//
// The auth middleware calls this on every authenticated request. The
// shared `shouldWriteHeartbeat` helper enforces the sample-window
// (default 60s per session) so we do not write the row on every hit.
// Hot-row contention is bounded to one write per session per window.
// -----------------------------------------------------------------------------

export async function recordHeartbeat(
  input: {
    userId: string;
    sid: string;
    sampleWindowSeconds?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ written: boolean }> {
  try {
    const sessionIdHash = hashSessionId(input.sid);
    const row = await client.authenticatedSession.findFirst({
      where: { userId: input.userId, sessionIdHash },
      select: { id: true, lastHeartbeatAtUtc: true },
    });
    if (!row) {
      return { written: false };
    }
    const sample =
      input.sampleWindowSeconds ?? SESSION_HEARTBEAT_DEFAULT_SAMPLE_SECONDS;
    if (
      !shouldWriteHeartbeat({
        lastHeartbeatAtUtc: row.lastHeartbeatAtUtc,
        sampleWindowSeconds: sample,
      })
    ) {
      bump("session_heartbeat_sampled_skip_total");
      return { written: false };
    }
    await client.authenticatedSession.update({
      where: { id: row.id },
      data: {
        lastHeartbeatAtUtc: new Date(),
        lastSeenAtUtc: new Date(),
      },
    });
    bump("session_heartbeat_total");
    return { written: true };
  } catch {
    /* best-effort; never throws */
    return { written: false };
  }
}

// -----------------------------------------------------------------------------
// Phase 26.5 — Stale-session reconcile
//
// Cron-driven sweep. Marks rows whose `lastHeartbeatAtUtc` (or
// `lastSeenAtUtc` as fallback) is older than `staleMinutes` as
// SUSPICIOUS_ACTIVITY-revoked. Bounded batch; never deletes; never
// silently revokes privileged accounts (those get a separate
// security event).
// -----------------------------------------------------------------------------

export type StaleSessionSweepResult = {
  scanned: number;
  staleDetected: number;
  swept: number;
};

export async function sweepStaleSessions(
  input: {
    teamId: string;
    staleMinutes?: number;
    batchSize?: number;
    revoke?: boolean;
  },
  client: PrismaClient = defaultPrisma,
): Promise<StaleSessionSweepResult> {
  const staleMinutes = input.staleMinutes ?? SESSION_STALE_DEFAULT_MINUTES;
  const batch = Math.min(Math.max(input.batchSize ?? 200, 1), 1000);
  const now = new Date();
  const candidates = await client.authenticatedSession.findMany({
    where: {
      teamId: input.teamId,
      revokedAtUtc: null,
      expiresAtUtc: { gt: now },
    },
    take: batch,
    select: {
      id: true,
      userId: true,
      lastHeartbeatAtUtc: true,
      lastSeenAtUtc: true,
      sessionIdHash: true,
    },
  });
  let staleDetected = 0;
  let swept = 0;
  for (const c of candidates) {
    if (
      !isSessionStale({
        lastHeartbeatAtUtc: c.lastHeartbeatAtUtc,
        lastSeenAtUtc: c.lastSeenAtUtc,
        staleMinutes,
        nowUtc: now,
      })
    ) {
      continue;
    }
    staleDetected += 1;
    bump("stale_session_total");
    if (input.revoke !== false) {
      try {
        await revokeSession(
          {
            teamId: input.teamId,
            userId: c.userId,
            sessionIdHash: c.sessionIdHash,
            reason: "RECONCILIATION_SWEEP",
            actorUserId: null,
            ipAddress: null,
            userAgent: null,
          },
          client,
        );
        await client.authenticatedSession.update({
          where: { id: c.id },
          data: {
            revokedAtUtc: now,
            revokedReason: "RECONCILIATION_SWEEP",
          },
        });
        bump("stale_session_swept_total");
        safeEmitSecurityEvent({
          teamId: input.teamId,
          eventType: "stale_session_swept",
          severity: "INFO",
          details: {
            sessionId: c.id,
            subjectUserId: c.userId,
            staleMinutes,
          },
        });
        swept += 1;
      } catch {
        /* sweeper is best-effort */
      }
    }
  }
  setGauge(
    "stale_session_backlog",
    Math.max(0, staleDetected - swept),
  );
  return { scanned: candidates.length, staleDetected, swept };
}

// -----------------------------------------------------------------------------
// Phase 26.5 — High-risk session count gauge update.
//
// Periodically refresh the `high_risk_sessions` gauge so the operations
// dashboard reflects the current risk distribution.
// -----------------------------------------------------------------------------

export async function refreshHighRiskSessionGauge(
  input: { teamId: string; threshold?: number },
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  const threshold = input.threshold ?? 60;
  const count = await client.authenticatedSession.count({
    where: {
      teamId: input.teamId,
      revokedAtUtc: null,
      expiresAtUtc: { gt: new Date() },
      riskScore: { gte: threshold },
    },
  });
  setGauge("high_risk_sessions", count);
  return count;
}
