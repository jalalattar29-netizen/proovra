/**
 * Phase 26.75 — Enterprise Identity Runtime canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). Extends Phase 26.5 with:
 *   - Session quarantine reasons + lifecycle
 *   - Geo intelligence provider + cache TTL
 *   - Runtime risk recompute scheduling
 *   - Trust decay weighting + quarantine signals on devices
 *   - Privileged-action catalog (what requires the adaptive-auth gate)
 *
 * Hard invariants:
 *   - Quarantine NEVER hard-revokes a session — read paths stay open.
 *     The adaptive auth engine enforces the privileged-action block.
 *   - Geo cache TTL is operator-tunable but bounded; failure modes
 *     never break auth.
 *   - Trust decay is additive and capped at 100.
 *   - Privileged-action catalog is a bounded enum the route layer
 *     references; ad-hoc actions are NOT supported.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Quarantine
// -----------------------------------------------------------------------------

export const SESSION_QUARANTINE_REASONS = [
  "MANUAL_OPERATOR",
  "SUSPICIOUS_SESSION_AUTO",
  "REPEATED_REPLAY",
  "GEO_ANOMALY",
  "PRIVILEGED_SESSION_AGED",
  "SUSPICIOUS_REVIEWER_ACTIVITY",
  "SUSPICIOUS_ADMIN_ACTIVITY",
  "EMERGENCY_ORG_WIDE",
] as const;
export const SessionQuarantineReasonSchema = z.enum(
  SESSION_QUARANTINE_REASONS,
);
export type SessionQuarantineReason = z.infer<
  typeof SessionQuarantineReasonSchema
>;

export const SESSION_QUARANTINE_DEFAULT_HOURS = 4;
export const SESSION_QUARANTINE_MAX_HOURS = 24;

// -----------------------------------------------------------------------------
// Privileged action catalog — what the adaptive-auth gate runs on.
//
// The route layer references this catalog so a new high-risk action
// cannot be added without an explicit code change.
// -----------------------------------------------------------------------------

export const PRIVILEGED_ACTIONS = [
  "REVIEWER_APPROVE",
  "REVIEWER_REJECT",
  "REVIEWER_BULK",
  "REVIEW_ESCALATION_RESOLVE",
  "REVIEW_ESCALATION_SUPPRESS",
  "EXPORT_GENERATE_PACKAGE",
  "EXPORT_GENERATE_REPORT",
  "ORIGINAL_EVIDENCE_DOWNLOAD",
  "RETENTION_POLICY_UPDATE",
  "LEGAL_HOLD_PLACE",
  "LEGAL_HOLD_RELEASE",
  "SCIM_TOKEN_CREATE",
  "SCIM_TOKEN_REVOKE",
  "SERVICE_ACCOUNT_CREATE",
  "SERVICE_ACCOUNT_ROTATE",
  "SSO_CONNECTION_CREATE",
  "SSO_CONNECTION_REVOKE",
  "ORG_SECURITY_POLICY_UPDATE",
  "WORKSPACE_GOVERNANCE_UPDATE",
  "API_CREDENTIAL_CREATE",
  "WEBHOOK_SECRET_ROTATE",
  "RBAC_TEMPORARY_ELEVATION",
  "DELEGATED_SCOPE_GRANT",
  "DELEGATED_SCOPE_REVOKE",
  "MEMBER_SUSPEND",
  "MEMBER_REVOKE",
  "MEMBER_ROLE_CHANGE",
] as const;
export const PrivilegedActionSchema = z.enum(PRIVILEGED_ACTIONS);
export type PrivilegedAction = z.infer<typeof PrivilegedActionSchema>;

/**
 * Privileged actions never proceed from a quarantined session. The
 * adaptive auth engine returns BLOCK + the route layer surfaces a
 * structured `quarantined_session` error.
 */
export const PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS: Record<
  PrivilegedAction,
  number
