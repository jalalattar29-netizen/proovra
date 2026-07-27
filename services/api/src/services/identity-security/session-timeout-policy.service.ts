/**
 * Phase 3 (Enterprise Identity) — Org session-timeout POLICY enforcement.
 *
 * REPAIR, not new build. The `OrganizationSecurityPolicy` row has long
 * stored `reviewerSessionTimeoutSeconds` / `contributorSessionTimeoutSeconds`
 * (Phase 17) but they were READ-ONLY / enforcement DEFERRED — the main
 * session cookie is a hardcoded 30-day JWT (auth.routes.ts). This service
 * connects those stored fields to actual enforcement in the auth
 * middleware (the same hot path that already checks RevokedSession +
 * touches the session).
 *
 * It answers exactly one question, on every authenticated request that
 * carries a workspace-scoped session:
 *
 *   "Given this user's role in this workspace, and the org's configured
 *    session timeout, has this session lived (or idled) too long?"
 *
 * Hard rules (mirroring the existing MFA circuit-breaker philosophy):
 *   - FAIL SAFE. If the policy or role lookup throws (Prisma outage,
 *     etc.) we DO NOT expire the session — we degrade to the JWT's own
 *     30-day exp cap and log. A policy-table outage must never lock out
 *     every user. (Contrast: the MFA path fails CLOSED because there a
 *     miss means "skip a security control"; here a miss means "log out
 *     everyone", which is the more dangerous failure.)
 *   - A `null` timeout for the applicable role = no policy constraint;
 *     the session is bounded only by the JWT exp.
 *   - The JWT `exp` (verifyJwt) is always the hard ceiling; this policy
 *     can only expire a session SOONER, never extend it.
 *   - Scope is AUTHENTICATED INTERNAL SESSIONS ONLY. The external
 *     reviewer portal has its own token/session model (portal-session
 *     .service.ts, bearer header, in-memory, its own ≤30m idle / ≤8h
 *     max caps) and never flows through requireAuth, so it is
 *     structurally unaffected by this enforcement.
 */

