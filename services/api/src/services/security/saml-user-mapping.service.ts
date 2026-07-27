/**
 * saml-user-mapping.service.ts
 *
 * Phase R8.2 — Real SAML Service Provider Activation
 *
 * Bridges a validated SamlAssertion to the internal User + ExternalIdentityMapping
 * model. Follows the same pattern as handleOidcCallback in sso.service.ts:
 *
 *   1. Extract email and display name from the assertion (using attribute mapping).
 *   2. Apply the allowed-email-domains gate.
 *   3. Look up ExternalIdentityMapping by (provider, externalSubjectId).
 *   4. If no mapping:
 *        a. Find or create the User by email.
 *        b. Evaluate JIT provisioning policy.
 *        c. Create ExternalIdentityMapping + upsert TeamMember.
 *   5. Emit saml_jit_provisioned / saml_user_linked / saml_jit_denied events.
 *   6. Return the internal user id, email, and provisioning metadata.
 *
 * Hard rules:
 *  - JIT provisioning ALWAYS goes through ExternalIdentityMapping so that
 *    table is the canonical subject-to-user pointer for SAML identities.
 *  - Email domain gating is enforced regardless of JIT configuration.
 *  - No raw NameID, email, or assertion content is ever logged.
 *  - This module has no knowledge of the HTTP layer or session minting.
 */

import type { PrismaClient } from "@prisma/client";

