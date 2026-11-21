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

import { createHash } from "node:crypto";

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
// PRO-A2-02 (WS-ORG RG-06; owner decision A, 2026-11-21) — A STORED LINK IS
// RE-CHECKED WHERE IT IS USED.
//
// An Organization identity link (ExternalIdentityMapping) lets the
// Organization's IdP sign in AS the linked account, approve that account's IdP
// step-up, and resolve it as a directory group member. For an account the
// Organization's own directory or IdP created that is the point of the link.
// For a PRE-EXISTING SELF-SERVE account only the owner's own signed-in consent
// (organization-link-consent.service.ts) may establish it: an administrator's
// manual link is not consent. Every reader of a mapping (OIDC and SAML sign-in,
// IdP step-up, the directory's reach) asks this ONE predicate before trusting
// it.
//
//   - Organization-originated account → honoured (directory / managed
//     identities are the Organization's own; no consent is involved)
//   - self-serve account → honoured only when ALL hold:
//       * the link carries linkSource OWNER_CONSENT (an administrator-made,
//         JIT/SCIM-made or pre-column link never does);
//       * the person is an ACTIVE member of the Organization now (no
//         suspended, removed, left or expired membership);
//       * a LIVE consent row (identity_link_consents) exists for exactly this
//         Organization, provider and subject (and connection, when the reader
//         knows it), approved after every membership deadline that has passed.
//
// CONSENT LIFETIME. Consent is ended — never deleted, never revived — when the
// owner withdraws it, when any of the person's memberships in the Organization
// is suspended, revoked (left / removed), deleted, or has a lapsed access window
// reopened (database triggers, migration 20281123010000), and it is read as
// ended once a membership deadline passed after the approval. A reactivation or
// a rejoin therefore needs a fresh owner approval. Consent rows are written by
// the owner-approval flow only: grants and link sources written before this
// rule prove nothing (the owner approves once more). Nothing is unlinked and no
// session is ended by a refusal (DEC-08: refusal at use time only).
//
// Fails closed: unreadable provenance is a refusal.
// -----------------------------------------------------------------------------
// (The OWNER sees and withdraws their consents on the stepped-up account
// routes GET/POST /v1/identity/links/organization-consents[/:id/withdraw].)

export const OWNER_CONSENT_LINK_SOURCE = "OWNER_CONSENT";
export const ADMIN_MANUAL_LINK_SOURCE = "ADMIN_MANUAL";
export const ORGANIZATION_LINK_GRANT_PREFIX = "org-link:";
const ORGANIZATION_LINK_SUBJECT_MARK = ":sub-";

export type IdentityLinkConsentEndReason =
  | "WITHDRAWN"
  | "SUPERSEDED"
  | "MEMBERSHIP_SUSPENDED"
  | "MEMBERSHIP_ENDED"
  | "MEMBERSHIP_EXPIRED";

/** The subject tag a consent grant carries (a digest: a subject can be an address). */
export function organizationLinkSubjectTag(externalSubjectId: string): string {
  return createHash("sha256").update(externalSubjectId, "utf8").digest("hex").slice(0, 32);
}

/** The full subject digest a consent row is bound to. */
export function organizationLinkSubjectDigest(externalSubjectId: string): string {
  return createHash("sha256").update(externalSubjectId, "utf8").digest("hex");
}

/**
 * The membership-grant reference the owner-consent flow writes: bound to the
 * provider, the connection AND the subject the owner approved. Provenance on
 * the membership only; since decision A it is NOT consent evidence (the
 * consent row is).
 */
export function organizationLinkConsentRef(input: {
  provider: string;
  connectionId: string;
  externalSubjectId: string;
}): string {
  return `${ORGANIZATION_LINK_GRANT_PREFIX}${input.provider}:${input.connectionId}${ORGANIZATION_LINK_SUBJECT_MARK}${organizationLinkSubjectTag(input.externalSubjectId)}`;
}

/**
 * REPORTING ONLY (the legacy-link remediation command). Does the person hold a
 * pre-decision consent GRANT for this provider and subject? Neither answer is
 * consent: since decision A only a live identity_link_consents row is.
 */
export async function findOwnerConsentEvidence(
  input: { userId: string; organizationId: string; provider: string; externalSubjectId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ bound: boolean; unbound: boolean }> {
  const memberships = await client.teamMember.findMany({
    where: { userId: input.userId, team: { organizationId: input.organizationId } },
    select: { id: true },
  });
  if (memberships.length === 0) return { bound: false, unbound: false };
  const providerPrefix = `${ORGANIZATION_LINK_GRANT_PREFIX}${input.provider}:`;
  const grants = await client.membershipGrant.findMany({
    where: {
      teamMemberId: { in: memberships.map((m) => m.id) },
      externalRef: { startsWith: providerPrefix },
    },
    select: { externalRef: true, revokedAtUtc: true },
  });
  const suffix = `${ORGANIZATION_LINK_SUBJECT_MARK}${organizationLinkSubjectTag(input.externalSubjectId)}`;
  let bound = false;
  let unbound = false;
  for (const grant of grants) {
    const ref = grant.externalRef ?? "";
    if (!ref.includes(ORGANIZATION_LINK_SUBJECT_MARK)) unbound = true;
    else if (ref.endsWith(suffix) && grant.revokedAtUtc === null) bound = true;
  }
  return { bound, unbound };
}

/**
 * Is the person an ACTIVE member of the Organization right now? The governance
 * membership decides when one exists (a suspended, removed or expired one is
 * not active whatever a workspace row still says); a person the consent flow
 * joined to a workspace only is active while a live, unexpired workspace
 * membership is.
 */
export async function holdsActiveOrganizationMembership(
  input: { userId: string; organizationId: string },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const governance = await client.organizationMembership.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId },
    select: { status: true, validUntilUtc: true },
  });
  if (governance) {
    if (governance.status !== "ACTIVE") return false;
    if (governance.validUntilUtc && governance.validUntilUtc.getTime() <= Date.now()) return false;
  }
  const workspace = await client.teamMember.findFirst({
    where: {
      userId: input.userId,
      status: "ACTIVE",
      team: { organizationId: input.organizationId, closedAtUtc: null },
      OR: [{ accessExpiresAtUtc: null }, { accessExpiresAtUtc: { gt: new Date() } }],
    },
    select: { id: true },
  });
  if (workspace) return true;
  // A governance-only member (no workspace assignment) is still a member.
  return governance !== null;
}

