/**
 * IDP REAUTHENTICATION STEP-UP — the Enterprise half of the authenticator
 * ladder (Collaboration Team archive, 2026-10-28).
 *
 * CONTRACT (consumed by step-up.service.ts; implemented here):
 *   - `resolveIdpStepUpConnection` — the ACTIVE SSO connection of the
 *     workspace's Organization that this user is linked to (an external
 *     identity mapping, never a SCIM token), or null.
 *   - `sessionSatisfiesIdpStepUp` — the CURRENT session was authenticated at
 *     that connection within the policy's max age, and its recorded
 *     authentication context is one the policy accepts (a non-empty accepted
 *     list is required for this shortcut). Null otherwise.
 *   - `idpStepUpBindingStillValid` — at spend time: the connection is still
 *     ACTIVE and the user still linked to it.
 *
 * WHAT "LINKED" MEANS HERE
 * ---------------------------------------------------------------------------
 * The SAML ACS and the OIDC callback resolve an IdP subject to a person through
 * ONE table: `ExternalIdentityMapping`, keyed (Organization, provider,
 * external subject). A connection authenticates as its own `provider`, so a
 * person is linked to a connection when they hold an UNLINKED-free mapping in
 * the connection's Organization under the connection's provider.
 *
 * SCIM never authenticates. SCIM writes its mappings under `GENERIC_SCIM`, and
 * a connection whose provider is `GENERIC_SCIM` is not a sign-in connection —
 * both are excluded explicitly, so a SCIM-provisioned person with no SSO link
 * has no IdP rung on the ladder, and a SCIM token can never stand in for one.
 */
import type { PrismaClient } from "@prisma/client";

import { organizationIdForPolicy } from "../identity/org-security-policy.service.js";

export type IdpStepUpPolicy = {
  acceptedContexts: ReadonlyArray<string>;
  maxAgeSeconds: number;
  assurance: "STANDARD" | "PHISHING_RESISTANT";
};

/** Allowed clock skew between this service and the IdP. */
export const IDP_STEP_UP_CLOCK_SKEW_SECONDS = 60;

/** The provider a SCIM directory writes under — never a sign-in. */
const SCIM_PROVIDER = "GENERIC_SCIM";

export type IdpStepUpProtocol = "SAML" | "OIDC";

/**
 * The protocol a connection signs in with, or null when it cannot complete a
 * forced reauthentication round trip (a SCIM connection, or a connection whose
 * protocol configuration is incomplete). Never offered when null.
 */
export function idpStepUpProtocolOf(conn: {
  provider: string;
  samlSsoUrl: string | null;
  samlCertificate: string | null;
  issuerUrl: string | null;
  clientId: string | null;
}): IdpStepUpProtocol | null {
  if (conn.provider === SCIM_PROVIDER) return null;
  if (conn.provider === "GENERIC_SAML") {
    return conn.samlSsoUrl && conn.samlCertificate ? "SAML" : null;
  }
  return conn.issuerUrl && conn.clientId ? "OIDC" : null;
}

const CONNECTION_SELECT = {
  id: true,
  organizationId: true,
  provider: true,
  status: true,
  samlSsoUrl: true,
  samlCertificate: true,
  issuerUrl: true,
  clientId: true,
} as const;

/** Does this person hold an active (not unlinked) link under this connection? */
export async function userLinkedToConnection(
  client: PrismaClient,
  input: { userId: string; organizationId: string; provider: string },
): Promise<boolean> {
  if (input.provider === SCIM_PROVIDER) return false;
  const count = await client.externalIdentityMapping.count({
    where: {
      userId: input.userId,
      organizationId: input.organizationId,
      provider: input.provider as never,
      unlinkedAtUtc: null,
    },
  });
  return count > 0;
}

/**
 * The person an IdP subject resolves to under a connection, through the SAME
 * mapping the sign-in paths use — or null when the subject is not linked (or
 * its link is quarantined). Never JIT-provisions, never creates a link.
 */
export async function resolveLinkedUserForSubject(
  client: PrismaClient,
  input: { organizationId: string; provider: string; externalSubjectId: string },
): Promise<string | null> {
  if (input.provider === SCIM_PROVIDER) return null;
  const mapping = await client.externalIdentityMapping.findUnique({
    where: {
      organizationId_provider_externalSubjectId: {
        organizationId: input.organizationId,
        provider: input.provider as never,
        externalSubjectId: input.externalSubjectId,
      },
    },
    select: { userId: true, unlinkedAtUtc: true },
  });
  if (!mapping || mapping.unlinkedAtUtc !== null) return null;
  return mapping.userId;
}

