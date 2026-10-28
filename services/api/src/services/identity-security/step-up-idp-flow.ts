/**
 * IDP_REAUTH STEP-UP — THE ROUND TRIP (2026-10-28).
 *
 *   begin     POST /v1/identity-security/step-up/handoff/idp/begin
 *             (system browser, holding only the single-use handoff token)
 *               → the handoff is spent once
 *               → a FORCED authentication request to the challenge's own SSO
 *                 connection: SAML ForceAuthn="true" (+ RequestedAuthnContext
 *                 Comparison="exact" when the Organization lists contexts);
 *                 OIDC prompt=login, max_age=0 (+ acr_values)
 *               → state bound to the challenge in the EXISTING replay ledger
 *                 (SsoCallbackAttempt), single-use and expiring
 *   callback  the existing SAML ACS / OIDC callback detects the step-up state
 *             and hands the response here:
 *               → consumed once (a replay is refused by the ledger)
 *               → verified with the SAME validator / id_token verification as
 *                 sign-in (signature, issuer, audience, destination, expiry,
 *                 InResponseTo / nonce)
 *               → subject resolved through the SAME external identity link
 *                 sign-in uses, and it must be the person who started the
 *                 challenge, at the connection the challenge is bound to
 *               → freshness: AuthnInstant / auth_time present, not before the
 *                 handoff (−60 s skew) and within the policy's max age
 *               → context: in the accepted list when there is one;
 *                 PHISHING_RESISTANT requires a list AND a match
 *               → approveIdpChallenge — and nothing else. NO session is
 *                 minted, NO cookie is set, nobody is provisioned.
 *             The browser is sent to `${APP_BASE_URL}/step-up/idp` with
 *             `result=approved`, or `result=denied&reason=<stable code>`.
 *
 * Nothing here logs or persists an assertion, an id_token, an access token or
 * a code. The only IdP-derived values written are the asserted context
 * identifier (on the approved challenge) and the failure reason code.
 *
 * Denial codes are stable, and none of them describes the Organization's IdP
 * configuration (which contexts are accepted, which connection, which max age).
 */
import { randomBytes } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import {
  consumeCallbackAttempt,
  hashStateToken,
  markCallbackFailed,
} from "../access-control/sso-hardening.service.js";
import {
  buildOidcStepUpAuthorizationUrl,
  exchangeCodeForVerifiedIdToken,
} from "../access-control/sso.service.js";
import { samlSpEntityId, samlSpSigningKey } from "../access-control/sso-endpoints.js";
import { enforceSsoLoginPolicy } from "../access-control/sso-login-policy.service.js";
import { buildSamlAuthnRequest } from "../security/saml-authn-request.service.js";
import {
  samlConnectionRequiresIssuerRemediation,
  validateSamlResponse,
} from "../security/saml-assertion.service.js";
import { resolveExternalSubjectId } from "../security/saml-user-mapping.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import {
  IDP_STEP_UP_CLOCK_SKEW_SECONDS,
  idpAuthInstantWithinAge,
  idpStepUpBindingStillValid,
  idpStepUpProtocolOf,
  resolveLinkedUserForSubject,
  type IdpStepUpPolicy,
} from "./step-up-idp.js";
import {
  StepUpError,
  approveIdpChallenge,
  beginIdpHandoff,
  loadHandoffChallenge,
  resolveStepUpOrganizationPolicy,
} from "./step-up.service.js";

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

/**
 * The marker a step-up attempt carries in `SsoCallbackAttempt.redirectAfter`.
 * It is not a URL: every sign-in persist refuses it (`isSafeRedirectAfter`
 * rejects an unknown scheme), so a sign-in state can never be mistaken for a
 * step-up one, and a step-up state can never be used to sign in.
 */
export const STEP_UP_IDP_ATTEMPT_MARKER = "stepup:idp:";

/** How long a forced reauthentication may take at the IdP. */
export const IDP_STEP_UP_STATE_TTL_SECONDS = 10 * 60;

