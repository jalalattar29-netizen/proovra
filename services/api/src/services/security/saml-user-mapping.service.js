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
import { emailMatchesAllowedDomains, evaluateJitProvisioning, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";
export class SamlMappingError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "SamlMappingError";
    }
}
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
function resolveEmail(assertion, mapping) {
    const attrs = assertion.attributes;
    // 1. Custom attribute name
    if (mapping?.email) {
        const vals = attrs[mapping.email];
        if (vals?.[0])
            return vals[0].toLowerCase().trim();
    }
    // 2. NameID if email format
    const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
    const UPN_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:WindowsDomainQualifiedName";
    if (assertion.nameIdFormat === EMAIL_FORMAT ||
        assertion.nameIdFormat === UPN_FORMAT ||
        assertion.nameId.includes("@")) {
        return assertion.nameId.toLowerCase().trim();
    }
    // 3. Well-known attribute names
    for (const attrName of EMAIL_ATTR_NAMES) {
        const vals = attrs[attrName];
        if (vals?.[0])
            return vals[0].toLowerCase().trim();
    }
    return null;
}
/**
 * Resolves the display name from the assertion.
 */
function resolveDisplayName(assertion, mapping) {
    const attrs = assertion.attributes;
    // 1. Custom attribute name
    if (mapping?.name) {
        const vals = attrs[mapping.name];
        if (vals?.[0])
            return vals[0].trim();
    }
    // 2. Well-known name attributes
    for (const attrName of NAME_ATTR_NAMES) {
        const vals = attrs[attrName];
        if (vals?.[0])
            return vals[0].trim();
    }
    return null;
}
/**
 * Resolves the external subject ID used as the ExternalIdentityMapping key.
 * Falls back to the NameID value.
 */
function resolveExternalSubjectId(assertion, mapping) {
    const attrs = assertion.attributes;
    if (mapping?.externalId) {
        const vals = attrs[mapping.externalId];
        if (vals?.[0])
            return vals[0].trim();
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
export async function handleSamlAssertion(input, client = defaultPrisma) {
    const { teamId, connectionId, provider, assertion, attributeMapping } = input;
    // -------------------------------------------------------------------------
    // Resolve email and display name
    // -------------------------------------------------------------------------
    const email = resolveEmail(assertion, attributeMapping ?? null);
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
    const externalSubjectId = resolveExternalSubjectId(assertion, attributeMapping ?? null);
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
                provider: provider,
                externalSubjectId: externalSubjectId,
            },
        },
    });
    let userId;
    let isNewlyProvisioned = false;
    let role = "MEMBER";
    if (externalMapping) {
        // Repeat login — user already linked
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
    }
    else {
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
        const jitPolicy = {
            enabled: !!input.jitDefaultRole,
            defaultRole: input.jitDefaultRole === "MEMBER" || input.jitDefaultRole === "VIEWER"
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
        // Find or create User by email
        const existingUser = await client.user.findFirst({
            where: { email: email },
            select: { id: true },
        });
        if (existingUser) {
            userId = existingUser.id;
        }
        else {
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
                provider: provider,
                externalSubjectId,
                displayName: displayName ?? null,
                externalEmail: email,
            },
        });
        // Upsert TeamMember (idempotent)
        await client.teamMember.upsert({
            where: { teamId_userId: { teamId, userId } },
            update: {},
            create: {
                teamId,
                userId,
                role: role === "VIEWER" ? "VIEWER" : "MEMBER",
                status: "ACTIVE",
                accessGrantedByUserId: userId, // self-provisioned
                accessReason: `SAML JIT (${provider})`,
            },
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
