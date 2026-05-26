/**
 * PHASE R8.1.3 — Login-time MFA enforcement resolver.
 *
 * Combines per-user enrollment state (R8.1.1 orchestrator) with
 * per-org policy (Phase 17/19 OrganizationSecurityPolicy +
 * mfaRequiredForRole) to answer ONE question at login:
 *
 *   For this user, given (a) their team memberships, (b) the role
 *   they hold in each team, and (c) each team's mfaPolicyLevel, do
 *   we issue a session, demand an MFA challenge, or demand they
 *   enroll a factor first?
 *
 * Three possible outcomes:
 *
 *   NOT_REQUIRED         No policy demands MFA AND user has no
 *                        active factor. Standard login proceeds.
 *
 *   MFA_REQUIRED         Either (a) the user has an enrolled active
 *                        factor (so we respect their personal opt-in)
 *                        OR (b) at least one team's policy requires
 *                        MFA for the user's role in that team AND
 *                        the user has an active factor to challenge
 *                        against.
 *
 *   ENROLLMENT_REQUIRED  At least one team's policy requires MFA for
 *                        the user's role AND the user has NO active
 *                        factor. The login endpoint MUST route this
 *                        user to guided enrollment — NEVER silently
 *                        lock them out.
 *
 * Hard rules:
 *   - NEVER returns an outcome that would allow a session to be
 *     issued without MFA when org policy requires it AND the user
 *     has a factor.
 *   - NEVER silently locks an enrollment-required user out — that
 *     decision is escalated to the caller and surfaced in the API
 *     response.
 *   - Tenant isolation: this service consults each team independently;
 *     a user's membership in team A never leaks into team B's policy.
 *   - Workflow/persona is NEVER consulted here — presentation layer
 *     only.
 *   - Service accounts and guest users are out of scope (the gate
 *     never calls this for them).
 */

import { prisma } from "../../db.js";
import { mfaRequiredForRole, type MfaPolicyLevel } from "@proovra/shared";

import { readMfaStatus } from "./mfa.service.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";

/**
 * PHASE R8.1.4 — fail-mode policy for the enforcement circuit
 * breaker. Three classes of failure are distinguished:
 *
 *   - factorLookupFailed  → cannot read MfaFactor / MfaRecoveryCode
 *   - membershipLookupFailed → cannot read TeamMember
 *   - policyLookupFailed  → cannot read OrganizationSecurityPolicy
 *
 * The circuit breaker is deliberately SIMPLE — it classifies the
 * failure, decides between fail-OPEN and fail-CLOSED for the
 * specific user / org combination, and emits a security event so
 * SecOps can see what happened. No risk engine, no thresholds.
 *
 * Default behaviour:
 *
 *   - membershipLookupFailed (we cannot determine the user's
 *     teams) → fail-CLOSED with `MFA_REQUIRED` if the user has
 *     any active factor; otherwise FAIL_CLOSED with
 *     `ENROLLMENT_REQUIRED`. Rationale: an outage that hides a
 *     user's org membership is the highest-leverage time for an
 *     attacker; enterprises pay us to not silently bypass MFA.
 *
 *   - factorLookupFailed → fail-CLOSED if we observed any team
 *     membership before the failure (the user is plausibly an
 *     org member); otherwise fail-OPEN with a degraded warning.
 *
 *   - policyLookupFailed → fail-CLOSED for users with at least one
 *     team membership (we cannot prove the org's policy is OFF).
 *
 * The `MFA_ENFORCEMENT_FAIL_MODE` env var allows operators to
 * override:
 *
 *   - `closed` → always fail-CLOSED (return ENROLLMENT_REQUIRED on
 *     any classified error)
 *   - `open`   → always fail-OPEN with a `mfa_enforcement_degraded`
 *     event (NOT recommended for enterprise)
 *   - `smart`  → the default behaviour described above
 */
export type EnforcementFailMode = "smart" | "open" | "closed";

/**
 * PHASE R8.1.5 — per-org fail-mode override.
 *
 * Resolution order:
 *   1. Per-org `OrganizationSecurityPolicy.mfaEnforcementFailMode`
 *      (case-insensitive, accepts the enterprise-readable values
 *      `SMART` / `FAIL_CLOSED` / `FAIL_OPEN`).
 *   2. Process env `MFA_ENFORCEMENT_FAIL_MODE` (the same enum
 *      values, lowercase).
 *   3. Default `smart`.
 *
 * The resolver consults #1 BEFORE deciding any circuit-breaker
 * outcome — so an admin who turns on FAIL_CLOSED for their org sees
 * that policy honoured even when an unrelated user from a different
 * org logs in (each user's strictest membership wins). Each
 * membership's team policy is checked; the strictest fail-mode
 * across the user's teams wins. The env is a true fallback: it
 * applies when NO team's policy specifies a value.
 */
