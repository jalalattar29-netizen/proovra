/**
 * PHASE R8.1.7 — Admin MFA recovery digest preference service.
 *
 * Per-user-per-team (optional) opt-out + suppress-until controls
 * for the consolidated MFA recovery digest email.
 *
 * Effective preference resolution for (user, team):
 *   1. team-specific row (user, team)        wins if present
 *   2. else, global row     (user, NULL)     wins if present
 *   3. else, default ENABLED                 (digest will be sent)
 *
 * `suppressUntil` overrides `digestEnabled` while the timestamp
 * is in the future: even if `digestEnabled = true`, the user is
 * suppressed until the snooze elapses.
 *
 * HARD RULES:
 *   - Preferences affect ONLY the operational digest EMAIL transport.
 *     They DO NOT suppress audit log rows, security events, or the
 *     admin SPA queue. Operator visibility is preserved unconditionally.
 *   - A user can only manage THEIR OWN preferences (route layer
 *     enforces; this service trusts the caller to pass the actor id).
 *   - A team-specific preference requires the user to be an ACTIVE
 *     member of that team.
 *   - Every mutation emits `mfa_recovery_digest_preference_updated`
 *     plus a platform audit log row.
 */

import { prisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";

export interface DigestPreferenceRow {
  id: string;
  userId: string;
  teamId: string | null;
  digestEnabled: boolean;
  suppressUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListDigestPreferencesInput {
  userId: string;
}

export interface ListDigestPreferencesResult {
  preferences: ReadonlyArray<DigestPreferenceRow>;
}

export async function listDigestPreferences(
  input: ListDigestPreferencesInput,
): Promise<ListDigestPreferencesResult> {
  const rows = await prisma.mfaAdminDigestPreference.findMany({
    where: { userId: input.userId },
    orderBy: [{ teamId: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      userId: true,
      teamId: true,
      digestEnabled: true,
      suppressUntil: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return {
    preferences: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      teamId: r.teamId,
      digestEnabled: r.digestEnabled,
      suppressUntil: r.suppressUntil?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
}

export interface UpdateDigestPreferenceInput {
  /** The user whose preference is being changed. Routes pass the
   *  authenticated actor id; the service enforces user == actor. */
  actorUserId: string;
  /** Target team scope. `null` writes the global preference for
   *  the user (no team scope). */
  teamId: string | null;
  digestEnabled?: boolean;
  /** ISO timestamp or null to clear the snooze. */
  suppressUntil?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface UpdateDigestPreferenceResult {
  ok: boolean;
  reason?: "not_member" | "invalid_suppress_until";
  preference?: DigestPreferenceRow;
}

export async function updateDigestPreference(
  input: UpdateDigestPreferenceInput,
): Promise<UpdateDigestPreferenceResult> {
  // Validate suppressUntil — must parse to a Date if supplied.
  let suppressUntilDate: Date | null | undefined;
  if (input.suppressUntil === undefined) {
    suppressUntilDate = undefined;
  } else if (input.suppressUntil === null) {
    suppressUntilDate = null;
  } else {
    const parsed = new Date(input.suppressUntil);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, reason: "invalid_suppress_until" };
    }
    suppressUntilDate = parsed;
  }

  // Team-specific preference requires ACTIVE membership in that team.
  if (input.teamId) {
    const membership = await prisma.teamMember.findFirst({
      where: {
        userId: input.actorUserId,
        teamId: input.teamId,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    if (!membership) return { ok: false, reason: "not_member" };
  }

  // Read prior so we only emit the event when something actually
  // changed (avoids SIEM noise on repeated no-op PATCHes).
  const prior = await prisma.mfaAdminDigestPreference.findFirst({
    where: { userId: input.actorUserId, teamId: input.teamId },
    select: {
      digestEnabled: true,
      suppressUntil: true,
    },
  });

  let row;
  if (prior) {
    row = await prisma.mfaAdminDigestPreference.updateMany({
      where: { userId: input.actorUserId, teamId: input.teamId },
      data: {
        ...(input.digestEnabled !== undefined
          ? { digestEnabled: input.digestEnabled }
          : {}),
        ...(suppressUntilDate !== undefined
          ? { suppressUntil: suppressUntilDate }
          : {}),
      },
    });
    // Re-read for the response payload.
    row = await prisma.mfaAdminDigestPreference.findFirst({
      where: { userId: input.actorUserId, teamId: input.teamId },
      select: {
        id: true,
        userId: true,
        teamId: true,
        digestEnabled: true,
        suppressUntil: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } else {
    row = await prisma.mfaAdminDigestPreference.create({
      data: {
        userId: input.actorUserId,
        teamId: input.teamId,
        digestEnabled: input.digestEnabled ?? true,
        suppressUntil: suppressUntilDate ?? null,
      },
      select: {
        id: true,
        userId: true,
        teamId: true,
        digestEnabled: true,
        suppressUntil: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  const changed =
    !prior ||
    (input.digestEnabled !== undefined &&
      input.digestEnabled !== prior.digestEnabled) ||
    (suppressUntilDate !== undefined &&
      (suppressUntilDate?.getTime() ?? null) !==
        (prior.suppressUntil?.getTime() ?? null));

  if (changed) {
    void emitTenantAudit({
      action: "mfa.recovery.digest_preference_updated",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.teamId,
      resourceType: "mfa_admin_digest_preference",
      resourceId: row?.id ?? input.actorUserId,
      metadata: {
        digestEnabled:
          input.digestEnabled ?? (prior?.digestEnabled ?? true),
        suppressUntil:
          (suppressUntilDate ?? prior?.suppressUntil ?? null)?.toISOString() ??
          null,
      },
    }).catch(() => null);
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "mfa_recovery_digest_preference_updated",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        teamId: input.teamId,
        digestEnabled:
          input.digestEnabled ?? (prior?.digestEnabled ?? true),
        suppressUntilIso:
          (suppressUntilDate ?? prior?.suppressUntil ?? null)?.toISOString() ??
          null,
      },
    });
  }

  return {
    ok: true,
    preference: row
      ? {
          id: row.id,
          userId: row.userId,
          teamId: row.teamId,
          digestEnabled: row.digestEnabled,
          suppressUntil: row.suppressUntil?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }
      : undefined,
  };
}

/**
 * Pure helper: given a user's preference rows and a teamId, return
 * the effective `shouldSendDigest` decision. Used by the worker
 * digest job to skip suppressed admins.
 *
 * Resolution:
 *   - team-specific row wins if present
 *   - else global row wins if present
 *   - else default ENABLED
 *   - suppressUntil > now ⇒ suppressed regardless of digestEnabled
 */
export function shouldSendDigest(
  prefs: ReadonlyArray<{
    teamId: string | null;
    digestEnabled: boolean;
    suppressUntil: Date | null;
  }>,
  teamId: string,
  now: Date = new Date(),
): boolean {
  const teamPref = prefs.find((p) => p.teamId === teamId);
  const globalPref = prefs.find((p) => p.teamId === null);
  const effective = teamPref ?? globalPref;
  if (!effective) return true; // default ENABLED
  if (
    effective.suppressUntil &&
    effective.suppressUntil.getTime() > now.getTime()
  ) {
    return false;
  }
  return effective.digestEnabled;
}
