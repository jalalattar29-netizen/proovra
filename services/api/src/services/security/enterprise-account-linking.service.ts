/**
 * P0 REMEDIATION (2026-07-21) — Enterprise account-linking safety.
 *
 * THE canonical guard for the highest-severity enterprise-identity risk
 * (CT1): an enterprise IdP (SAML / OIDC / SCIM) asserting an email that
 * already belongs to an EXISTING global User must NEVER be silently linked
 * to (and a session minted for) that account unless the linkage is
 * administratively safe. Without this guard, any customer who self-
 * configures a JIT-enabled SSO connection on their own enterprise
 * workspace can assert `victim@othercompany.com` and take over the
 * victim's account platform-wide.
 *
 * Canonical rule (fail-closed):
 *
 *   Linking an IdP-asserted email to a PRE-EXISTING User is allowed ONLY
 *   when the email's domain is
 *     (a) DNS-verified by the ORGANIZATION that owns the SSO/SCIM
 *         connection's workspace, AND
 *     (b) verified by NO OTHER organization (a globally-unique claim —
 *         two tenants both "owning" a domain is an unresolved conflict
 *         and must fail closed until an operator resolves it).
 *
 *   IDENT-013 / PRO-025 (2026-11-04) — creating a BRAND-NEW User through
 *   OIDC JIT, SAML JIT or SCIM is held to the SAME rule: a new row for an
 *   address the Organization has not proved was a pre-account takeover (the
 *   Organization kept signing in to it ahead of the address's real owner).
 *   Each creation site calls this function before it creates the row.
 *
 * Every decision (allow and deny) is observable: callers emit the
 * security event; this service returns a bounded reason code and never
 * throws for policy denials.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  domainFromEmail,
  normalizeDomain,
} from "../organization/organization-domain.service.js";

export type ExistingAccountLinkDenialReason =
  | "email_invalid"
  | "workspace_not_found"
  | "domain_not_verified_for_org"
  | "domain_claim_conflict";

export type ExistingAccountLinkDecision =
  | { ok: true; organizationId: string; domain: string }
  | { ok: false; reason: ExistingAccountLinkDenialReason };

/**
 * Decide whether an enterprise identity flow on `teamId`'s connection may
 * link the asserted `email` to a pre-existing User account.
 *
 * Pure policy over injected client state — unit-testable with a fake
 * Prisma client. Fail-closed on every unresolvable input.
 */
export async function evaluateExistingAccountLink(
  input: { teamId: string; email: string },
  client: PrismaClient = defaultPrisma,
): Promise<ExistingAccountLinkDecision> {
  const rawDomain = domainFromEmail(input.email);
  const domain = rawDomain ? normalizeDomain(rawDomain) : null;
  if (!domain) return { ok: false, reason: "email_invalid" };

  const team = await client.team.findUnique({
    where: { id: input.teamId },
    select: { organizationId: true },
  });
  if (!team?.organizationId) {
    return { ok: false, reason: "workspace_not_found" };
  }

  // Every organization holding a VERIFIED claim on this domain. One query
  // answers both questions: does OUR org hold it, and does anyone else.
  const claims = await client.organizationDomain.findMany({
    where: { domain, verifiedAt: { not: null } },
    select: { organizationId: true },
  });

  const ours = claims.some((c) => c.organizationId === team.organizationId);
  if (!ours) return { ok: false, reason: "domain_not_verified_for_org" };

  const foreign = claims.some(
    (c) => c.organizationId !== team.organizationId,
  );
  if (foreign) return { ok: false, reason: "domain_claim_conflict" };

  return { ok: true, organizationId: team.organizationId, domain };
}

// -----------------------------------------------------------------------------
// B5B-F-302 — WHO CREATED THIS ACCOUNT?
//
// A verified domain proves the Organization controls the ADDRESS. It does not
// prove the Organization created, or may take over, an ACCOUNT somebody opened
// for themselves at that address: a self-serve account holds a Personal Space,
// personal evidence and a personal export right that a managed conversion
// removes. Domain proof alone therefore never links or converts an existing
// account. Only an account THIS Organization's own directory or IdP created is
// the Organization's to link (an IdP-first sign-in followed by a directory push,
// or the reverse).
//
// Provenance comes from the synthetic provider id each creation site writes in
// the same transaction as the account row (and nothing else writes):
//   scim-<organizationId>:<subject>   SCIM create            (scim.service.ts)
//   sso-<organizationId>:<subject>    OIDC JIT create        (sso.service.ts)
//   saml-<organizationId>:<subject>   SAML JIT create        (saml-user-mapping)
// Rows created before DOM-13 (2026-10-25) carry `<kind>-<subject>` with no
// Organization; they count only when this Organization holds a mapping for
// that exact subject on this account, linked within minutes of the account's
// creation (the creation and the link were one write). An EMAIL row whose
// provider id is its own address, a Google/Apple row, or another
// Organization's synthetic id is a PRE-EXISTING SELF-SERVE account here.
// -----------------------------------------------------------------------------

const SYNTHETIC_PROVIDER_ID = /^(scim|sso|saml)-(.+)$/;
const ORGANIZATION_SCOPED_SUBJECT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:/i;
/** A pre-DOM-13 creation wrote the account and its mapping together. */
const LEGACY_LINK_WINDOW_MS = 10 * 60 * 1000;

export type AccountOrigin =
  | { kind: "ORGANIZATION_ORIGINATED"; via: "scim" | "sso" | "saml"; legacy: boolean }
  | { kind: "SELF_SERVE" };

