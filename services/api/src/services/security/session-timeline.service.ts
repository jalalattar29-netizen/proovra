/**
 * Phase P1.1 — Bounded session identity timeline.
 *
 * Reconstructs the identity-security event timeline for a single
 * `AuthenticatedSession`. This is NOT a surveillance system:
 *
 *   * Only events from the bounded "identity events" set are returned
 *     (login, MFA, step-up, trusted device, geo anomaly,
 *     quarantine, revoke, logout).
 *
 *   * Never includes: page views, mouse activity, evidence-content
 *     viewing (unless already a custody event), private behavior
 *     telemetry.
 *
 *   * IP / userAgent / device telemetry are NOT in the response.
 *     The bounded payload carries only the operator-safe summary +
 *     severity + correlation ids.
 *
 *   * Workspace-scoped: requires `teamId` and validates the session
 *     belongs to that workspace.
 *
 * Today the SecurityEvent table does NOT have a dedicated `sessionId`
 * column (per the P1.1.0 audit). Two correlation strategies:
 *
 *   A. Direct lookup of session row + linked event windows
 *      (issued..lastSeen) — surfaces the bracket of events that
 *      happened during the session's lifecycle.
 *
 *   B. JSON-path lookup against SecurityEvent.details where event
 *      services that carry sessionId persist it (adaptive auth /
 *      step-up / runtime risk).
 *
 * We use (A) — the session-row time bracket — because Prisma JSON
 * path queries vary by database and we want a deterministic
 * Postgres-only behavior. The events surfaced are the ones that
 * occurred for `userId` within `[issuedAtUtc, lastSeenAtUtc OR NOW]`
 * for the bounded event-type allowlist.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

// Identity-security event-type allowlist. ONLY these types appear in
// the timeline; everything else is filtered.
const IDENTITY_TIMELINE_EVENT_TYPES = [
  // Login family
  "saml_login_started",
  "saml_login_succeeded",
  "saml_login_failed",
  "saml_assertion_rejected",
  "saml_jit_provisioned",
  "saml_jit_denied",
  "sso_login_started",
  "sso_login_succeeded",
  "sso_login_failed",
  "user_logged_in",
  "user_logged_out",
  // MFA
  "mfa_enrollment_started",
  "mfa_enrollment_succeeded",
  "mfa_enrollment_failed",
  "mfa_verification_failed",
  "mfa_challenge_issued",
  "mfa_challenge_verified",
  // Step-up
  "step_up_challenge_started",
  "step_up_challenge_verified",
  "step_up_challenge_failed",
  "high_risk_action_step_up_required",
  // Trusted device
  "trusted_device_trusted",
  "trusted_device_revoked",
  // Risk / adaptive auth
  "suspicious_session_detected",
  "privileged_session_blocked",
  "session_quarantined",
  "session_quarantine_released",
  "rbac_temporary_elevation_granted",
  // Revocation
  "session_revoked_admin",
  "all_sessions_revoked_admin",
] as const;

export type IdentityTimelineSeverity = "INFO" | "WARNING" | "HIGH";

export type IdentityTimelineEvent = {
  id: string;
  occurredAtUtc: string;
  eventType: string;
  severity: IdentityTimelineSeverity;
  summary: string;
};

export type IdentitySessionTimeline = {
  sessionId: string;
  teamId: string;
  /** Bounded session metadata operator-safe to expose. */
  session: {
    issuedAtUtc: string;
    expiresAtUtc: string | null;
    lastSeenAtUtc: string | null;
    revokedAtUtc: string | null;
    revocationReason: string | null;
    /** SAML / OIDC connection id when applicable (no provider secrets). */
    ssoConnectionId: string | null;
  };
  /** Event count cap — bounded to 200. */
  events: ReadonlyArray<IdentityTimelineEvent>;
  truncated: boolean;
};

