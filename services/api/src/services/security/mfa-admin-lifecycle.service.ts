/**
 * PHASE R8.1.4 — Admin MFA lifecycle service.
 *
 * Org-admin / security-operator controls over a user's MFA state.
 * Every public function in this file enforces the SAME hard
 * tenant-isolation contract:
 *
 *   1. The acting admin MUST be an ACTIVE OWNER/ADMIN of the team
 *      under which the action is scoped.
 *   2. The target user MUST be an ACTIVE member of the SAME team.
 *   3. Cross-team actions are REFUSED (returning `not_in_team`).
 *
 * Every state transition emits:
 *   - A `safeEmitSecurityEvent` row from the bounded R8.1.4
 *     vocabulary (`mfa_admin_factor_revoked`,
 *     `mfa_admin_reenrollment_required`, `mfa_trusted_devices_reset`).
 *   - A `appendPlatformAuditLog` row carrying the admin's userId,
 *     the target's userId, and the team scope.
 *
 * Hard rules:
 *   - This service NEVER returns OTP, recovery code, secret material,
 *     or signed token. The most it returns is a count + a bounded
 *     status enum.
 *   - This service NEVER deletes a factor — `revokeUserFactor` flips
 *     the status to REVOKED so the audit trail survives the action.
 *   - This service NEVER issues a session. Forcing re-enrollment
 *     means flipping factors to REVOKED, NOT minting any
 *     credential the admin could log in with.
 */

import { prisma } from "../../db.js";
import {
  keysetAfter,
  keysetPage,
  type KeysetKey,
} from "../pagination/keyset-cursor.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";

export type MfaAdminScopeFailure =
  | "admin_not_in_team"
  | "admin_not_admin"
  | "target_not_in_team";

interface ScopeCheckInput {
  teamId: string;
  actorUserId: string;
  targetUserId: string;
}

/**
 * Shared tenant-isolation guard. Used by every public function in
 * this service. Returns null on success, a bounded failure code on
 * any mismatch.
 */