function readGlobalFailMode(): EnforcementFailMode {
  const raw = (process.env.MFA_ENFORCEMENT_FAIL_MODE ?? "smart").toLowerCase();
  if (raw === "open" || raw === "closed" || raw === "smart") return raw;
  return "smart";
}

const PER_ORG_FAIL_MODE_VALUES: ReadonlyArray<string> = [
  "SMART",
  "FAIL_OPEN",
  "FAIL_CLOSED",
];

function normalisePerOrgFailMode(raw: string | null | undefined):
  | EnforcementFailMode
  | null {
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (!PER_ORG_FAIL_MODE_VALUES.includes(upper)) return null;
  if (upper === "FAIL_OPEN") return "open";
  if (upper === "FAIL_CLOSED") return "closed";
  return "smart";
}

const FAIL_MODE_STRICTNESS: Record<EnforcementFailMode, number> = {
  open: 0,
  smart: 1,
  closed: 2,
};

/**
 * Pick the strictest per-org fail-mode across the user's teams.
 * Returns null when NO team specifies one (caller falls back to env).
 */
function pickStrictestPerOrgFailMode(
  policies: ReadonlyArray<{ mfaEnforcementFailMode: string | null }>,
): EnforcementFailMode | null {
  let best: EnforcementFailMode | null = null;
  for (const p of policies) {
    const v = normalisePerOrgFailMode(p.mfaEnforcementFailMode);
    if (!v) continue;
    if (best == null || FAIL_MODE_STRICTNESS[v] > FAIL_MODE_STRICTNESS[best]) {
      best = v;
    }
  }
  return best;
}

export type EnforcementErrorKind =
  | "factor_lookup_failed"
  | "membership_lookup_failed"
  | "policy_lookup_failed";

export type LoginMfaEnforcementOutcome =
  | "NOT_REQUIRED"
  | "MFA_REQUIRED"
  | "ENROLLMENT_REQUIRED";

export interface LoginMfaEnforcementResult {
  outcome: LoginMfaEnforcementOutcome;
  /** Number of ACTIVE MFA factors the user has enrolled. */
  activeFactorCount: number;
  /**
   * When outcome is MFA_REQUIRED or ENROLLMENT_REQUIRED, the
   * `policyTeamId` and `policyLevel` identify the SPECIFIC team
   * whose policy triggered the requirement. When the user opted in
   * personally (no team-required policy), both are null. The audit
   * + security-event call sites use these to attribute correctly.
   */
  policyTeamId: string | null;
  policyLevel: MfaPolicyLevel | null;
}

export interface ResolveLoginMfaEnforcementInput {
  userId: string;
}

/**
 * Resolve the effective MFA enforcement decision for a user at
 * primary-credential success.
 *
 * R8.1.4 circuit breaker:
 *   - Each Prisma lookup is wrapped in try/catch.
 *   - On error, we classify (factor / membership / policy) and emit
 *     either `mfa_enforcement_degraded` (fail-open with warning)
 *     or `mfa_enforcement_failed_closed` (fail-closed with deny).
 *   - The default behaviour favours fail-CLOSED for org-scoped
 *     users; only personal users with no membership and no factor
 *     are fail-OPEN'd.
 *   - Operators can override via `MFA_ENFORCEMENT_FAIL_MODE`.
 *
 * The function still NEVER throws — callers see one of the three
 * bounded outcomes regardless of which Prisma call failed. The
 * auth.routes.ts fail-open `catch` is now defence-in-depth only.
 */
