/**
 * PROOVRA Phase 2B Closure — External Reviewer Portal SSO federation.
 *
 * Binds the existing platform SAML primitives (saml-authn-request,
 * saml-assertion) to an external reviewer grant so the reviewer can
 * sign in with their organization's IdP instead of (or in addition
 * to) the raw portal token.
 *
 * Flow:
 *
 *   1. `startPortalSsoFlow` — operator-issued grant + SsoConnection
 *      → builds an HTTP-Redirect AuthnRequest. Returns the redirect
 *      URL and a bounded RelayState that encodes the grant id. We
 *      emit EXTERNAL_SSO_STARTED.
 *
 *   2. `completePortalSsoFlow` — the SP ACS receives the signed
 *      assertion. We:
 *
 *        * validate the assertion against the connection's pinned
 *          IdP cert (delegated to the existing saml-assertion service),
 *        * extract the NameID + email attribute,
 *        * verify the asserted email matches the grant's inviteEmail
 *          OR an entry in the role assignment's `allowedDomains`,
 *        * fail closed on mismatch (EXTERNAL_SSO_IDENTITY_MISMATCH +
 *          NOT_PERMITTED denial),
 *        * record the SSO subject hash on first bind,
 *        * verify subsequent binds match the recorded subject hash,
 *        * stamp the grant as ACTIVE and the role-assignment as
 *          SSO-bound,
 *        * emit EXTERNAL_SSO_SUCCEEDED.
 *
 * Hard rules:
 *   * Workspace-anchored at every step.
 *   * NEVER second identity system — we reuse SsoConnection,
 *     validateSamlResponse, and the existing custody/audit emitter.
 *   * Fail closed on any identity mismatch.
 *   * NEVER log raw NameID / raw assertion. We log `nameIdHash` only.
 *   * Bounded denial reasons.
 */

import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  type ExternalPortalDenialReason,
  type PortalAuthMethod,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { buildSamlAuthnRequest } from "../security/saml-authn-request.service.js";
import {
  SamlAssertionError,
  validateSamlResponse,
  type SamlAssertion,
} from "../security/saml-assertion.service.js";
import { transitionExternalReviewGrant } from "./external-review-grant.service.js";
import { emitPortalActivity } from "./portal-activity.service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StartPortalSsoInput = {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  /**
   * Override the SsoConnection — useful when the role assignment was
   * issued before SSO was federated. When NULL, we read
   * `role_assignment.ssoConnectionId`.
   */
  ssoConnectionIdOverride?: string;
  spEntityId: string;
  acsUrl: string;
  ip?: string | null;
  userAgent?: string | null;
};

export type StartPortalSsoResult =
  | {
      ok: true;
      redirectUrl: string;
      requestId: string;
      relayState: string;
      connectionId: string;
    }
  | { ok: false; denial: ExternalPortalDenialReason };

export type CompletePortalSsoInput = {
  prisma?: PrismaClient;
  /** Workspace id, derived from the grant on the way in. */
  teamId: string;
  grantId: string;
  samlResponseBase64: string;
  expectedInResponseTo: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type CompletePortalSsoResult =
  | {
      ok: true;
      grantId: string;
      ssoSubjectHash: string;
      authMethod: PortalAuthMethod;
      assertion: {
        nameIdHash: string;
        issuer: string;
        boundAtUtc: string;
      };
    }
  | {
      ok: false;
      denial: ExternalPortalDenialReason;
      /** Bounded SAML failure category from saml-assertion.service. */
      samlCategory?: string;
    };

// ---------------------------------------------------------------------------
// startPortalSsoFlow
// ---------------------------------------------------------------------------

export async function startPortalSsoFlow(
  input: StartPortalSsoInput,
): Promise<StartPortalSsoResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // 1. Load the grant and the role assignment, workspace-anchored.
  const role = await prisma.externalReviewerRoleAssignment.findFirst({
    where: { teamId: input.teamId, id: input.grantId },
    select: {
      id: true,
      ssoConnectionId: true,
      inviteEmail: true,
    },
  });
  if (!role) {
    return { ok: false, denial: "INVITE_NOT_FOUND" };
  }
  const connectionId = input.ssoConnectionIdOverride ?? role.ssoConnectionId;
  if (!connectionId) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }

  // 2. Resolve the SsoConnection — must be ACTIVE and SAML-shaped.
  const conn = await prisma.ssoConnection.findFirst({
    where: { id: connectionId, teamId: input.teamId, status: "ACTIVE" },
    select: {
      id: true,
      provider: true,
      samlSsoUrl: true,
      samlCertificate: true,
      samlNameIdFormat: true,
    },
  });
  if (!conn) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (!conn.samlSsoUrl || !conn.samlCertificate) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }

  // 3. Build the AuthnRequest. We encode the grant id into a bounded
  // RelayState payload so the ACS callback can correlate without
  // sticky sessions.
  const built = buildSamlAuthnRequest({
    connectionId: conn.id,
    spEntityId: input.spEntityId,
    acsUrl: input.acsUrl,
    idpSsoUrl: conn.samlSsoUrl,
    nameIdFormat: conn.samlNameIdFormat ?? undefined,
  });

  // 4. Persist the AuthnRequest correlation on a bounded session row —
  // for Phase 2B Closure we attach it to the role assignment by storing
  // it as a bounded activity payload. A future enterprise pass can
  // promote this to a real `external_review_sso_pending` table.
  await emitPortalActivity({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    code: "EXTERNAL_SSO_STARTED",
    ip: input.ip,
    userAgent: input.userAgent,
    payload: {
      connectionId: conn.id,
      requestId: built.requestId,
      relayState: built.relayState,
      acsUrl: input.acsUrl,
      spEntityId: input.spEntityId,
    },
  });

  return {
    ok: true,
    redirectUrl: built.redirectUrl,
    requestId: built.requestId,
    relayState: built.relayState,
    connectionId: conn.id,
  };
}

