/**
 * B5B-F-302 — THE OWNER LINKS THEIR OWN ACCOUNT TO AN ORGANIZATION.
 *
 * An enterprise sign-in (OIDC or SAML) whose verified email belongs to a
 * PRE-EXISTING SELF-SERVE account is no longer linked to it on the strength of
 * the Organization's verified domain. The sign-in is refused with
 * `SSO_ACCOUNT_LINK_REQUIRES_CONSENT`, no session is minted, nothing is
 * written, and the browser receives a short-lived, signed, httpOnly link ticket
 * naming exactly what the IdP proved (connection, Organization, subject,
 * address) and the account that address belongs to.
 *
 * The owner then signs in to THEIR OWN account the way they always do, and
 * approves the link on the existing login-methods surface
 * (`POST /v1/identity/links/organization`, identity-links.routes.ts), with the
 * same account step-up every other login-method link requires. Approval writes
 * exactly two things, in one transaction under the seat authority:
 *
 *   1. the Organization's identity mapping for that subject → this account, so
 *      the next sign-in through that connection lands in this account;
 *   2. an ordinary workspace membership (SSO_JIT provenance, the role the
 *      connection's JIT grants; a suspended or removed membership stays so).
 *
 * It NEVER converts the account to a managed identity: no `setManagedIdentity`
 * call is made here, and `completeSsoSession` / `provisionManagedMembership`
 * refuse to bind a self-serve account later. The owner keeps their Personal
 * Space and their personal data export.
 *
 * The ticket is not a JWT: it is a two-segment HMAC envelope under a key
 * derived for this purpose only, so it can never be presented as a session.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";

import { prisma as defaultPrisma } from "../../db.js";
import { getSecret } from "../../config/runtime-secrets.js";
import { isProovraProductionRequest } from "../../http/cors-origin-policy.js";
import { withSeatClaimRetry } from "../billing/workspace-seats.service.js";
import {
  holdsActiveOrganizationMembership,
  organizationLinkConsentRef,
  organizationLinkSubjectDigest,
} from "../security/enterprise-account-linking.service.js";
import { isAccountClosed } from "./account-closed.js";
import { provisionMembership } from "./membership-provisioning.service.js";

export const ACCOUNT_LINK_REQUIRES_CONSENT = "SSO_ACCOUNT_LINK_REQUIRES_CONSENT";
export const ORGANIZATION_LINK_COOKIE = "proovra_org_link";
export const ORGANIZATION_LINK_TTL_SECONDS = 15 * 60;

/** What a verified enterprise sign-in proved, held until the owner decides. */
export type PendingOrganizationLink = {
  connectionId: string;
  organizationId: string;
  /** The connection's workspace (where the membership is granted). */
  teamId: string;
  /** ExternalIdentityProvider value of the connection (GENERIC_OIDC, GENERIC_SAML, …). */
  provider: string;
  protocol: "OIDC" | "SAML";
  subject: string;
  email: string;
  displayName: string | null;
  /** The pre-existing account the address belongs to. */
  userId: string;
  role: "MEMBER" | "VIEWER";
  /*
   * What the owner is shown before approving, captured when the IdP flow
   * (which already holds the connection's Organization) refused the sign-in
   * and SIGNED into the ticket — so the approval page reads no Organization
   * row on the strength of a cookie. Approval re-validates everything.
   */
  organizationName: string | null;
  organizationRestrictsPersonalSpace: boolean;
};

/** The display facts a pending link carries (see PendingOrganizationLink). */
export async function organizationDisplayForLink(
  organizationId: string,
  client: PrismaClient = defaultPrisma,
): Promise<Pick<PendingOrganizationLink, "organizationName" | "organizationRestrictsPersonalSpace">> {
  const [org, policy] = await Promise.all([
    client.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
    client.organizationSecurityPolicy.findFirst({ where: { organizationId }, select: { noPersonalSpace: true } }),
  ]);
  return {
    organizationName: org?.name ?? null,
    organizationRestrictsPersonalSpace: policy?.noPersonalSpace === true,
  };
}

type TicketPayload = PendingOrganizationLink & {
  v: 1;
  typ: "org_link";
  iat: number;
  exp: number;
};

