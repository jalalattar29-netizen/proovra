/**
 * Phase 19 — Enterprise Identity Security & Adaptive Access Control
 * canonical types.
 *
 * Provider-agnostic, framework-agnostic primitives for:
 *   - MFA policy level (OFF / ADMINS_ONLY / REVIEWERS_AND_ABOVE /
 *     ALL_MEMBERS / HIGH_RISK_ONLY)
 *   - Step-up challenge purposes (the enumerated set of sensitive
 *     actions that demand a fresh verification)
 *   - Step-up challenge statuses
 *   - Trusted device status
 *   - Adaptive risk levels (LOW / MEDIUM / HIGH / CRITICAL) +
 *     deterministic risk-reason catalog
 *   - Session revocation reasons
 *
 * Hard invariants encoded here:
 *   - Risk scoring is deterministic. Adding a signal MUST be a code
 *     change; the runtime never invents a new reason at request time.
 *   - Step-up purposes are exhaustive — a route may NOT pass an
 *     ad-hoc string.
 *   - High-risk-only MFA does not waive verification for known
 *     sensitive actions; those are gated by step-up regardless.
 *   - Operator-facing wording must be operational. Never claim "fraud
 *     proof", "certified", "impossible to bypass", or "legally
 *     compliant".
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// MFA policy levels
// -----------------------------------------------------------------------------

export const MFA_POLICY_LEVELS = [
  "OFF",
  "ADMINS_ONLY",
  "REVIEWERS_AND_ABOVE",
  "ALL_MEMBERS",
  "HIGH_RISK_ONLY",
] as const;
export const MfaPolicyLevelSchema = z.enum(MFA_POLICY_LEVELS);
export type MfaPolicyLevel = z.infer<typeof MfaPolicyLevelSchema>;

/**
 * Decide whether MFA is required for a given canonical role under a
 * given policy level. The function is pure and deterministic; it does
 * NOT take risk into account (that's `mfaRequiredForRiskLevel`).
 *
 * Contributors and external/public roles never get workspace MFA
 * here — they're handled by contributor verification flows separately
 * (Phase 19 step-up purpose CONTRIBUTOR_PHONE_VERIFICATION).
 */
export function mfaRequiredForRole(
  policy: MfaPolicyLevel,
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | string,
): boolean {
  if (policy === "OFF") return false;
  if (policy === "HIGH_RISK_ONLY") return false;
  if (policy === "ADMINS_ONLY") return role === "OWNER" || role === "ADMIN";
  if (policy === "REVIEWERS_AND_ABOVE")
    return role === "OWNER" || role === "ADMIN" || role === "MEMBER";
  if (policy === "ALL_MEMBERS")
    return (
      role === "OWNER" ||
      role === "ADMIN" ||
      role === "MEMBER" ||
      role === "VIEWER"
    );
  // Unknown policy / role combination defaults to require-MFA (fail
  // closed). This branch is unreachable under the type system; the
  // safeguard is here for resilience to schema drift.
  return true;
}

// -----------------------------------------------------------------------------
// Step-up challenge purposes
//
// These are the EXHAUSTIVE set of actions that may require a step-up.
// The route layer MUST pass one of these values; an ad-hoc string is
// not accepted by `StepUpPurposeSchema`.
// -----------------------------------------------------------------------------