/**
 * Was `userId` created by `organizationId`'s own directory (SCIM) or IdP
 * (OIDC / SAML JIT)? Returns null when the account does not exist.
 */
export async function resolveAccountOriginForOrganization(
  input: { userId: string; organizationId: string },
  client: PrismaClient = defaultPrisma,
): Promise<AccountOrigin | null> {
  const user = await client.user.findUnique({
    where: { id: input.userId },
    select: { providerUserId: true, email: true, createdAt: true },
  });
  if (!user) return null;
  const providerUserId = user.providerUserId ?? "";
  // A self-serve EMAIL account's provider id is its own address — whatever
  // that address happens to start with.
  if (
    user.email &&
    providerUserId.toLowerCase() === user.email.trim().toLowerCase()
  ) {
    return { kind: "SELF_SERVE" };
  }
  const match = SYNTHETIC_PROVIDER_ID.exec(providerUserId);
  if (!match) return { kind: "SELF_SERVE" };
  const via = match[1] as "scim" | "sso" | "saml";
  const rest = match[2]!;
  if (rest.startsWith(`${input.organizationId}:`)) {
    return { kind: "ORGANIZATION_ORIGINATED", via, legacy: false };
  }
  // Another Organization's directory or IdP created it: not ours.
  if (ORGANIZATION_SCOPED_SUBJECT.test(rest)) return { kind: "SELF_SERVE" };
  // Legacy (pre-DOM-13) synthetic id: ours only if we hold the mapping that
  // minted it, written with the account.
  const mapping = await client.externalIdentityMapping.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      externalSubjectId: rest,
    },
    orderBy: { linkedAtUtc: "asc" },
    select: { linkedAtUtc: true },
  });
  if (
    mapping &&
    mapping.linkedAtUtc.getTime() - user.createdAt.getTime() <= LEGACY_LINK_WINDOW_MS
  ) {
    return { kind: "ORGANIZATION_ORIGINATED", via, legacy: true };
  }
  return { kind: "SELF_SERVE" };
}

/**
 * True when `userId` is a pre-existing self-serve account for this Organization
 * — i.e. NOT one its own directory or IdP created. Fails closed: an account
 * whose provenance cannot be read is never treated as the Organization's.
 */
export async function isSelfServeAccountForOrganization(
  input: { userId: string; organizationId: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const origin = await resolveAccountOriginForOrganization(input, client);
  return origin?.kind !== "ORGANIZATION_ORIGINATED";
}

// -----------------------------------------------------------------------------
// PRO-A2-02 (WS-ORG RG-06) — A STORED LINK IS RE-CHECKED WHERE IT IS USED.
//
// An Organization identity link (ExternalIdentityMapping) lets the
// Organization's IdP sign in AS the linked account, approve that account's IdP
// step-up, and resolve it as a directory group member. For an account the
// Organization's own directory or IdP created that is the point of the link.
// For a PRE-EXISTING SELF-SERVE account only the owner's own signed-in consent
// (organization-link-consent.service.ts) may establish it: an administrator's
// manual link is not consent. Every reader of a mapping asks this ONE
// predicate before trusting it.
//
//   - Organization-originated account                 → honoured
//   - linkSource OWNER_CONSENT                        → honoured
//   - linkSource NULL (written before the column):    honoured only with the
//     owner-consent evidence the consent flow wrote with it (a membership
//     grant whose externalRef is `org-link:<provider>:…` on a workspace of this
//     Organization). Never guessed: a legacy link without that evidence is
//     not honoured, and the owner can re-approve it through the consent flow.
//   - anything else (ADMIN_MANUAL, SCIM/JIT on a self-serve account) → refused
//
// Fails closed: unreadable provenance is a refusal.
// -----------------------------------------------------------------------------

export const OWNER_CONSENT_LINK_SOURCE = "OWNER_CONSENT";
export const ADMIN_MANUAL_LINK_SOURCE = "ADMIN_MANUAL";
export const ORGANIZATION_LINK_GRANT_PREFIX = "org-link:";

export type ExternalLinkAuthority =
  | { honoured: true; basis: "ORGANIZATION_ORIGINATED" | "OWNER_CONSENT" | "LEGACY_OWNER_CONSENT_EVIDENCE" }
  | { honoured: false; reason: "self_serve_link_without_owner_consent" };

export async function evaluateExternalLinkAuthority(
  input: {
    userId: string;
    organizationId: string;
    provider: string;
    linkSource: string | null | undefined;
  },
  client: PrismaClient = defaultPrisma,
): Promise<ExternalLinkAuthority> {
  if (!(await isSelfServeAccountForOrganization(input, client))) {
    return { honoured: true, basis: "ORGANIZATION_ORIGINATED" };
  }
  if (input.linkSource === OWNER_CONSENT_LINK_SOURCE) {
    return { honoured: true, basis: "OWNER_CONSENT" };
  }
  if (input.linkSource === null || input.linkSource === undefined) {
    const memberships = await client.teamMember.findMany({
      where: { userId: input.userId, team: { organizationId: input.organizationId } },
      select: { id: true },
    });
    const evidence =
      memberships.length > 0
        ? await client.membershipGrant.findFirst({
            where: {
              teamMemberId: { in: memberships.map((m) => m.id) },
              externalRef: { startsWith: `${ORGANIZATION_LINK_GRANT_PREFIX}${input.provider}:` },
            },
            select: { id: true },
          })
        : null;
    if (evidence) return { honoured: true, basis: "LEGACY_OWNER_CONSENT_EVIDENCE" };
  }
  return { honoured: false, reason: "self_serve_link_without_owner_consent" };
}
