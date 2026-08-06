/**
 * Phase 17 — Organization Security Policy service.
 *
 * Reads + writes the 1:1 OrganizationSecurityPolicy row for a team.
 * The policy stores org-level posture (MFA readiness, allowed email
 * domains, IP restrictions, session timeouts, SSO/SCIM readiness flags).
 *
 * Phase 17 enforcement scope:
 *   - allowedEmailDomains: enforced when a member is invited or a new
 *     external identity mapping is linked (caller checks).
 *   - restrictedIpRanges: enforced by the integrations-auth middleware
 *     for service accounts (intersection of org list and per-credential
 *     list; both empty = no restriction).
 *   - reviewerSessionTimeoutSeconds / contributorSessionTimeoutSeconds:
 *     read by the JWT layer / intake-token issuer in later phases.
 *   - mfaRequiredFlag / ssoReadyFlag / scimReadyFlag: stored, surfaced
 *     in the /identity UI, NOT enforced in Phase 17.
 */

import type { PrismaClient } from "@prisma/client";


import { prisma as defaultPrisma } from "../../db.js";
import { DomainError } from "../../errors.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
// PHASE 10 §10.1 — this service is the SOLE org security-policy authority; it
// COMPOSES the internal pure evaluator (no second public service).
import {
  coerceSecurityPolicy,
  evaluateAuthMethod,
  evaluateSessionLifetime,
  evaluatePolicyVersion,
  evaluateHighSecurityActivation,
  highSecurityPosture,
  type AuthMethod,
  type Decision,
  type HighSecurityPrerequisites,
  type ResolvedSecurityPolicy,
  type SecurityPolicyPatch,
} from "./enterprise-security-policy.policy.js";
// correction 4/5 — mandatory-SSO (login method) is DECOUPLED from managed
// identity; this service no longer reads managed status for the login gate.
import { resolveEnterpriseContract } from "../organization/enterprise-contract.service.js";
import { revokeAllSessionsForUser } from "../identity-security/session-revocation.service.js";



function normaliseDomains(
  raw: ReadonlyArray<string>,
): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim().toLowerCase();
    if (trimmed.length === 0 || trimmed.length > 253) continue;
    // Basic sanity: must contain a dot. Reject anything else.
    if (!trimmed.includes(".")) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function normaliseCidrs(
  raw: ReadonlyArray<string>,
): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > 64) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function clampTimeoutSeconds(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(86_400, Math.floor(value));
}

// PHASE 12B WAVE 1.2 (2026-07-28) — the legacy teamId-keyed writer
// `upsertOrgSecurityPolicy` (unversioned, no step-up, no optimistic
// concurrency) was DELETED with its GET/PUT /v1/identity/policy route pair.
// Its fields are folded into the canonical `applySecurityPolicyPatch` below
// (org-keyed, versioned, step-up-gated). One writer authority remains.

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 10 §10.1 — the versioned advanced-policy surface. These are the ONLY
// public read/write of the Phase 10 fields; both compose the pure evaluator.
// The generated Prisma client (post `prisma generate`) types the new columns.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PHASE 10 §policy-convergence (2026-07-23) — CANONICAL, ORGANIZATION-SCOPED
 * resolver. There is exactly ONE OrganizationSecurityPolicy per Customer
 * Organization, keyed by `organizationId`. This is THE authoritative decision
 * input for every Organization security policy (mandatory-SSO, session limits,
 * high-security, no-personal, step-up…). SYSTEM organizations and Personal/OWNED
 * workspaces have NO policy row → default (unrestricted) posture.
 */