/**
 * The owner's CURRENT consent for exactly this link, or null. Live (never
 * ended), bound to the Organization, provider and subject (and the connection
 * when the reader names it), and approved after every membership deadline that
 * has since passed: a window that lapsed after the approval ended the consent
 * even if nobody wrote anything when it lapsed.
 */
export async function findCurrentOwnerConsent(
  input: {
    userId: string;
    organizationId: string;
    provider: string;
    externalSubjectId: string;
    connectionId?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string; approvedAtUtc: Date; connectionId: string } | null> {
  const consent = await client.identityLinkConsent.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      provider: input.provider,
      subjectDigest: organizationLinkSubjectDigest(input.externalSubjectId),
      endedAtUtc: null,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    },
    orderBy: { approvedAtUtc: "desc" },
    select: { id: true, approvedAtUtc: true, connectionId: true },
  });
  if (!consent) return null;
  const lapsedWindow = { gt: consent.approvedAtUtc, lte: new Date() };
  const [lapsedGovernance, lapsedWorkspace] = await Promise.all([
    client.organizationMembership.findFirst({
      where: { organizationId: input.organizationId, userId: input.userId, validUntilUtc: lapsedWindow },
      select: { id: true },
    }),
    client.teamMember.findFirst({
      where: {
        userId: input.userId,
        team: { organizationId: input.organizationId },
        accessExpiresAtUtc: lapsedWindow,
      },
      select: { id: true },
    }),
  ]);
  if (lapsedGovernance || lapsedWorkspace) return null;
  return consent;
}

export type ExternalLinkAuthority =
  | { honoured: true; basis: "ORGANIZATION_ORIGINATED" | "OWNER_CONSENT" }
  | {
      honoured: false;
      /**
       * self_serve_link_without_owner_consent — no current owner consent
       *   (never given, legacy, withdrawn, or ended by a suspension, departure
       *   or lapse the person has since returned from): the owner may approve
       *   afresh.
       * owner_consent_membership_ended — the person is not an active member:
       *   approving again cannot help until they are a member again.
       */
      reason: "self_serve_link_without_owner_consent" | "owner_consent_membership_ended";
    };

export async function evaluateExternalLinkAuthority(
  input: {
    userId: string;
    organizationId: string;
    provider: string;
    /** The link's own subject: the consent must name it. */
    externalSubjectId: string;
    linkSource: string | null | undefined;
    /** The connection the IdP answered through, when the reader knows it. */
    connectionId?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<ExternalLinkAuthority> {
  if (!(await isSelfServeAccountForOrganization(input, client))) {
    return { honoured: true, basis: "ORGANIZATION_ORIGINATED" };
  }
  if (input.linkSource !== OWNER_CONSENT_LINK_SOURCE) {
    return { honoured: false, reason: "self_serve_link_without_owner_consent" };
  }
  if (!(await holdsActiveOrganizationMembership(input, client))) {
    return { honoured: false, reason: "owner_consent_membership_ended" };
  }
  if (!(await findCurrentOwnerConsent(input, client))) {
    return { honoured: false, reason: "self_serve_link_without_owner_consent" };
  }
  return { honoured: true, basis: "OWNER_CONSENT" };
}

/**
 * THE DIRECTORY'S REACH (PRO-A2-02 / PRO-014 / PRO-030). May this
 * Organization's directory act on the person (change a role or a status, name
 * them in a group)? An allow-list, never "anything but a known-bad source":
 *
 *   - an account the Organization's directory or IdP created, holding a link
 *     in the Organization (`includeEnded`: a link the directory already ended
 *     still counts, so a repeated deactivation or a reactivation works);
 *   - a self-serve account with at least one LIVE link the canonical predicate
 *     above honours (the owner's current, subject-bound consent; active member).
 *
 * Anyone else — a pre-column or administrator-made link on a self-serve
 * account included — is outside the directory's reach.
 */
export async function isWithinDirectoryReach(
  input: { userId: string; organizationId: string; includeEnded?: boolean },
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const any = await client.externalIdentityMapping.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      ...(input.includeEnded === true ? {} : { unlinkedAtUtc: null }),
    },
    select: { id: true },
  });
  if (!any) return false;
  if (!(await isSelfServeAccountForOrganization(input, client))) return true;
  const live = await client.externalIdentityMapping.findMany({
    where: { organizationId: input.organizationId, userId: input.userId, unlinkedAtUtc: null },
    select: { provider: true, externalSubjectId: true, linkSource: true },
  });
  for (const link of live) {
    const authority = await evaluateExternalLinkAuthority(
      {
        userId: input.userId,
        organizationId: input.organizationId,
        provider: String(link.provider),
        externalSubjectId: link.externalSubjectId,
        linkSource: link.linkSource,
      },
      client,
    );
    if (authority.honoured) return true;
  }
  return false;
}