export const STEP_UP_PURPOSES = [
  // Identity / RBAC mutations
  "MEMBER_SUSPEND",
  "MEMBER_REVOKE",
  "MEMBER_ROLE_CHANGE",
  "MEMBER_RESTORE",
  "CAPABILITY_GRANT",
  "CAPABILITY_REVOKE",
  "DELEGATED_ADMIN_GRANT",
  "DELEGATED_ADMIN_REVOKE",
  "SERVICE_ACCOUNT_CREATE",
  "SERVICE_ACCOUNT_DISABLE",
  "SERVICE_ACCOUNT_ENABLE",
  "SERVICE_ACCOUNT_REVOKE",
  "SERVICE_ACCOUNT_HARDENING_UPDATE",
  "CONTRIBUTOR_SESSION_REVOKE",
  "ORG_SECURITY_POLICY_UPDATE",
  "EXTERNAL_IDENTITY_LINK",
  "EXTERNAL_IDENTITY_UNLINK",
  // Governance + publication
  "LEGAL_HOLD_PLACE",
  "LEGAL_HOLD_RELEASE",
  "PUBLIC_VERIFY_PUBLISH",
  "PUBLIC_VERIFY_UNPUBLISH",
  "PUBLIC_VERIFY_SUSPEND",
  "PUBLIC_VERIFY_RESTORE",
  "GOVERNANCE_POLICY_UPDATE",
  "RETENTION_POLICY_UPDATE",
  // Phase 27 — Enterprise destruction queue + lifecycle moves.
  "EVIDENCE_DESTRUCTION_APPROVE",
  "EVIDENCE_DESTRUCTION_EXECUTE",
  "EVIDENCE_LIFECYCLE_FORCE",
  // High-risk evidence operations
  "ORIGINAL_EVIDENCE_DOWNLOAD",
  "REPORT_EXPORT_HIGH_RISK",
  "PACKAGE_EXPORT_HIGH_RISK",
  // Review approval when overall risk is HIGH/CRITICAL
  "REVIEW_APPROVAL_HIGH_RISK",
  // Phase 25.5 — reviewer-ops sensitive decisions. The workspace
  // governance flags `require_step_up_for_*` decide when these fire.
  "REVIEWER_OPS_REJECT",
  "REVIEWER_OPS_ESCALATION_RESOLVE",
  "REVIEWER_OPS_BULK_ACTION",
  // MFA policy mutation (changing posture is itself a sensitive action)
  "MFA_POLICY_UPDATE",
  // Generic "operator session sanity check" — used when no specific
  // resource ties to the action.
  "SESSION_SANITY_CHECK",
  // External contributor phone verification before upload, when the
  // org policy demands it. NEVER triggers workspace MFA.
  "CONTRIBUTOR_PHONE_VERIFICATION",
  // Phase P1.1 — Identity operations completion pass.
  //   SCIM_RECONCILIATION_EXECUTE: destructive reconcile actions
  //     (suspend membership, archive token, archive group) require
  //     step-up regardless of org policy.
  //   SAML_MAPPING_PRIVILEGE_UPDATE: when a SAML attribute mapping
  //     change is flagged as privilege-affecting (group→OWNER/ADMIN,
  //     external-id override, default role downgrade) we require
  //     step-up before persisting the new mapping.
  "SCIM_RECONCILIATION_EXECUTE",
  "SAML_MAPPING_PRIVILEGE_UPDATE",
  // Phase P2.3 / P2.5 — Operations console.
  //   QUEUE_JOB_REPLAY: any replay of a job classified as
  //     `requires_step_up` in the replay safety matrix.
  //   RESTORE_VALIDATION_EXECUTE: running the restore-readiness
  //     validation actually exercises the recovery path (read-only,
  //     but expensive) and is gated so the operator confirms intent.
  "QUEUE_JOB_REPLAY",
  "RESTORE_VALIDATION_EXECUTE",
  // Phase P3.1 — Signer governance + custody attestation.
  //   SIGNER_PROMOTE: promoting a staged signer to active changes
  //     which key will sign future artifacts.
  //   SIGNER_RETIRE: marking a signer retired means no future
  //     artifacts will be signed with it.
  //   SIGNER_REVOKE: revocation is the most destructive transition
  //     and disables an active or staged signer outright.
  //   CUSTODY_ATTESTATION_BACKFILL: bulk-signing historical custody
  //     events for attestation coverage; potentially expensive.
  "SIGNER_PROMOTE",
  "SIGNER_RETIRE",
  "SIGNER_REVOKE",
  "CUSTODY_ATTESTATION_BACKFILL",
  // Phase M2.1 — C2PA bulk backfill is potentially expensive across a
  // large evidence corpus and the operator must confirm intent.
  "C2PA_BACKFILL_START",
  // Phase M3 — generating an insurer-ready SIU export bundle compiles
  // sensitive case material; the operator must confirm intent.
  "SIU_EXPORT_GENERATE",
  // Phase M3.2 — revealing or exporting claimant PII (name + contact)
  // is independently audited. Re-using SIU_EXPORT_GENERATE would
  // conflate two distinct sensitive actions, so PROOVRA tracks them
  // separately.
  "SIU_PII_REVEAL",
] as const;
export const StepUpPurposeSchema = z.enum(STEP_UP_PURPOSES);
export type StepUpPurpose = z.infer<typeof StepUpPurposeSchema>;

// -----------------------------------------------------------------------------
// Step-up challenge statuses
// -----------------------------------------------------------------------------

export const STEP_UP_CHALLENGE_STATUSES = [
  "PENDING",
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "CANCELLED",
] as const;
export const StepUpChallengeStatusSchema = z.enum(STEP_UP_CHALLENGE_STATUSES);
export type StepUpChallengeStatus = z.infer<typeof StepUpChallengeStatusSchema>;