/**
 * Thrown when a CUSTOMER Organization has no provisioned security policy.
 *
 * PHASE 12 — POINT 7 CORRECTIVE PASS (2026-08-05). This is now a typed
 * `DomainError`, for two reasons the first Point-7 run demonstrated.
 *
 * It escaped `POST /v1/platform/context/switch-workspace` as an UNHANDLED
 * exception — thrown inside `establishOrganizationSessionContext`'s
 * transaction, recognised by nothing on the way out — so it became an
 * error-level Sentry issue and a 500. Fail-closed was correct; being
 * unhandled was not.
 *
 * And its message carried the Organization UUID. That message went to the
 * client. A tenant identifier belongs in the operator's log, never in a
 * response to someone who has just been refused access to that tenant — so
 * the developer message keeps the id (it is what makes the log actionable)
 * and `publicMessage` does not.
 *
 * STATUS: 503 is RETAINED, and it is one of the two readings the contract
 * allows. From the caller's position this is a required security dependency
 * that is not yet available: a CUSTOMER Organization must have a policy, the
 * admin editor provisions v1 explicitly, and until an operator does that no
 * ordinary request can proceed. It is not 4xx, because the client did nothing
 * wrong and cannot fix it; it is not 500, because nothing crashed and the
 * system is behaving exactly as designed. `OPERATIONAL_WARNING` reportability
 * carries that distinction into the capture decision: an operator still sees
 * it in the bounded warn stream, without it paging as a server fault.
 */
export type PolicyNotProvisionedError = DomainError;
export function policyNotProvisioned(organizationId: string): PolicyNotProvisionedError {
  return new DomainError(
    `Organization ${organizationId} has no provisioned security policy.`,
    {
      httpStatus: 503,
      publicCode: "POLICY_NOT_PROVISIONED",
      publicMessage:
        "This organization's security configuration is not available. An organization administrator must complete its security setup.",
      reportability: "OPERATIONAL_WARNING",
      severity: "warning",
      // The id belongs in the operator's record, not in the response body.
      metadata: { organizationId },
    },
  );
}

/**
 * Canonical CUSTOMER-Organization policy resolver. Callers pass a CUSTOMER
 * organizationId (the projection below guards SYSTEM/non-org). §3 — a CUSTOMER
 * Organization MUST have a persisted, provisioned policy; a MISSING row FAILS
 * CLOSED (`POLICY_NOT_PROVISIONED`) — NO synthesized allow-oriented default (no
 * implicit ssoRequired=false / high-security=false / unlimited sessions).
 */