async function assertAdminCanAct(
  input: ScopeCheckInput,
): Promise<MfaAdminScopeFailure | null> {
  if (input.actorUserId === input.targetUserId) {
    // Self-target is allowed in principle (an admin can revoke
    // their OWN factor), but the higher level functions decide.
  }
  const adminMembership = await prisma.teamMember.findFirst({
    where: {
      userId: input.actorUserId,
      teamId: input.teamId,
      status: "ACTIVE",
    },
    select: { role: true },
  });
  if (!adminMembership) return "admin_not_in_team";
  if (!(adminMembership.role === "OWNER" || adminMembership.role === "ADMIN")) {
    return "admin_not_admin";
  }
  const targetMembership = await prisma.teamMember.findFirst({
    where: {
      userId: input.targetUserId,
      teamId: input.teamId,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (!targetMembership) return "target_not_in_team";
  return null;
}

// ---------------------------------------------------------------------------
// READ — user MFA posture
// ---------------------------------------------------------------------------

export interface ReadUserMfaPostureInput {
  teamId: string;
  actorUserId: string;
  targetUserId: string;
}

export interface UserMfaPostureRow {
  userId: string;
  activeFactorCount: number;
  recoveryCodesRemaining: number;
  lastUsedAt: string | null;
  enrollmentRequired: boolean;
  pendingRecoveryRequestId: string | null;
}

export interface ReadUserMfaPostureResult {
  ok: boolean;
  reason?: MfaAdminScopeFailure;
  posture?: UserMfaPostureRow;
}

/**
 * Read-only posture surface. NEVER returns the factor's secret,
 * label, otpauth URI, or any recovery code plaintext — only
 * counts + a single `lastUsedAt` timestamp.
 */
export async function readUserMfaPosture(
  input: ReadUserMfaPostureInput,
): Promise<ReadUserMfaPostureResult> {
  const guard = await assertAdminCanAct(input);
  if (guard) return { ok: false, reason: guard };

  const [factors, recoveryCount, pendingRequest] = await Promise.all([
    prisma.mfaFactor.findMany({
      where: { userId: input.targetUserId, status: "ACTIVE" },
      select: { id: true, lastUsedAt: true },
    }),
    prisma.mfaRecoveryCode.count({
      where: {
        userId: input.targetUserId,
        usedAt: null,
        batchInvalidatedAt: null,
      },
    }),
    // R8.1.5 — admin posture surfaces ANY in-flight recovery request
    // (either preflight state). Approved/Completed/Cancelled rows
    // are closed lifecycle states and not shown here.
    prisma.mfaRecoveryRequest.findFirst({
      where: {
        userId: input.targetUserId,
        teamId: input.teamId,
        status: {
          in: ["EMAIL_VERIFICATION_PENDING", "PENDING_ADMIN_REVIEW"],
        },
      },
      select: { id: true },
    }),
  ]);
  const lastUsedAt =
    factors.reduce<Date | null>((acc, f) => {
      if (!f.lastUsedAt) return acc;
      if (!acc) return f.lastUsedAt;
      return f.lastUsedAt.getTime() > acc.getTime() ? f.lastUsedAt : acc;
    }, null)?.toISOString() ?? null;
  return {
    ok: true,
    posture: {
      userId: input.targetUserId,
      activeFactorCount: factors.length,
      recoveryCodesRemaining: recoveryCount,
      lastUsedAt,
      enrollmentRequired: factors.length === 0,
      pendingRecoveryRequestId: pendingRequest?.id ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// REVOKE a single factor
// ---------------------------------------------------------------------------

export interface RevokeUserFactorInput {
  teamId: string;
  actorUserId: string;
  targetUserId: string;
  factorId: string;
  reason: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface RevokeUserFactorResult {
  ok: boolean;
  reason?: MfaAdminScopeFailure | "factor_not_found" | "factor_not_active";
}

export async function revokeUserFactor(
  input: RevokeUserFactorInput,
): Promise<RevokeUserFactorResult> {
  const guard = await assertAdminCanAct(input);
  if (guard) return { ok: false, reason: guard };
  const factor = await prisma.mfaFactor.findUnique({
    where: { id: input.factorId },
    select: { id: true, userId: true, status: true },
  });
  if (!factor || factor.userId !== input.targetUserId) {
    return { ok: false, reason: "factor_not_found" };
  }
  if (factor.status !== "ACTIVE") {
    return { ok: false, reason: "factor_not_active" };
  }
  await prisma.mfaFactor.update({
    where: { id: factor.id },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      revokedReason: input.reason.slice(0, 120) || "admin_revoked",
    },
  });
  void emitTenantAudit({
    action: "mfa.admin.factor_revoked",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "mfa_factor",
    resourceId: factor.id,
    metadata: {
      targetUserId: input.targetUserId,
      reason: input.reason.slice(0, 120),
    },
  }).catch(() => null);
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "mfa_admin_factor_revoked",
    severity: "WARNING",
    details: {
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      factorId: factor.id,
    },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// REQUIRE re-enrollment — revoke every active factor for a user
// ---------------------------------------------------------------------------

export interface RequireReenrollmentInput {
  teamId: string;
  actorUserId: string;
  targetUserId: string;
  reason: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface RequireReenrollmentResult {
  ok: boolean;
  reason?: MfaAdminScopeFailure;
  revokedFactorCount?: number;
}

/**
 * Atomic "force re-enroll" — flips every ACTIVE factor on the
 * target user to REVOKED in a single UPDATE. The next login goes
 * through R8.1.3's ENROLLMENT_REQUIRED branch.
 */
export async function requireUserReenrollment(
  input: RequireReenrollmentInput,
): Promise<RequireReenrollmentResult> {
  const guard = await assertAdminCanAct(input);
  if (guard) return { ok: false, reason: guard };
  const result = await prisma.mfaFactor.updateMany({
    where: { userId: input.targetUserId, status: "ACTIVE" },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      revokedReason:
        (input.reason ?? "admin_required_reenrollment").slice(0, 120),
    },
  });
  void emitTenantAudit({
    action: "mfa.admin.reenrollment_required",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "user_mfa",
    resourceId: input.targetUserId,
    metadata: {
      targetUserId: input.targetUserId,
      revokedFactorCount: result.count,
      reason: input.reason.slice(0, 120),
    },
  }).catch(() => null);
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "mfa_admin_reenrollment_required",
    severity: "WARNING",
    details: {
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      revokedFactorCount: result.count,
    },
  });
  return { ok: true, revokedFactorCount: result.count };
}

// ---------------------------------------------------------------------------
// RESET trusted devices
// ---------------------------------------------------------------------------

export interface ResetTrustedDevicesInput {
  teamId: string;
  actorUserId: string;
  targetUserId: string;
  reason: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ResetTrustedDevicesResult {
  ok: boolean;
  reason?: MfaAdminScopeFailure;
  resetCount?: number;
}

/**
 * Revoke every trusted-device row for the target user under the
 * scope of the given team. The trusted-device service already has
 * a per-row revoke; this is the bulk variant scoped + audited.
 *
 * NOTE: the schema's `trusted_devices.userId` is global (not
 * team-scoped) because a device is "trusted by user X to skip MFA
 * for N days"; team scope is the admin's authority anchor, not
 * the row's. We still enforce the admin's team membership above.
 */
export async function resetTrustedDevicesForUser(
  input: ResetTrustedDevicesInput,
): Promise<ResetTrustedDevicesResult> {
  const guard = await assertAdminCanAct(input);
  if (guard) return { ok: false, reason: guard };
  const result = await prisma.trustedDevice.updateMany({
    where: {
      userId: input.targetUserId,
      teamId: input.teamId,
      status: "ACTIVE",
    },
    data: {
      status: "REVOKED",
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId,
      revokedReason: (input.reason ?? "admin_reset_devices").slice(0, 200),
    },
  });
  void emitTenantAudit({
    action: "mfa.admin.trusted_devices_reset",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "trusted_device_collection",
    resourceId: input.targetUserId,
    metadata: {
      targetUserId: input.targetUserId,
      resetCount: result.count,
      reason: input.reason.slice(0, 200),
    },
  }).catch(() => null);
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "mfa_trusted_devices_reset",
    severity: "WARNING",
    details: {
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      resetCount: result.count,
    },
  });
  return { ok: true, resetCount: result.count };
}

// ---------------------------------------------------------------------------
// READ recent MFA security events (admin view)
// ---------------------------------------------------------------------------

export interface ListRecentMfaEventsInput {
  teamId: string;
  actorUserId: string;
  limit?: number;
  /** Decoded keyset cursor — rows strictly after this (createdAt, id). */
  after?: KeysetKey | null;
}

export type RecentMfaEventRow = {
  id: string;
  eventType: string;
  severity: string;
  createdAt: string;
  details: unknown;
  /**
   * PHASE 5 §6 — who. A stable id for correlation and a display label for the
   * console; never an email, which is not a thing the Security page should be
   * a place to read out of.
   */
  actorUserId: string | null;
  actorDisplay: string | null;
};

/**
 * One page of the team's MFA-related security events, newest first.
 *
 * Bounded to at most 100 rows a page and keyset over `createdAt desc, id
 * desc`, so the console can walk the whole history 25 rows at a time
 * instead of rendering the most recent fifty and calling it the history.
 */
export async function listRecentMfaEvents(
  input: ListRecentMfaEventsInput,
): Promise<
  | {
      ok: true;
      events: ReadonlyArray<RecentMfaEventRow>;
      /** Opaque continuation, `null` on the last page. */
      nextCursor: string | null;
      /** The server's own answer — not an inference from the row count. */
      hasMore: boolean;
    }
  | { ok: false; reason: "admin_not_in_team" | "admin_not_admin" }
> {
  // Re-use the scope check but target = actor (admin is self).
  const guard = await assertAdminCanAct({
    teamId: input.teamId,
    actorUserId: input.actorUserId,
    targetUserId: input.actorUserId,
  });
  if (guard === "admin_not_in_team" || guard === "admin_not_admin") {
    return { ok: false, reason: guard };
  }
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const filters = {
    teamId: input.teamId,
    eventType: { startsWith: "mfa_" },
  };
  const events = await prisma.securityEvent.findMany({
    where: input.after
      ? { AND: [filters, keysetAfter("createdAt", input.after)] }
      : filters,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      eventType: true,
      severity: true,
      createdAt: true,
      details: true,
      // PHASE 5 §6 — the Security page showed what happened to second factors
      // and never who did it. `SecurityEvent.userId` has always been here; the
      // read simply did not select it, so the console had nothing to render in
      // an actor column and therefore had no actor column.
      userId: true,
    },
  });
  const page = keysetPage(events, limit, (e) => ({ at: e.createdAt, id: e.id }));

  // ONE query for the whole page, not one per row. Only ids that are actually
  // on the page are resolved, and a deleted account simply has no entry.
  const actorIds = Array.from(
    new Set(page.rows.map((e) => e.userId).filter((id): id is string => Boolean(id))),
  );
  const displayById = new Map<string, string>();
  if (actorIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: actorIds } },
      // No email: this is a display label, and the Security console must not
      // become a place addresses are read out of.
      select: { id: true, displayName: true },
    });
    for (const u of users) {
      if (u.displayName && u.displayName.trim()) displayById.set(u.id, u.displayName.trim());
    }
  }

  return {
    ok: true,
    events: page.rows.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      severity: e.severity,
      createdAt: e.createdAt.toISOString(),
      details: e.details,
      /*
       * PHASE 5 §6 — the actor, resolved for the page rather than left as an
       * id the operator would have to look up.
       *
       * Resolved LIVE here, deliberately, and this is the one place that is
       * right: a SecurityEvent is not the append-only operator audit and
       * carries no contemporaneous snapshot, so the current name is the only
       * name available. Where the account is gone the map has no entry and the
       * client renders the honest fallback rather than inventing one.
       *
       * An event with no user is not "the system" — MFA events are raised by
       * detection as often as by a person — so the honest value is null and
       * the client says so.
       */
      actorUserId: e.userId ?? null,
      actorDisplay: e.userId ? (displayById.get(e.userId) ?? null) : null,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}