// ---------------------------------------------------------------------------
// completePortalSsoFlow
// ---------------------------------------------------------------------------

export async function completePortalSsoFlow(
  input: CompletePortalSsoInput,
): Promise<CompletePortalSsoResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // 1. Load the role assignment + the SsoConnection together.
  const role = await prisma.externalReviewerRoleAssignment.findFirst({
    where: { teamId: input.teamId, id: input.grantId },
    select: {
      id: true,
      teamId: true,
      ssoConnectionId: true,
      inviteEmail: true,
      externalEmail: true,
      allowedDomains: true,
      ssoSubjectHash: true,
    },
  });
  if (!role) {
    return { ok: false, denial: "INVITE_NOT_FOUND" };
  }
  const connectionId = role.ssoConnectionId;
  if (!connectionId) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const conn = await prisma.ssoConnection.findFirst({
    where: { id: connectionId, teamId: input.teamId, status: "ACTIVE" },
    select: {
      id: true,
      provider: true,
      samlEntityId: true,
      samlCertificate: true,
    },
  });
  if (!conn || !conn.samlCertificate || !conn.samlEntityId) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }

  // 2. Validate the SAML assertion using the existing service.
  let assertion: SamlAssertion;
  try {
    assertion = validateSamlResponse({
      samlResponseBase64: input.samlResponseBase64,
      idpCertificate: conn.samlCertificate,
      spEntityId: conn.samlEntityId,
      expectedInResponseTo: input.expectedInResponseTo,
    });
  } catch (err) {
    const code =
      err instanceof SamlAssertionError ? err.code : "SAML_PARSE_FAILED";
    await emitPortalActivity({
      prisma,
      teamId: input.teamId,
      grantId: input.grantId,
      code: "EXTERNAL_SSO_FAILED",
      ip: input.ip,
      userAgent: input.userAgent,
      payload: { samlCategory: code },
    });
    return {
      ok: false,
      denial: "POLICY_REJECTED",
      samlCategory: code,
    };
  }

  // 3. Identity-binding rules. Either:
  //
  //    (a) the assertion's email matches the grant's inviteEmail
  //        case-insensitively, OR
  //    (b) the assertion's email domain is in `allowedDomains`.
  //
  // We fail closed otherwise.
  const assertedEmail = extractEmail(assertion);
  if (!assertedEmail) {
    await emitPortalActivity({
      prisma,
      teamId: input.teamId,
      grantId: input.grantId,
      code: "EXTERNAL_SSO_IDENTITY_MISMATCH",
      ip: input.ip,
      userAgent: input.userAgent,
      payload: {
        reason: "no_email_attribute",
        nameIdHash: assertion.nameIdHash,
      },
    });
    return { ok: false, denial: "POLICY_REJECTED" };
  }

  const expectedEmail = role.inviteEmail ?? role.externalEmail;
  const identityOk = identityMatchesGrant(
    assertedEmail,
    expectedEmail,
    role.allowedDomains,
  );
  if (!identityOk) {
    await emitPortalActivity({
      prisma,
      teamId: input.teamId,
      grantId: input.grantId,
      code: "EXTERNAL_SSO_IDENTITY_MISMATCH",
      ip: input.ip,
      userAgent: input.userAgent,
      payload: {
        reason: "email_mismatch",
        nameIdHash: assertion.nameIdHash,
        assertedEmailHash: hashEmail(assertedEmail),
        expectedEmailHash: hashEmail(expectedEmail),
      },
    });
    return { ok: false, denial: "NOT_PERMITTED" };
  }

  // 4. Subject stability — once we have bound a subject hash to the
  // role assignment, every subsequent SSO sign-in MUST present the
  // same nameId. This protects against a compromised admin re-pointing
  // the grant at a different identity in the IdP.
  if (
    role.ssoSubjectHash &&
    role.ssoSubjectHash !== assertion.nameIdHash
  ) {
    await emitPortalActivity({
      prisma,
      teamId: input.teamId,
      grantId: input.grantId,
      code: "EXTERNAL_SSO_IDENTITY_MISMATCH",
      ip: input.ip,
      userAgent: input.userAgent,
      payload: {
        reason: "subject_hash_drift",
        nameIdHash: assertion.nameIdHash,
      },
    });
    return { ok: false, denial: "NOT_PERMITTED" };
  }

  // 5. Bind. Stamp ssoSubjectHash + ssoBoundAtUtc on first success,
  // promote authMethod to SSO, and transition the grant ACTIVE if it
  // was still INVITED.
  const boundAt = new Date();
  await prisma.externalReviewerRoleAssignment.update({
    where: { id: input.grantId },
    data: {
      authMethod: "SSO" satisfies PortalAuthMethod,
      ssoSubjectHash: role.ssoSubjectHash ?? assertion.nameIdHash,
      ssoNameId: assertion.nameId.slice(0, 320),
      ssoBoundAtUtc: role.ssoSubjectHash ? undefined : boundAt,
      inviteAcceptedAtUtc: { set: boundAt },
    },
  });

  // The grant primitive enforces its own state machine — if the grant
  // is already ACTIVE this is a no-op.
  await transitionExternalReviewGrant(
    {
      grantId: input.grantId,
      teamId: input.teamId,
      toState: "ACTIVE",
      actorUserId: "00000000-0000-0000-0000-000000000000",
    },
    prisma,
  ).catch(() => undefined);

  await emitPortalActivity({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    code: "EXTERNAL_SSO_SUCCEEDED",
    ip: input.ip,
    userAgent: input.userAgent,
    payload: {
      connectionId: conn.id,
      issuer: assertion.issuer,
      nameIdHash: assertion.nameIdHash,
      firstBind: role.ssoSubjectHash === null,
    },
  });

  return {
    ok: true,
    grantId: input.grantId,
    ssoSubjectHash: role.ssoSubjectHash ?? assertion.nameIdHash,
    authMethod: "SSO",
    assertion: {
      nameIdHash: assertion.nameIdHash,
      issuer: assertion.issuer,
      boundAtUtc: boundAt.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the asserted email from the SAML assertion. Tries the
 * common bounded set in order: NameID (when emailAddress format),
 * the `email` attribute, then RFC-2822-shaped attribute fallbacks.
 */
function extractEmail(a: SamlAssertion): string | null {
  if (
    a.nameIdFormat ===
      "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" &&
    isEmail(a.nameId)
  ) {
    return a.nameId.trim().toLowerCase();
  }
  const candidates = [
    a.attributes["email"]?.[0],
    a.attributes["emailAddress"]?.[0],
    a.attributes["mail"]?.[0],
    a.attributes[
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
    ]?.[0],
    a.attributes[
      "urn:oid:0.9.2342.19200300.100.1.3"
    ]?.[0],
  ];
  for (const c of candidates) {
    if (typeof c === "string" && isEmail(c)) {
      return c.trim().toLowerCase();
    }
  }
  return null;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function identityMatchesGrant(
  assertedEmail: string,
  expectedEmail: string,
  allowedDomains: string[],
): boolean {
  const asserted = assertedEmail.toLowerCase();
  const expected = expectedEmail.toLowerCase();
  if (asserted === expected) return true;
  const at = asserted.lastIndexOf("@");
  if (at < 0) return false;
  const domain = asserted.slice(at + 1);
  for (const allowed of allowedDomains) {
    const norm = allowed.toLowerCase().replace(/^@/, "").trim();
    if (norm.length > 0 && norm === domain) return true;
  }
  return false;
}

function hashEmail(value: string): string {
  return createHash("sha256")
    .update(value.trim().toLowerCase(), "utf8")
    .digest("hex");
}