export async function buildIdentitySessionTimeline(
  input: { teamId: string; sessionId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<IdentitySessionTimeline> {
  const session = await client.authenticatedSession.findFirst({
    where: { id: input.sessionId },
    select: {
      id: true,
      userId: true,
      teamId: true,
      ssoConnectionId: true,
      issuedAtUtc: true,
      expiresAtUtc: true,
      lastSeenAtUtc: true,
      revokedAtUtc: true,
      revokedReason: true,
    },
  });

  // Tenant gate: refuse session that belongs to a different team.
  // We return an empty timeline rather than 404 — this is a read,
  // and the caller is already team-scoped by the route layer; this
  // gate is belt-and-suspenders.
  if (!session || session.teamId !== input.teamId) {
    return {
      sessionId: input.sessionId,
      teamId: input.teamId,
      session: {
        issuedAtUtc: new Date().toISOString(),
        expiresAtUtc: null,
        lastSeenAtUtc: null,
        revokedAtUtc: null,
        revocationReason: null,
        ssoConnectionId: null,
      },
      events: [],
      truncated: false,
    };
  }

  const from = session.issuedAtUtc;
  const to =
    session.revokedAtUtc ??
    session.lastSeenAtUtc ??
    session.expiresAtUtc ??
    new Date();

  const events = await client.securityEvent.findMany({
    where: {
      teamId: input.teamId,
      userId: session.userId,
      eventType: { in: IDENTITY_TIMELINE_EVENT_TYPES as unknown as string[] },
      createdAt: { gte: from, lte: to },
    },
    orderBy: { createdAt: "asc" },
    take: 201,
    select: {
      id: true,
      eventType: true,
      severity: true,
      createdAt: true,
    },
  });

  const truncated = events.length > 200;
  const capped = events.slice(0, 200);

  return {
    sessionId: session.id,
    teamId: input.teamId,
    session: {
      issuedAtUtc: session.issuedAtUtc.toISOString(),
      expiresAtUtc: session.expiresAtUtc
        ? session.expiresAtUtc.toISOString()
        : null,
      lastSeenAtUtc: session.lastSeenAtUtc
        ? session.lastSeenAtUtc.toISOString()
        : null,
      revokedAtUtc: session.revokedAtUtc
        ? session.revokedAtUtc.toISOString()
        : null,
      revocationReason: session.revokedReason ?? null,
      ssoConnectionId: session.ssoConnectionId ?? null,
    },
    events: capped.map((e) => ({
      id: e.id,
      occurredAtUtc: e.createdAt.toISOString(),
      eventType: e.eventType,
      severity: (e.severity as IdentityTimelineSeverity) ?? "INFO",
      summary: humaniseIdentityEvent(e.eventType),
    })),
    truncated,
  };
}

function humaniseIdentityEvent(eventType: string): string {
  // Operator-safe one-liners. No internal payloads, no PII.
  switch (eventType) {
    case "saml_login_started":
      return "SAML login initiated";
    case "saml_login_succeeded":
      return "SAML login succeeded";
    case "saml_login_failed":
      return "SAML login failed (see audit center for reason)";
    case "saml_assertion_rejected":
      return "SAML assertion rejected by validator";
    case "saml_jit_provisioned":
      return "JIT-provisioned via SAML";
    case "saml_jit_denied":
      return "JIT provisioning denied (policy / domain)";
    case "sso_login_started":
      return "SSO login initiated";
    case "sso_login_succeeded":
      return "SSO login succeeded";
    case "sso_login_failed":
      return "SSO login failed";
    case "user_logged_in":
      return "Operator logged in";
    case "user_logged_out":
      return "Operator logged out";
    case "mfa_enrollment_started":
      return "MFA enrollment started";
    case "mfa_enrollment_succeeded":
      return "MFA factor enrolled";
    case "mfa_enrollment_failed":
      return "MFA enrollment failed";
    case "mfa_verification_failed":
      return "MFA verification failed";
    case "mfa_challenge_issued":
      return "MFA challenge issued";
    case "mfa_challenge_verified":
      return "MFA challenge verified";
    case "step_up_challenge_started":
      return "Step-up challenge started";
    case "step_up_challenge_verified":
      return "Step-up challenge verified";
    case "step_up_challenge_failed":
      return "Step-up challenge failed";
    case "high_risk_action_step_up_required":
      return "High-risk action required step-up";
    case "trusted_device_trusted":
      return "Device marked trusted";
    case "trusted_device_revoked":
      return "Trusted device revoked";
    case "suspicious_session_detected":
      return "Suspicious session signal detected";
    case "privileged_session_blocked":
      return "Privileged session blocked by adaptive auth";
    case "session_quarantined":
      return "Session quarantined";
    case "session_quarantine_released":
      return "Quarantined session released";
    case "rbac_temporary_elevation_granted":
      return "Temporary privilege elevation granted";
    case "session_revoked_admin":
      return "Session revoked by admin";
    case "all_sessions_revoked_admin":
      return "All sessions revoked by admin (bulk)";
    default:
      return "Identity event";
  }
}