export async function resolveLoginMfaEnforcement(
  input: ResolveLoginMfaEnforcementInput,
): Promise<LoginMfaEnforcementResult> {
  // R8.1.5 — env-derived fallback. The per-org override (computed
  // below from the policy rows) wins when present.
  const envFailMode = readGlobalFailMode();
  let failMode: EnforcementFailMode = envFailMode;

  // 1) Per-user enrollment state.
  let activeFactorCount = 0;
  let factorLookupOk = true;
  try {
    const status = await readMfaStatus({ userId: input.userId });
    activeFactorCount = status.factors.filter(
      (f) => f.status === "ACTIVE",
    ).length;
  } catch {
    factorLookupOk = false;
  }

  // 2) Per-team membership lookup. We only consider ACTIVE
  //    memberships — SUSPENDED / REVOKED memberships do not grant
  //    access, so their policy must not gate this user's login.
  let memberships: Array<{ teamId: string; role: string }> = [];
  let membershipLookupOk = true;
  try {
    memberships = await prisma.teamMember.findMany({
      where: { userId: input.userId, status: "ACTIVE" },
      select: {
        teamId: true,
        role: true,
      },
    });
  } catch {
    membershipLookupOk = false;
  }

  // ===== CIRCUIT BREAKER — short-circuit on classified errors. =====
  if (!membershipLookupOk) {
    return circuitBreakerOutcome(
      "membership_lookup_failed",
      activeFactorCount,
      failMode,
      input.userId,
    );
  }
  if (!factorLookupOk) {
    return circuitBreakerOutcome(
      "factor_lookup_failed",
      activeFactorCount,
      failMode,
      input.userId,
      memberships.length > 0,
    );
  }

  // No team memberships → fall through to personal enrollment.
  if (memberships.length === 0) {
    if (activeFactorCount > 0) {
      // User opted in personally — honour the factor.
      return {
        outcome: "MFA_REQUIRED",
        activeFactorCount,
        policyTeamId: null,
        policyLevel: null,
      };
    }
    return {
      outcome: "NOT_REQUIRED",
      activeFactorCount: 0,
      policyTeamId: null,
      policyLevel: null,
    };
  }

  // 3) Look up org security policy rows for each membership's team.
  //    Bounded by the number of teams the user belongs to; typically
  //    1–3 even for power users.
  const teamIds = memberships.map((m) => m.teamId);
  let policies: Array<{
    teamId: string;
    mfaPolicyLevel: string | null;
    mfaRequiredFlag: boolean;
    mfaEnforcementFailMode: string | null;
  }> = [];
  try {
    policies = await prisma.organizationSecurityPolicy.findMany({
      where: { teamId: { in: teamIds } },
      select: {
        teamId: true,
        mfaPolicyLevel: true,
        mfaRequiredFlag: true,
        mfaEnforcementFailMode: true,
      },
    });
  } catch {
    return circuitBreakerOutcome(
      "policy_lookup_failed",
      activeFactorCount,
      failMode,
      input.userId,
      memberships.length > 0,
    );
  }
  // R8.1.5 — strictest per-org fail-mode across the user's teams
  // wins; falls back to env when no team specifies one.
  const perOrgFailMode = pickStrictestPerOrgFailMode(policies);
  if (perOrgFailMode) failMode = perOrgFailMode;

  const policyByTeam = new Map(policies.map((p) => [p.teamId, p]));

  // 4) Pick the STRICTEST team whose policy requires MFA for the
  //    user's role in that team. Strict ordering follows the bounded
  //    MFA_POLICY_LEVELS list — ALL_MEMBERS > REVIEWERS_AND_ABOVE >
  //    ADMINS_ONLY > HIGH_RISK_ONLY > OFF.
  const LEVEL_STRICTNESS: Record<string, number> = {
    OFF: 0,
    HIGH_RISK_ONLY: 1,
    ADMINS_ONLY: 2,
    REVIEWERS_AND_ABOVE: 3,
    ALL_MEMBERS: 4,
  };

  let strictestTeamId: string | null = null;
  let strictestLevel: MfaPolicyLevel | null = null;
  let strictestRank = -1;
  for (const m of memberships) {
    const p = policyByTeam.get(m.teamId);
    // Normalize: missing row OR unknown level → OFF.
    let level: MfaPolicyLevel = "OFF";
    if (p?.mfaPolicyLevel && typeof p.mfaPolicyLevel === "string") {
      const candidates: MfaPolicyLevel[] = [
        "OFF",
        "ADMINS_ONLY",
        "REVIEWERS_AND_ABOVE",
        "ALL_MEMBERS",
        "HIGH_RISK_ONLY",
      ];
      if (candidates.includes(p.mfaPolicyLevel as MfaPolicyLevel)) {
        level = p.mfaPolicyLevel as MfaPolicyLevel;
      }
    }
    // Legacy mfaRequiredFlag interpreted as ADMINS_ONLY when level==OFF
    // (matches mfa-policy.service.ts normalisation).
    if (level === "OFF" && p?.mfaRequiredFlag) {
      level = "ADMINS_ONLY";
    }
    if (!mfaRequiredForRole(level, m.role)) continue;
    const rank = LEVEL_STRICTNESS[level] ?? 0;
    if (rank > strictestRank) {
      strictestRank = rank;
      strictestTeamId = m.teamId;
      strictestLevel = level;
    }
  }

  // 5) Decide the outcome.
  if (!strictestLevel) {
    // No org policy demands MFA for this user. Personal opt-in still
    // honoured.
    if (activeFactorCount > 0) {
      return {
        outcome: "MFA_REQUIRED",
        activeFactorCount,
        policyTeamId: null,
        policyLevel: null,
      };
    }
    return {
      outcome: "NOT_REQUIRED",
      activeFactorCount: 0,
      policyTeamId: null,
      policyLevel: null,
    };
  }

  // Org policy requires MFA for this user's role.
  if (activeFactorCount > 0) {
    return {
      outcome: "MFA_REQUIRED",
      activeFactorCount,
      policyTeamId: strictestTeamId,
      policyLevel: strictestLevel,
    };
  }

  // Org policy requires MFA but the user has not enrolled a factor.
  // The caller MUST route to guided enrollment — NEVER lock out.
  return {
    outcome: "ENROLLMENT_REQUIRED",
    activeFactorCount: 0,
    policyTeamId: strictestTeamId,
    policyLevel: strictestLevel,
  };
}