const TERMINAL_STEP_UP_STATUSES: ReadonlyArray<StepUpChallengeStatus> = [
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "CANCELLED",
];

export function isTerminalStepUpStatus(s: StepUpChallengeStatus): boolean {
  return TERMINAL_STEP_UP_STATUSES.includes(s);
}

// Step-up TTL — kept short. The route layer reads
// STEP_UP_SESSION_TTL_MINUTES; the default below is the floor.
export const STEP_UP_TTL_DEFAULT_SECONDS = 15 * 60;
export const STEP_UP_TTL_MAX_SECONDS = 60 * 60;

// -----------------------------------------------------------------------------
// Trusted device
// -----------------------------------------------------------------------------

export const TRUSTED_DEVICE_STATUSES = ["ACTIVE", "REVOKED"] as const;
export const TrustedDeviceStatusSchema = z.enum(TRUSTED_DEVICE_STATUSES);
export type TrustedDeviceStatus = z.infer<typeof TrustedDeviceStatusSchema>;

export const TRUSTED_DEVICE_TTL_DAYS_DEFAULT = 30;
export const TRUSTED_DEVICE_TTL_DAYS_MAX = 180;

/**
 * Derive a stable device id hash from a per-request "device cookie"
 * value. The cookie value is a long random string we set on the user
 * agent the first time they sign in; we never persist it raw —
 * everything we store is the hash.
 */
export function isValidDeviceCookieValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const t = value.trim();
  if (t.length < 16 || t.length > 256) return false;
  return /^[A-Za-z0-9_\-]+$/.test(t);
}

// -----------------------------------------------------------------------------
// Adaptive risk levels + signal catalog
//
// Risk scoring is deterministic. Adding a signal requires a code
// change so we never accumulate ad-hoc risk reasons. The score is the
// SUM of the (capped) signal weights; the level is read off the
// thresholds.
// -----------------------------------------------------------------------------

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RISK_SIGNAL_KINDS = [
  "NEW_DEVICE",
  "NEW_IP",
  "NEW_USER_AGENT",
  "NEW_COUNTRY",
  "IMPOSSIBLE_TRAVEL",
  "FAILED_AUTH_BURST",
  "FAILED_OTP_BURST",
  "SERVICE_ACCOUNT_NEW_IP",
  "SERVICE_ACCOUNT_IP_ALLOWLIST_VIOLATION",
  "CONTRIBUTOR_TOKEN_FAILURE_BURST",
  "CONTRIBUTOR_REVOKED_ATTEMPT",
  "SUSPENDED_MEMBER_ACTIVITY",
  "REVOKED_MEMBER_ACTIVITY",
  "EXCESSIVE_COMMUNICATION_SENDS",
  "PERMISSION_DENIED_BURST",
  "WEBHOOK_INVALID_SIGNATURE_BURST",
] as const;
export const RiskSignalKindSchema = z.enum(RISK_SIGNAL_KINDS);
export type RiskSignalKind = z.infer<typeof RiskSignalKindSchema>;

/**
 * Per-signal weight. The score is the sum, capped at 100 (CRITICAL).
 * Weights are intentionally large for actions that ALONE warrant a
 * step-up (e.g. impossible travel) and small for ambient noise (e.g.
 * a new user agent without a new IP).
 */
const RISK_SIGNAL_WEIGHTS: Readonly<Record<RiskSignalKind, number>> = {
  NEW_DEVICE: 25,
  NEW_IP: 20,
  NEW_USER_AGENT: 10,
  NEW_COUNTRY: 30,
  IMPOSSIBLE_TRAVEL: 80,
  FAILED_AUTH_BURST: 50,
  FAILED_OTP_BURST: 40,
  SERVICE_ACCOUNT_NEW_IP: 35,
  SERVICE_ACCOUNT_IP_ALLOWLIST_VIOLATION: 70,
  CONTRIBUTOR_TOKEN_FAILURE_BURST: 40,
  CONTRIBUTOR_REVOKED_ATTEMPT: 60,
  SUSPENDED_MEMBER_ACTIVITY: 70,
  REVOKED_MEMBER_ACTIVITY: 100,
  EXCESSIVE_COMMUNICATION_SENDS: 25,
  PERMISSION_DENIED_BURST: 30,
  WEBHOOK_INVALID_SIGNATURE_BURST: 30,
};

export function riskSignalWeight(kind: RiskSignalKind): number {
  return RISK_SIGNAL_WEIGHTS[kind];
}