function ticketKey(): Buffer {
  const secret = getSecret("AUTH_JWT_SECRET");
  if (!secret) throw new Error("organization_link_secret_unavailable");
  // Domain-separated: the session-signing secret is never used directly.
  return createHmac("sha256", secret).update("proovra/org-link-ticket/v1").digest();
}

function mac(payloadB64: string): string {
  return createHmac("sha256", ticketKey()).update(`org-link.v1.${payloadB64}`).digest("base64url");
}

export function signOrganizationLinkTicket(
  pending: PendingOrganizationLink,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload: TicketPayload = {
    ...pending,
    v: 1,
    typ: "org_link",
    iat: nowSeconds,
    exp: nowSeconds + ORGANIZATION_LINK_TTL_SECONDS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${mac(payloadB64)}`;
}

/** The pending link a ticket carries, or null when it is forged, malformed or expired. */
export function verifyOrganizationLinkTicket(
  ticket: string | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): PendingOrganizationLink | null {
  if (!ticket || typeof ticket !== "string" || ticket.length > 4096) return null;
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts as [string, string];
  let expected: string;
  try {
    expected = mac(payloadB64);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as TicketPayload;
  } catch {
    return null;
  }
  if (payload?.v !== 1 || payload.typ !== "org_link") return null;
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
  // An explicit projection: only the link's own fields leave, never the
  // envelope (v, typ, iat, exp) or anything else a payload might carry.
  return {
    connectionId: payload.connectionId,
    organizationId: payload.organizationId,
    teamId: payload.teamId,
    provider: payload.provider,
    protocol: payload.protocol,
    subject: payload.subject,
    email: payload.email,
    displayName: payload.displayName,
    userId: payload.userId,
    role: payload.role,
    organizationName: payload.organizationName ?? null,
    organizationRestrictsPersonalSpace: payload.organizationRestrictsPersonalSpace === true,
  };
}

function cookieShape(req: FastifyRequest) {
  const host = req.headers["host"] ?? "";
  const origin = req.headers["origin"] ?? "";
  const domain =
    process.env["SSO_COOKIE_DOMAIN"] ||
    (isProovraProductionRequest(String(host), String(origin)) ? ".proovra.com" : undefined);
  const secure = process.env["SSO_COOKIE_SECURE"] === "true" || !!domain;
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/", domain };
}

/** Hand the browser the pending link (never a session). */
export function setOrganizationLinkCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  pending: PendingOrganizationLink,
): void {
  reply.setCookie(ORGANIZATION_LINK_COOKIE, signOrganizationLinkTicket(pending), {
    ...cookieShape(req),
    maxAge: ORGANIZATION_LINK_TTL_SECONDS,
  });
}

export function clearOrganizationLinkCookie(req: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(ORGANIZATION_LINK_COOKIE, cookieShape(req));
}

export function readOrganizationLinkCookie(req: FastifyRequest): PendingOrganizationLink | null {
  const cookies = (req as unknown as { cookies?: Record<string, string | undefined> }).cookies;
  return verifyOrganizationLinkTicket(cookies?.[ORGANIZATION_LINK_COOKIE]);
}

export type OrganizationLinkOutcome =
  | { kind: "ok"; organizationId: string; teamId: string; alreadyLinked: boolean }
  /** The ticket names a different account than the one signed in. */
  | { kind: "account_mismatch" }
  /** The signed-in account no longer holds, or never proved, the address the IdP asserted. */
  | { kind: "email_mismatch" }
  | { kind: "account_closed" }
  /** The connection or its Organization is no longer active. */
  | { kind: "connection_unavailable" }
  /** The IdP subject is already linked to a different account. */
  | { kind: "identity_linked_elsewhere" }
  | { kind: "seat_limit_reached" }
  | { kind: "seat_contention" }
  /**
   * PRO-A2-02 (decision A) — the person is not an active member of the
   * Organization (suspended, removed, left, expired). A consent recorded now
   * would come alive on a later reactivation without a fresh approval, so the
   * whole approval is rolled back: nothing is written.
   */
  | { kind: "membership_inactive" };

class LinkedElsewhereError extends Error {}
class MembershipInactiveError extends Error {}

/**
 * Approve a pending organization link for the SIGNED-IN owner. The caller has
 * already verified the account step-up. Never converts the account.
 */
export async function approveOrganizationLink(
  input: { userId: string; pending: PendingOrganizationLink },
  client: PrismaClient = defaultPrisma,
): Promise<OrganizationLinkOutcome> {
  const { userId, pending } = input;
  if (pending.userId !== userId) return { kind: "account_mismatch" };

  const user = await client.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerifiedAt: true },
  });
  if (
    !user?.email ||
    !user.emailVerifiedAt ||
    user.email.trim().toLowerCase() !== pending.email.trim().toLowerCase()
  ) {
    return { kind: "email_mismatch" };
  }
  if (await isAccountClosed(userId, client)) return { kind: "account_closed" };

  const conn = await client.ssoConnection.findUnique({
    where: { id: pending.connectionId },
    select: {
      status: true,
      teamId: true,
      provider: true,
      team: { select: { organizationId: true, closedAtUtc: true, organization: { select: { status: true, name: true } } } },
    },
  });
  if (
    !conn ||
    conn.status !== "ACTIVE" ||
    conn.teamId !== pending.teamId ||
    String(conn.provider) !== pending.provider ||
    conn.team?.organizationId !== pending.organizationId ||
    conn.team.closedAtUtc !== null ||
    conn.team.organization?.status !== "ACTIVE"
  ) {
    return { kind: "connection_unavailable" };
  }

  let alreadyLinked = false;
  try {
    await withSeatClaimRetry(() =>
      client.$transaction(async (tx) => {
        alreadyLinked = false;
        const key = {
          organizationId: pending.organizationId,
          provider: pending.provider as never,
          externalSubjectId: pending.subject,
        };
        const existing = await tx.externalIdentityMapping.findUnique({
          where: { organizationId_provider_externalSubjectId: key },
          select: { id: true, userId: true, unlinkedAtUtc: true },
        });
        if (existing && existing.userId !== userId) throw new LinkedElsewhereError();
        let mappingId: string;
        if (existing) {
          mappingId = existing.id;
          alreadyLinked = existing.unlinkedAtUtc === null;
          // The owner re-approves a link that was ended (re-link it), or
          // confirms one that exists: either way it now carries the owner's
          // consent (PRO-A2-02 — readers honour a self-serve link only so).
          await tx.externalIdentityMapping.update({
            where: { id: existing.id },
            data: alreadyLinked
              ? { linkSource: "OWNER_CONSENT" }
              : { unlinkedAtUtc: null, externalEmail: pending.email, linkSource: "OWNER_CONSENT" },
          });
        } else {
          const created = await tx.externalIdentityMapping.create({
            data: {
              teamId: pending.teamId,
              organizationId: pending.organizationId,
              userId,
              provider: pending.provider as never,
              externalSubjectId: pending.subject,
              displayName: pending.displayName,
              externalEmail: pending.email,
              linkSource: "OWNER_CONSENT",
            },
            select: { id: true },
          });
          mappingId = created.id;
        }
        // An ordinary membership — the same grant a JIT sign-in makes. A
        // suspended or removed membership stays as an administrator left it.
        await provisionMembership(tx as never, {
          intent: "SSO_JIT",
          source: "SSO_JIT",
          userId,
          workspace: { teamId: pending.teamId, role: pending.role === "VIEWER" ? "VIEWER" : "MEMBER" },
          actorUserId: userId,
          // PRO-A2-02 — the consent evidence names the SUBJECT the owner
          // approved, not only the provider and connection.
          externalRef: organizationLinkConsentRef({
            provider: pending.provider,
            connectionId: pending.connectionId,
            externalSubjectId: pending.subject,
          }).slice(0, 200),
          accessReason: `Account owner approved ${pending.protocol} organization link`,
          preserveExistingStatus: true,
        });
        // PRO-A2-02 (decision A) — consent is recorded only for an ACTIVE
        // member: approval never revives a suspended, removed or expired
        // membership, and a consent written beside one would come alive on its
        // reactivation without a fresh approval.
        if (!(await holdsActiveOrganizationMembership({ userId, organizationId: pending.organizationId }, tx as never))) {
          throw new MembershipInactiveError();
        }
        // THE consent record: bound to this Organization, connection, provider
        // and subject. An earlier live consent for the same link is ended as
        // SUPERSEDED (history is kept). Membership triggers end it later.
        const subjectDigest = organizationLinkSubjectDigest(pending.subject);
        const now = new Date();
        await tx.identityLinkConsent.updateMany({
          where: {
            organizationId: pending.organizationId,
            userId,
            provider: pending.provider,
            subjectDigest,
            endedAtUtc: null,
          },
          data: { endedAtUtc: now, endReason: "SUPERSEDED", endedByUserId: userId },
        });
        await tx.identityLinkConsent.create({
          data: {
            organizationId: pending.organizationId,
            userId,
            provider: pending.provider,
            subjectDigest,
            connectionId: pending.connectionId,
            externalIdentityMappingId: mappingId,
            organizationName: conn.team?.organization?.name?.slice(0, 200) ?? null,
            approvedAtUtc: now,
          },
        });
      }),
    );
  } catch (err) {
    if (err instanceof MembershipInactiveError) return { kind: "membership_inactive" };
    if (err instanceof LinkedElsewhereError) return { kind: "identity_linked_elsewhere" };
    if ((err as { code?: string })?.code === "P2002") return { kind: "identity_linked_elsewhere" };
    const code = (err as { code?: string })?.code;
    if (code === "MANAGED_SEAT_LIMIT_REACHED") return { kind: "seat_limit_reached" };
    if (code === "WORKSPACE_SEAT_CONTENTION") return { kind: "seat_contention" };
    throw err;
  }
  return {
    kind: "ok",
    organizationId: pending.organizationId,
    teamId: pending.teamId,
    alreadyLinked,
  };
}

// -----------------------------------------------------------------------------
// PRO-A2-02 (owner decision A) — THE OWNER SEES AND WITHDRAWS THEIR CONSENT.
//
// Both are account-tier and bound to the signed-in owner's own user id: there
// is no parameter naming another person, so an Organization administrator (or
// anybody else) can neither read nor end someone else's consent through them.
// Withdrawal ENDS the live consent rows (ended_at_utc, end_reason WITHDRAWN,
// ended_by_user_id = the owner); nothing is deleted, the Organization's mapping
// row is kept as history and simply no longer honoured, the membership is not
// touched, and no session is ended (DEC-08).
// -----------------------------------------------------------------------------

export type OrganizationLinkConsentView = {
  id: string;
  organizationId: string;
  organizationName: string | null;
  provider: string;
  connectionId: string;
  approvedAtUtc: string;
  endedAtUtc: string | null;
  endReason: string | null;
};

const CONSENT_LIST_LIMIT = 50;

/** The signed-in owner's consents (live first, then the most recent ended ones). */
export async function listOrganizationLinkConsents(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<OrganizationLinkConsentView[]> {
  const rows = await client.identityLinkConsent.findMany({
    where: { userId },
    orderBy: [{ approvedAtUtc: "desc" }],
    take: CONSENT_LIST_LIMIT,
    select: {
      id: true,
      organizationId: true,
      provider: true,
      connectionId: true,
      organizationName: true,
      approvedAtUtc: true,
      endedAtUtc: true,
      endReason: true,
    },
  });
  // The name recorded at approval: this account-tier read touches no
  // Organization row.
  const views = rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    organizationName: r.organizationName,
    provider: r.provider,
    connectionId: r.connectionId,
    approvedAtUtc: r.approvedAtUtc.toISOString(),
    endedAtUtc: r.endedAtUtc ? r.endedAtUtc.toISOString() : null,
    endReason: r.endReason,
  }));
  // Live consents first; order otherwise kept (newest approval first).
  return [...views.filter((v) => v.endedAtUtc === null), ...views.filter((v) => v.endedAtUtc !== null)];
}

/**
 * The owner withdraws every live IdP-link consent they gave `organizationId`.
 * Returns how many were ended (0: there was none of THEIRS to withdraw).
 */
export async function withdrawOrganizationLinkConsent(
  input: { userId: string; organizationId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ withdrawn: number }> {
  const r = await client.identityLinkConsent.updateMany({
    where: { userId: input.userId, organizationId: input.organizationId, endedAtUtc: null },
    data: { endedAtUtc: new Date(), endReason: "WITHDRAWN", endedByUserId: input.userId },
  });
  return { withdrawn: r.count };
}