/**
 * Circuit-breaker decision helper. Emits the correct security
 * event (`mfa_enforcement_degraded` or `mfa_enforcement_failed_closed`)
 * and returns the bounded outcome. Pure: no Prisma; no further
 * lookups — by the time we reach here the resolver has already
 * decided one of its lookups failed.
 *
 * `hasObservedMembership` is true when the failure happened AFTER
 * we successfully read at least one ACTIVE membership. In that
 * case the user is provably an org member, so fail-CLOSED is the
 * right default even under `smart` mode.
 */
function circuitBreakerOutcome(
  kind: EnforcementErrorKind,
  activeFactorCount: number,
  failMode: EnforcementFailMode,
  userId: string,
  hasObservedMembership: boolean = false,
): LoginMfaEnforcementResult {
  // Explicit operator override always wins.
  if (failMode === "open") {
    safeEmitSecurityEvent({
      teamId: null,
      eventType: "mfa_enforcement_degraded",
      severity: "WARNING",
      details: {
        actorUserId: userId,
        kind,
        failMode: "open",
      },
    });
    if (activeFactorCount > 0) {
      // Fail-open with personal opt-in still honoured.
      return {
        outcome: "MFA_REQUIRED",
        activeFactorCount,
        policyTeamId: null,
        policyLevel: null,
      };
    }
    return {
      outcome: "NOT_REQUIRED",
      activeFactorCount: 0,
      policyTeamId: null,
      policyLevel: null,
    };
  }

  if (failMode === "closed") {
    safeEmitSecurityEvent({
      teamId: null,
      eventType: "mfa_enforcement_failed_closed",
      severity: "WARNING",
      details: {
        actorUserId: userId,
        kind,
        failMode: "closed",
      },
    });
    if (activeFactorCount > 0) {
      return {
        outcome: "MFA_REQUIRED",
        activeFactorCount,
        policyTeamId: null,
        policyLevel: null,
      };
    }
    return {
      outcome: "ENROLLMENT_REQUIRED",
      activeFactorCount: 0,
      policyTeamId: null,
      policyLevel: null,
    };
  }

  // SMART mode (default): org-scoped users fail-closed; personal
  // users with no membership AND no factor fail-open with degraded
  // warning. Membership-lookup failure is treated as "potentially
  // org-scoped" — fail-closed unless the user has no factor at all
  // and is clearly personal (we cannot distinguish, so fail-closed).
  const looksOrgScoped =
    hasObservedMembership ||
    kind === "membership_lookup_failed" ||
    kind === "policy_lookup_failed";

  if (looksOrgScoped) {
    safeEmitSecurityEvent({
      teamId: null,
      eventType: "mfa_enforcement_failed_closed",
      severity: "WARNING",
      details: {
        actorUserId: userId,
        kind,
        failMode: "smart",
      },
    });
    if (activeFactorCount > 0) {
      return {
        outcome: "MFA_REQUIRED",
        activeFactorCount,
        policyTeamId: null,
        policyLevel: null,
      };
    }
    return {
      outcome: "ENROLLMENT_REQUIRED",
      activeFactorCount: 0,
      policyTeamId: null,
      policyLevel: null,
    };
  }

  // Personal user, factor lookup failed — best-effort fail-open
  // with degraded warning. Personal users have no org policy to
  // enforce; locking them out on a Prisma blip is the wrong
  // trade-off.
  safeEmitSecurityEvent({
    teamId: null,
    eventType: "mfa_enforcement_degraded",
    severity: "WARNING",
    details: {
      actorUserId: userId,
      kind,
      failMode: "smart",
    },
  });
  return {
    outcome: "NOT_REQUIRED",
    activeFactorCount: 0,
    policyTeamId: null,
    policyLevel: null,
  };
}