export type RiskScoreInput = {
  signals: ReadonlyArray<RiskSignalKind>;
  // Operator-tunable thresholds (env-driven at the call site). Defaults
  // mirror the documented Phase 19 env vars.
  highThreshold?: number;
  mediumThreshold?: number;
};

export type RiskScoreResult = {
  score: number;
  level: RiskLevel;
  signals: ReadonlyArray<RiskSignalKind>;
};

export function computeRiskScore(input: RiskScoreInput): RiskScoreResult {
  const high = input.highThreshold ?? 75;
  const medium = input.mediumThreshold ?? 40;
  let total = 0;
  for (const s of input.signals) total += RISK_SIGNAL_WEIGHTS[s] ?? 0;
  if (total > 100) total = 100;
  const level: RiskLevel =
    total >= 100
      ? "CRITICAL"
      : total >= high
        ? "HIGH"
        : total >= medium
          ? "MEDIUM"
          : "LOW";
  return { score: total, level, signals: input.signals };
}

export function riskRequiresStepUp(level: RiskLevel): boolean {
  return level === "HIGH" || level === "CRITICAL";
}

export function riskBlocksAction(level: RiskLevel): boolean {
  return level === "CRITICAL";
}

// -----------------------------------------------------------------------------
// Session revocation reasons
// -----------------------------------------------------------------------------

export const SESSION_REVOCATION_REASONS = [
  "OPERATOR_REVOKED",
  "USER_LOGGED_OUT",
  "MEMBER_SUSPENDED",
  "MEMBER_REVOKED",
  "PASSWORD_CHANGED",
  "SUSPICIOUS_ACTIVITY",
  "STEP_UP_DENIED",
  "POLICY_CHANGE",
  "RECONCILIATION_SWEEP",
] as const;
export const SessionRevocationReasonSchema = z.enum(SESSION_REVOCATION_REASONS);
export type SessionRevocationReason = z.infer<
  typeof SessionRevocationReasonSchema
>;

// -----------------------------------------------------------------------------
// Hash helpers — pure, no Node deps so this module stays browser-safe.
//
// The actual hashing is done in the API service using HMAC-SHA256
// keyed by IDENTITY_SECURITY_HASH_SECRET. This file exposes only the
// MASK helpers (browser-safe) for IP + user agent previews.
// -----------------------------------------------------------------------------

/**
 * Mask an IPv4/v6 address to a short operator-safe preview. The first
 * group is kept; the rest is replaced with bullets except for the last
 * group. This NEVER decides whether two addresses match — it's a
 * presentation helper only.
 */
export function maskIpPreview(ip: string | null | undefined): string {
  if (!ip) return "";
  const t = ip.trim();
  if (t.length === 0) return "";
  if (t.includes(":")) {
    // IPv6 — preserve first + last hextet.
    const parts = t.split(":").filter((p) => p.length > 0);
    if (parts.length < 2) return "•••";
    return `${parts[0]}:•••:${parts[parts.length - 1]}`;
  }
  const parts = t.split(".");
  if (parts.length !== 4) return "•••";
  return `${parts[0]}.•••.•••.${parts[3]}`;
}

/**
 * Squash a user-agent string to a short operator preview (browser /
 * OS family at most). Never echoes the full UA — that string is large
 * and can leak fingerprintable build numbers.
 */
export function summariseUserAgent(ua: string | null | undefined): string {
  if (!ua) return "";
  const t = ua.trim();
  if (t.length === 0) return "";
  // Look for a couple of common families. We don't pull in a UA-parser
  // dep; this is a heuristic for operator readability only.
  const lower = t.toLowerCase();
  const families: Array<[RegExp, string]> = [
    [/edg\//, "Edge"],
    [/chrome\/[\d.]+/i, "Chrome"],
    [/firefox\/[\d.]+/i, "Firefox"],
    [/safari\//, "Safari"],
    [/curl\//, "curl"],
    [/postman/, "Postman"],
  ];
  let browser = "unknown";
  for (const [re, name] of families) {
    if (re.test(lower)) {
      browser = name;
      break;
    }
  }
  let os = "";
  if (lower.includes("windows")) os = "Windows";
  else if (lower.includes("mac os")) os = "macOS";
  else if (lower.includes("android")) os = "Android";
  else if (lower.includes("iphone") || lower.includes("ios")) os = "iOS";
  else if (lower.includes("linux")) os = "Linux";
  return os ? `${browser} on ${os}` : browser;
}
