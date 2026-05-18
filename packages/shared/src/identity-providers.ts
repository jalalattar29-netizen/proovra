/**
 * Phase 26 — Enterprise identity provider (SSO + SCIM) canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). Holds:
 *   - SSO connection lifecycle states
 *   - SSO provider catalog (reuses the existing Phase 17
 *     ExternalIdentityProvider enum)
 *   - SCIM scope catalog
 *   - SCIM v2 User resource shape (operator-safe subset)
 *   - JIT provisioning policy
 *
 * Hard invariants:
 *   - Client secrets / SCIM tokens NEVER appear in any type here.
 *     The "preview" string is a display-only `ck-***-abcd` mask.
 *   - SCIM User payloads carry the operator-safe subset only:
 *     userName, displayName, active. Phone numbers / addresses are
 *     rejected at the route boundary.
 *   - Allowed-email-domains validation lives here (pure function).
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// SSO connection lifecycle
// -----------------------------------------------------------------------------

export const SSO_CONNECTION_STATUSES = [
  "PENDING",
  "ACTIVE",
  "DISABLED",
  "REVOKED",
] as const;
export const SsoConnectionStatusSchema = z.enum(SSO_CONNECTION_STATUSES);
export type SsoConnectionStatus = z.infer<typeof SsoConnectionStatusSchema>;

const SSO_CONNECTION_STATUS_TRANSITIONS: Readonly<
  Record<SsoConnectionStatus, ReadonlyArray<SsoConnectionStatus>>
> = {
  PENDING: ["ACTIVE", "DISABLED", "REVOKED"],
  ACTIVE: ["DISABLED", "REVOKED"],
  DISABLED: ["ACTIVE", "REVOKED"],
  REVOKED: [], // terminal
};

export function isAllowedSsoConnectionTransition(
  from: SsoConnectionStatus,
  to: SsoConnectionStatus,
): boolean {
  if (from === to) return true;
  return SSO_CONNECTION_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

// -----------------------------------------------------------------------------
// SSO providers — reuse the Phase 17 ExternalIdentityProvider enum.
// We keep a UI-facing label catalog so the admin UI never composes
// free-form provider names.
// -----------------------------------------------------------------------------

export const SSO_PROVIDERS = [
  "GENERIC_OIDC",
  "GENERIC_SAML",
  "GENERIC_SCIM",
  "OKTA",
  "AZURE_AD",
  "GOOGLE_WORKSPACE",
] as const;
export const SsoProviderSchema = z.enum(SSO_PROVIDERS);
export type SsoProvider = z.infer<typeof SsoProviderSchema>;

export const SSO_PROVIDER_LABELS: Record<SsoProvider, string> = {
  GENERIC_OIDC: "Generic OIDC",
  GENERIC_SAML: "Generic SAML",
  GENERIC_SCIM: "Generic SCIM",
  OKTA: "Okta",
  AZURE_AD: "Microsoft Entra ID (Azure AD)",
  GOOGLE_WORKSPACE: "Google Workspace",
};

export function ssoProviderLabel(p: SsoProvider): string {
  return SSO_PROVIDER_LABELS[p];
}

/**
 * Which protocol does a provider use? Phase 26 ships OIDC support for
 * Google Workspace + Generic OIDC + Okta + Azure AD. SAML is shape-only.
 */
export function ssoProviderProtocol(p: SsoProvider): "OIDC" | "SAML" | "SCIM" {
  switch (p) {
    case "GENERIC_SAML":
      return "SAML";
    case "GENERIC_SCIM":
      return "SCIM";
    default:
      return "OIDC";
  }
}

// -----------------------------------------------------------------------------
// SSO connection create input — validated by the admin route.
// -----------------------------------------------------------------------------

export const SsoConnectionCreateInputSchema = z
  .object({
    teamId: z.string().uuid(),
    provider: SsoProviderSchema,
    displayName: z.string().min(1).max(180),
    issuerUrl: z
      .string()
      .url()
      .max(400)
      .startsWith("https://", "issuer URL must use https")
      .optional(),
    clientId: z.string().min(1).max(180).optional(),
    clientSecret: z.string().min(8).max(400).optional(),
    samlMetadataJson: z.record(z.string(), z.unknown()).optional(),
    allowedEmailDomains: z
      .array(z.string().min(1).max(180))
      .max(40)
      .optional(),
    jitDefaultRole: z.enum(["MEMBER", "VIEWER"]).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const protocol = ssoProviderProtocol(input.provider);
    if (protocol === "OIDC") {
      if (!input.issuerUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["issuerUrl"],
          message: "OIDC connections require issuerUrl",
        });
      }
      if (!input.clientId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clientId"],
          message: "OIDC connections require clientId",
        });
      }
      if (!input.clientSecret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clientSecret"],
          message: "OIDC connections require clientSecret",
        });
      }
    } else if (protocol === "SAML") {
      if (!input.samlMetadataJson) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["samlMetadataJson"],
          message: "SAML connections require samlMetadataJson",
        });
      }
    }
  });
export type SsoConnectionCreateInput = z.infer<
  typeof SsoConnectionCreateInputSchema
>;

// -----------------------------------------------------------------------------
// Allowed-email-domains validation. Used by JIT provisioning + SCIM.
// -----------------------------------------------------------------------------

