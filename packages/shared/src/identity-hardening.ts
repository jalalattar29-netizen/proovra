/**
 * Phase 26.5 — Enterprise Identity Hardening canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). Extends the Phase 26
 * identity-providers + rbac modules with:
 *
 *   - Suspicious-session signal catalog + risk-score helper
 *   - Adaptive auth decision shape
 *   - SCIM Group resource schema (RFC 7644)
 *   - SSO callback attempt lifecycle states
 *   - Identity event timeline event types
 *   - Sampled-heartbeat sample window + bounds
 *
 * Hard invariants:
 *   - Risk scores capped to [0..100]; "explainable" signals carry a
 *     bounded reason string from a fixed catalog.
 *   - SCIM Group payloads never carry raw user emails; only stable
 *     subject IDs (the Phase 17 ExternalIdentityMapping pointer).
 *   - Adaptive decisions name the canonical step-up purpose; never
 *     compose ad-hoc strings.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Suspicious session signals
// -----------------------------------------------------------------------------

export const SUSPICIOUS_SESSION_SIGNAL_KINDS = [
  "IMPOSSIBLE_TRAVEL",
  "RAPID_GEO_CHANGE",
  "CONCURRENT_RISKY_SESSIONS",
  "HIGH_RISK_IP_SHIFT",
  "UNKNOWN_DEVICE_ANOMALY",
  "REPEATED_FAILED_SSO_CALLBACKS",
  "ELEVATED_PRIVILEGE_ANOMALY",
  "SUSPICIOUS_REVIEWER_ACTIVITY",
  "TOKEN_REPLAY_INDICATOR",
] as const;
export const SuspiciousSessionSignalKindSchema = z.enum(
  SUSPICIOUS_SESSION_SIGNAL_KINDS,
);
export type SuspiciousSessionSignalKind = z.infer<
  typeof SuspiciousSessionSignalKindSchema
>;

/**
 * Per-signal weight on a 0..100 risk score. The weights are
 * operator-tunable in the suspicious-session service; these are the
 * documented defaults.
 */
export const SUSPICIOUS_SESSION_SIGNAL_WEIGHTS: Record<
  SuspiciousSessionSignalKind,
  number
> = {
  IMPOSSIBLE_TRAVEL: 80,
  RAPID_GEO_CHANGE: 50,
  CONCURRENT_RISKY_SESSIONS: 35,
  HIGH_RISK_IP_SHIFT: 40,
  UNKNOWN_DEVICE_ANOMALY: 30,
  REPEATED_FAILED_SSO_CALLBACKS: 35,
  ELEVATED_PRIVILEGE_ANOMALY: 60,
  SUSPICIOUS_REVIEWER_ACTIVITY: 45,
  TOKEN_REPLAY_INDICATOR: 90,
};

export type SuspiciousSessionSignal = {
  kind: SuspiciousSessionSignalKind;
  weight: number;
  /** Operator-readable explanation. Catalog-bound. */
  reason: string;
};

/**
 * Cap the score at 100 and saturate via additive weights (deterministic,
 * order-independent).
 */
export function computeSuspiciousSessionRisk(
  signals: ReadonlyArray<SuspiciousSessionSignal>,
): number {
  let total = 0;
  for (const s of signals) {
    if (!Number.isFinite(s.weight) || s.weight <= 0) continue;
    total += s.weight;
  }
  if (total < 0) return 0;
  if (total > 100) return 100;
  return Math.round(total);
}

// -----------------------------------------------------------------------------
// Risk level — reused naming convention from Phase 19 risk service.
// -----------------------------------------------------------------------------

export const SESSION_RISK_LEVELS = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;
export type SessionRiskLevel = (typeof SESSION_RISK_LEVELS)[number];

export const SESSION_RISK_HIGH_THRESHOLD = 60;
export const SESSION_RISK_MEDIUM_THRESHOLD = 30;

export function sessionRiskLevel(score: number): SessionRiskLevel {
  if (score >= 90) return "CRITICAL";
  if (score >= SESSION_RISK_HIGH_THRESHOLD) return "HIGH";
  if (score >= SESSION_RISK_MEDIUM_THRESHOLD) return "MEDIUM";
  return "LOW";
}

// -----------------------------------------------------------------------------
// Adaptive auth — decides whether a sensitive action needs step-up,
// forced re-auth, or should be blocked entirely.
// -----------------------------------------------------------------------------

export const ADAPTIVE_AUTH_DECISIONS = [
  "ALLOW",
  "REQUIRE_STEP_UP",
  "REQUIRE_REAUTH",
  "BLOCK",
] as const;
export type AdaptiveAuthDecision = (typeof ADAPTIVE_AUTH_DECISIONS)[number];

