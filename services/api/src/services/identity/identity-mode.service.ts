/**
 * PHASE 10 §13.2 (2026-07-22) — managed-identity mode (foundational
 * primitive for §13.1 mandatory SSO + §13.3 government mode).
 *
 * A MANAGED_ENTERPRISE identity is org-controlled: NO personal space,
 * SSO-only, no personal data export, org-controlled lifecycle. STANDARD
 * is the normal self-service identity. This service is the ONE place the
 * mode is read and the ONE place the mode-derived guards live, so every
 * enforcement point (bootstrap, export, personal-space creation) resolves
 * the same answer.
 *
 * DEPLOYMENT ORDER (PHASE 10 §3, 2026-07-23): schema BEFORE code. The Phase-10
 * identity columns arrive with `20270925000000_user_identity_mode` +
 * `20271002000000_managed_identity_ownership`. A missing table/column at
 * runtime is SCHEMA UNAVAILABILITY, NOT evidence that the identity is STANDARD
 * — this service NEVER downgrades to STANDARD or grants access on a schema
 * error. It FAILS CLOSED: P2021/P2022 (and unknown-field validation) propagate
 * as a typed `SECURITY_SCHEMA_UNAVAILABLE` failure that every caller denies.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export type UserIdentityMode = "STANDARD" | "MANAGED_ENTERPRISE";

export type IdentityModeError = Error & { statusCode: number; code: string };

function modeError(code: string, message: string): IdentityModeError {
  const err = new Error(message) as IdentityModeError;
  err.statusCode = 403;
  err.code = code;
  return err;
}

export type SecuritySchemaUnavailableError = Error & { statusCode: number; code: string };

/**
 * PHASE 10 §0B/§3 — schema-unavailability FAILS CLOSED. Thrown when a Phase-10
 * identity column/table is missing at runtime (P2021/P2022) or the client field
 * is absent. Carries a generic 503 posture; callers deny (middleware → 503,
 * bootstrap/export/provisioning/readiness → zero-mutation deny). It is NEVER
 * interpreted as STANDARD.
 */
export function securitySchemaUnavailable(detail: string): SecuritySchemaUnavailableError {
  const err = new Error(
    `Security identity schema unavailable (${detail}). Apply Phase-10 migrations before serving.`,
  ) as SecuritySchemaUnavailableError;
  err.statusCode = 503;
  err.code = "SECURITY_SCHEMA_UNAVAILABLE";
  return err;
}

/** True for the schema-absence errors that MUST fail closed (never STANDARD). */
function isSchemaUnavailable(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "P2021" || code === "P2022") return true;
  // Prisma "Unknown field/argument" validation (client not regenerated for the
  // new column) is also schema-unavailability, not a STANDARD signal.
  const msg = (err as { message?: string })?.message ?? "";
  return /Unknown (field|arg)|does not exist in the current database/i.test(msg);
}

export type ManagedIdentitySource = "SAML" | "OIDC" | "SCIM" | "DOMAIN";

/**
 * PHASE 10 §0B — the AUTHORITATIVE managed-identity ownership envelope. A
 * global `identityMode` alone is NOT authoritative: MANAGED_ENTERPRISE governs
 * a user's Personal scope + mandatory-SSO ONLY when an owning Organization is
 * bound (`managingOrganizationId`). This is the ONE place that answers "who
 * manages this identity, and via what verified provenance".
 *
 * Migration-window safe: the ownership columns arrive with
 * `20271002000000_managed_identity_ownership` (authored, NOT applied). Any
 * absence collapses to an UNOWNED result → treated as STANDARD (fail-safe).
 */