/**
 * Normalise a domain: lowercase, strip leading "@" or "*.".
 */
export function normaliseEmailDomain(raw: string): string {
  return raw.trim().replace(/^@/, "").replace(/^\*\./, "").toLowerCase();
}

export function emailMatchesAllowedDomains(
  email: string,
  domains: ReadonlyArray<string>,
): boolean {
  if (domains.length === 0) return true; // empty = any
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const ed = email.slice(at + 1).toLowerCase();
  for (const raw of domains) {
    const d = normaliseEmailDomain(raw);
    if (!d) continue;
    if (ed === d) return true;
    if (ed.endsWith("." + d)) return true; // subdomain ok
  }
  return false;
}

// -----------------------------------------------------------------------------
// SCIM v2 — operator-safe subset.
//
// We support the User resource. Group sync is out of scope for Phase 26
// (the brief allows deferral); the schema accepts a `userType` so the
// IdP can hint the role at JIT time.
// -----------------------------------------------------------------------------

export const SCIM_SCOPES = [
  "users.read",
  "users.write",
  "users.deactivate",
  "groups.read",
] as const;
export const ScimScopeSchema = z.enum(SCIM_SCOPES);
export type ScimScope = z.infer<typeof ScimScopeSchema>;

export const SCIM_TOKEN_PREFIX_LENGTH = 12;
export const SCIM_TOKEN_BYTES = 32;
export const SCIM_TOKEN_PREFIX = "scim_pat_";

export type ScimUserName = {
  formatted?: string;
  givenName?: string;
  familyName?: string;
};

export type ScimEmail = {
  value: string;
  primary?: boolean;
  type?: string;
};

export const ScimUserSchema = z
  .object({
    schemas: z
      .array(z.string())
      .nonempty()
      .refine(
        (arr) => arr.includes("urn:ietf:params:scim:schemas:core:2.0:User"),
        "schemas must include the SCIM 2.0 User schema",
      ),
    userName: z.string().min(1).max(320),
    name: z
      .object({
        formatted: z.string().max(180).optional(),
        givenName: z.string().max(180).optional(),
        familyName: z.string().max(180).optional(),
      })
      .optional(),
    displayName: z.string().max(180).optional(),
    active: z.boolean().default(true),
    emails: z
      .array(
        z.object({
          value: z.string().email().max(320),
          primary: z.boolean().optional(),
          type: z.string().max(40).optional(),
        }),
      )
      .min(1)
      .max(5),
    userType: z.enum(["MEMBER", "VIEWER", "REVIEWER"]).optional(),
    externalId: z.string().max(180).optional(),
  })
  .strict();
export type ScimUserInput = z.infer<typeof ScimUserSchema>;

export type ScimUserResource = {
  schemas: ReadonlyArray<string>;
  id: string;
  userName: string;
  displayName: string | null;
  active: boolean;
  emails: ReadonlyArray<ScimEmail>;
  externalId: string | null;
  meta: {
    resourceType: "User";
    created: string;
    lastModified: string;
    location: string;
  };
};

export const SCIM_USER_SCHEMA_URI =
  "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_LIST_RESPONSE_SCHEMA_URI =
  "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_ERROR_SCHEMA_URI =
  "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_PATCH_OP_SCHEMA_URI =
  "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export type ScimError = {
  schemas: [typeof SCIM_ERROR_SCHEMA_URI];
  status: string;
  scimType?: string;
  detail?: string;
};

export function scimError(
  status: number,
  detail: string,
  scimType?: string,
): ScimError {
  return {
    schemas: [SCIM_ERROR_SCHEMA_URI],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

// SCIM PatchOp — only `replace` on `active` supported in Phase 26
// (covers IdP-driven deactivation, the highest-value operation).
export const ScimPatchOpSchema = z
  .object({
    schemas: z
      .array(z.string())
      .nonempty()
      .refine(
        (arr) => arr.includes(SCIM_PATCH_OP_SCHEMA_URI),
        "schemas must include PatchOp",
      ),
    Operations: z
      .array(
        z.object({
          op: z.enum(["replace", "add", "remove"]),
          path: z.string().min(1).max(80),
          value: z.unknown().optional(),
        }),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type ScimPatchOpInput = z.infer<typeof ScimPatchOpSchema>;

// -----------------------------------------------------------------------------
// JIT provisioning — pure helper that decides whether the SSO callback
// can mint a new TeamMember on first login.
// -----------------------------------------------------------------------------

export type JitProvisioningPolicy = {
  enabled: boolean;
  defaultRole: "MEMBER" | "VIEWER" | null;
  allowedEmailDomains: ReadonlyArray<string>;
};

export type JitProvisioningDecision =
  | { ok: true; role: "MEMBER" | "VIEWER" }
  | { ok: false; reason: "JIT_DISABLED" | "EMAIL_DOMAIN_NOT_ALLOWED" };

export function evaluateJitProvisioning(
  policy: JitProvisioningPolicy,
  email: string,
): JitProvisioningDecision {
  if (!policy.enabled || !policy.defaultRole) {
    return { ok: false, reason: "JIT_DISABLED" };
  }
  if (!emailMatchesAllowedDomains(email, policy.allowedEmailDomains)) {
    return { ok: false, reason: "EMAIL_DOMAIN_NOT_ALLOWED" };
  }
  return { ok: true, role: policy.defaultRole };
}