export type AdaptiveAuthInput = {
  riskScore: number;
  trustedDevice: boolean;
  highPrivilegeAction: boolean;
  workspaceRequiresStepUp: boolean;
  /** When the session was issued (ms epoch). */
  sessionIssuedAtMs?: number;
  /** Override for tests. */
  nowMs?: number;
};

export type AdaptiveAuthResult = {
  decision: AdaptiveAuthDecision;
  /** Catalog-bound reason; operator-readable. */
  reason: string;
  /** When decision = REQUIRE_STEP_UP, the canonical step-up purpose to use. */
  stepUpPurpose?:
    | "REVIEW_APPROVAL_HIGH_RISK"
    | "REVIEWER_OPS_REJECT"
    | "REVIEWER_OPS_ESCALATION_RESOLVE"
    | "REVIEWER_OPS_BULK_ACTION"
    | "ORG_SECURITY_POLICY_UPDATE"
    | "GOVERNANCE_POLICY_UPDATE"
    | "EXTERNAL_IDENTITY_LINK"
    | "EXTERNAL_IDENTITY_UNLINK"
    | "ORIGINAL_EVIDENCE_DOWNLOAD"
    | "REPORT_EXPORT_HIGH_RISK"
    | "PACKAGE_EXPORT_HIGH_RISK"
    | "SESSION_SANITY_CHECK";
};

const REAUTH_WINDOW_MS = 24 * 3600 * 1000; // 24h

/**
 * The decision matrix:
 *   - CRITICAL risk        → BLOCK
 *   - HIGH risk            → REQUIRE_REAUTH (unless trusted device, then STEP_UP)
 *   - MEDIUM risk          → REQUIRE_STEP_UP
 *   - LOW risk + sensitive → STEP_UP if workspace requires; ALLOW otherwise
 *   - LOW risk + non-sensitive → ALLOW
 *   - Session > 24h old + HIGH privilege → REQUIRE_REAUTH
 */
export function evaluateAdaptiveAuth(
  input: AdaptiveAuthInput,
): AdaptiveAuthResult {
  const level = sessionRiskLevel(input.riskScore);
  if (level === "CRITICAL") {
    return {
      decision: "BLOCK",
      reason: "critical_session_risk",
    };
  }
  // Stale + privileged → reauth (defensive, regardless of risk).
  if (
    input.sessionIssuedAtMs &&
    input.highPrivilegeAction &&
    (input.nowMs ?? Date.now()) - input.sessionIssuedAtMs > REAUTH_WINDOW_MS
  ) {
    return {
      decision: "REQUIRE_REAUTH",
      reason: "session_too_old_for_privileged_action",
    };
  }
  if (level === "HIGH") {
    return input.trustedDevice
      ? {
          decision: "REQUIRE_STEP_UP",
          reason: "high_risk_trusted_device",
          stepUpPurpose: "SESSION_SANITY_CHECK",
        }
      : {
          decision: "REQUIRE_REAUTH",
          reason: "high_risk_untrusted_device",
        };
  }
  if (level === "MEDIUM") {
    return {
      decision: "REQUIRE_STEP_UP",
      reason: "medium_risk_session",
      stepUpPurpose: "SESSION_SANITY_CHECK",
    };
  }
  // LOW
  if (input.highPrivilegeAction && input.workspaceRequiresStepUp) {
    return {
      decision: "REQUIRE_STEP_UP",
      reason: "workspace_policy_requires_step_up",
      stepUpPurpose: "SESSION_SANITY_CHECK",
    };
  }
  return {
    decision: "ALLOW",
    reason: level === "LOW" ? "low_risk_session" : "no_signal",
  };
}

// -----------------------------------------------------------------------------
// SSO callback attempt lifecycle
// -----------------------------------------------------------------------------

export const SSO_CALLBACK_ATTEMPT_STATUSES = [
  "PENDING",
  "CONSUMED",
  "EXPIRED",
  "REPLAYED",
  "FAILED",
] as const;
export type SsoCallbackAttemptStatus =
  (typeof SSO_CALLBACK_ATTEMPT_STATUSES)[number];

export const SSO_CALLBACK_STATE_TTL_SECONDS = 10 * 60;

/**
 * Open-redirect protection. A redirectAfter URL is acceptable iff:
 *   - it is empty (default "/"), OR
 *   - it begins with `/` and does NOT begin with `//` (relative,
 *     in-app navigation), OR
 *   - its origin matches one of the workspace allowed origins.
 */