/**
 * PHASE 10 §0B/correction 2 — the canonical managed-identity RESOLUTION STATE:
 *   - STANDARD          — no managing Organization; ordinary product behavior.
 *   - MANAGED           — identityMode MANAGED + an owning Organization bound.
 *   - MANAGED_UNRESOLVED — a persisted MANAGED signal exists but ownership
 *     CANNOT be proven (owner NULL). This is an INCONSISTENT SECURITY STATE,
 *     NOT a STANDARD identity: Personal bootstrap + no-personal-sensitive ops +
 *     managed org entry are DENIED until reconciled, and it is NEVER
 *     auto-downgraded to STANDARD.
 */
export type ManagedIdentityState = "STANDARD" | "MANAGED" | "MANAGED_UNRESOLVED";

export type ManagedIdentity = {
  state: ManagedIdentityState;
  /** True ONLY for the fully-resolved MANAGED state (owning Org bound). */
  managed: boolean;
  mode: UserIdentityMode;
  managingOrganizationId: string | null;
  source: ManagedIdentitySource | null;
  managedBySsoConnectionId: string | null;
};

export async function resolveManagedIdentity(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ManagedIdentity> {
  let row:
    | {
        identityMode?: string | null;
        managingOrganizationId?: string | null;
        managedIdentitySource?: string | null;
        managedBySsoConnectionId?: string | null;
      }
    | null;
  try {
    row = (await client.user.findUnique({
      where: { id: userId },
      select: {
        identityMode: true,
        managingOrganizationId: true,
        managedIdentitySource: true,
        managedBySsoConnectionId: true,
      } as never,
    })) as typeof row;
  } catch (err) {
    // FAIL CLOSED (§0B/§3): a missing table/column (P2021/P2022) or an absent
    // client field is SCHEMA UNAVAILABILITY — NOT evidence the identity is
    // STANDARD. It NEVER downgrades to STANDARD or grants access. Deployment
    // order is schema-before-code; a schema-unavailable read propagates as a
    // typed 503 that every caller denies. Any other error propagates as-is.
    if (isSchemaUnavailable(err)) {
      throw securitySchemaUnavailable("managed identity ownership columns");
    }
    throw err;
  }
  const mode: UserIdentityMode =
    row?.identityMode === "MANAGED_ENTERPRISE" ? "MANAGED_ENTERPRISE" : "STANDARD";
  const managingOrganizationId = row?.managingOrganizationId ?? null;
  const source = (row?.managedIdentitySource as ManagedIdentitySource | null) ?? null;
  const managedBySsoConnectionId = row?.managedBySsoConnectionId ?? null;

  let state: ManagedIdentityState;
  if (mode !== "MANAGED_ENTERPRISE") {
    state = "STANDARD";
  } else if (managingOrganizationId === null) {
    // MANAGED flag with no owner = inconsistent → UNRESOLVED (never STANDARD).
    state = "MANAGED_UNRESOLVED";
  } else if (
    await isManagementSourceValid(
      { source, managedBySsoConnectionId, managingOrganizationId },
      client,
    )
  ) {
    state = "MANAGED";
  } else {
    // correction (item 2) — owner present but the required management SOURCE is
    // missing/invalid/revoked/wrong-org → UNRESOLVED (fail closed, NOT STANDARD).
    state = "MANAGED_UNRESOLVED";
  }
  return {
    state,
    managed: state === "MANAGED",
    mode,
    managingOrganizationId,
    source,
    managedBySsoConnectionId,
  };
}

/**
 * PHASE 10 item 2 — SOURCE INTEGRITY. Is the management SOURCE for an
 * owner-bound MANAGED identity valid? The requirement is encoded EXPLICITLY per
 * source type (never inferred from null):
 *   - SCIM / DOMAIN — directory/domain-provisioned; NO SsoConnection required.
 *   - SAML / OIDC   — REQUIRES `managedBySsoConnectionId` present, the
 *                     connection ACTIVE, and OWNED by the managing Organization.
 *   - null / unknown — no proven source → invalid.
 * A schema-unavailable connection read fails closed (propagates).
 */
async function isManagementSourceValid(
  input: {
    source: ManagedIdentitySource | null;
    managedBySsoConnectionId: string | null;
    managingOrganizationId: string;
  },
  client: PrismaClient,
): Promise<boolean> {
  if (input.source === "SCIM" || input.source === "DOMAIN") return true;
  if (input.source !== "SAML" && input.source !== "OIDC") return false; // null/unknown
  if (!input.managedBySsoConnectionId) return false; // SSO source requires a bound connection
  let conn: { status: string; team: { organizationId: string | null } | null } | null;
  try {
    conn = (await client.ssoConnection.findUnique({
      where: { id: input.managedBySsoConnectionId },
      select: { status: true, team: { select: { organizationId: true } } },
    })) as typeof conn;
  } catch (err) {
    if (isSchemaUnavailable(err)) throw securitySchemaUnavailable("sso connection");
    throw err;
  }
  if (!conn || conn.status !== "ACTIVE") return false; // deleted / revoked / inactive
  return conn.team?.organizationId === input.managingOrganizationId; // must be owned by THIS org
}

/**
 * §0B — is this identity AUTHORITATIVELY managed (owning Org bound)? Only the
 * fully-resolved MANAGED state qualifies; MANAGED_UNRESOLVED does NOT (it is
 * handled separately — denied, not treated as managed OR standard).
 */
export async function isManagedEnterprise(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  return (await resolveManagedIdentity(userId, client)).managed;
}

/**
 * §0B — is this identity managed by THIS SPECIFIC Organization? Org A's managed
 * policy (no-personal, mandatory-SSO) applies ONLY when Org A owns the
 * management. Org B and the user's Personal scope are never governed by Org A.
 */
export async function isManagedByOrganization(
  userId: string,
  organizationId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const mi = await resolveManagedIdentity(userId, client);
  return mi.managed && mi.managingOrganizationId === organizationId;
}

export type ManagedIdentityConflictError = Error & { statusCode: number; code: string };

/**
 * §0B — the SOLE guarded writer of managed-identity ownership. SCIM/SSO call
 * THIS (never a blind `identityMode` write). Enforces org-owned management and
 * FAILS CLOSED on a management conflict: a user already managed by Organization
 * A cannot be re-claimed by Organization B (an idempotent same-org write is
 * allowed). Requires a verified provenance source. Never touches Personal
 * custody or unrelated memberships.
 */
/**
 * PHASE 10 §9/§6 — PERSISTENCE-VERIFIED source evidence. `setManagedIdentity`
 * NEVER trusts caller-asserted truth; the evidence carries immutable persisted
 * IDENTIFIERS + a ceremony type, and the authority LOADS each from the DB:
 *   - SAML/OIDC — an SsoConnection id: loaded, ACTIVE, owned by the managing org.
 *   - SCIM      — a SCIM SsoConnection id (provider GENERIC_SCIM): loaded,
 *                 ACTIVE, owned by the managing org (no caller-supplied org id).
 *   - DOMAIN    — an OrganizationDomain id + the user email: loaded, VERIFIED,
 *                 owned by the managing org, AND the user's email domain matches
 *                 the verified domain (no caller-supplied org id).
 * The persisted `managedIdentitySource` enum is DERIVED from the ceremony.
 */
export type ManagedIdentityEvidence =
  | { source: "SAML" | "OIDC"; ssoConnectionId: string }
  // SCIM's authoritative credential is the ScimProvisioningToken (keyed by
  // teamId), NOT an SsoConnection. The token id comes from the AUTHENTICATED
  // SCIM request context (`ctx.tokenId`) — never findFirst/caller-declared.
  | { source: "SCIM"; scimTokenId: string }
  | { source: "DOMAIN"; organizationDomainId: string; userEmail: string };

/** DB-verify evidence against the managing org. Throws on any mismatch/absence. */
async function validateManagedIdentityEvidence(
  ev: ManagedIdentityEvidence,
  managingOrganizationId: string,
  client: PrismaClient,
): Promise<{ managedBySsoConnectionId: string | null }> {
  const invalid = (msg: string): never => {
    throw modeError("MANAGED_IDENTITY_SOURCE_INVALID", msg);
  };
  if (ev.source === "DOMAIN") {
    // Load the OrganizationDomain; require verified + org-owned + email match.
    let dom: { organizationId: string; domain: string; verifiedAt: Date | null } | null;
    try {
      dom = (await client.organizationDomain.findUnique({
        where: { id: ev.organizationDomainId },
        select: { organizationId: true, domain: true, verifiedAt: true },
      })) as typeof dom;
    } catch (err) {
      if (isSchemaUnavailable(err)) throw securitySchemaUnavailable("organization domain");
      throw err;
    }
    if (!dom || dom.verifiedAt === null) return invalid("The domain is not verified.");
    if (dom.organizationId !== managingOrganizationId) return invalid("The verified domain is owned by a different Organization.");
    const emailDomain = ev.userEmail.split("@")[1]?.toLowerCase() ?? "";
    if (!emailDomain || emailDomain !== dom.domain.toLowerCase()) return invalid("The user's email domain does not match the verified domain.");
    return { managedBySsoConnectionId: null };
  }
  if (ev.source === "SCIM") {
    // Load the SCIM credential (ScimProvisioningToken); require ACTIVE + its
    // team owned by the managing Organization. No caller-declared org proof.
    let tok: { status: string; team: { organizationId: string | null } | null } | null;
    try {
      tok = (await client.scimProvisioningToken.findUnique({
        where: { id: ev.scimTokenId },
        select: { status: true, team: { select: { organizationId: true } } },
      })) as typeof tok;
    } catch (err) {
      if (isSchemaUnavailable(err)) throw securitySchemaUnavailable("scim provisioning token");
      throw err;
    }
    if (!tok || tok.status !== "ACTIVE") return invalid("The SCIM provisioning token is missing or not active.");
    if (tok.team?.organizationId !== managingOrganizationId) return invalid("The SCIM tenant is not owned by the managing Organization.");
    return { managedBySsoConnectionId: null };
  }
  // SAML / OIDC — load the SsoConnection; require ACTIVE + org-owned.
  let conn: { status: string; provider: string; team: { organizationId: string | null } | null } | null;
  try {
    conn = (await client.ssoConnection.findUnique({
      where: { id: ev.ssoConnectionId },
      select: { status: true, provider: true, team: { select: { organizationId: true } } },
    })) as typeof conn;
  } catch (err) {
    if (isSchemaUnavailable(err)) throw securitySchemaUnavailable("sso connection");
    throw err;
  }
  if (!conn || conn.status !== "ACTIVE") return invalid("The SSO connection is missing or not active.");
  if (conn.team?.organizationId !== managingOrganizationId) return invalid("The connection is not owned by the managing Organization.");
  return { managedBySsoConnectionId: ev.ssoConnectionId };
}

export async function setManagedIdentity(
  input: {
    userId: string;
    managingOrganizationId: string;
    evidence: ManagedIdentityEvidence;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  if (!input.managingOrganizationId) {
    throw modeError("MANAGED_IDENTITY_UNOWNED", "A managing Organization is required to set a managed identity.");
  }
  // §9/§6 — DB-VERIFY the evidence BEFORE any write. Invalid/foreign/unverified
  // → fail closed (no identity/session/membership mutation).
  const ev = input.evidence;
  const { managedBySsoConnectionId } = await validateManagedIdentityEvidence(ev, input.managingOrganizationId, client);

  const current = await resolveManagedIdentity(input.userId, client);
  if (
    current.managingOrganizationId &&
    current.managingOrganizationId !== input.managingOrganizationId
  ) {
    // Conflict: another Organization already manages this identity. Fail closed.
    throw modeError(
      "MANAGED_IDENTITY_CONFLICT",
      "This identity is already managed by a different Organization; management cannot be reassigned implicitly.",
    );
  }
  await (client.user.update as unknown as (args: unknown) => Promise<unknown>)({
    where: { id: input.userId },
    data: {
      identityMode: "MANAGED_ENTERPRISE",
      managingOrganizationId: input.managingOrganizationId,
      managedIdentitySource: ev.source,
      managedBySsoConnectionId,
    },
  });
}

/**
 * §0B — release an Organization's management of an identity (SCIM deprovision).
 * Clears the managed binding ONLY when THIS Org owns it (no-op otherwise, so
 * Org B can never release Org A's management). Never deletes the User, Personal
 * custody, or any other Organization membership.
 */
export async function releaseManagedIdentity(
  input: { userId: string; managingOrganizationId: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const current = await resolveManagedIdentity(input.userId, client);
  if (current.managingOrganizationId !== input.managingOrganizationId) {
    return false; // not owned by this Org → refuse to release (fail closed)
  }
  await (client.user.update as unknown as (args: unknown) => Promise<unknown>)({
    where: { id: input.userId },
    data: {
      identityMode: "STANDARD",
      managingOrganizationId: null,
      managedIdentitySource: null,
      managedBySsoConnectionId: null,
    },
  });
  return true;
}

/**
 * PHASE 12 — POINT 7 (2026-08-05): the reason a Personal Space is refused.
 *
 * Two INDEPENDENT rules deny a Personal Space and they are not the same rule:
 *
 *   MANAGED_IDENTITY   the identity itself is org-controlled (§13.2) —
 *                      MANAGED_ENTERPRISE, or MANAGED_UNRESOLVED which fails
 *                      closed pending reconciliation;
 *   ORG_POLICY         an Organization the user is an ACTIVE member of sets
 *                      `noPersonalSpace = true` on its security policy.
 *
 * Before Point 7 only the first was enforced. `noPersonalSpace` was persisted,
 * settable through `PUT /v1/enterprise/security/policy`, and written
 * unconditionally by HIGH_SECURITY activation — and read by nothing. The pure
 * evaluator `evaluatePersonalSpaceAllowed` had zero production callers, so an
 * Organization that had switched the control on still handed every STANDARD
 * member a Personal Space, and the server still fell back into one.
 */
export type PersonalSpaceDenialReason = "MANAGED_IDENTITY" | "ORG_POLICY";

export type PersonalSpaceEligibility =
  | { allowed: true }
  | {
      allowed: false;
      reason: PersonalSpaceDenialReason;
      /** The Organization whose policy denied it (ORG_POLICY only). */
      organizationId: string | null;
    };

/**
 * §13.2 + POINT 7 — THE one Personal-Space permission decision.
 *
 * Every surface that creates, restores, selects, routes into, or falls back to
 * a Personal Workspace resolves here. Returning a discriminated result rather
 * than a boolean is deliberate: the platform-context fallback has to be able to
 * say WHY it refused to fabricate a Personal Space, and a boolean cannot.
 *
 * A CUSTOMER Organization with NO provisioned policy row cannot have set
 * `noPersonalSpace`, so it does not deny here. That is not a permissive
 * default: the unprovisioned case is already `POLICY_NOT_PROVISIONED` /
 * fail-closed at the security surfaces that resolve the policy for a decision
 * (`resolveOrgSecurityPolicy`), and inventing a second, quieter denial in this
 * resolver would remove every enterprise member's Personal Space on the
 * strength of a missing row rather than a stated policy.
 */
export async function resolvePersonalSpaceEligibility(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<PersonalSpaceEligibility> {
  // correction 2 — ONLY a STANDARD identity has Personal Space. Both MANAGED
  // and MANAGED_UNRESOLVED deny Personal bootstrap (the latter fails closed
  // pending reconciliation — it is NOT a self-service identity).
  if ((await resolveManagedIdentity(userId, client)).state !== "STANDARD") {
    return { allowed: false, reason: "MANAGED_IDENTITY", organizationId: null };
  }

  // POINT 7 — the org-policy rule. Only CUSTOMER Organizations the user
  // actually belongs to participate: an `OrganizationMembership` row IS the
  // membership (the model carries no status column — removal deletes the row),
  // and a SYSTEM container org (the 1:1 container behind a Personal/Owned
  // workspace) owns no policy at all.
  let rows: Array<{ organizationId: string; noPersonalSpace: boolean }>;
  try {
    rows = (await client.organizationSecurityPolicy.findMany({
      where: {
        noPersonalSpace: true,
        organization: {
          kind: "CUSTOMER",
          memberships: { some: { userId } },
        },
      },
      select: { organizationId: true, noPersonalSpace: true },
    })) as Array<{ organizationId: string; noPersonalSpace: boolean }>;
  } catch (err) {
    // Same posture as the identity columns above: a missing table/column is
    // schema unavailability, never evidence that no policy exists.
    if (isSchemaUnavailable(err)) {
      throw securitySchemaUnavailable("organization_security_policy");
    }
    throw err;
  }

  const denying = rows.find((r) => r.noPersonalSpace === true);
  if (denying) {
    return {
      allowed: false,
      reason: "ORG_POLICY",
      organizationId: denying.organizationId,
    };
  }
  return { allowed: true };
}

/**
 * Boolean projection of {@link resolvePersonalSpaceEligibility}, kept because
 * most call sites only need the verdict. It is a projection, not a second
 * implementation — there is exactly one decision.
 */
export async function personalSpaceAllowed(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  return (await resolvePersonalSpaceEligibility(userId, client)).allowed;
}

/**
 * PHASE 10 §13.2 STEP 6 (2026-07-23) — the canonical assert used by EVERY
 * remaining PERSONAL-scope server surface (personal capture draft, personal
 * Evidence create, personal Evidence finalize, personal checkout/billing,
 * personal-context switch). It is a THIN wrapper over `personalSpaceAllowed`
 * (the ONE decision) — NOT a new resolver: a MANAGED identity is org-controlled
 * and a MANAGED_UNRESOLVED identity fails closed, so BOTH are denied a Personal
 * action. Throws MANAGED_IDENTITY_NO_PERSONAL_SPACE (403) BEFORE any mutation so
 * Personal Evidence is never created/finalized/deleted/transferred on denial.
 * Callers MUST invoke this only when the action targets Personal scope
 * (teamId null / the caller's own personal Team); TEAM-scoped actions are
 * unaffected. Dormant (all STANDARD) until the identity-mode migration applies.
 */
export async function assertPersonalSpaceAllowed(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const eligibility = await resolvePersonalSpaceEligibility(userId, client);
  if (eligibility.allowed) return;
  // POINT 7 — the two denials are distinguishable on the wire. They are
  // different facts about the tenant and the operator remediates them
  // differently: one is an identity binding, the other is a policy switch.
  if (eligibility.reason === "ORG_POLICY") {
    throw modeError(
      "ORG_POLICY_NO_PERSONAL_SPACE",
      "This organization does not permit a personal workspace for its members.",
    );
  }
  throw modeError(
    "MANAGED_IDENTITY_NO_PERSONAL_SPACE",
    "Managed enterprise identities do not have a personal workspace; the organization controls this identity's data lifecycle.",
  );
}

/**
 * §13.2/correction 2 — only a STANDARD identity may perform PERSONAL data
 * export. A MANAGED identity is org-controlled; a MANAGED_UNRESOLVED identity
 * fails closed. Throws MANAGED_IDENTITY_NO_PERSONAL_EXPORT (403) otherwise.
 */
export async function assertPersonalExportAllowed(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  if ((await resolveManagedIdentity(userId, client)).state !== "STANDARD") {
    throw modeError(
      "MANAGED_IDENTITY_NO_PERSONAL_EXPORT",
      "Managed enterprise identities cannot export personal data; the organization controls data lifecycle.",
    );
  }
}
