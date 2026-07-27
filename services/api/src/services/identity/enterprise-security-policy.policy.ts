/**
 * PHASE 10 §10.1–§10.7 (2026-07-23) — PURE enterprise-security-policy evaluator.
 *
 * This module is INTERNAL and PURE: no Prisma/DB access, no writes, no audit,
 * no session mutation, no route imports. Deterministic input → decision output
 * only. The SOLE production authority is `org-security-policy.service.ts`,
 * which composes these evaluators; routes/session/SSO/SCIM callers go through
 * that service, never this module directly (only the service + tests import it).
 */

export type SecurityMode = "STANDARD" | "HIGH_SECURITY";
export type AuthMethod = "PASSWORD" | "OAUTH" | "SSO";

/** The Phase 10 decision-relevant projection of the policy row. */
export type ResolvedSecurityPolicy = {
  teamId: string;
  organizationId: string | null;
  policyVersion: number;
  ssoRequired: boolean;
  managedIdentityRequired: boolean;
  noPersonalSpace: boolean;
  securityMode: SecurityMode;
  maxSessionAgeSeconds: number | null;
  idleTimeoutSeconds: number | null;
  concurrentSessionLimit: number | null;
  stepUpIntervalSeconds: number | null;
  allowedAuthMethods: AuthMethod[];
};

/** The STANDARD, fully-permissive default posture (fail-safe / pre-migration). */
export function defaultSecurityPolicy(
  teamId: string,
  organizationId: string | null = null,
): ResolvedSecurityPolicy {
  return {
    teamId,
    organizationId,
    policyVersion: 1,
    ssoRequired: false,
    managedIdentityRequired: false,
    noPersonalSpace: false,
    securityMode: "STANDARD",
    maxSessionAgeSeconds: null,
    idleTimeoutSeconds: null,
    concurrentSessionLimit: null,
    stepUpIntervalSeconds: null,
    allowedAuthMethods: [],
  };
}

/** Coerce a persisted row (or null) into the resolved posture. Pure. */
export function coerceSecurityPolicy(
  teamId: string,
  organizationId: string | null,
  row: Record<string, unknown> | null,
): ResolvedSecurityPolicy {
  if (!row) return defaultSecurityPolicy(teamId, organizationId);
  const d = defaultSecurityPolicy(teamId, organizationId);
  return {
    teamId,
    organizationId,
    policyVersion: typeof row.policyVersion === "number" ? row.policyVersion : d.policyVersion,
    ssoRequired: row.ssoRequired === true,
    managedIdentityRequired: row.managedIdentityRequired === true,
    noPersonalSpace: row.noPersonalSpace === true,
    securityMode: row.securityMode === "HIGH_SECURITY" ? "HIGH_SECURITY" : "STANDARD",
    maxSessionAgeSeconds: typeof row.maxSessionAgeSeconds === "number" ? row.maxSessionAgeSeconds : null,
    idleTimeoutSeconds: typeof row.idleTimeoutSeconds === "number" ? row.idleTimeoutSeconds : null,
    concurrentSessionLimit: typeof row.concurrentSessionLimit === "number" ? row.concurrentSessionLimit : null,
    stepUpIntervalSeconds: typeof row.stepUpIntervalSeconds === "number" ? row.stepUpIntervalSeconds : null,
    allowedAuthMethods: Array.isArray(row.allowedAuthMethods)
      ? (row.allowedAuthMethods.filter((m) => m === "PASSWORD" || m === "OAUTH" || m === "SSO") as AuthMethod[])
      : [],
  };
}

export type Denial = { allowed: false; reason: string };
export type Allowed = { allowed: true };
export type Decision = Allowed | Denial;
const ALLOW: Allowed = { allowed: true };
const deny = (reason: string): Denial => ({ allowed: false, reason });

/**
 * §10.2/§10.7 + PHASE 10 correction 4/5 — is this authentication method
 * permitted for org access? MANDATORY SSO is a LOGIN-METHOD policy, DISTINCT
 * from managed-identity ownership: when `ssoRequired` is set, EVERY ordinary
 * session entering the Organization must use SSO — STANDARD, MANAGED, first
 * owner, admin, invited user, workspace member alike. It is NOT conditional on
 * managed status (the only bypass is the explicit, bounded break-glass path).
 * `allowedAuthMethods` (when non-empty) is an additional filter.
 */