/** Stable, non-disclosing reasons a round trip ends in `result=denied`. */
export const IDP_STEP_UP_DENIAL_CODES = [
  /** The asserted context is not one the Organization accepts. */
  "IDP_CONTEXT_INSUFFICIENT",
  /** The IdP authenticated too long ago (or before this step-up began). */
  "IDP_REAUTH_STALE",
  /** The IdP did not say WHEN the person authenticated. */
  "IDP_AUTH_TIME_MISSING",
  /** The person who signed in at the IdP is not the person who asked. */
  "IDP_SUBJECT_MISMATCH",
  /** The response came through a different connection than the challenge's. */
  "IDP_CONNECTION_MISMATCH",
  /** The connection is not usable (inactive, incomplete, Organization inactive). */
  "IDP_CONNECTION_UNAVAILABLE",
  /** The challenge or its state expired, was completed, or was never issued. */
  "IDP_REAUTH_EXPIRED",
  /** This response / state was already used. */
  "IDP_REAUTH_REPLAYED",
  /** The response failed verification (signature, issuer, audience, nonce…). */
  "IDP_RESPONSE_INVALID",
  /** The person cancelled at the IdP, or the IdP returned an error. */
  "IDP_REAUTH_CANCELLED",
  /** An unexpected failure on our side; nothing was approved. */
  "IDP_REAUTH_FAILED",
] as const;
export type IdpStepUpDenialCode = (typeof IDP_STEP_UP_DENIAL_CODES)[number];

/**
 * Recorded as the approved challenge's context when a STANDARD Organization
 * listed no contexts and the IdP asserted none. The challenge still needs a
 * non-null context to be spendable; this says truthfully that the forced
 * sign-in happened and that no context was asserted. It never satisfies a
 * listed context (nobody can list it by accident — it is not a URI an IdP
 * emits) and PHISHING_RESISTANT never reaches this branch.
 */
export const IDP_CONTEXT_UNASSERTED = "urn:proovra:step-up:idp-context-unasserted";

const DEFAULT_POLICY: IdpStepUpPolicy = {
  assurance: "STANDARD",
  acceptedContexts: [],
  maxAgeSeconds: 300,
};

const SAML_DEFAULT_NAME_ID_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL?.trim() || "https://app.proovra.com").replace(/\/+$/, "");
}

/** Where the browser lands when the round trip ends. Carries no secret. */
export function stepUpIdpDoneUrl(
  outcome: { result: "approved" } | { result: "denied"; reason: IdpStepUpDenialCode },
): string {
  const params = new URLSearchParams({ result: outcome.result });
  if (outcome.result === "denied") params.set("reason", outcome.reason);
  return `${appBaseUrl()}/step-up/idp?${params.toString()}`;
}