> = {
  REVIEWER_APPROVE: 8,
  REVIEWER_REJECT: 8,
  REVIEWER_BULK: 4,
  REVIEW_ESCALATION_RESOLVE: 8,
  REVIEW_ESCALATION_SUPPRESS: 4,
  EXPORT_GENERATE_PACKAGE: 4,
  EXPORT_GENERATE_REPORT: 4,
  ORIGINAL_EVIDENCE_DOWNLOAD: 1,
  RETENTION_POLICY_UPDATE: 1,
  LEGAL_HOLD_PLACE: 1,
  LEGAL_HOLD_RELEASE: 1,
  SCIM_TOKEN_CREATE: 1,
  SCIM_TOKEN_REVOKE: 1,
  SERVICE_ACCOUNT_CREATE: 1,
  SERVICE_ACCOUNT_ROTATE: 1,
  SSO_CONNECTION_CREATE: 1,
  SSO_CONNECTION_REVOKE: 1,
  ORG_SECURITY_POLICY_UPDATE: 1,
  WORKSPACE_GOVERNANCE_UPDATE: 1,
  API_CREDENTIAL_CREATE: 1,
  WEBHOOK_SECRET_ROTATE: 1,
  RBAC_TEMPORARY_ELEVATION: 1,
  DELEGATED_SCOPE_GRANT: 1,
  DELEGATED_SCOPE_REVOKE: 1,
  MEMBER_SUSPEND: 2,
  MEMBER_REVOKE: 2,
  MEMBER_ROLE_CHANGE: 4,
};

// -----------------------------------------------------------------------------
// Geo intelligence
// -----------------------------------------------------------------------------

export const GEO_PROVIDERS = [
  "OFFLINE_DB",
  "MAXMIND",
  "IP2LOCATION",
  "STUB",
] as const;
export const GeoProviderSchema = z.enum(GEO_PROVIDERS);
export type GeoProvider = z.infer<typeof GeoProviderSchema>;

export const GEO_LOOKUP_DEFAULT_TIMEOUT_MS = 1500;
export const GEO_LOOKUP_MAX_TIMEOUT_MS = 5000;
export const GEO_CACHE_TTL_DAYS = 30;
export const GEO_CACHE_NEGATIVE_TTL_HOURS = 1;

export type GeoLookupResult = {
  countryCode: string | null;
  cached: boolean;
  provider: GeoProvider;
};

// -----------------------------------------------------------------------------
// Runtime risk recompute
// -----------------------------------------------------------------------------

export const RUNTIME_RISK_RECOMPUTE_DEFAULT_MINUTES = 15;
export const RUNTIME_RISK_RECOMPUTE_MIN_MINUTES = 5;
export const RUNTIME_RISK_RECOMPUTE_MAX_MINUTES = 360;

/**
 * Whether a session is due for a runtime risk recompute. Pure helper
 * shared between the cron and the on-demand admin route.
 */
export function isSessionDueForRiskRecompute(input: {
  lastRiskRecomputedAtUtc: Date | null | undefined;
  recomputeWindowMinutes?: number;
  nowUtc?: Date;
}): boolean {
  if (!input.lastRiskRecomputedAtUtc) return true;
  const window =
    input.recomputeWindowMinutes ?? RUNTIME_RISK_RECOMPUTE_DEFAULT_MINUTES;
  const now = (input.nowUtc ?? new Date()).getTime();
  return (
    now - input.lastRiskRecomputedAtUtc.getTime() >= window * 60_000
  );
}

// -----------------------------------------------------------------------------
// Privileged session aging
// -----------------------------------------------------------------------------

export const PRIVILEGED_SESSION_MAX_AGE_DEFAULT_HOURS = 24;

export type PrivilegedSessionAgeingInput = {
  sessionIssuedAtUtc: Date;
  /** Highest-privilege action attempted by this session. */
  action: PrivilegedAction;
  nowUtc?: Date;
  maxAgeHours?: number;
};