export function evaluateAuthMethod(
  policy: ResolvedSecurityPolicy,
  input: { method: AuthMethod },
): Decision {
  if (policy.ssoRequired && input.method !== "SSO") {
    return deny("mandatory_sso_required");
  }
  if (policy.allowedAuthMethods.length > 0 && !policy.allowedAuthMethods.includes(input.method)) {
    return deny("auth_method_not_allowed");
  }
  return ALLOW;
}

/** §10.1 — a session minted under an OLDER policy version must re-authenticate. */
export function evaluatePolicyVersion(
  policy: ResolvedSecurityPolicy,
  sessionPolicyVersion: number | null | undefined,
): Decision {
  if (sessionPolicyVersion == null) return ALLOW; // legacy session — not version-gated
  return sessionPolicyVersion >= policy.policyVersion ? ALLOW : deny("policy_version_stale");
}

/** §10.7 — bounded session age + idle timeout (backend-authoritative; ms). */
export function evaluateSessionLifetime(
  policy: ResolvedSecurityPolicy,
  input: { issuedAtMs: number; lastSeenAtMs: number; nowMs: number },
): Decision {
  if (policy.maxSessionAgeSeconds != null && input.nowMs - input.issuedAtMs > policy.maxSessionAgeSeconds * 1000) {
    return deny("session_max_age_exceeded");
  }
  if (policy.idleTimeoutSeconds != null && input.nowMs - input.lastSeenAtMs > policy.idleTimeoutSeconds * 1000) {
    return deny("session_idle_timeout");
  }
  return ALLOW;
}

/** §10.7 — step-up is due when the interval has elapsed since last step-up. */
export function evaluateStepUpDue(
  policy: ResolvedSecurityPolicy,
  input: { lastStepUpAtMs: number | null; nowMs: number },
): { due: boolean } {
  if (policy.stepUpIntervalSeconds == null) return { due: false };
  if (input.lastStepUpAtMs == null) return { due: true };
  return { due: input.nowMs - input.lastStepUpAtMs > policy.stepUpIntervalSeconds * 1000 };
}

/** §10.5 — may this org context bootstrap/route into a personal workspace? */
export function evaluatePersonalSpaceAllowed(policy: ResolvedSecurityPolicy): boolean {
  return !policy.noPersonalSpace;
}

/** §10.4 — HIGH_SECURITY activation prerequisites (atomic gate). */
export type HighSecurityPrerequisites = {
  hasActiveSsoConnection: boolean;
  ssoConnectionTested: boolean;
  hasVerifiedDomain: boolean;
  hasBreakGlassReadiness: boolean;
  unresolvedPersonalCustodyUserIds: string[];
  contractActive: boolean;
};

export function evaluateHighSecurityActivation(
  pre: HighSecurityPrerequisites,
): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (!pre.contractActive) missing.push("enterprise_contract_active");
  if (!pre.hasActiveSsoConnection) missing.push("active_sso_connection");
  if (!pre.ssoConnectionTested) missing.push("sso_connection_tested");
  if (!pre.hasVerifiedDomain) missing.push("verified_domain");
  if (!pre.hasBreakGlassReadiness) missing.push("break_glass_readiness");
  if (pre.unresolvedPersonalCustodyUserIds.length > 0) missing.push("unresolved_personal_custody");
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** The HIGH_SECURITY composed posture (what activation writes). */
export function highSecurityPosture(): Pick<
  ResolvedSecurityPolicy,
  "ssoRequired" | "managedIdentityRequired" | "noPersonalSpace" | "securityMode"
> {
  return { securityMode: "HIGH_SECURITY", ssoRequired: true, managedIdentityRequired: true, noPersonalSpace: true };
}

export type SecurityPolicyPatch = Partial<
  Pick<
    ResolvedSecurityPolicy,
    | "ssoRequired"
    | "managedIdentityRequired"
    | "noPersonalSpace"
    | "securityMode"
    | "maxSessionAgeSeconds"
    | "idleTimeoutSeconds"
    | "concurrentSessionLimit"
    | "stepUpIntervalSeconds"
    | "allowedAuthMethods"
  >
>;