export async function resolveIdpStepUpConnection(
  client: PrismaClient,
  input: { userId: string; teamId: string },
): Promise<{ connectionId: string; protocol: "SAML" | "OIDC" } | null> {
  // Only a CUSTOMER Organization owns sign-in connections that may answer.
  const organizationId = await organizationIdForPolicy(input.teamId, client);
  if (!organizationId) return null;
  // Under PHISHING_RESISTANT an IdP reauthentication counts only when its
  // asserted context is one the Organization listed. With no list it can
  // never be proven, so the rung is not offered at all (fail closed, and the
  // person is told what they CAN use instead of being sent on a round trip
  // that must be refused). Read from the ONE policy row.
  const policyRow = await client.organizationSecurityPolicy.findUnique({
    where: { organizationId },
    select: { stepUpAssurance: true, idpStepUpAcceptedContexts: true },
  });
  if (
    policyRow &&
    policyRow.stepUpAssurance !== "STANDARD" &&
    (policyRow.idpStepUpAcceptedContexts ?? []).length === 0
  ) {
    return null;
  }
  const connections = await client.ssoConnection.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
      provider: { not: SCIM_PROVIDER as never },
    },
    select: CONNECTION_SELECT,
    orderBy: { createdAt: "asc" },
  });
  const candidates: Array<{ connectionId: string; protocol: IdpStepUpProtocol }> = [];
  for (const conn of connections) {
    const protocol = idpStepUpProtocolOf(conn);
    if (!protocol) continue;
    if (
      !(await userLinkedToConnection(client, {
        userId: input.userId,
        organizationId,
        provider: conn.provider,
      }))
    ) {
      continue;
    }
    candidates.push({ connectionId: conn.id, protocol });
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  // Prefer the connection this person actually signs in with: the one their
  // most recent SSO session came through.
  const recent = await client.authenticatedSession.findFirst({
    where: {
      userId: input.userId,
      ssoConnectionId: { in: candidates.map((c) => c.connectionId) },
    },
    orderBy: { issuedAtUtc: "desc" },
    select: { ssoConnectionId: true },
  });
  return candidates.find((c) => c.connectionId === recent?.ssoConnectionId) ?? candidates[0]!;
}

export async function sessionSatisfiesIdpStepUp(
  client: PrismaClient,
  input: { sessionIdHash: string | null; userId: string; connectionId: string; policy: IdpStepUpPolicy },
): Promise<{ authnContext: string } | null> {
  // Without an accepted list the policy has not said which context is enough,
  // so only a FORCED fresh sign-in may answer — never a session's history.
  if (!input.sessionIdHash || input.policy.acceptedContexts.length === 0) return null;
  const session = await client.authenticatedSession.findFirst({
    where: {
      userId: input.userId,
      sessionIdHash: input.sessionIdHash,
      revokedAtUtc: null,
      expiresAtUtc: { gt: new Date() },
    },
    select: {
      authMethod: true,
      ssoConnectionId: true,
      authnContext: true,
      idpAuthAtUtc: true,
    },
  });
  if (!session) return null;
  if (session.authMethod !== "SAML" && session.authMethod !== "OIDC") return null;
  if (session.ssoConnectionId !== input.connectionId) return null;
  if (!session.authnContext || !session.idpAuthAtUtc) return null;
  if (!idpAuthInstantWithinAge(session.idpAuthAtUtc, input.policy.maxAgeSeconds, Date.now())) {
    return null;
  }
  if (!input.policy.acceptedContexts.includes(session.authnContext)) return null;
  // The connection and the link must still stand, exactly as at spend time.
  if (!(await idpStepUpBindingStillValid(client, { userId: input.userId, connectionId: input.connectionId }))) {
    return null;
  }
  return { authnContext: session.authnContext };
}

export async function idpStepUpBindingStillValid(
  client: PrismaClient,
  input: { userId: string; connectionId: string },
): Promise<boolean> {
  const conn = await client.ssoConnection.findUnique({
    where: { id: input.connectionId },
    select: CONNECTION_SELECT,
  });
  if (!conn || conn.status !== "ACTIVE" || idpStepUpProtocolOf(conn) === null) return false;
  return userLinkedToConnection(client, {
    userId: input.userId,
    organizationId: conn.organizationId,
    provider: conn.provider,
  });
}

/**
 * Is an IdP authentication instant recent enough? Not in the future beyond the
 * allowed skew, and no older than the policy's maximum age.
 */
export function idpAuthInstantWithinAge(at: Date, maxAgeSeconds: number, nowMs: number): boolean {
  const t = at.getTime();
  if (!Number.isFinite(t)) return false;
  if (t > nowMs + IDP_STEP_UP_CLOCK_SKEW_SECONDS * 1000) return false;
  return nowMs - t <= maxAgeSeconds * 1000;
}
