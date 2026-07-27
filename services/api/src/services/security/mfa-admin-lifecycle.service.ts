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
}

/**
 * Read recent security events for the team that relate to MFA.
 * Bounded to the most recent 100 rows.
 */
export async function listRecentMfaEvents(
  input: ListRecentMfaEventsInput,
): Promise<
  | {
      ok: true;
      events: ReadonlyArray<{
        id: string;
        eventType: string;
        severity: string;
        createdAt: string;
        details: unknown;
      }>;
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
  const events = await prisma.securityEvent.findMany({
    where: {
      teamId: input.teamId,
      eventType: { startsWith: "mfa_" },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      eventType: true,
      severity: true,
      createdAt: true,
      details: true,
    },
  });
  return {
    ok: true,
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      severity: e.severity,
      createdAt: e.createdAt.toISOString(),
      details: e.details,
    })),
  };
}