export function isSafeRedirectAfter(
  value: string | null | undefined,
  allowedOrigins: ReadonlyArray<string> = [],
): boolean {
  if (!value || value.length === 0) return true;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/")) return true;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return allowedOrigins.includes(u.origin);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// SCIM Group resource (RFC 7644)
// -----------------------------------------------------------------------------

export const SCIM_GROUP_SCHEMA_URI =
  "urn:ietf:params:scim:schemas:core:2.0:Group";

export const SCIM_GROUP_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type ScimGroupStatus = (typeof SCIM_GROUP_STATUSES)[number];

/** Roles the SCIM group can map onto. Subset of the Phase 17 TeamRole. */
export const SCIM_GROUP_MAPPED_ROLES = ["ADMIN", "MEMBER", "VIEWER"] as const;
export type ScimGroupMappedRole = (typeof SCIM_GROUP_MAPPED_ROLES)[number];

export const ScimGroupSchema = z
  .object({
    schemas: z
      .array(z.string())
      .nonempty()
      .refine(
        (arr) => arr.includes(SCIM_GROUP_SCHEMA_URI),
        "schemas must include the SCIM 2.0 Group schema",
      ),
    displayName: z.string().min(1).max(180),
    externalId: z.string().max(180).optional(),
    /** Custom extension — operator selects which workspace role this
     *  group projects onto. Default MEMBER. */
    mappedRole: z.enum(SCIM_GROUP_MAPPED_ROLES).default("MEMBER"),
    members: z
      .array(
        z.object({
          /** SCIM member.value is the SCIM User resource id (which we
           *  set to the PROOVRA User.id at create time). */
          value: z.string().min(1).max(64),
          display: z.string().max(180).optional(),
        }),
      )
      .max(2000)
      .optional(),
  })
  .strict();
export type ScimGroupInput = z.infer<typeof ScimGroupSchema>;

export type ScimGroupMember = {
  value: string; // userId
  display: string | null;
};

export type ScimGroupResource = {
  schemas: ReadonlyArray<string>;
  id: string;
  displayName: string;
  externalId: string | null;
  mappedRole: ScimGroupMappedRole;
  members: ReadonlyArray<ScimGroupMember>;
  meta: {
    resourceType: "Group";
    created: string;
    lastModified: string;
    location: string;
  };
};

// SCIM Group PATCH — only operations we support are:
//   replace displayName / mappedRole
//   add members
//   remove members
export const ScimGroupPatchOpSchema = z
  .object({
    schemas: z
      .array(z.string())
      .nonempty()
      .refine((arr) =>
        arr.includes("urn:ietf:params:scim:api:messages:2.0:PatchOp"),
      ),
    Operations: z
      .array(
        z.object({
          op: z.enum(["replace", "add", "remove"]),
          path: z.string().min(1).max(120),
          value: z.unknown().optional(),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type ScimGroupPatchOpInput = z.infer<typeof ScimGroupPatchOpSchema>;

// -----------------------------------------------------------------------------
// Identity event timeline — operator-safe projection.
// -----------------------------------------------------------------------------

export const IDENTITY_TIMELINE_EVENT_KINDS = [
  "SSO_LOGIN_SUCCEEDED",
  "SSO_LOGIN_FAILED",
  "SSO_JIT_PROVISIONED",
  "SCIM_USER_CREATED",
  "SCIM_USER_DEACTIVATED",
  "SCIM_GROUP_SYNCED",
  "SCIM_GROUP_DELETED",
  "SESSION_REVOKED_ADMIN",
  "ALL_SESSIONS_REVOKED_ADMIN",
  "SUSPICIOUS_SESSION_DETECTED",
  "FORCED_REAUTHENTICATION",
  "SESSION_REPLAY_DETECTED",
  "ADAPTIVE_STEP_UP_TRIGGERED",
  "RBAC_TEMPORARY_ELEVATION_GRANTED",
  "ACCESS_REVIEW_DECIDED",
  "TRUSTED_DEVICE_ADDED",
  "TRUSTED_DEVICE_REVOKED",
  "STEP_UP_STARTED",
  "STEP_UP_APPROVED",
  "STEP_UP_DENIED",
  "MEMBER_ROLE_CHANGED",
  "MEMBER_SUSPENDED",
  "MEMBER_REVOKED",
  "IDP_OUTAGE_DETECTED",
  "IDP_OUTAGE_CLEARED",
] as const;
export type IdentityTimelineEventKind =
  (typeof IDENTITY_TIMELINE_EVENT_KINDS)[number];

export type IdentityTimelineEvent = {
  id: string;
  kind: IdentityTimelineEventKind;
  severity: "INFO" | "WARNING" | "HIGH";
  occurredAtUtc: string;
  actorUserId: string | null;
  subjectUserId: string | null;
  /** Operator-readable summary. NEVER carries secrets. */
  summary: string;
  /** Optional pointer (workflowId, escalationId, ssoConnectionId, etc.). */
  resourceKind: string | null;
  resourceId: string | null;
};

// -----------------------------------------------------------------------------
// Sampled heartbeat — pure helper that decides whether the middleware
// should write `last_heartbeat_at_utc` for this request.
// -----------------------------------------------------------------------------

export const SESSION_HEARTBEAT_DEFAULT_SAMPLE_SECONDS = 60;
export const SESSION_HEARTBEAT_MIN_SAMPLE_SECONDS = 5;
export const SESSION_HEARTBEAT_MAX_SAMPLE_SECONDS = 3600;

export function shouldWriteHeartbeat(input: {
  lastHeartbeatAtUtc: Date | null | undefined;
  nowUtc?: Date;
  sampleWindowSeconds?: number;
}): boolean {
  if (!input.lastHeartbeatAtUtc) return true; // first heartbeat
  const window =
    input.sampleWindowSeconds ?? SESSION_HEARTBEAT_DEFAULT_SAMPLE_SECONDS;
  const now = (input.nowUtc ?? new Date()).getTime();
  return now - input.lastHeartbeatAtUtc.getTime() >= window * 1000;
}

// -----------------------------------------------------------------------------
// Stale session — defaults documented in the env vars.
// -----------------------------------------------------------------------------

export const SESSION_STALE_DEFAULT_MINUTES = 30;

export function isSessionStale(input: {
  lastHeartbeatAtUtc: Date | null | undefined;
  lastSeenAtUtc: Date;
  nowUtc?: Date;
  staleMinutes?: number;
}): boolean {
  const stale = input.staleMinutes ?? SESSION_STALE_DEFAULT_MINUTES;
  const anchor = input.lastHeartbeatAtUtc ?? input.lastSeenAtUtc;
  const ageMs = (input.nowUtc ?? new Date()).getTime() - anchor.getTime();
  return ageMs > stale * 60_000;
}

// -----------------------------------------------------------------------------
// Phase 3 (Enterprise Identity) — Org session-timeout POLICY enforcement.
//
// The OrganizationSecurityPolicy row stores two role-tiered absolute
// session-timeout fields — `reviewerSessionTimeoutSeconds` and
// `contributorSessionTimeoutSeconds` — that were previously STORED but
// never enforced (read-only / deferred). These pure helpers let the
// auth middleware turn a stored policy + the current session's age +
// idle time into an expire/allow decision WITHOUT importing Prisma or
// any Node built-in, so they are browser-safe and trivially unit-
// testable.
//
// Hard rules:
//   - A `null` timeout for a role means "no policy timeout for that
//     role" — the session is bounded only by the JWT's own 30-day exp.
//     (Mirrors the "empty allow-list ALWAYS allows" convention.)
//   - The configured timeout is an INACTIVITY (idle) timeout — the
//     standard enterprise "session timeout" meaning. A session expires
//     once the user has been idle (no last-seen activity) longer than
//     the limit. When no last-seen heartbeat exists yet, idle is
//     measured from issuance (age). We do NOT invent a separate idle
//     policy field.
//   - The JWT `exp` (checked in verifyJwt) is always the hard ceiling;
//     this policy can only make a session expire SOONER, never later.
// -----------------------------------------------------------------------------

/**
 * The workspace roles the timeout policy discriminates on. This is the
 * canonical Phase 17 TeamRole set; kept as a local string union so the
 * shared module stays Prisma-free.
 */
export type SessionTimeoutRole =
  | "OWNER"
  | "ADMIN"
  | "MEMBER"
  | "VIEWER"
  | null;

export type SessionTimeoutPolicyFields = {
  /** Applies to the reviewer/staff tier: OWNER, ADMIN, MEMBER. */
  reviewerSessionTimeoutSeconds: number | null;
  /** Applies to the limited / contributor tier: VIEWER. */
  contributorSessionTimeoutSeconds: number | null;
};

/**
 * Resolve the absolute-session-timeout (in seconds) that applies to a
 * user with the given workspace role, or `null` when no policy timeout
 * constrains that role (fall back to the JWT exp cap).
 *
 * Mapping rationale — the policy exposes exactly two tiers:
 *   - "reviewer" = internal reviewing staff → OWNER / ADMIN / MEMBER
 *   - "contributor" = limited / read-scoped → VIEWER
 * An unknown / null role is treated as the MORE restrictive tier
 * (contributor) so an unexpected value never GRANTS a longer session.
 */
export function resolveSessionTimeoutSecondsForRole(
  role: SessionTimeoutRole,
  policy: SessionTimeoutPolicyFields,
): number | null {
  const reviewer = normaliseTimeoutSeconds(policy.reviewerSessionTimeoutSeconds);
  const contributor = normaliseTimeoutSeconds(
    policy.contributorSessionTimeoutSeconds,
  );
  switch (role) {
    case "OWNER":
    case "ADMIN":
    case "MEMBER":
      return reviewer;
    case "VIEWER":
      return contributor;
    default:
      // Unknown / null role — fail toward the tighter tier. Use the
      // contributor timeout when present, else the reviewer timeout,
      // else null (no constraint). Never returns the LONGER of the two.
      if (contributor !== null && reviewer !== null) {
        return Math.min(contributor, reviewer);
      }
      return contributor ?? reviewer;
  }
}

function normaliseTimeoutSeconds(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export type SessionTimeoutDecision = {
  expired: boolean;
  /**
   * Why the session expired (or `null` when allowed). `idle` = time
   * since last-seen (heartbeat) exceeded the policy; `absolute` = no
   * last-seen anchor existed so inactivity was measured from issuance
   * (age) instead.
   */
  reason: "absolute" | "idle" | null;
  /** The resolved timeout applied, seconds; null = no policy timeout. */
  appliedTimeoutSeconds: number | null;
  /** Age of the session at evaluation time, seconds. */
  ageSeconds: number;
  /** Idle time (since last-seen) at evaluation time, seconds. */
  idleSeconds: number;
};

/**
 * Decide whether an authenticated internal session has exceeded the
 * org's role-applicable session timeout. Pure + deterministic.
 *
 * The configured timeout is treated as an INACTIVITY (idle) timeout —
 * the standard enterprise "session timeout" meaning: a session is
 * expired once the user has been idle (no last-seen activity) for
 * longer than the limit. The JWT's own 30-day `exp` remains the
 * absolute ceiling (enforced in verifyJwt); this policy only expires a
 * session SOONER.
 *
 *   - `issuedAtMs`  — session issuance (JWT iat, ms epoch). Used as the
 *                     idle anchor when no last-seen heartbeat exists.
 *   - `lastSeenAtMs`— last-seen heartbeat (ms epoch). When present, the
 *                     idle window is measured from here; the decision is
 *                     reported as `idle`. When absent, it is measured
 *                     from issuance and reported as `absolute`.
 *   - a `null` resolved timeout ⇒ never expired by policy.
 */
export function evaluateSessionTimeout(input: {
  role: SessionTimeoutRole;
  policy: SessionTimeoutPolicyFields;
  issuedAtMs: number;
  lastSeenAtMs?: number | null;
  nowMs?: number;
}): SessionTimeoutDecision {
  const now = input.nowMs ?? Date.now();
  const timeoutSeconds = resolveSessionTimeoutSecondsForRole(
    input.role,
    input.policy,
  );
  const ageSeconds = Math.max(0, Math.floor((now - input.issuedAtMs) / 1000));
  const hasLastSeen =
    input.lastSeenAtMs != null && Number.isFinite(input.lastSeenAtMs);
  const lastSeen = hasLastSeen
    ? (input.lastSeenAtMs as number)
    : input.issuedAtMs;
  const idleSeconds = Math.max(0, Math.floor((now - lastSeen) / 1000));

  if (timeoutSeconds === null) {
    return {
      expired: false,
      reason: null,
      appliedTimeoutSeconds: null,
      ageSeconds,
      idleSeconds,
    };
  }
  // Inactivity (idle) is the primary check. When we have a real
  // last-seen anchor the reason is `idle`; without one we fall back to
  // measuring from issuance and report `absolute` (age-based). Either
  // way the same configured timeout applies — we do NOT invent a
  // separate idle policy field.
  if (idleSeconds > timeoutSeconds) {
    return {
      expired: true,
      reason: hasLastSeen ? "idle" : "absolute",
      appliedTimeoutSeconds: timeoutSeconds,
      ageSeconds,
      idleSeconds,
    };
  }
  return {
    expired: false,
    reason: null,
    appliedTimeoutSeconds: timeoutSeconds,
    ageSeconds,
    idleSeconds,
  };
}