/**
 * Decide whether a privileged action requires a forced reauth purely
 * because of session age. The decision matrix:
 *   - Always: session must be < PRIVILEGED_SESSION_MAX_AGE_HOURS old.
 *   - Per-action override: if the action's freshness window is set
 *     in PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS, use the lower
 *     of (action window, max session age).
 */
export function privilegedActionRequiresFreshAuth(
  input: PrivilegedSessionAgeingInput,
): boolean {
  const maxAgeHours =
    input.maxAgeHours ?? PRIVILEGED_SESSION_MAX_AGE_DEFAULT_HOURS;
  const actionWindowHours =
    PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS[input.action] ?? maxAgeHours;
  const effectiveWindowMs =
    Math.min(actionWindowHours, maxAgeHours) * 3600_000;
  const ageMs =
    (input.nowUtc ?? new Date()).getTime() -
    input.sessionIssuedAtUtc.getTime();
  return ageMs > effectiveWindowMs;
}

// -----------------------------------------------------------------------------
// Trust decay
// -----------------------------------------------------------------------------

export const TRUST_DECAY_DEFAULT_MAX = 100;
export const TRUST_DECAY_STALE_DAYS = 14;
export const TRUST_DECAY_RISKY_INCREMENT = 25;

export type TrustDecayInput = {
  lastSeenAtUtc: Date;
  nowUtc?: Date;
  staleDays?: number;
  /** Incremental decay added by a risky signal observed since last sweep. */
  riskyIncrement?: number;
  /** Existing decay value on the device row. */
  currentDecay?: number;
};

export function computeTrustDecay(input: TrustDecayInput): number {
  const stale = input.staleDays ?? TRUST_DECAY_STALE_DAYS;
  const inc = input.riskyIncrement ?? 0;
  const base = input.currentDecay ?? 0;
  const now = (input.nowUtc ?? new Date()).getTime();
  const ageDays = (now - input.lastSeenAtUtc.getTime()) / 86400_000;
  const stalePenalty = Math.max(0, Math.floor(ageDays - stale)) * 2;
  const next = base + inc + stalePenalty;
  if (next < 0) return 0;
  if (next > TRUST_DECAY_DEFAULT_MAX) return TRUST_DECAY_DEFAULT_MAX;
  return next;
}

// -----------------------------------------------------------------------------
// Adaptive auth runtime decision — extends Phase 26.5 with quarantine
// + privileged-session aging.
// -----------------------------------------------------------------------------

export type RuntimeAdaptiveDecision = {
  /** ALLOW | REQUIRE_STEP_UP | REQUIRE_REAUTH | BLOCK */
  decision: "ALLOW" | "REQUIRE_STEP_UP" | "REQUIRE_REAUTH" | "BLOCK";
  /** Catalog-bound reason. Operator-readable. */
  reason: string;
  /** Optional step-up purpose when decision = REQUIRE_STEP_UP. */
  stepUpPurpose?: string | null;
};

// -----------------------------------------------------------------------------
// Forced reauth cooldown
// -----------------------------------------------------------------------------

export const FORCED_REAUTH_COOLDOWN_DEFAULT_MINUTES = 30;

export function isFormedReauthAllowed(input: {
  lastForcedReauthAtUtc: Date | null | undefined;
  cooldownMinutes?: number;
  nowUtc?: Date;
}): boolean {
  if (!input.lastForcedReauthAtUtc) return true;
  const window =
    input.cooldownMinutes ?? FORCED_REAUTH_COOLDOWN_DEFAULT_MINUTES;
  const ageMs =
    (input.nowUtc ?? new Date()).getTime() -
    input.lastForcedReauthAtUtc.getTime();
  return ageMs >= window * 60_000;
}

// Friendly alias — Phase 26.75 brief uses "ForcedReauth" naming;
// keep the typo-free helper as the canonical export.
export const isForcedReauthAllowed = isFormedReauthAllowed;

// -----------------------------------------------------------------------------
// High-risk incident threshold
// -----------------------------------------------------------------------------

export const HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD = 5;
export const HIGH_RISK_INCIDENT_DEDUP_HOURS = 1;