export async function resolveOrgSecurityPolicy(
  organizationId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ResolvedSecurityPolicy> {
  const row = await client.organizationSecurityPolicy.findUnique({
    where: { organizationId },
  });
  if (!row) {
    throw policyNotProvisioned(organizationId);
  }
  return coerceSecurityPolicy("", organizationId, row as Record<string, unknown> | null);
}

/**
 * COMPATIBILITY PROJECTION (zero-decision · Phase-12 removal target): resolve a
 * workspace to its parent Customer Organization, then load the ONE org policy.
 * `teamId` is ONLY a lookup input — it is NEVER a policy decision key. A
 * workspace with no parent org (Personal/OWNED, or a SYSTEM-org container) gets
 * NO org policy → default posture. Existing teamId callers route through here
 * unchanged; the DECISION is always the organizationId-keyed policy.
 */
/**
 * PHASE 10 §1.1 — the ONE permitted teamId→policy compatibility ADAPTER
 * (ZERO-DECISION · Phase-12 removal target · owner: identity/org-security-policy).
 * Resolves a workspace to its parent CUSTOMER organizationId, or `null` when the
 * workspace is Personal/OWNED or belongs to a SYSTEM organization (→ no org
 * policy). Contains NO policy decision — it only maps teamId→organizationId so
 * that raw policy-column readers (MFA / session-timeout / governance / bulk
 * enforcement) can query by the AUTHORITATIVE organizationId, never by teamId.
 */
export async function organizationIdForPolicy(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<string | null> {
  const team = await client.team.findUnique({
    where: { id: teamId },
    select: { organizationId: true, organization: { select: { kind: true } } },
  });
  if (!team?.organizationId || team.organization?.kind !== "CUSTOMER") return null;
  return team.organizationId;
}

/**
 * PHASE 10 §1.3 — the DISCRIMINATED policy resolution. A NOT_APPLICABLE result
 * carries NO fabricated policy fields: Personal/OWNED/SYSTEM callers CANNOT read
 * ssoRequired / highSecurity / concurrentSessionLimit / session / no-personal /
 * break-glass / support settings. Only an ORGANIZATION result exposes the
 * persisted CUSTOMER-Organization policy (and a missing one FAILS CLOSED inside
 * resolveOrgSecurityPolicy). This is the canonical typed decision input.
 */
export type OrganizationPolicyResolution =
  | { applicability: "ORGANIZATION"; organizationId: string; policy: ResolvedSecurityPolicy }
  | { applicability: "NOT_APPLICABLE"; reason: "PERSONAL" | "OWNED" | "SYSTEM" };

export async function resolveOrganizationPolicy(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<OrganizationPolicyResolution> {
  const team = await client.team.findUnique({
    where: { id: teamId },
    select: { organizationId: true, isPersonal: true, organization: { select: { kind: true } } },
  });
  if (!team || team.isPersonal) return { applicability: "NOT_APPLICABLE", reason: "PERSONAL" };
  if (!team.organizationId) return { applicability: "NOT_APPLICABLE", reason: "OWNED" };
  if (team.organization?.kind !== "CUSTOMER") return { applicability: "NOT_APPLICABLE", reason: "SYSTEM" };
  // CUSTOMER org — its missing policy FAILS CLOSED (POLICY_NOT_PROVISIONED).
  const policy = await resolveOrgSecurityPolicy(team.organizationId, client);
  return { applicability: "ORGANIZATION", organizationId: team.organizationId, policy };
}

/**
 * PHASE 12 CORRECTION 1 — the AUTHORITATIVE org-admin READ, keyed by
 * organizationId (NOT a teamId adapter). Discriminates applicability by the org's
 * kind: a CUSTOMER org owns the ONE policy (same for every workspace); SYSTEM /
 * non-CUSTOMER orgs are NOT_APPLICABLE. For a CUSTOMER org with no provisioned
 * row yet, returns the coerced default posture so the admin editor can render +
 * create the first version via PATCH — ENFORCEMENT still fails closed via the
 * throwing `resolveOrgSecurityPolicy`.
 */
export async function resolveOrgPolicyByOrgId(
  organizationId: string,
  client: PrismaClient = defaultPrisma,
): Promise<OrganizationPolicyResolution> {
  const org = await client.organization.findUnique({
    where: { id: organizationId },
    select: { kind: true },
  });
  if (!org || org.kind !== "CUSTOMER") {
    return { applicability: "NOT_APPLICABLE", reason: "SYSTEM" };
  }
  const row = await client.organizationSecurityPolicy.findUnique({
    where: { organizationId },
  });
  // PHASE 12B acceptance — a CUSTOMER Organization with NO provisioned policy
  // FAILS CLOSED (POLICY_NOT_PROVISIONED / 503) even on the admin read. The
  // editor provisions v1 explicitly via PATCH; no synthesized permissive
  // defaults are ever projected for a Customer Organization.
  if (!row) throw policyNotProvisioned(organizationId);
  const policy = coerceSecurityPolicy("", organizationId, row as Record<string, unknown> | null);
  return { applicability: "ORGANIZATION", organizationId, policy };
}

/**
 * §10.1 — canonical versioned policy update: bumps `policyVersion` (→ session
 * re-evaluation), writes transactionally, audits. The route enforces
 * authorization + step-up before calling this write chokepoint. Returns the
 * new resolved posture.
 */
/**
 * PHASE 12 CORRECTION 1 (2026-07-28) — resolve the org's canonical team id, used
 * ONLY as an audit-workspace binding + a step-up challenge anchor. It is NEVER a
 * policy decision key: the DECISION is always the input `organizationId`.
 */
export async function orgCanonicalTeamId(
  organizationId: string,
  client: PrismaClient = defaultPrisma,
): Promise<string | null> {
  const t = await client.team.findFirst({
    where: { organizationId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return t?.id ?? null;
}

function orgPolicyNotApplicable(): Error & { statusCode?: number; code?: string } {
  const err = new Error(
    "Security policy is a Customer-Organization policy; this organization cannot own one.",
  ) as Error & { statusCode?: number; code?: string };
  err.statusCode = 404; // anti-enumeration: same shape as not-found
  err.code = "ORG_SECURITY_POLICY_NOT_APPLICABLE";
  return err;
}

/**
 * PHASE 12B WAVE 1.2 — the folded legacy field set (formerly the
 * `upsertOrgSecurityPolicy` / PUT /v1/identity/policy surface). These are
 * admin-config columns on the ONE organization_security_policy row; they now
 * flow ONLY through this versioned, step-up-gated writer.
 */
export type ExtendedSecurityPolicyPatch = SecurityPolicyPatch & {
  mfaRequiredFlag?: boolean;
  allowedEmailDomains?: string[];
  restrictedIpRanges?: string[];
  reviewerSessionTimeoutSeconds?: number | null;
  contributorSessionTimeoutSeconds?: number | null;
  ssoReadyFlag?: boolean;
  scimReadyFlag?: boolean;
  notes?: string | null;
};

export async function applySecurityPolicyPatch(
  input: {
    // PHASE 12 CORRECTION 1 — the AUTHORITATIVE key is organizationId. No teamId /
    // workspace derivation; the same policy is shared by every workspace in the org.
    organizationId: string;
    actorUserId: string;
    patch: ExtendedSecurityPolicyPatch;
    /** Optimistic concurrency — if provided, must equal the current policyVersion. */
    expectedPolicyVersion?: number | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<ResolvedSecurityPolicy> {
  const { organizationId } = input;
  // The policy exists ONLY for CUSTOMER organizations. SYSTEM orgs cannot own one.
  const org = await client.organization.findUnique({
    where: { id: organizationId },
    select: { kind: true },
  });
  if (!org || org.kind !== "CUSTOMER") throw orgPolicyNotApplicable();
  // Read the raw existing row directly (NOT resolveOrgSecurityPolicy, which
  // fail-closes on a missing CUSTOMER policy — the FIRST patch legitimately has
  // none). Version starts at 1 on create.
  const existing = await client.organizationSecurityPolicy.findUnique({
    where: { organizationId },
    select: { policyVersion: true },
  });
  const currentVersion = existing?.policyVersion ?? 0;
  // Optimistic concurrency — stale expected version → 409, ZERO mutation.
  if (input.expectedPolicyVersion != null && input.expectedPolicyVersion !== currentVersion) {
    const err = new Error(
      "Security policy was modified concurrently; reload and retry.",
    ) as Error & { statusCode?: number; code?: string; details?: unknown };
    err.statusCode = 409;
    err.code = "POLICY_VERSION_CONFLICT";
    err.details = { expected: input.expectedPolicyVersion, current: currentVersion };
    throw err;
  }
  const nextVersion = currentVersion + 1;
  // PHASE 12B WAVE 1.2 — normalise the folded legacy fields (same rules the
  // deleted upsertOrgSecurityPolicy applied) so unvalidated raw values never
  // reach the row: lowercased deduped domains, deduped CIDRs, clamped timeouts.
  if (input.patch.allowedEmailDomains !== undefined) {
    input.patch.allowedEmailDomains = normaliseDomains(input.patch.allowedEmailDomains);
  }
  if (input.patch.restrictedIpRanges !== undefined) {
    input.patch.restrictedIpRanges = normaliseCidrs(input.patch.restrictedIpRanges);
  }
  if (input.patch.reviewerSessionTimeoutSeconds !== undefined) {
    input.patch.reviewerSessionTimeoutSeconds = clampTimeoutSeconds(input.patch.reviewerSessionTimeoutSeconds);
  }
  if (input.patch.contributorSessionTimeoutSeconds !== undefined) {
    input.patch.contributorSessionTimeoutSeconds = clampTimeoutSeconds(input.patch.contributorSessionTimeoutSeconds);
  }
  // §policy-lifecycle — UPSERT BY organizationId (authoritative). teamId is
  // nullable compat metadata only; org-keyed writes never derive it.
  await client.organizationSecurityPolicy.upsert({
    where: { organizationId },
    create: {
      organizationId,
      teamId: null,
      updatedByUserId: input.actorUserId,
      policyVersion: nextVersion,
      ...input.patch,
    },
    update: {
      updatedByUserId: input.actorUserId,
      policyVersion: nextVersion,
      ...input.patch,
    },
  });
  const auditTeamId = await orgCanonicalTeamId(organizationId, client);
  await emitTenantAudit({
    action: "identity.security_policy.update",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: auditTeamId,
    policyVersion: nextVersion,
    resourceType: "organization_security_policy",
    resourceId: organizationId,
    metadata: {
      organizationId,
      patch: input.patch as Record<string, unknown>,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, client);
  const prior =
    existing !== null
      ? await resolveOrgSecurityPolicy(organizationId, client)
      : coerceSecurityPolicy("", organizationId, null);
  return { ...prior, ...input.patch, policyVersion: nextVersion };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 10 §10.2/§10.7 — canonical LOGIN + SESSION gates. Production callers
// (login mint paths, session middleware, context switch) invoke these; the
// decision is composed from the resolved policy + the user's identity mode.
// Both are backend-authoritative and MIGRATION-DORMANT (a STANDARD posture
// until the policy is activated, so nothing is retroactively gated).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §10.2 — may `userId` establish access to the workspace `teamId` using
 * `method`? Managed internal identities under `ssoRequired` are denied
 * password/OAuth. Personal/self-service (non-managed) identities are not
 * forced through org SSO. Deterministic result the caller maps to a bounce.
 */
export async function evaluateOrgLoginMethod(
  input: {
    teamId: string;
    userId: string;
    method: AuthMethod;
    /**
     * §10.2 correction — the SsoConnection id the session authenticated
     * through (SAML/OIDC only). A SAML/OIDC method ALONE never satisfies an
     * arbitrary Organization: the connection must be ACTIVE and owned by the
     * TARGET org (a connection uniquely binds Organization + issuer).
     */
    ssoConnId?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<Decision> {
  const resolution = await resolveOrganizationPolicy(input.teamId, client);
  // §1.3 — Personal/OWNED/SYSTEM are NOT governed by an Organization login
  // policy → allowed (the login-method gate only RESTRICTS org access).
  if (resolution.applicability !== "ORGANIZATION") return { allowed: true };
  const policy = resolution.policy;
  const team = { organizationId: resolution.organizationId };
  // correction 4/5 — MANDATORY SSO is a LOGIN-METHOD decision, INDEPENDENT of
  // managed-identity ownership. When the Org requires SSO, every session must
  // use SSO regardless of STANDARD/MANAGED status.
  const base = evaluateAuthMethod(policy, { method: input.method });
  if (!base.allowed) return base;
  // §10.2 ORG-BINDING: when this org requires SSO and the session satisfies via
  // SSO, the SSO connection must be ACTIVE and belong to THIS org — Org-A's SSO
  // never satisfies Org-B. Applies to ALL SSO sessions, not just managed ones.
  if (policy.ssoRequired && input.method === "SSO") {
    if (!input.ssoConnId) {
      return { allowed: false, reason: "sso_connection_unbound" };
    }
    const conn = await client.ssoConnection.findUnique({
      where: { id: input.ssoConnId },
      select: { status: true, team: { select: { organizationId: true } } },
    });
    if (!conn || conn.status !== "ACTIVE") {
      return { allowed: false, reason: "sso_connection_inactive" };
    }
    if (
      !team?.organizationId ||
      conn.team?.organizationId !== team.organizationId
    ) {
      return { allowed: false, reason: "sso_connection_wrong_organization" };
    }
  }
  return { allowed: true };
}

/**
 * §10.7 — is an existing session still valid under the CURRENT policy? Enforces
 * max-age, idle timeout and policy-version staleness (session minted before a
 * policy bump must reauthenticate). Session-bound facts are supplied by the
 * middleware from the JWT/session row.
 */
export async function evaluateSessionAgainstPolicy(
  input: {
    teamId: string;
    issuedAtMs: number;
    lastSeenAtMs: number;
    sessionPolicyVersion: number | null;
    nowMs?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<Decision> {
  const resolution = await resolveOrganizationPolicy(input.teamId, client);
  // §1.3 — non-Organization contexts have no session policy to evaluate.
  if (resolution.applicability !== "ORGANIZATION") return { allowed: true };
  const policy = resolution.policy;
  const nowMs = input.nowMs ?? Date.now();
  const version = evaluatePolicyVersion(policy, input.sessionPolicyVersion);
  if (!version.allowed) return version;
  return evaluateSessionLifetime(policy, {
    issuedAtMs: input.issuedAtMs,
    lastSeenAtMs: input.lastSeenAtMs,
    nowMs,
  });
}

/**
 * PHASE 10 §1 — CONTINUOUS organization-context policy enforcement for the
 * authenticated request hot path. Composes the canonical gates so mandatory-SSO
 * + org lifecycle + session policy are re-evaluated on EVERY request operating
 * in an ORGANIZATION workspace — not only at the switch-workspace seam. The
 * middleware supplies the session's resolved workspace + provenance; this reads
 * LIVE policy (a later tightening affects subsequent requests).
 *
 * PERSONAL / OWNED workspaces are exempt (return allowed) — an unrelated
 * OrganizationSecurityPolicy never applies to them. Fails CLOSED on missing /
 * ambiguous context (unknown workspace, suspended org). Performs NO mutation.
 *
 * Reasons: `workspace_not_found` · `organization_suspended` ·
 * (evaluateOrgLoginMethod reasons) · (evaluateSessionAgainstPolicy reasons).
 */
export async function evaluateOrgContextForSession(
  input: {
    userId: string;
    teamId: string;
    method: AuthMethod;
    ssoConnId?: string | null;
    authAtMs: number;
    lastSeenAtMs: number;
    nowMs?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<Decision> {
  const team = await client.team.findUnique({
    where: { id: input.teamId },
    select: { isPersonal: true, organizationId: true, organization: { select: { status: true } } },
  });
  if (!team) return { allowed: false, reason: "workspace_not_found" };
  // PERSONAL / OWNED (non-org) workspaces: no OrganizationSecurityPolicy applies.
  if (team.isPersonal || !team.organizationId) return { allowed: true };
  // Org lifecycle: a suspended/archived Organization cannot be operated in.
  if (team.organization && team.organization.status !== "ACTIVE") {
    return { allowed: false, reason: "organization_suspended" };
  }
  const loginGate = await evaluateOrgLoginMethod(
    { teamId: input.teamId, userId: input.userId, method: input.method, ssoConnId: input.ssoConnId ?? null },
    client,
  );
  if (!loginGate.allowed) return loginGate;
  return evaluateSessionAgainstPolicy(
    {
      teamId: input.teamId,
      issuedAtMs: input.authAtMs,
      lastSeenAtMs: input.lastSeenAtMs,
      sessionPolicyVersion: null, // global session — live policy is authoritative
      nowMs: input.nowMs,
    },
    client,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 10 §10.4 — HIGH-SECURITY readiness + ATOMIC activation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the high-security prerequisites from real persisted signals. Reads
 * only; conservative/fail-closed where a signal is absent. `client` may be a
 * tx client so activation validates + writes in one transaction.
 */
export async function assembleHighSecurityReadiness(
  // PHASE 12 CORRECTION 1 — org-keyed. Readiness is ORGANIZATION-wide (SSO across
  // ANY workspace in the org), not a single workspace's signal.
  organizationId: string,
  client: PrismaClient = defaultPrisma,
): Promise<HighSecurityPrerequisites> {
  const [activeSso, verifiedDomainCount, emergencyReadyCount, contract] = await Promise.all([
    client.ssoConnection.findFirst({
      where: { team: { organizationId }, status: "ACTIVE" },
      select: { id: true },
    }),
    client.organizationDomain.count({ where: { organizationId, verifiedAt: { not: null } } }),
    // Break-glass readiness = at least one configured emergency grant exists.
    client.emergencyAccessGrant.count({ where: { organizationId } }),
    resolveEnterpriseContract(organizationId, client),
  ]);

  // Unresolved personal custody: MANAGED users owning personal (teamId-null)
  // evidence in this org. Managed identities must not have personal custody
  // seized — its presence BLOCKS activation (fail closed).
  let unresolvedPersonalCustodyUserIds: string[] = [];
  if (organizationId) {
    const managed = await client.user.findMany({
      where: { identityMode: "MANAGED_ENTERPRISE" },
      select: { id: true },
      take: 500,
    });
    const managedIds = managed.map((u) => u.id);
    if (managedIds.length > 0) {
      const custody = await client.evidence.findMany({
        where: { teamId: null, ownerUserId: { in: managedIds } },
        select: { ownerUserId: true },
        distinct: ["ownerUserId"],
        take: 50,
      });
      unresolvedPersonalCustodyUserIds = custody.map((e) => e.ownerUserId);
    }
  }

  return {
    hasActiveSsoConnection: Boolean(activeSso),
    ssoConnectionTested: Boolean(activeSso), // ACTIVE connection = tested
    hasVerifiedDomain: verifiedDomainCount > 0,
    hasBreakGlassReadiness: emergencyReadyCount > 0,
    unresolvedPersonalCustodyUserIds,
    contractActive: contract?.status === "ACTIVE",
  };
}

/**
 * §10.4 — readiness verdict (dry-run). The service composes the pure
 * evaluator so routes never import the internal evaluator directly.
 */
export async function checkHighSecurityReadiness(
  organizationId: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ readiness: { ok: true } | { ok: false; missing: string[] }; prerequisites: HighSecurityPrerequisites }> {
  const prerequisites = await assembleHighSecurityReadiness(organizationId, client);
  return { readiness: evaluateHighSecurityActivation(prerequisites), prerequisites };
}

/**
 * §10.4 — ATOMIC high-security activation. Validates every prerequisite; on
 * failure performs ZERO policy mutation and ZERO session revocation and
 * returns the exact fail-closed reason. On success, in ONE transaction:
 * writes the composed HIGH_SECURITY posture (versioned) + revokes the org
 * members' sessions (re-auth under stricter policy) + audits the affected
 * count. No compliance claim is made.
 */
export async function activateHighSecurityMode(
  input: {
    // PHASE 12 CORRECTION 1 — org-keyed. Readiness + revocation are ORGANIZATION-wide.
    organizationId: string;
    actorUserId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<
  | { ok: true; policy: ResolvedSecurityPolicy; affectedSessionUserCount: number }
  | { ok: false; missing: string[] }
> {
  return client.$transaction(async (tx) => {
    const pre = await assembleHighSecurityReadiness(input.organizationId, tx as PrismaClient);
    const verdict = evaluateHighSecurityActivation(pre);
    if (!verdict.ok) {
      // Zero partial mutation, zero revocation — surface the exact reason.
      return { ok: false, missing: verdict.missing };
    }
    const policy = await applySecurityPolicyPatch(
      { organizationId: input.organizationId, actorUserId: input.actorUserId, patch: highSecurityPosture(), ipAddress: input.ipAddress, userAgent: input.userAgent },
      tx as PrismaClient,
    );
    // Revoke EVERY org member's sessions across ALL workspaces in the org (re-auth
    // under the stricter policy). Sessions are global — dedupe by userId so the
    // affected count is distinct users, not membership rows.
    const memberships = await (tx as PrismaClient).teamMember.findMany({
      where: { team: { organizationId: input.organizationId }, status: "ACTIVE" },
      select: { userId: true },
    });
    const uniqueUserIds = [...new Set(memberships.map((m) => m.userId))];
    const auditTeamId = await orgCanonicalTeamId(input.organizationId, tx as PrismaClient);
    for (const userId of uniqueUserIds) {
      await revokeAllSessionsForUser(
        { teamId: auditTeamId ?? "", userId, reason: "POLICY_CHANGE", actorUserId: input.actorUserId },
        tx as PrismaClient,
      );
    }
    await emitTenantAudit({
      action: "identity.security_policy.high_security_activated",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: auditTeamId,
      policyVersion: policy.policyVersion,
      resourceType: "organization_security_policy",
      resourceId: input.organizationId,
      metadata: { organizationId: input.organizationId, affectedSessionUserCount: uniqueUserIds.length },
    }, tx as PrismaClient);
    return { ok: true, policy, affectedSessionUserCount: uniqueUserIds.length };
  });
}