import {
  emailMatchesAllowedDomains,
  evaluateJitProvisioning,
  type JitProvisioningPolicy,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";
import type { SamlAssertion } from "./saml-assertion.service.js";
// P0 remediation (2026-07-21) — canonical guard for linking an IdP-asserted
// email to a PRE-EXISTING User (cross-tenant account-takeover fix).
import { evaluateExistingAccountLink } from "./enterprise-account-linking.service.js";
// PHASE 3 (2026-07-21) — canonical membership orchestrator.
import { provisionMembership } from "../identity/membership-provisioning.service.js";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type SamlMappingErrorCode =
  | "SAML_EMAIL_MISSING"
  | "SAML_EMAIL_DOMAIN_NOT_ALLOWED"
  | "SAML_JIT_DISABLED"
  | "SAML_CONNECTION_NOT_FOUND"
  | "SAML_CONNECTION_INACTIVE"
  // P0 remediation (2026-07-21) — unsafe existing-account link denial.
  | "SAML_ACCOUNT_LINK_DENIED";

export class SamlMappingError extends Error {
  constructor(
    public readonly code: SamlMappingErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "SamlMappingError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Optional operator-supplied attribute name mapping.
 * Sourced from SsoConnection.samlAttributeMapping (JSON field).
 */
export type SamlAttributeMapping = {
  /** Attribute name that contains the user's email. */
  email?: string | null;
  /** Attribute name that contains the user's display name. */
  name?: string | null;
  /**
   * Attribute name to use as the external subject ID (falls back to NameID).
   * Useful when the IdP uses an opaque NameID but provides a stable
   * user identifier as an attribute.
   */
  externalId?: string | null;
};

export type HandleSamlAssertionInput = {
  teamId: string;
  connectionId: string;
  provider: string; // ExternalIdentityProvider enum value (e.g. "GENERIC_SAML")
  assertion: SamlAssertion;
  allowedEmailDomains: string[];
  jitDefaultRole: string | null;
  attributeMapping?: SamlAttributeMapping | null;
  /**
   * R8.2.1 — JIT policy hardening.
   *
   * When true, this team is managed via SCIM and JIT provisioning is
   * disabled unconditionally — even if `jitDefaultRole` is set. Admins
   * must manage membership exclusively through SCIM. This prevents
   * shadow accounts from SAML logins that bypass SCIM lifecycle events.
   *
   * Sourced from `SsoConnection.samlScimManaged`.
   */
  scimManaged?: boolean;
};

export type HandleSamlAssertionResult = {
  userId: string;
  email: string;
  displayName: string | null;
  isNewlyProvisioned: boolean;
  role: "MEMBER" | "VIEWER";
};

// ---------------------------------------------------------------------------
// Attribute extraction helpers
// ---------------------------------------------------------------------------

/**
 * R8.2.1 — Hardened email attribute name list.
 *
 * Ordered from most-specific to most-generic. The resolver stops at
 * the first attribute name that yields a non-empty value. Covers:
 *   - Okta: "email", "mail"
 *   - Entra ID (Azure AD): WS-Fed URN email + UPN claim, "EmailAddress"
 *   - Google Workspace: "email", "Email"
 *   - OpenLDAP/LDAP federations: "mail", RFC 2798 OID (eduPerson)
 *
 * Custom operator mapping (SsoConnection.samlAttributeMapping.email)
 * takes priority over this list — see resolveEmail().
 */
const EMAIL_ATTR_NAMES = [
  // Short-form names (Okta, Google Workspace, generic)
  "email",
  "mail",
  "emailAddress",
  "EmailAddress",
  // Entra ID (Azure AD) WS-Fed email claim
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  // Entra ID UPN (user@tenant.onmicrosoft.com — often the login email)
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  "http://schemas.microsoft.com/identity/claims/userprincipalname",
  // Entra ID NameId-as-UPN alternative
  "userPrincipalName",
  // Google Workspace SAML claim
  "urn:oasis:names:tc:SAML:attribute:email",
  // RFC 2798 / eduPerson mail OID (used by universities + Shibboleth)
  "urn:oid:0.9.2342.19200300.100.1.3",
  // eduPerson principal name (eppn) — typically user@institution.edu
  "urn:oid:1.3.6.1.4.1.5923.1.1.1.6",
];

/**
 * R8.2.1 — Hardened display name attribute list.
 *
 * Covers Okta, Entra ID, Google Workspace, and generic LDAP federations.
 */
const NAME_ATTR_NAMES = [
  // Common short-form names
  "displayName",
  "cn",
  "name",
  "commonName",
  // Entra ID / WS-Fed display name
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  "http://schemas.microsoft.com/identity/claims/displayname",
  // Entra ID given name (first name; better than nothing)
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  // RFC 2798 displayName OID
  "urn:oid:2.16.840.1.113730.3.1.241",
  // LDAP commonName OID
  "urn:oid:2.5.4.3",
];

/**
 * Resolves the user's email from the assertion.
 *
 * Priority:
 *  1. Custom attribute name from attributeMapping.email
 *  2. NameID if it has an email format
 *  3. Well-known email attribute names (EMAIL_ATTR_NAMES)
 */
function resolveEmail(
  assertion: SamlAssertion,
  mapping: SamlAttributeMapping | null | undefined,
): string | null {
  const attrs = assertion.attributes;

  // 1. Custom attribute name
  if (mapping?.email) {
    const vals = attrs[mapping.email];
    if (vals?.[0]) return vals[0].toLowerCase().trim();
  }

  // 2. NameID if email format
  const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
  const UPN_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:WindowsDomainQualifiedName";
  if (
    assertion.nameIdFormat === EMAIL_FORMAT ||
    assertion.nameIdFormat === UPN_FORMAT ||
    assertion.nameId.includes("@")
  ) {
    return assertion.nameId.toLowerCase().trim();
  }

  // 3. Well-known attribute names
  for (const attrName of EMAIL_ATTR_NAMES) {
    const vals = attrs[attrName];
    if (vals?.[0]) return vals[0].toLowerCase().trim();
  }

  return null;
}

/**
 * Resolves the display name from the assertion.
 */
function resolveDisplayName(
  assertion: SamlAssertion,
  mapping: SamlAttributeMapping | null | undefined,
): string | null {
  const attrs = assertion.attributes;

  // 1. Custom attribute name
  if (mapping?.name) {
    const vals = attrs[mapping.name];
    if (vals?.[0]) return vals[0].trim();
  }

  // 2. Well-known name attributes
  for (const attrName of NAME_ATTR_NAMES) {
    const vals = attrs[attrName];
    if (vals?.[0]) return vals[0].trim();
  }

  return null;
}

/**
 * Resolves the external subject ID used as the ExternalIdentityMapping key.
 * Falls back to the NameID value.
 */
function resolveExternalSubjectId(
  assertion: SamlAssertion,
  mapping: SamlAttributeMapping | null | undefined,
): string {
  const attrs = assertion.attributes;

  if (mapping?.externalId) {
    const vals = attrs[mapping.externalId];
    if (vals?.[0]) return vals[0].trim();
  }

  return assertion.nameId;
}

// ---------------------------------------------------------------------------
// handleSamlAssertion
// ---------------------------------------------------------------------------

/**
 * Maps a validated SAML assertion to an internal User record.
 *
 * On first login (no ExternalIdentityMapping exists):
 *   - Evaluates JIT provisioning policy.
 *   - Finds or creates the User by email.
 *   - Creates ExternalIdentityMapping.
 *   - Upserts TeamMember.
 *
 * On repeat login:
 *   - Looks up the ExternalIdentityMapping to find the user.
 *   - Emits saml_user_linked event.
 *
 * @throws {SamlMappingError} if email cannot be resolved, domain is not
 *   allowed, or JIT is disabled.
 */
export async function handleSamlAssertion(
  input: HandleSamlAssertionInput,
  client: PrismaClient = defaultPrisma,
): Promise<HandleSamlAssertionResult> {
  const { teamId, connectionId, provider, assertion, attributeMapping } = input;

  // -------------------------------------------------------------------------
  // Resolve email and display name
  // -------------------------------------------------------------------------
  // P0 remediation (2026-07-21) — normalize the asserted email exactly like
  // registration / SSO / SCIM do (trim + lowercase). Without this, an IdP
  // asserting a different casing than the stored (lowercased) account
  // silently created a DUPLICATE User instead of matching the existing one.
  const email =
    resolveEmail(assertion, attributeMapping ?? null)?.trim().toLowerCase() ??
    null;
  if (!email || !email.includes("@")) {
    // R8.2.1 — Attribute mapping failure: IdP did not return a mappable email.
    // Emit the new hardening event so operators can diagnose attribute name mismatches.
    bump("saml_attribute_mapping_failure_total");
    safeEmitSecurityEvent({
      teamId,
      eventType: "saml_attribute_mapping_failed",
      severity: "WARNING",
      details: {
        connectionId,
        reason: "no_email_attribute",
        nameIdHash: assertion.nameIdHash,
        // Expose the attribute key names present (NOT their values) so operators
        // can see what the IdP sent and configure the correct mapping.
        attributeKeysPresent: Object.keys(assertion.attributes).slice(0, 20),
      },
    });
    throw new SamlMappingError("SAML_EMAIL_MISSING", { connectionId });
  }

  const displayName = resolveDisplayName(assertion, attributeMapping ?? null);
  const externalSubjectId = resolveExternalSubjectId(
    assertion,
    attributeMapping ?? null,
  );

  // -------------------------------------------------------------------------
  // Email domain gating
  // -------------------------------------------------------------------------
  if (!emailMatchesAllowedDomains(email, input.allowedEmailDomains)) {
    bump("saml_login_failure_total");
    safeEmitSecurityEvent({
      teamId,
      eventType: "saml_login_failed",
      severity: "WARNING",
      details: {
        connectionId,
        reason: "email_domain_not_allowed",
        nameIdHash: assertion.nameIdHash,
      },
    });
    throw new SamlMappingError("SAML_EMAIL_DOMAIN_NOT_ALLOWED", {
      connectionId,
    });
  }

  // -------------------------------------------------------------------------
  // Look up existing ExternalIdentityMapping
  // -------------------------------------------------------------------------
  const externalMapping = await client.externalIdentityMapping.findUnique({
    where: {
      provider_externalSubjectId: {
        provider: provider as never,
        externalSubjectId: externalSubjectId,
      },
    },
  });

  let userId: string;
  let isNewlyProvisioned = false;
  let role: "MEMBER" | "VIEWER" = "MEMBER";

  if (externalMapping) {
    // PHASE 8 §11.1 (2026-07-22) — REPEAT LOGIN MUST NOT BYPASS THE
    // LINKING GUARD. The mapping is keyed globally by
    // (provider, externalSubjectId), so a mapping created under a
    // DIFFERENT connection/team — or a pre-remediation mapping that no
    // longer satisfies policy — would otherwise authorize its user
    // straight into THIS connection. Re-validate the stored mapping
    // against the current connection before trusting it, and QUARANTINE
    // (soft-unlink) any mapping that fails so it can never authorize
    // again without an explicit operator re-link. The email-domain gate
    // above already re-ran; here we bind team + quarantine state.
    const revalidationFailure =
      externalMapping.unlinkedAtUtc !== null
        ? "mapping_quarantined"
        : externalMapping.teamId !== teamId
          ? "connection_team_mismatch"
          : null;
    if (revalidationFailure) {
      if (externalMapping.unlinkedAtUtc === null) {
        await client.externalIdentityMapping.update({
          where: { id: externalMapping.id },
          data: { unlinkedAtUtc: new Date() },
        });
      }
      bump("saml_login_failure_total");
      safeEmitSecurityEvent({
        teamId,
        eventType: "saml_mapping_quarantined",
        severity: "WARNING",
        details: {
          connectionId,
          reason: revalidationFailure,
          mappingTeamId: externalMapping.teamId,
          nameIdHash: assertion.nameIdHash,
        },
      });
      throw new SamlMappingError("SAML_ACCOUNT_LINK_DENIED", {
        connectionId,
        reason: revalidationFailure,
      });
    }

    // Repeat login — user already linked and revalidated.
    userId = externalMapping.userId;

    safeEmitSecurityEvent({
      teamId,
      eventType: "saml_user_linked",
      severity: "INFO",
      details: {
        connectionId,
        userId,
        nameIdHash: assertion.nameIdHash,
      },
    });
  } else {
    // -----------------------------------------------------------------------
    // JIT provisioning path
    // -----------------------------------------------------------------------

    // R8.2.1 — SCIM-managed JIT gate. If this team is SCIM-managed, JIT
    // provisioning is unconditionally disabled to prevent shadow accounts
    // from bypassing the SCIM lifecycle. Operators must manage membership
    // exclusively through SCIM.
    if (input.scimManaged) {
      bump("saml_jit_policy_denied_total");
      safeEmitSecurityEvent({
        teamId,
        eventType: "saml_jit_policy_denied",
        severity: "WARNING",
        details: {
          connectionId,
          reason: "scim_managed_org",
          nameIdHash: assertion.nameIdHash,
        },
      });
      throw new SamlMappingError("SAML_JIT_DISABLED", {
        connectionId,
        reason: "scim_managed_org_disables_jit",
      });
    }

    const jitPolicy: JitProvisioningPolicy = {
      enabled: !!input.jitDefaultRole,
      defaultRole:
        input.jitDefaultRole === "MEMBER" || input.jitDefaultRole === "VIEWER"
          ? input.jitDefaultRole
          : null,
      allowedEmailDomains: input.allowedEmailDomains,
    };
    const jitDecision = evaluateJitProvisioning(jitPolicy, email);

    if (!jitDecision.ok) {
      bump("saml_jit_denied_total");
      safeEmitSecurityEvent({
        teamId,
        eventType: "saml_jit_denied",
        severity: "WARNING",
        details: {
          connectionId,
          reason: jitDecision.reason,
          nameIdHash: assertion.nameIdHash,
        },
      });
      throw new SamlMappingError("SAML_JIT_DISABLED", {
        connectionId,
        reason: jitDecision.reason,
      });
    }

    role = jitDecision.role;

    // Find or create User by email (normalized lowercase — see above).
    const existingUser = await client.user.findFirst({
      where: { email: email },
      select: { id: true },
    });

    if (existingUser) {
      // P0 remediation (2026-07-21) — linking an IdP-asserted email to a
      // PRE-EXISTING account requires the domain to be DNS-verified by
      // exactly this connection's own organization (globally-unique
      // claim). Otherwise any tenant-controlled IdP could assert an
      // arbitrary existing user's email and mint a session as them.
      // Fail closed; never fall through to creating a duplicate account.
      const link = await evaluateExistingAccountLink(
        { teamId, email },
        client,
      );
      if (!link.ok) {
        bump("saml_login_failure_total");
        safeEmitSecurityEvent({
          teamId,
          eventType: "saml_login_failed",
          severity: "HIGH",
          details: {
            connectionId,
            reason: `unsafe_account_link:${link.reason}`,
            nameIdHash: assertion.nameIdHash,
          },
        });
        throw new SamlMappingError("SAML_ACCOUNT_LINK_DENIED", {
          connectionId,
          reason: link.reason,
        });
      }
      userId = existingUser.id;
    } else {
      const created = await client.user.create({
        data: {
          email,
          provider: "EMAIL",
          providerUserId: `saml-${externalSubjectId}`,
        },
        select: { id: true },
      });
      userId = created.id;
      isNewlyProvisioned = true;
    }

    // Create ExternalIdentityMapping
    await client.externalIdentityMapping.create({
      data: {
        teamId,
        userId,
        provider: provider as never,
        externalSubjectId,
        displayName: displayName ?? null,
        externalEmail: email,
      },
    });

    // PHASE 3 (2026-07-21) — canonical orchestrator: SSO_JIT intent.
    // `preserveExistingStatus` — a SAML login never silently reactivates a
    // SUSPENDED/REVOKED member; the grant provenance is recorded either way.
    await provisionMembership(client, {
      intent: "SSO_JIT",
      source: "SSO_JIT",
      userId,
      workspace: {
        teamId,
        role: role === "VIEWER" ? "VIEWER" : "MEMBER",
      },
      actorUserId: null, // self-provisioned via IdP assertion
      externalRef: `saml:${provider}:${externalSubjectId}`.slice(0, 200),
      accessReason: `SAML JIT (${provider})`,
      preserveExistingStatus: true,
    });

    bump("saml_jit_provisioned_total");
    safeEmitSecurityEvent({
      teamId,
      eventType: "saml_jit_provisioned",
      severity: "INFO",
      details: {
        connectionId,
        userId,
        role,
        nameIdHash: assertion.nameIdHash,
        isNewlyProvisioned,
      },
    });
  }

  return {
    userId,
    email,
    displayName: displayName ?? null,
    isNewlyProvisioned,
    role,
  };
}