import type { PrismaClient, TeamRole } from "@prisma/client";
import {
  type SessionTimeoutDecision,
  type SessionTimeoutRole,
  evaluateSessionTimeout,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { organizationIdForPolicy } from "../identity/org-security-policy.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { bump } from "../ops/metrics.service.js";

export type SessionTimeoutEnforcementInput = {
  userId: string;
  /** Workspace/org anchor for the session; null = personal-space token. */
  teamId: string | null;
  /** JWT issued-at, unix seconds. */
  iat: number | null;
  /** Session last-seen (best-effort heartbeat). Null ⇒ measure idle from iat. */
  lastSeenAtMs?: number | null;
  nowMs?: number;
};

export type SessionTimeoutEnforcementResult =
  | { action: "allow"; degraded: boolean }
  | {
      action: "expire";
      reason: "absolute" | "idle";
      appliedTimeoutSeconds: number;
      role: SessionTimeoutRole;
    };

/**
 * The single decision function called by the auth middleware. Never
 * throws — any internal failure resolves to `{ action: "allow",
 * degraded: true }` (fail-safe).
 */
export async function enforceSessionTimeoutPolicy(
  input: SessionTimeoutEnforcementInput,
  client: PrismaClient = defaultPrisma,
): Promise<SessionTimeoutEnforcementResult> {
  // Personal-space tokens have no workspace policy to evaluate — no-op
  // by design (mirrors the security-gate skip for teamless sessions).
  if (!input.teamId) {
    return { action: "allow", degraded: false };
  }
  // Without an issued-at we cannot compute age/idle — allow (the JWT
  // exp still bounds the session). Pre-Phase-19 tokens have no iat.
  if (input.iat === null || !Number.isFinite(input.iat)) {
    return { action: "allow", degraded: false };
  }

  let policyFields: {
    reviewerSessionTimeoutSeconds: number | null;
    contributorSessionTimeoutSeconds: number | null;
  };
  let role: SessionTimeoutRole;
  try {
    // §1.1 — the policy is read by AUTHORITATIVE organizationId (never teamId)
    // via the zero-decision adapter. Both lookups are keyed single-row reads.
    const policyOrgId = await organizationIdForPolicy(input.teamId, client);
    const [policyRow, memberRow] = await Promise.all([
      policyOrgId
        ? client.organizationSecurityPolicy.findUnique({
            where: { organizationId: policyOrgId },
            select: {
              reviewerSessionTimeoutSeconds: true,
              contributorSessionTimeoutSeconds: true,
            },
          })
        : Promise.resolve(null),
      client.teamMember.findUnique({
        where: {
          teamId_userId: { teamId: input.teamId, userId: input.userId },
        },
        select: { role: true },
      }),
    ]);
    policyFields = {
      reviewerSessionTimeoutSeconds:
        policyRow?.reviewerSessionTimeoutSeconds ?? null,
      contributorSessionTimeoutSeconds:
        policyRow?.contributorSessionTimeoutSeconds ?? null,
    };
    role = mapTeamRole(memberRow?.role ?? null);
  } catch {
    // FAIL SAFE — degrade to the JWT exp cap; never lock everyone out.
    bump("session_timeout_policy_fail_open_total");
    return { action: "allow", degraded: true };
  }

  const decision: SessionTimeoutDecision = evaluateSessionTimeout({
    role,
    policy: policyFields,
    issuedAtMs: input.iat * 1000,
    lastSeenAtMs: input.lastSeenAtMs ?? null,
    nowMs: input.nowMs,
  });

  if (!decision.expired || decision.reason === null) {
    return { action: "allow", degraded: false };
  }

  // Session exceeded the applicable policy timeout — audit + return
  // expire. Emission is best-effort; it must not throw on the hot path.
  bump("session_expired_by_policy_total");
  await recordPolicyExpiry(
    {
      teamId: input.teamId,
      userId: input.userId,
      reason: decision.reason,
      appliedTimeoutSeconds: decision.appliedTimeoutSeconds ?? 0,
      ageSeconds: decision.ageSeconds,
      idleSeconds: decision.idleSeconds,
      role,
    },
    client,
  );

  return {
    action: "expire",
    reason: decision.reason,
    appliedTimeoutSeconds: decision.appliedTimeoutSeconds ?? 0,
    role,
  };
}

/**
 * Map the Prisma TeamRole enum to the shared browser-safe timeout role
 * union. Unknown values collapse to `null`, which
 * `resolveSessionTimeoutSecondsForRole` treats as the tighter tier.
 */
function mapTeamRole(role: TeamRole | null): SessionTimeoutRole {
  switch (role) {
    case "OWNER":
    case "ADMIN":
    case "MEMBER":
    case "VIEWER":
      return role;
    default:
      return null;
  }
}

/**
 * Write the audit + security-event trail for a policy expiry. Best
 * effort — swallows its own errors so a logging failure never turns a
 * clean 401 into a 500.
 */
async function recordPolicyExpiry(
  input: {
    teamId: string;
    userId: string;
    reason: "absolute" | "idle";
    appliedTimeoutSeconds: number;
    ageSeconds: number;
    idleSeconds: number;
    role: SessionTimeoutRole;
  },
  client: PrismaClient,
): Promise<void> {
  try {
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "session_expired_by_policy",
        severity: "INFO",
        details: {
          subjectUserId: input.userId,
          reason: input.reason,
          appliedTimeoutSeconds: input.appliedTimeoutSeconds,
          ageSeconds: input.ageSeconds,
          idleSeconds: input.idleSeconds,
          role: input.role,
        },
      },
      client,
    );
    await emitTenantAudit({
      action: "identity_security.session.expired_by_policy",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.userId,
      serviceActor: "session_timeout_policy",
      workspaceId: input.teamId,
      resourceType: "authenticated_session",
      resourceId: input.userId,
      metadata: {
        reason: input.reason,
        appliedTimeoutSeconds: input.appliedTimeoutSeconds,
        ageSeconds: input.ageSeconds,
        idleSeconds: input.idleSeconds,
        role: input.role,
      },
    }, client);
  } catch {
    /* audit is best-effort; never break the auth decision */
  }
}
