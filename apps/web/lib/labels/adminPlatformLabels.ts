/**
 * PV-LANG-003 — product language for the stored identifiers the platform
 * admin console reads back (plans, providers, roles, workspace kinds, add-on
 * keys, job kinds). Each family whose members the generic reading would
 * misname keeps a short curated map here and falls back to `identifierLabel`
 * for any member added later, so a new stored value renders as words rather
 * than as the key. Families the generic reading already names correctly
 * (subscription/payment statuses, severities) call `identifierLabel` directly.
 */

import { identifierLabel } from "@proovra/shared";

function curated(map: Readonly<Record<string, string>>, value: string): string {
  return map[value] ?? identifierLabel(value);
}

const PLAN_LABELS: Readonly<Record<string, string>> = {
  FREE: "Free",
  PAYG: "Pay-as-you-go",
  PRO: "Pro",
  TEAM: "Team",
  ENTERPRISE: "Enterprise",
};

/** `PlanType` → the plan name a customer sees on the pricing page. */
export function planLabel(plan: string): string {
  return curated(PLAN_LABELS, plan);
}

const BILLING_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  STRIPE: "Stripe",
  PAYPAL: "PayPal",
};

/** `PaymentProvider` → the payment processor's own name. */
export function billingProviderLabel(provider: string): string {
  return curated(BILLING_PROVIDER_LABELS, provider);
}

const SIGN_IN_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  EMAIL: "Email and password",
  GOOGLE: "Google",
  APPLE: "Apple",
  GUEST: "Guest",
};

/** `AuthProvider` → how the person signs in. */
export function signInProviderLabel(provider: string): string {
  return curated(SIGN_IN_PROVIDER_LABELS, provider);
}

const SSO_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  GENERIC_SAML: "SAML",
  GENERIC_OIDC: "OpenID Connect",
  GENERIC_SCIM: "SCIM",
  OKTA: "Okta",
  AZURE_AD: "Microsoft Entra ID",
  GOOGLE_WORKSPACE: "Google Workspace",
};

/** `ExternalIdentityProvider` → the identity provider's product name. */
export function ssoProviderLabel(provider: string): string {
  return curated(SSO_PROVIDER_LABELS, provider);
}

const ORG_ROLE_LABELS: Readonly<Record<string, string>> = {
  ORG_OWNER: "Organization owner",
  ORG_ADMIN: "Organization admin",
  ORG_SECURITY_ADMIN: "Security admin",
  ORG_BILLING_ADMIN: "Billing admin",
  ORG_AUDITOR: "Auditor",
  ORG_MEMBER: "Member",
};

/** `OrganizationRole` → the role name, as the platform admin reads it. */
export function orgRoleLabel(role: string): string {
  return curated(ORG_ROLE_LABELS, role);
}

const WORKSPACE_KIND_LABELS: Readonly<Record<string, string>> = {
  PERSONAL: "Personal",
  OWNED: "Owned",
  ORGANIZATION: "Organization",
};

/** `WorkspaceKind` → the kind of workspace. */
export function workspaceKindLabel(kind: string): string {
  return curated(WORKSPACE_KIND_LABELS, kind);
}

/**
 * `OrganizationAuditEvent.eventType` ("ORG_MEMBER_INVITED") → "Member
 * invited". Every member of the family carries the `ORG_` namespace, which on
 * an organization's own activity list says nothing.
 */
export function orgAuditEventLabel(eventType: string): string {
  const stripped = eventType.replace(/^ORG_/, "");
  return identifierLabel(stripped || eventType);
}

const STORAGE_ADDON_LABELS: Readonly<Record<string, string>> = {
  PERSONAL_10_GB: "Personal 10 GB",
  PERSONAL_50_GB: "Personal 50 GB",
  PERSONAL_200_GB: "Personal 200 GB",
  TEAM_100_GB: "Team 100 GB",
  TEAM_500_GB: "Team 500 GB",
  TEAM_1_TB: "Team 1 TB",
};

/** `StorageAddonKey` → the add-on's name with its size unit intact. */
export function storageAddonLabel(addonKey: string): string {
  return curated(STORAGE_ADDON_LABELS, addonKey);
}

const BILLING_CYCLE_LABELS: Readonly<Record<string, string>> = {
  ONE_TIME: "One-time",
  MONTHLY: "Monthly",
};

/** `StorageAddonBillingCycle` → how often it is billed. */
export function billingCycleLabel(cycle: string): string {
  return curated(BILLING_CYCLE_LABELS, cycle);
}

const MEDIA_JOB_KIND_LABELS: Readonly<Record<string, string>> = {
  OCR: "Text recognition (OCR)",
  TRANSCRIPT: "Transcript",
  ENTITY_EXTRACTION: "Entity extraction",
  EMBEDDING: "Embedding",
  SIMILARITY: "Similarity",
};

/** `EvidenceIntelligenceJobKind` → what the job produces. */
export function mediaJobKindLabel(kind: string): string {
  return curated(MEDIA_JOB_KIND_LABELS, kind);
}

const SIGNER_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  aws_kms: "AWS KMS",
  local_pem: "Local key file (PEM)",
  disabled: "Disabled",
};

/** Signer provider key → where the signing key lives. */
export function signerProviderLabel(provider: string): string {
  return curated(SIGNER_PROVIDER_LABELS, provider);
}