function challengeIdFromMarker(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(STEP_UP_IDP_ATTEMPT_MARKER)) return null;
  const id = value.slice(STEP_UP_IDP_ATTEMPT_MARKER.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

/**
 * Is this SAML RelayState / OIDC state one the step-up round trip minted?
 * A read, not a consume: the sign-in paths keep their own consume untouched.
 */
export async function isStepUpIdpState(client: PrismaClient, stateRaw: string): Promise<boolean> {
  const row = await client.ssoCallbackAttempt.findUnique({
    where: { stateHash: hashStateToken(stateRaw) },
    select: { redirectAfter: true },
  });
  return challengeIdFromMarker(row?.redirectAfter) !== null;
}

// -----------------------------------------------------------------------------
// Begin
// -----------------------------------------------------------------------------

export type IdpStepUpBeginErrorCode =
  | "STEP_UP_HANDOFF_INVALID"
  | "IDP_REAUTH_EXPIRED"
  | "IDP_CONNECTION_UNAVAILABLE"
  | "IDP_CONTEXT_INSUFFICIENT";

export class IdpStepUpBeginError extends Error {
  readonly code: IdpStepUpBeginErrorCode;
  constructor(code: IdpStepUpBeginErrorCode) {
    super(code);
    this.code = code;
  }
}

const BEGIN_CONNECTION_SELECT = {
  id: true,
  teamId: true,
  organizationId: true,
  provider: true,
  status: true,
  samlSsoUrl: true,
  samlCertificate: true,
  samlEntityId: true,
  samlIdpEntityId: true,
  samlNameIdFormat: true,
  samlSignRequests: true,
  samlSpPrivateKey: true,
  issuerUrl: true,
  clientId: true,
} as const;

/**
 * Start the forced reauthentication for one IDP_REAUTH challenge. Every check
 * that can refuse runs BEFORE the handoff is spent, so a refusal never burns
 * the link for nothing; the spend itself is the single-use gate.
 */
export async function beginIdpStepUp(
  client: PrismaClient,
  input: {
    challengeId: string;
    handoffToken: string;
    samlAcsUrl: string;
    oidcRedirectUri: string;
    ipPreview: string | null;
    uaPreview: string | null;
  },
): Promise<{ redirectUrl: string }> {
  let row: prismaPkg.StepUpChallenge;
  try {
    row = await loadHandoffChallenge(
      { challengeId: input.challengeId, handoffToken: input.handoffToken, method: "IDP_REAUTH" },
      client,
    );
  } catch (err) {
    if (err instanceof StepUpError && err.code === "challenge_expired") {
      throw new IdpStepUpBeginError("IDP_REAUTH_EXPIRED");
    }
    throw new IdpStepUpBeginError("STEP_UP_HANDOFF_INVALID");
  }
  if (row.handoffUsedAtUtc !== null || !row.ssoConnectionId) {
    throw new IdpStepUpBeginError("STEP_UP_HANDOFF_INVALID");
  }

  const conn = await client.ssoConnection.findUnique({
    where: { id: row.ssoConnectionId },
    select: BEGIN_CONNECTION_SELECT,
  });
  const protocol = conn ? idpStepUpProtocolOf(conn) : null;
  if (
    !conn ||
    conn.status !== "ACTIVE" ||
    !protocol ||
    (protocol === "SAML" && samlConnectionRequiresIssuerRemediation(conn)) ||
    !(await idpStepUpBindingStillValid(client, {
      userId: row.initiatedByUserId,
      connectionId: conn.id,
    }))
  ) {
    throw new IdpStepUpBeginError("IDP_CONNECTION_UNAVAILABLE");
  }

  const policy = (await resolveStepUpOrganizationPolicy(row.teamId, client)) ?? DEFAULT_POLICY;
  if (policy.assurance === "PHISHING_RESISTANT" && policy.acceptedContexts.length === 0) {
    throw new IdpStepUpBeginError("IDP_CONTEXT_INSUFFICIENT");
  }

  // The single-use spend. A second begin with the same link is refused here.
  try {
    await beginIdpHandoff({ challengeId: row.id, handoffToken: input.handoffToken }, client);
  } catch (err) {
    if (err instanceof StepUpError && err.code === "challenge_expired") {
      throw new IdpStepUpBeginError("IDP_REAUTH_EXPIRED");
    }
    throw new IdpStepUpBeginError("STEP_UP_HANDOFF_INVALID");
  }

  try {
    if (protocol === "SAML") {
      const built = buildSamlAuthnRequest({
        connectionId: conn.id,
        spEntityId: conn.samlEntityId || samlSpEntityId(conn.id),
        acsUrl: input.samlAcsUrl,
        idpSsoUrl: conn.samlSsoUrl as string,
        nameIdFormat: conn.samlNameIdFormat ?? SAML_DEFAULT_NAME_ID_FORMAT,
        forceAuthn: true,
        requestedAuthnContextClassRefs: policy.acceptedContexts,
        spPrivateKeyPem: conn.samlSignRequests ? samlSpSigningKey(conn.samlSpPrivateKey) : null,
      });
      await persistStepUpAttempt(client, {
        connection: conn,
        challengeId: row.id,
        stateRaw: built.relayState,
        nonceSource: built.requestId,
        samlAuthnRequestId: built.requestId,
        ipPreview: input.ipPreview,
        uaPreview: input.uaPreview,
      });
      return { redirectUrl: built.redirectUrl };
    }
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(16).toString("base64url");
    const redirectUrl = await buildOidcStepUpAuthorizationUrl({
      conn,
      redirectUri: input.oidcRedirectUri,
      state,
      nonce,
      acrValues: policy.acceptedContexts,
    });
    await persistStepUpAttempt(client, {
      connection: conn,
      challengeId: row.id,
      stateRaw: state,
      nonceSource: nonce,
      samlAuthnRequestId: null,
      ipPreview: input.ipPreview,
      uaPreview: input.uaPreview,
    });
    return { redirectUrl };
  } catch {
    // Discovery unreachable, a malformed SP key, … — the IdP cannot be
    // reached right now. The handoff is spent, so the person starts again.
    throw new IdpStepUpBeginError("IDP_CONNECTION_UNAVAILABLE");
  }
}

/**
 * The step-up state in the EXISTING replay ledger. Written directly rather
 * than through the sign-in persist helpers because the marker is deliberately
 * NOT a safe redirect — which is exactly what keeps the two flows apart.
 */
async function persistStepUpAttempt(
  client: PrismaClient,
  input: {
    connection: { id: string; teamId: string; organizationId: string };
    challengeId: string;
    stateRaw: string;
    /** OIDC: the raw nonce. SAML: the AuthnRequest ID (as the sign-in path does). */
    nonceSource: string;
    samlAuthnRequestId: string | null;
    ipPreview: string | null;
    uaPreview: string | null;
  },
): Promise<void> {
  await client.ssoCallbackAttempt.create({
    data: {
      teamId: input.connection.teamId,
      organizationId: input.connection.organizationId,
      ssoConnectionId: input.connection.id,
      stateHash: hashStateToken(input.stateRaw),
      nonceHash: hashStateToken(input.nonceSource),
      samlAuthnRequestId: input.samlAuthnRequestId,
      status: "PENDING",
      redirectAfter: `${STEP_UP_IDP_ATTEMPT_MARKER}${input.challengeId}`,
      ipPreview: input.ipPreview,
      uaPreview: input.uaPreview,
      expiresAtUtc: new Date(Date.now() + IDP_STEP_UP_STATE_TTL_SECONDS * 1000),
    },
  });
}

// -----------------------------------------------------------------------------
// Callback — protocol halves
// -----------------------------------------------------------------------------

type ConsumedStepUpAttempt = {
  attempt: prismaPkg.SsoCallbackAttempt;
  challengeId: string;
};

async function consumeStepUpAttempt(
  client: PrismaClient,
  stateRaw: string,
): Promise<ConsumedStepUpAttempt | { denied: IdpStepUpDenialCode }> {
  const consumed = await consumeCallbackAttempt({ stateRaw }, client);
  if (!consumed.ok) {
    return { denied: consumed.reason === "REPLAYED" ? "IDP_REAUTH_REPLAYED" : "IDP_REAUTH_EXPIRED" };
  }
  const challengeId = challengeIdFromMarker(consumed.attempt.redirectAfter);
  if (!challengeId) {
    await markCallbackFailed({ attemptId: consumed.attempt.id, reason: "step_up_state_invalid" }, client);
    return { denied: "IDP_REAUTH_EXPIRED" };
  }
  return { attempt: consumed.attempt, challengeId };
}

/** The SAML ACS branch for a step-up RelayState. Returns the redirect target. */
export async function completeSamlIdpStepUp(
  client: PrismaClient,
  input: { samlResponseBase64: string; relayStateRaw: string; acsUrl: string },
): Promise<string> {
  const consumed = await consumeStepUpAttempt(client, input.relayStateRaw);
  if ("denied" in consumed) return stepUpIdpDoneUrl({ result: "denied", reason: consumed.denied });
  const { attempt, challengeId } = consumed;
  try {
    const conn = await client.ssoConnection.findUnique({
      where: { id: attempt.ssoConnectionId },
      select: {
        id: true,
        teamId: true,
        organizationId: true,
        provider: true,
        status: true,
        samlSsoUrl: true,
        samlCertificate: true,
        samlCertificateNext: true,
        samlEntityId: true,
        samlIdpEntityId: true,
        samlAttributeMapping: true,
        issuerUrl: true,
        clientId: true,
      },
    });
    if (
      !conn ||
      conn.status !== "ACTIVE" ||
      idpStepUpProtocolOf(conn) !== "SAML" ||
      !conn.samlCertificate ||
      samlConnectionRequiresIssuerRemediation(conn) ||
      !(await organizationAcceptsSso(client, conn.teamId))
    ) {
      return await deny(client, { attempt, challengeId, reason: "IDP_CONNECTION_UNAVAILABLE" });
    }
    let assertion: ReturnType<typeof validateSamlResponse>;
    try {
      // The SAME validator, with the SAME mandatory controls, as sign-in.
      assertion = validateSamlResponse({
        samlResponseBase64: input.samlResponseBase64,
        idpCertificate: conn.samlCertificate,
        idpCertificateNext: conn.samlCertificateNext ?? null,
        spEntityId: conn.samlEntityId || samlSpEntityId(conn.id),
        expectedInResponseTo: attempt.samlAuthnRequestId ?? undefined,
        allowedClockSkewSeconds: IDP_STEP_UP_CLOCK_SKEW_SECONDS,
        expectedIdpEntityId: conn.samlIdpEntityId ?? null,
        requireAudience: true,
        expectedAcsUrl: input.acsUrl,
        requireRecipientDestination: true,
      });
      if (!attempt.samlAuthnRequestId || assertion.inResponseTo !== attempt.samlAuthnRequestId) {
        throw new Error("in_response_to_mismatch");
      }
    } catch {
      return await deny(client, { attempt, challengeId, reason: "IDP_RESPONSE_INVALID" });
    }
    const externalSubjectId = resolveExternalSubjectId(
      assertion,
      conn.samlAttributeMapping as { externalId?: string } | null,
    );
    return await judgeAndApprove(client, {
      attempt,
      challengeId,
      connection: conn,
      externalSubjectId,
      authnInstant: assertion.authnInstant,
      authnContext: assertion.authnContextClassRef,
    });
  } catch {
    return await deny(client, { attempt, challengeId, reason: "IDP_REAUTH_FAILED" });
  }
}

/** The OIDC callback branch for a step-up state. Returns the redirect target. */
export async function completeOidcIdpStepUp(
  client: PrismaClient,
  input: { stateRaw: string; code: string | null; idpError: string | null; redirectUri: string },
): Promise<string> {
  // Consumed first in every case, so a cancelled state cannot be re-used.
  const consumed = await consumeStepUpAttempt(client, input.stateRaw);
  if ("denied" in consumed) return stepUpIdpDoneUrl({ result: "denied", reason: consumed.denied });
  const { attempt, challengeId } = consumed;
  if (input.idpError || !input.code) {
    return deny(client, { attempt, challengeId, reason: "IDP_REAUTH_CANCELLED" });
  }
  try {
    const conn = await client.ssoConnection.findUnique({ where: { id: attempt.ssoConnectionId } });
    if (
      !conn ||
      conn.status !== "ACTIVE" ||
      idpStepUpProtocolOf(conn) !== "OIDC" ||
      !(await organizationAcceptsSso(client, conn.teamId))
    ) {
      return await deny(client, { attempt, challengeId, reason: "IDP_CONNECTION_UNAVAILABLE" });
    }
    let verified: Awaited<ReturnType<typeof exchangeCodeForVerifiedIdToken>>;
    try {
      // The SAME exchange + id_token verification as sign-in; the nonce is
      // compared with the HMAC persisted for THIS state (not process memory).
      verified = await exchangeCodeForVerifiedIdToken({
        conn,
        code: input.code,
        redirectUri: input.redirectUri,
        nonceMatches: (nonce) =>
          typeof nonce === "string" && nonce.length > 0 && hashStateToken(nonce) === attempt.nonceHash,
      });
    } catch {
      return await deny(client, { attempt, challengeId, reason: "IDP_RESPONSE_INVALID" });
    }
    return await judgeAndApprove(client, {
      attempt,
      challengeId,
      connection: conn,
      externalSubjectId: verified.sub,
      authnInstant: verified.authTime,
      authnContext: verified.acr,
    });
  } catch {
    return await deny(client, { attempt, challengeId, reason: "IDP_REAUTH_FAILED" });
  }
}

/** The Organization's own SSO gate (Enterprise, Organization workspace, active). */
async function organizationAcceptsSso(client: PrismaClient, teamId: string): Promise<boolean> {
  const gate = await enforceSsoLoginPolicy(
    { teamId, email: "", restrictToVerifiedDomains: false },
    client,
  );
  return gate.ok;
}

// -----------------------------------------------------------------------------
// Callback — the judgement (protocol-neutral)
// -----------------------------------------------------------------------------

export type IdpStepUpEvidence = {
  /** The connection the verified response came through. */
  connectionId: string;
  organizationId: string;
  provider: string;
  /** The verified IdP subject (NameID / mapped externalId, or `sub`). */
  externalSubjectId: string;
  /** AuthnInstant / auth_time — null when the IdP did not send one. */
  authnInstant: Date | null;
  /** AuthnContextClassRef / acr — null when the IdP did not send one. */
  authnContext: string | null;
};

/**
 * Decide whether verified IdP evidence satisfies this challenge. Pure over the
 * rows it is given plus the link lookup; returns the context to record, or the
 * stable reason it does not.
 */
export async function judgeIdpStepUpEvidence(
  client: PrismaClient,
  input: { challenge: prismaPkg.StepUpChallenge; evidence: IdpStepUpEvidence; nowMs?: number },
): Promise<{ ok: true; authnContext: string } | { ok: false; reason: IdpStepUpDenialCode }> {
  const { challenge, evidence } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (
    challenge.method !== "IDP_REAUTH" ||
    challenge.status !== prismaPkg.StepUpChallengeStatus.PENDING ||
    challenge.handoffUsedAtUtc === null ||
    challenge.expiresAtUtc.getTime() <= nowMs
  ) {
    return { ok: false, reason: "IDP_REAUTH_EXPIRED" };
  }
  if (challenge.ssoConnectionId !== evidence.connectionId) {
    return { ok: false, reason: "IDP_CONNECTION_MISMATCH" };
  }
  const linkedUserId = await resolveLinkedUserForSubject(client, {
    organizationId: evidence.organizationId,
    provider: evidence.provider,
    externalSubjectId: evidence.externalSubjectId,
  });
  if (!linkedUserId || linkedUserId !== challenge.initiatedByUserId) {
    return { ok: false, reason: "IDP_SUBJECT_MISMATCH" };
  }
  const policy = (await resolveStepUpOrganizationPolicy(challenge.teamId, client)) ?? DEFAULT_POLICY;
  if (!evidence.authnInstant) return { ok: false, reason: "IDP_AUTH_TIME_MISSING" };
  const earliest = challenge.handoffUsedAtUtc.getTime() - IDP_STEP_UP_CLOCK_SKEW_SECONDS * 1000;
  if (
    evidence.authnInstant.getTime() < earliest ||
    !idpAuthInstantWithinAge(evidence.authnInstant, policy.maxAgeSeconds, nowMs)
  ) {
    return { ok: false, reason: "IDP_REAUTH_STALE" };
  }
  const asserted = evidence.authnContext?.trim() || null;
  if (policy.acceptedContexts.length > 0) {
    if (!asserted || !policy.acceptedContexts.includes(asserted)) {
      return { ok: false, reason: "IDP_CONTEXT_INSUFFICIENT" };
    }
    return { ok: true, authnContext: asserted };
  }
  // No list: PHISHING_RESISTANT cannot be proven; STANDARD accepts the forced
  // fresh sign-in itself and records what was asserted (or that nothing was).
  if (policy.assurance !== "STANDARD") return { ok: false, reason: "IDP_CONTEXT_INSUFFICIENT" };
  return { ok: true, authnContext: asserted ?? IDP_CONTEXT_UNASSERTED };
}

async function judgeAndApprove(
  client: PrismaClient,
  input: {
    attempt: prismaPkg.SsoCallbackAttempt;
    challengeId: string;
    connection: { id: string; organizationId: string; provider: string };
    externalSubjectId: string;
    authnInstant: Date | null;
    authnContext: string | null;
  },
): Promise<string> {
  const challenge = await client.stepUpChallenge.findUnique({ where: { id: input.challengeId } });
  if (!challenge) {
    return deny(client, { attempt: input.attempt, challengeId: input.challengeId, reason: "IDP_REAUTH_EXPIRED" });
  }
  const verdict = await judgeIdpStepUpEvidence(client, {
    challenge,
    evidence: {
      connectionId: input.connection.id,
      organizationId: input.connection.organizationId,
      provider: input.connection.provider,
      externalSubjectId: input.externalSubjectId,
      authnInstant: input.authnInstant,
      authnContext: input.authnContext,
    },
  });
  if (!verdict.ok) {
    return deny(client, { attempt: input.attempt, challengeId: input.challengeId, challenge, reason: verdict.reason });
  }
  try {
    await approveIdpChallenge(
      {
        challengeId: challenge.id,
        userId: challenge.initiatedByUserId,
        connectionId: input.connection.id,
        authnContext: verdict.authnContext,
      },
      client,
    );
  } catch {
    // Completed, expired or cancelled between the judgement and the write.
    return deny(client, { attempt: input.attempt, challengeId: input.challengeId, challenge, reason: "IDP_REAUTH_EXPIRED" });
  }
  return stepUpIdpDoneUrl({ result: "approved" });
}

/**
 * A refusal: the ledger row is marked FAILED with the code, an INFO security
 * event and a tenant audit row are written (an expected refusal is not an
 * incident), and the browser is sent to the result page. The challenge stays
 * unapproved.
 */
async function deny(
  client: PrismaClient,
  input: {
    attempt: prismaPkg.SsoCallbackAttempt;
    challengeId: string;
    challenge?: prismaPkg.StepUpChallenge | null;
    reason: IdpStepUpDenialCode;
  },
): Promise<string> {
  await markCallbackFailed({ attemptId: input.attempt.id, reason: input.reason.toLowerCase() }, client);
  const challenge =
    input.challenge ??
    (await client.stepUpChallenge
      .findUnique({ where: { id: input.challengeId } })
      .catch(() => null));
  if (challenge) {
    safeEmitSecurityEvent(
      {
        teamId: challenge.teamId,
        eventType: "step_up_denied",
        severity: "INFO",
        details: {
          actorUserId: challenge.initiatedByUserId,
          purpose: challenge.purpose,
          method: "IDP_REAUTH",
          reason: input.reason,
        },
      },
      client,
    );
    await emitTenantAudit(
      {
        action: "identity_security.step_up.denied",
        outcome: "denied",
        denialReason: input.reason,
        sourceApp: "SSO",
        actorUserId: challenge.initiatedByUserId,
        workspaceId: challenge.teamId,
        resourceType: "step_up_challenge",
        resourceId: challenge.id,
        metadata: { purpose: challenge.purpose, method: "IDP_REAUTH", reason: input.reason },
      },
      client,
    ).catch(() => null);
  }
  return stepUpIdpDoneUrl({ result: "denied", reason: input.reason });
}
