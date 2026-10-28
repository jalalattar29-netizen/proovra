/**
 * Phase 19 — Step-up authentication service.
 *
 * Wraps Phase 18 Twilio Verify with an application-side challenge
 * row that BINDS approval to:
 *   - the initiating user
 *   - the team
 *   - the canonical step-up purpose (e.g. LEGAL_HOLD_RELEASE)
 *   - an optional resource (kind + id)
 *
 * Lifecycle:
 *   PENDING --(check passes)--> APPROVED (TTL ~15 min)
 *           --(check fails too often / TTL elapses)--> EXPIRED / DENIED
 *           --(operator/route cancels)--> CANCELLED
 *
 * Hard invariants:
 *   - The OTP code is NEVER persisted on the challenge row.
 *   - A challenge approved for purpose X / resource Y may NOT be
 *     reused for any other (purpose, resource) combination.
 *   - `consumeApprovedChallenge` is single-use: once consumed, the
 *     row is marked CANCELLED so the same approval cannot satisfy
 *     two sensitive actions.
 *   - Service accounts and contributors do NOT use this service for
 *     workspace MFA — see the comments in mfa-policy.service.ts.
 *   - Failures fail closed and emit generic errors.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import {
  STEP_UP_TTL_DEFAULT_SECONDS,
  STEP_UP_TTL_MAX_SECONDS,
  STEP_UP_ASSURANCE_LEVELS,
  purposeSatisfies,
  stepUpFactorKindsAllowed,
  stepUpFactorKindsFor,
  type StepUpAssuranceLevel,
  type StepUpFactorKind,
  type StepUpPurpose,
} from "@proovra/shared";
import { organizationIdForPolicy } from "../identity/org-security-policy.service.js";
import {
  buildPasskeyAssertionOptions,
  userHasActivePasskey,
  verifyPasskeyAssertion,
} from "./step-up-passkey.js";
import {
  idpStepUpBindingStillValid,
  resolveIdpStepUpConnection,
  sessionSatisfiesIdpStepUp,
  type IdpStepUpPolicy,
} from "./step-up-idp.js";
import { openSecret } from "../security/mfa-secret-storage.js";
import { claimTotpStep, requireTotpSecret } from "../security/mfa.service.js";
import { matchTotpStep } from "../security/mfa-totp.js";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import {
  VerificationError,
  checkVerification,
  startVerification,
} from "../communications/verification.service.js";
import { maybeFireFailedOtpBurst } from "./risk.service.js";
// PHASE 13 (NEW-058) — the enrolled-factor authority. This is the ONLY source
// of a step-up destination; nothing here may read one from a request.
import {
  resolveActiveContactFactor,
  resolveStepUpDestination,
} from "../security/verified-contact-factor.service.js";

// -----------------------------------------------------------------------------
// Error surface
// -----------------------------------------------------------------------------

export type StepUpErrorCode =
  | "feature_disabled"
  | "invalid_phone"
  | "rate_limited"
  | "provider_unconfigured"
  | "provider_unreachable"
  | "provider_rejected"
  | "challenge_not_found"
  | "challenge_expired"
  | "challenge_consumed"
  | "challenge_purpose_mismatch"
  | "challenge_resource_mismatch"
  /**
   * PHASE 13 (NEW-058) — the account holds no enrolled contact factor.
   *
   * A STABLE, non-disclosing denial that the product can act on: it is the
   * difference between "you got the code wrong" and "there is nothing to send
   * a code to, enrol a device first". It exists because the alternative — the
   * old behaviour — was to accept whatever destination the request carried.
   */
  | "enrollment_required"
  /**
   * 2026-10-28 — the challenge is answered elsewhere (a passkey assertion, an
   * IdP round trip) and this request carried the wrong kind of answer.
   */
  | "method_mismatch"
  | "denied";

export class StepUpError extends Error {
  readonly code: StepUpErrorCode;
  /**
   * `enrollment_required` only: the kinds THIS purpose admits under the
   * Organization's policy, so the refusal names what would satisfy it.
   */
  readonly acceptedFactors: ReadonlyArray<StepUpFactorKind> | null;
  constructor(code: StepUpErrorCode, acceptedFactors: ReadonlyArray<StepUpFactorKind> | null = null) {
    super(code);
    this.code = code;
    this.acceptedFactors = acceptedFactors;
  }
}

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

export type StartStepUpInput = {
  teamId: string;
  userId: string;
  purpose: StepUpPurpose;
  resourceKind?: string | null;
  resourceId?: string | null;
  /**
   * PHASE 13 (NEW-058) — the destination is RESOLVED, never supplied.
   *
   * This used to be `phoneE164OrRaw: string`, taken straight from the request
   * body, which meant an approved challenge proved possession of a handset the
   * CALLER chose rather than of a factor the ACCOUNT enrolled — a stolen
   * session supplied the attacker's own number and approved its own challenge.
   *
   * A caller may now NAME one of its own enrolled factors, and that is all: the
   * server reads the destination from the factor authority, and a `factorId`
   * that is not an ACTIVE, VERIFIED factor belonging to this user simply does
   * not resolve. Omitting it selects the account's active factor.
   */
  factorId?: string | null;
  /**
   * Preferred channel, honoured only if the account has an enrolled factor on
   * it. It selects among what the user HOLDS; it can never introduce a
   * destination.
   */
  channel?: StepUpFactorKind | null;
  reason?: string | null;
  ttlSeconds?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /**
   * PHASE 12B B3 — the canonical hash of the session starting the challenge
   * (`req.user.sessionIdHash`). Persisted so the approval can only be spent
   * from the SAME session. Callers that cannot resolve a session (there are
   * none on the authenticated step-up routes) pass null and get a legacy
   * session-unbound challenge.
   */
  sessionIdHash?: string | null;
  /**
   * 2026-10-28 — the caller will complete a PASSKEY challenge in a SYSTEM
   * BROWSER (the mobile app): mint a single-use handoff token for it. An
   * IDP_REAUTH challenge always gets one, since it is completed by a browser
   * round trip by definition.
   */
  handoff?: boolean;
};

export type StartStepUpResult = {
  challenge: prismaPkg.StepUpChallenge;
  /** PV-STEPUP-001 — the factor kind this challenge is answered with. */
  method: StepUpFactorKind;
  /** The enrolled phone's mask when a code was sent; null for TOTP. */
  destinationMask: string | null;
  /**
   * Every kind this person could answer THIS purpose with, strongest first
   * (the policy-narrowed ladder intersected with what they hold), so a
   * surface can offer "use another method" without guessing.
   */
  availableMethods: StepUpFactorKind[];
  /** PASSKEY: the WebAuthn request options to pass to the browser. */
  passkeyOptions: Record<string, unknown> | null;
  /** The raw single-use handoff token (returned once, stored hashed). */
  handoffToken: string | null;
};

// -----------------------------------------------------------------------------
// 2026-10-28 — the Organization's step-up assurance, read from the ONE
// Organization security policy row (no second policy store). A workspace with
// no CUSTOMER Organization, or a customer Organization with no policy row yet,
// has the default posture: STANDARD, SMS allowed — today's behaviour.
// -----------------------------------------------------------------------------

export type StepUpOrganizationPolicy = IdpStepUpPolicy & {
  smsAllowed: boolean;
  /**
   * The Organization's approval lifetime (`stepUpTtlSeconds`). It was stored
   * and editable and read by nothing: every challenge lived the default 15
   * minutes whatever the Organization set (members ledger S-2).
   */
  ttlSeconds: number | null;
};

export async function resolveStepUpOrganizationPolicy(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<StepUpOrganizationPolicy | null> {
  const organizationId = await organizationIdForPolicy(teamId, client);
  if (!organizationId) return null;
  const row = await client.organizationSecurityPolicy.findUnique({
    where: { organizationId },
    select: {
      stepUpAssurance: true,
      stepUpSmsAllowed: true,
      idpStepUpAcceptedContexts: true,
      idpStepUpMaxAgeSeconds: true,
      stepUpTtlSeconds: true,
    },
  });
  if (!row) return null;
  // An absent value is the column default (STANDARD, SMS allowed, 300s); a
  // stored level that is not a known one fails toward the stronger requirement.
  const stored = row.stepUpAssurance ?? "STANDARD";
  const assurance = (STEP_UP_ASSURANCE_LEVELS as ReadonlyArray<string>).includes(stored)
    ? (stored as StepUpAssuranceLevel)
    : "PHISHING_RESISTANT";
  return {
    assurance,
    smsAllowed: row.stepUpSmsAllowed ?? true,
    acceptedContexts: row.idpStepUpAcceptedContexts ?? [],
    maxAgeSeconds: Math.max(30, Math.min(3600, row.idpStepUpMaxAgeSeconds ?? 300)),
    ttlSeconds: row.stepUpTtlSeconds ?? null,
  };
}

export function hashStepUpHandoffToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * A bound on how often one person may START a challenge for a ladder purpose:
 * each start is a passkey ceremony, an IdP round trip or a code, and none of
 * them should be an unmetered loop.
 */
const LADDER_MAX_STARTS_PER_WINDOW = 10;
const LADDER_START_WINDOW_MS = 15 * 60 * 1000;

/**
 * PV-STEPUP-001 — an authenticator-app challenge is refused to start once
 * this many of its challenges were DENIED within the window. Each challenge
 * admits one code attempt, so this bounds guessing at five codes per quarter
 * hour per factor, against a 10^6 code space.
 */
const TOTP_MAX_DENIALS_PER_WINDOW = 5;
const TOTP_DENIAL_WINDOW_MS = 15 * 60 * 1000;

export async function startStepUpChallenge(
  input: StartStepUpInput,
  client: PrismaClient = defaultPrisma,
): Promise<StartStepUpResult> {
  /**
   * PHASE 13 (NEW-058) — RESOLVE THE FACTOR FIRST, AND FAIL CLOSED WITHOUT ONE.
   *
   * Nothing downstream may see a caller-supplied destination, so the factor
   * lookup happens before any provider call. An account with no enrolled,
   * verified, unrevoked factor that this purpose accepts — an authenticator
   * app or a contact factor (PV-STEPUP-001) — CANNOT elevate: it receives a
   * stable `enrollment_required` denial and every step-up-gated mutation
   * refuses.
   *
   * That is deliberately a refusal and not a fallback to the old behaviour:
   * "no factor" used to mean "use whatever number arrived", which is the
   * defect. It now means the gate cannot be satisfied, which is what a gate
   * with nothing to check against should say.
   */
  const policy = await resolveStepUpOrganizationPolicy(input.teamId, client);
  const allowedKinds = stepUpFactorKindsAllowed(input.purpose, policy);
  if (stepUpFactorKindsFor(input.purpose).includes("PASSKEY")) {
    const recentStarts = await client.stepUpChallenge.count({
      where: {
        initiatedByUserId: input.userId,
        purpose: input.purpose,
        createdAt: { gte: new Date(Date.now() - LADDER_START_WINDOW_MS) },
      },
    });
    if (recentStarts >= LADDER_MAX_STARTS_PER_WINDOW) {
      throw new StepUpError("rate_limited");
    }
  }
  const available = await resolveAvailableStepUpKinds(
    { userId: input.userId, teamId: input.teamId, allowedKinds },
    client,
  );
  // A named channel NARROWS among what the person holds; it never introduces
  // a kind the policy or the person does not have.
  const requested = input.channel ?? null;
  const chosenKind: StepUpFactorKind | null =
    requested !== null
      ? available.kinds.includes(requested)
        ? requested
        : null
      : (available.kinds[0] ?? null);
  if (chosenKind === null) throw new StepUpError("enrollment_required", allowedKinds);

  if (chosenKind === "PASSKEY" || chosenKind === "IDP_REAUTH") {
    return startLadderChallenge(
      {
        input,
        kind: chosenKind,
        availableMethods: available.kinds,
        idpConnectionId: available.idpConnectionId,
        policy,
      },
      client,
    );
  }

  const factor = await resolveStepUpFactor(
    {
      userId: input.userId,
      purpose: input.purpose,
      factorId: input.factorId ?? null,
      channel: chosenKind,
      allowedKinds,
    },
    client,
  );
  if (!factor) throw new StepUpError("enrollment_required", allowedKinds);

  let verificationAttemptId: string | null = null;
  let generation = factor.generation;
  if (factor.method === "TOTP") {
    /**
     * PV-STEPUP-001 — an authenticator code is checked here; nothing is sent.
     *
     * What the one-time-code path gets from the provider's own rate limit,
     * this path enforces itself. Each challenge admits ONE code attempt — a
     * wrong code DENIES it — so the guessing rate is the rate at which
     * challenges can be started, and that is bounded by the recent denials
     * recorded against this factor.
     */
    const recentDenials = await client.stepUpChallenge.count({
      where: {
        initiatedByUserId: input.userId,
        factorId: factor.factorId,
        status: prismaPkg.StepUpChallengeStatus.DENIED,
        createdAt: { gte: new Date(Date.now() - TOTP_DENIAL_WINDOW_MS) },
      },
    });
    if (recentDenials >= TOTP_MAX_DENIALS_PER_WINDOW) {
      throw new StepUpError("rate_limited");
    }
  } else {
    const resolved = await resolveStepUpDestination(
      { userId: input.userId, factorId: factor.factorId },
      client,
    );
    generation = resolved.generation;

    // Translate Verify errors -> StepUpError codes so the route surface
    // is uniform.
    let verification;
    try {
      verification = await startVerification(
        {
          teamId: input.teamId,
          channel: resolved.kind,
          phoneE164OrRaw: resolved.destination,
          initiatedByUserId: input.userId,
          purpose: `STEP_UP:${input.purpose}`,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
        client,
      );
    } catch (err) {
      if (err instanceof VerificationError) {
        throw new StepUpError(mapVerifyErrorToStepUp(err.code));
      }
      throw err;
    }
    if (verification.status === "rate_limited") {
      throw new StepUpError("rate_limited");
    }
    verificationAttemptId = verification.attempt.id;
  }

  const ttl = clampTtl(input.ttlSeconds ?? policy?.ttlSeconds ?? null);
  const expiresAt = new Date(Date.now() + ttl * 1000);

  // PHASE 12B B3 — the Organization is DERIVED FROM PERSISTENCE, never from a
  // request field. `Team.organizationId` is NOT NULL, so a resolvable workspace
  // always yields the Organization the elevation is minted against.
  const workspace = await client.team.findUnique({
    where: { id: input.teamId },
    select: { organizationId: true },
  });

  const challenge = await client.stepUpChallenge.create({
    data: {
      teamId: input.teamId,
      initiatedByUserId: input.userId,
      purpose: input.purpose,
      resourceKind: input.resourceKind ?? null,
      resourceId: input.resourceId ?? null,
      status: prismaPkg.StepUpChallengeStatus.PENDING,
      // Null for an authenticator-app challenge: nothing was sent, so there
      // is no provider attempt to bind. The factor binding below still is.
      verificationAttemptId,
      expiresAtUtc: expiresAt,
      reason: input.reason?.slice(0, 400) ?? null,
      sessionIdHash: input.sessionIdHash ?? null,
      organizationId: workspace?.organizationId ?? null,
      /**
       * PHASE 13 (NEW-058) — WHICH factor authorised this, and at which
       * generation.
       *
       * The generation is what makes the approval perishable: re-enrolling a
       * different handset bumps it, and a challenge minted against the old
       * value stops being spendable at the consume path. Without it, an
       * attacker who enrolled their own number could still spend an elevation
       * the legitimate holder had approved moments earlier.
       */
      factorId: factor.factorId,
      factorGeneration: generation,
      method: factor.method,
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "step_up_started",
      severity: "INFO",
      details: {
        actorUserId: input.userId,
        purpose: input.purpose,
        method: factor.method,
        resourceKind: input.resourceKind ?? null,
        resourceId: input.resourceId ?? null,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity_security.step_up.start",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.userId,
    workspaceId: input.teamId,
    resourceType: "step_up_challenge",
    resourceId: challenge.id,
    metadata: {
      purpose: input.purpose,
      method: factor.method,
      resourceKind: input.resourceKind ?? null,
      resourceId: input.resourceId ?? null,
    },
  }, client);
  return {
    challenge,
    method: factor.method,
    destinationMask: factor.destinationMask,
    availableMethods: available.kinds,
    passkeyOptions: null,
    handoffToken: null,
  };
}

/**
 * Which kinds of the policy-narrowed ladder this person can actually answer
 * with, strongest first. Holding is checked here, at start; the factor that
 * answers is re-checked when the approval is spent.
 */
async function resolveAvailableStepUpKinds(
  input: { userId: string; teamId: string; allowedKinds: ReadonlyArray<StepUpFactorKind> },
  client: PrismaClient,
): Promise<{ kinds: StepUpFactorKind[]; idpConnectionId: string | null }> {
  const kinds: StepUpFactorKind[] = [];
  let idpConnectionId: string | null = null;
  for (const kind of input.allowedKinds) {
    if (kind === "PASSKEY") {
      if (await userHasActivePasskey(client, input.userId)) kinds.push(kind);
      continue;
    }
    if (kind === "IDP_REAUTH") {
      const connection = await resolveIdpStepUpConnection(client, {
        userId: input.userId,
        teamId: input.teamId,
      });
      if (connection) {
        idpConnectionId = connection.connectionId;
        kinds.push(kind);
      }
      continue;
    }
    if (kind === "TOTP") {
      const totp = await client.mfaFactor.count({
        where: {
          userId: input.userId,
          kind: "TOTP",
          status: "ACTIVE",
          revokedAt: null,
          verifiedAtUtc: { not: null },
        },
      });
      if (totp > 0) kinds.push(kind);
      continue;
    }
    const contact = await resolveActiveContactFactor(
      { userId: input.userId, kind },
      client,
    );
    if (contact && contact.kind === kind) kinds.push(kind);
  }
  return { kinds, idpConnectionId };
}

/**
 * PASSKEY and IDP_REAUTH challenges. Neither sends anything: a passkey
 * challenge carries the random WebAuthn challenge its assertion must sign; an
 * IdP challenge is completed by a forced, assurance-checked sign-in at the
 * Organization's IdP — or approved at once when THIS session's own IdP
 * sign-in is recent enough and its context is one the policy accepts.
 *
 * Every binding of a code challenge applies: user, workspace, Organization,
 * purpose, resource, session, expiry. The factor binding is set when the
 * challenge is answered (the passkey that signed); an IdP challenge is bound
 * to the SSO connection instead, re-checked when the approval is spent.
 */
async function startLadderChallenge(
  args: {
    input: StartStepUpInput;
    kind: "PASSKEY" | "IDP_REAUTH";
    availableMethods: StepUpFactorKind[];
    idpConnectionId: string | null;
    policy: StepUpOrganizationPolicy | null;
  },
  client: PrismaClient,
): Promise<StartStepUpResult> {
  const { input, kind } = args;
  const ttl = clampTtl(input.ttlSeconds ?? args.policy?.ttlSeconds ?? null);
  const workspace = await client.team.findUnique({
    where: { id: input.teamId },
    select: { organizationId: true },
  });

  let passkeyOptions: Record<string, unknown> | null = null;
  let webauthnChallenge: string | null = null;
  let approvedContext: string | null = null;
  if (kind === "PASSKEY") {
    const built = await buildPasskeyAssertionOptions(client, input.userId);
    if (!built) throw new StepUpError("enrollment_required");
    passkeyOptions = built.options;
    webauthnChallenge = built.challenge;
  } else {
    if (!args.idpConnectionId) throw new StepUpError("enrollment_required");
    const recent = await sessionSatisfiesIdpStepUp(client, {
      sessionIdHash: input.sessionIdHash ?? null,
      userId: input.userId,
      connectionId: args.idpConnectionId,
      policy: args.policy ?? { acceptedContexts: [], maxAgeSeconds: 300, assurance: "STANDARD" },
    });
    approvedContext = recent?.authnContext ?? null;
  }

  const approvedNow = approvedContext !== null;
  const wantsHandoff = kind === "IDP_REAUTH" ? !approvedNow : input.handoff === true;
  const handoffToken = wantsHandoff ? randomBytes(32).toString("base64url") : null;

  const challenge = await client.stepUpChallenge.create({
    data: {
      teamId: input.teamId,
      initiatedByUserId: input.userId,
      purpose: input.purpose,
      resourceKind: input.resourceKind ?? null,
      resourceId: input.resourceId ?? null,
      status: approvedNow
        ? prismaPkg.StepUpChallengeStatus.APPROVED
        : prismaPkg.StepUpChallengeStatus.PENDING,
      approvedAtUtc: approvedNow ? new Date() : null,
      expiresAtUtc: new Date(Date.now() + ttl * 1000),
      reason: input.reason?.slice(0, 400) ?? null,
      sessionIdHash: input.sessionIdHash ?? null,
      organizationId: workspace?.organizationId ?? null,
      method: kind,
      ssoConnectionId: kind === "IDP_REAUTH" ? args.idpConnectionId : null,
      authnContext: approvedContext,
      webauthnChallenge,
      handoffTokenHash: handoffToken ? hashStepUpHandoffToken(handoffToken) : null,
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: approvedNow ? "step_up_approved" : "step_up_started",
      severity: "INFO",
      details: {
        actorUserId: input.userId,
        purpose: input.purpose,
        method: kind,
        resourceKind: input.resourceKind ?? null,
        resourceId: input.resourceId ?? null,
        ...(approvedNow ? { satisfiedBy: "recent_idp_sign_in" } : {}),
      },
    },
    client,
  );
  await emitTenantAudit({
    action: approvedNow ? "identity_security.step_up.approved" : "identity_security.step_up.start",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.userId,
    workspaceId: input.teamId,
    resourceType: "step_up_challenge",
    resourceId: challenge.id,
    metadata: {
      purpose: input.purpose,
      method: kind,
      resourceKind: input.resourceKind ?? null,
      resourceId: input.resourceId ?? null,
    },
  }, client);
  return {
    challenge,
    method: kind,
    destinationMask: null,
    availableMethods: args.availableMethods,
    passkeyOptions,
    handoffToken,
  };
}

// -----------------------------------------------------------------------------
// Check
// -----------------------------------------------------------------------------

export type CheckStepUpInput = {
  teamId: string;
  userId: string;
  challengeId: string;
  // Passed straight to Phase 18 Verify — NEVER persisted, NEVER
  // logged. The verify route already enforces this; we re-state it
  // here so a casual reader sees it.
  code?: string | null;
  /** 2026-10-28 — a WebAuthn assertion (AuthenticationResponseJSON). */
  assertion?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  /**
   * PHASE 12B B3 — the session attempting the verification. A challenge started
   * in one session may only be approved from that same session.
   */
  sessionIdHash?: string | null;
};

export type CheckStepUpResult = {
  challenge: prismaPkg.StepUpChallenge;
};

export async function checkStepUpChallenge(
  input: CheckStepUpInput,
  client: PrismaClient = defaultPrisma,
): Promise<CheckStepUpResult> {
  const row = await client.stepUpChallenge.findFirst({
    where: { id: input.challengeId, teamId: input.teamId },
  });
  if (!row) throw new StepUpError("challenge_not_found");
  if (row.initiatedByUserId !== input.userId) {
    // We deliberately surface a generic not_found so an attacker
    // cannot enumerate other users' challenges.
    throw new StepUpError("challenge_not_found");
  }
  // PHASE 12B B3 — the approval must happen in the session that started the
  // challenge; otherwise a second session could complete someone else's
  // in-flight elevation. Same generic denial, same anti-enumeration reason.
  // Nullish — an absent column means the challenge is session-unbound.
  if (row.sessionIdHash != null) {
    const verifying = input.sessionIdHash ?? null;
    if (verifying === null || verifying !== row.sessionIdHash) {
      throw new StepUpError("challenge_not_found");
    }
  }
  if (row.status !== prismaPkg.StepUpChallengeStatus.PENDING) {
    throw new StepUpError("challenge_consumed");
  }

  // 2026-10-28 — a passkey challenge is answered by an assertion; an IdP
  // challenge only by its IdP round trip. A code never answers either.
  if (row.method === "PASSKEY") {
    const approved = await answerPasskeyChallenge(
      { teamId: input.teamId, userId: input.userId, assertion: input.assertion },
      row,
      client,
    );
    return { challenge: approved };
  }
  if (row.method === "IDP_REAUTH") {
    throw new StepUpError("method_mismatch");
  }
  if (typeof input.code !== "string" || input.code.length === 0) {
    throw new StepUpError("method_mismatch");
  }

  /**
   * PHASE 13 (NEW-058) — THE FACTOR MUST STILL BE THE ONE THAT AUTHORISED THIS.
   *
   * Re-read at CONSUME time, not trusted from issue time. Three things are
   * refused here, and each was reachable before:
   *
   *   * a challenge with NO factor — every row written before this migration.
   *     Treated as unspendable rather than unbound, so the pre-existing window
   *     fails closed and empties as those rows expire (max TTL 1h).
   *   * a factor that has since been REVOKED — the elevation must die with the
   *     enrolment, otherwise revoking a compromised handset leaves an approved
   *     challenge behind that still works.
   *   * a factor whose GENERATION has moved — the user re-enrolled a different
   *     destination between issue and spend, so the approval no longer refers
   *     to the thing it was granted against.
   *
   * The denial is the same generic `challenge_not_found` the ownership and
   * session checks use, for the same anti-enumeration reason.
   */
  if (row.factorId == null || row.factorGeneration == null) {
    throw new StepUpError("challenge_not_found");
  }
  const boundFactor = await client.mfaFactor.findFirst({
    where: {
      id: row.factorId,
      userId: input.userId,
      status: "ACTIVE",
      revokedAt: null,
      verifiedAtUtc: { not: null },
    },
    select: { generation: true, kind: true },
  });
  if (!boundFactor || boundFactor.generation !== row.factorGeneration) {
    throw new StepUpError("challenge_not_found");
  }

  if (row.expiresAtUtc.getTime() <= Date.now()) {
    await client.stepUpChallenge.update({
      where: { id: row.id },
      data: { status: prismaPkg.StepUpChallengeStatus.EXPIRED },
    });
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "step_up_expired",
        severity: "INFO",
        details: {
          actorUserId: input.userId,
          purpose: row.purpose,
        },
      },
      client,
    );
    throw new StepUpError("challenge_expired");
  }

  if (boundFactor.kind === "TOTP") {
    /**
     * PV-STEPUP-001 — an authenticator-app challenge is answered against the
     * bound factor's own secret, and a matching code is CLAIMED: its time step
     * is recorded atomically, so the code cannot approve a second challenge or
     * a sign-in, nor race a concurrent request (WCC-NEW-008). A wrong or
     * replayed code spends the challenge exactly as a wrong SMS code does.
     */
    const accepted = await verifyStepUpTotp(
      { userId: input.userId, factorId: row.factorId, code: input.code },
      client,
    );
    if (!accepted) {
      await recordStepUpDenial(input, row, client);
      throw new StepUpError("denied");
    }
  } else {
    const resolvedDestination = await resolveStepUpDestination(
      { userId: input.userId, factorId: row.factorId },
      client,
    );
    let verifyResult;
    try {
      verifyResult = await checkVerification(
        {
          teamId: input.teamId,
          // NEW-058: the destination comes from the FACTOR that authorised
          // this challenge, re-resolved above — never from the request.
          phoneE164OrRaw: resolvedDestination.destination,
          code: input.code,
          initiatedByUserId: input.userId,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          /**
           * PHASE 13 (NEW-055) — the attempt THIS challenge started.
           *
           * `startStepUpChallenge` persists `verificationAttemptId`, and
           * nothing read it: the verification lookup independently took the
           * most recent STARTED attempt for the recipient, so two concurrent
           * challenges on one number let the code minted for the second
           * approve the first. The binding the schema records is now the
           * binding that is enforced.
           */
          verificationAttemptId: row.verificationAttemptId ?? null,
        },
        client,
      );
    } catch (err) {
      if (err instanceof VerificationError) {
        // Don't leak Verify's exact code surface; surface a generic
        // denial. Phase 18 already audited the specific reason.
        await recordStepUpDenial(input, row, client);
        throw new StepUpError("denied");
      }
      throw err;
    }
    if (verifyResult.status !== "approved") {
      await recordStepUpDenial(input, row, client);
      throw new StepUpError("denied");
    }
  }
  const approved = await client.stepUpChallenge.update({
    where: { id: row.id },
    data: {
      status: prismaPkg.StepUpChallengeStatus.APPROVED,
      approvedAtUtc: new Date(),
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "step_up_approved",
      severity: "INFO",
      details: {
        actorUserId: input.userId,
        purpose: row.purpose,
        resourceKind: row.resourceKind,
        resourceId: row.resourceId,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity_security.step_up.approved",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.userId,
    workspaceId: input.teamId,
    resourceType: "step_up_challenge",
    resourceId: approved.id,
    metadata: {
      purpose: row.purpose,
      resourceKind: row.resourceKind ?? null,
      resourceId: row.resourceId ?? null,
    },
  }, client);
  return { challenge: approved };
}

// -----------------------------------------------------------------------------
// Consume — single-use binding from a sensitive action.
//
// Returns the consumed challenge on success. On failure raises a
// StepUpError that the route layer maps to STEP_UP_REQUIRED. The
// consumed row is marked CANCELLED so it cannot be reused.
// -----------------------------------------------------------------------------

export type ConsumeApprovedChallengeInput = {
  teamId: string;
  userId: string;
  challengeId: string;
  purpose: StepUpPurpose;
  resourceKind?: string | null;
  resourceId?: string | null;
  /**
   * PHASE 12B B3 — the canonical hash of the session SPENDING the challenge.
   * Must equal the session that started it whenever the row carries a binding.
   */
  sessionIdHash?: string | null;
};

export async function consumeApprovedChallenge(
  input: ConsumeApprovedChallengeInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.StepUpChallenge> {
  const row = await client.stepUpChallenge.findFirst({
    where: { id: input.challengeId, teamId: input.teamId },
  });
  if (!row) throw new StepUpError("challenge_not_found");
  if (row.initiatedByUserId !== input.userId) {
    throw new StepUpError("challenge_not_found");
  }
  // PHASE 12B B3 — SESSION BINDING. Enforced whenever the row carries one, so a
  // stolen cookie replayed from a different session cannot spend an elevation
  // the legitimate operator approved on their own device. Rows minted before the
  // binding migration have a null hash and stay session-unbound until they
  // expire (max TTL one hour). Denials are the generic not_found so a caller
  // cannot distinguish "wrong session" from "no such challenge".
  // Nullish, not `!== null`: a row whose column is ABSENT (legacy row, or a
  // projection that did not select it) reads as `undefined`, and an absent
  // binding must mean UNBOUND. Treating `undefined` as "bound" would have made
  // every pre-migration challenge unspendable.
  if (row.sessionIdHash != null) {
    const spending = input.sessionIdHash ?? null;
    if (spending === null || spending !== row.sessionIdHash) {
      throw new StepUpError("challenge_not_found");
    }
  }
  // PHASE 12B B3 — ORGANIZATION BINDING. teamId already scopes the row, but an
  // administrator of two Organizations must not be able to spend an
  // A-minted elevation against a B-owned target, so the Organization the
  // challenge was minted against is re-verified against the target workspace's
  // CURRENT persisted parent.
  // Nullish for the same reason as the session binding above.
  if (row.organizationId != null) {
    const workspace = await client.team.findUnique({
      where: { id: input.teamId },
      select: { organizationId: true },
    });
    if (!workspace || workspace.organizationId !== row.organizationId) {
      throw new StepUpError("challenge_not_found");
    }
  }
  if (row.status !== prismaPkg.StepUpChallengeStatus.APPROVED) {
    throw new StepUpError("challenge_not_found");
  }

  /**
   * PHASE 13 (NEW-058) — FACTOR BINDING, RE-CHECKED AT SPEND TIME.
   *
   * This is the path every step-up-gated mutation actually takes, and it is a
   * DIFFERENT moment from approval: a challenge is approved once and may be
   * spent seconds or minutes later. Checking the factor only at approval would
   * leave the window this fix exists to close — revoke a compromised handset
   * and an already-approved elevation would still work.
   *
   * Three refusals, each reachable:
   *
   *   * NO factor on the challenge — every row written before this migration.
   *     Unspendable rather than unbound, so the pre-existing window fails
   *     CLOSED and empties as those rows expire (max TTL 1h). This is the
   *     opposite of the choice made for the session and organization bindings
   *     above, and deliberately so: those were added to rows that had already
   *     been issued under a weaker contract, whereas a challenge with no factor
   *     is one whose destination nobody ever proved.
   *   * factor REVOKED or no longer ACTIVE — the elevation dies with the
   *     enrolment.
   *   * factor GENERATION moved — the user re-enrolled a different destination
   *     between approval and spend, so the approval no longer refers to the
   *     thing it was granted against.
   *
   * Same generic `challenge_not_found` denial as the bindings above, for the
   * same anti-enumeration reason.
   */
  if (row.method === "IDP_REAUTH") {
    /*
     * 2026-10-28 — an IdP approval is bound to the Organization's SSO
     * connection rather than to a factor row: the connection must still be
     * ACTIVE and the person still linked to it, or the approval dies with
     * the link (the analogue of a revoked factor). It must also carry the
     * context the IdP asserted — an approval without one was never proven.
     */
    if (
      row.ssoConnectionId == null ||
      row.authnContext == null ||
      !(await idpStepUpBindingStillValid(client, {
        userId: input.userId,
        connectionId: row.ssoConnectionId,
      }))
    ) {
      throw new StepUpError("challenge_not_found");
    }
  } else {
    if (row.factorId == null || row.factorGeneration == null) {
      throw new StepUpError("challenge_not_found");
    }
    const spendingFactor = await client.mfaFactor.findFirst({
      where: {
        id: row.factorId,
        userId: input.userId,
        status: "ACTIVE",
        revokedAt: null,
        verifiedAtUtc: { not: null },
      },
      select: { generation: true, kind: true },
    });
    if (!spendingFactor || spendingFactor.generation !== row.factorGeneration) {
      throw new StepUpError("challenge_not_found");
    }
    // A row that names its method must have been answered by that kind.
    if (row.method != null && row.method !== spendingFactor.kind) {
      throw new StepUpError("challenge_not_found");
    }
  }

  if (row.expiresAtUtc.getTime() <= Date.now()) {
    await client.stepUpChallenge.update({
      where: { id: row.id },
      data: { status: prismaPkg.StepUpChallengeStatus.EXPIRED },
    });
    throw new StepUpError("challenge_expired");
  }
  // Phase 4 closure — back-compat: a challenge row stored with a
  // legacy purpose (SERVICE_ACCOUNT_CREATE / SERVICE_ACCOUNT_REVOKE /
  // SERVICE_ACCOUNT_HARDENING_UPDATE) STILL satisfies the
  // corresponding new INTEGRATION_* purpose check, per
  // LEGACY_STEP_UP_PURPOSE_ALIASES in @proovra/shared. Exact-match
  // remains the common case; the alias map only kicks in when the
  // stored row is a legacy value. The reverse direction (new purpose
  // satisfying a legacy check) is intentionally NOT allowed.
  if (!purposeSatisfies(row.purpose, input.purpose)) {
    throw new StepUpError("challenge_purpose_mismatch");
  }
  const expectedResourceId = input.resourceId ?? null;
  const expectedResourceKind = input.resourceKind ?? null;
  if (row.resourceId !== expectedResourceId) {
    throw new StepUpError("challenge_resource_mismatch");
  }
  if (row.resourceKind !== expectedResourceKind) {
    throw new StepUpError("challenge_resource_mismatch");
  }
  // Atomic consume: only one consumer wins.
  const result = await client.stepUpChallenge.updateMany({
    where: {
      id: row.id,
      status: prismaPkg.StepUpChallengeStatus.APPROVED,
    },
    data: { status: prismaPkg.StepUpChallengeStatus.CANCELLED },
  });
  if (result.count === 0) {
    throw new StepUpError("challenge_consumed");
  }
  const consumed = await client.stepUpChallenge.findUniqueOrThrow({
    where: { id: row.id },
  });
  return consumed;
}

// -----------------------------------------------------------------------------
// 2026-10-28 — answering ladder challenges
// -----------------------------------------------------------------------------

/**
 * A PASSKEY challenge answered by an assertion. The assertion must be signed
 * over THIS challenge's random value by one of THIS person's ACTIVE passkeys,
 * with user verification; the approval is then bound to that passkey's factor
 * and generation, so revoking the passkey kills it exactly as revoking a
 * phone does. A failed assertion spends the challenge (one attempt each).
 */
async function answerPasskeyChallenge(
  input: { teamId: string; userId: string; assertion: unknown },
  row: prismaPkg.StepUpChallenge,
  client: PrismaClient,
): Promise<prismaPkg.StepUpChallenge> {
  if (row.expiresAtUtc.getTime() <= Date.now()) {
    await client.stepUpChallenge.updateMany({
      where: { id: row.id, status: prismaPkg.StepUpChallengeStatus.PENDING },
      data: { status: prismaPkg.StepUpChallengeStatus.EXPIRED },
    });
    throw new StepUpError("challenge_expired");
  }
  if (input.assertion == null || row.webauthnChallenge == null) {
    throw new StepUpError("method_mismatch");
  }
  const verified = await verifyPasskeyAssertion(client, {
    userId: row.initiatedByUserId,
    expectedChallenge: row.webauthnChallenge,
    assertion: input.assertion,
  });
  if (!verified) {
    await recordStepUpDenial({ teamId: input.teamId, userId: input.userId }, row, client);
    throw new StepUpError("denied");
  }
  return markLadderChallengeApproved(
    row,
    { factorId: verified.factorId, factorGeneration: verified.generation, authnContext: null },
    client,
  );
}

/**
 * The single transition PENDING -> APPROVED for a ladder challenge, guarded so
 * two answers cannot both approve (and a cancelled or expired row stays so).
 * The webauthn challenge and the handoff hash are cleared: neither can be
 * used again.
 */
async function markLadderChallengeApproved(
  row: prismaPkg.StepUpChallenge,
  binding: { factorId: string | null; factorGeneration: number | null; authnContext: string | null },
  client: PrismaClient,
): Promise<prismaPkg.StepUpChallenge> {
  const moved = await client.stepUpChallenge.updateMany({
    where: {
      id: row.id,
      status: prismaPkg.StepUpChallengeStatus.PENDING,
      expiresAtUtc: { gt: new Date() },
    },
    data: {
      status: prismaPkg.StepUpChallengeStatus.APPROVED,
      approvedAtUtc: new Date(),
      factorId: binding.factorId,
      factorGeneration: binding.factorGeneration,
      authnContext: binding.authnContext,
      webauthnChallenge: null,
      handoffTokenHash: null,
    },
  });
  if (moved.count === 0) throw new StepUpError("challenge_consumed");
  const approved = await client.stepUpChallenge.findUniqueOrThrow({ where: { id: row.id } });
  safeEmitSecurityEvent(
    {
      teamId: row.teamId,
      eventType: "step_up_approved",
      severity: "INFO",
      details: {
        actorUserId: row.initiatedByUserId,
        purpose: row.purpose,
        method: row.method,
        resourceKind: row.resourceKind,
        resourceId: row.resourceId,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity_security.step_up.approved",
    outcome: "success",
    sourceApp: "API",
    actorUserId: row.initiatedByUserId,
    workspaceId: row.teamId,
    resourceType: "step_up_challenge",
    resourceId: row.id,
    metadata: {
      purpose: row.purpose,
      method: row.method,
      resourceKind: row.resourceKind ?? null,
      resourceId: row.resourceId ?? null,
    },
  }, client);
  return approved;
}

/**
 * THE SYSTEM-BROWSER HANDOFF. A challenge started by the app (or by a page
 * that opens an IdP popup) is completed in a browser that does not hold the
 * app's session. The handoff token — 256 random bits, returned once at start,
 * stored only as a hash — names the ONE challenge it may complete, and a
 * completed or expired challenge refuses it. Completing the challenge is all
 * it can do: spending the approval still requires the session that started
 * it, so a leaked handoff link is useless to anyone but that session.
 */
export async function loadHandoffChallenge(
  input: { challengeId: string; handoffToken: string; method: "PASSKEY" | "IDP_REAUTH" },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.StepUpChallenge> {
  const row = await client.stepUpChallenge.findUnique({ where: { id: input.challengeId } });
  if (
    !row ||
    row.method !== input.method ||
    row.handoffTokenHash == null ||
    row.handoffTokenHash !== hashStepUpHandoffToken(input.handoffToken) ||
    row.status !== prismaPkg.StepUpChallengeStatus.PENDING
  ) {
    throw new StepUpError("challenge_not_found");
  }
  if (row.expiresAtUtc.getTime() <= Date.now()) {
    throw new StepUpError("challenge_expired");
  }
  return row;
}

/**
 * The IdP round trip begins: the handoff is spent (once), so the same link
 * cannot start a second sign-in for this challenge. Returns the challenge and
 * its connection for the protocol redirect.
 */
export async function beginIdpHandoff(
  input: { challengeId: string; handoffToken: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.StepUpChallenge> {
  const row = await loadHandoffChallenge({ ...input, method: "IDP_REAUTH" }, client);
  const spent = await client.stepUpChallenge.updateMany({
    where: { id: row.id, handoffUsedAtUtc: null, status: prismaPkg.StepUpChallengeStatus.PENDING },
    data: { handoffUsedAtUtc: new Date() },
  });
  if (spent.count === 0) throw new StepUpError("challenge_consumed");
  return row;
}

/** The WebAuthn request options for a PASSKEY challenge's stored challenge. */
export async function passkeyOptionsForChallenge(
  row: prismaPkg.StepUpChallenge,
  client: PrismaClient = defaultPrisma,
): Promise<Record<string, unknown> | null> {
  if (row.method !== "PASSKEY" || row.webauthnChallenge == null) return null;
  const built = await buildPasskeyAssertionOptions(
    client,
    row.initiatedByUserId,
    row.webauthnChallenge,
  );
  return built?.options ?? null;
}

/** A passkey answered in the handoff browser for an app-started challenge. */
export async function answerPasskeyHandoff(
  input: { challengeId: string; handoffToken: string; assertion: unknown },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.StepUpChallenge> {
  const row = await loadHandoffChallenge(
    { challengeId: input.challengeId, handoffToken: input.handoffToken, method: "PASSKEY" },
    client,
  );
  return answerPasskeyChallenge(
    { teamId: row.teamId, userId: row.initiatedByUserId, assertion: input.assertion },
    row,
    client,
  );
}

/**
 * The IdP returned. The caller (the SAML ACS / OIDC callback branch) has
 * verified the assertion or ID token, that its subject is linked to the
 * person who started the challenge at this connection, that it is fresh, and
 * that its context satisfies the Organization's policy. Only then is this
 * called; it binds the approval to the connection and the asserted context.
 */
export async function approveIdpChallenge(
  input: { challengeId: string; userId: string; connectionId: string; authnContext: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.StepUpChallenge> {
  const row = await client.stepUpChallenge.findUnique({ where: { id: input.challengeId } });
  if (
    !row ||
    row.method !== "IDP_REAUTH" ||
    row.initiatedByUserId !== input.userId ||
    row.ssoConnectionId !== input.connectionId ||
    row.handoffUsedAtUtc == null
  ) {
    throw new StepUpError("challenge_not_found");
  }
  return markLadderChallengeApproved(
    row,
    { factorId: null, factorGeneration: null, authnContext: input.authnContext.slice(0, 256) },
    client,
  );
}

/**
 * Status of one's own challenge — what a page waiting on a popup or the app
 * waiting on a system browser polls. Never reveals another person's row.
 */
export async function readOwnStepUpChallenge(
  input: { teamId: string; userId: string; challengeId: string; sessionIdHash: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ status: string; method: string | null; expiresAtUtc: string }> {
  const row = await client.stepUpChallenge.findFirst({
    where: { id: input.challengeId, teamId: input.teamId, initiatedByUserId: input.userId },
    select: { status: true, method: true, expiresAtUtc: true, sessionIdHash: true },
  });
  if (!row) throw new StepUpError("challenge_not_found");
  if (row.sessionIdHash != null && row.sessionIdHash !== input.sessionIdHash) {
    throw new StepUpError("challenge_not_found");
  }
  return {
    status: row.status,
    method: row.method,
    expiresAtUtc: row.expiresAtUtc.toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type StepUpFactor = {
  method: StepUpFactorKind;
  factorId: string;
  generation: number;
  destinationMask: string | null;
};

/**
 * PV-STEPUP-001 — the factor a step-up challenge is answered with.
 *
 * Only kinds the purpose's policy admits are considered (the policy is total;
 * see STEP_UP_PURPOSE_FACTOR_POLICY). With no preference the account's
 * authenticator app wins — it involves no provider, no delivery and no phone
 * number — and the verified phone is the fallback. A named channel or
 * `factorId` NARROWS the choice among factors the account already holds; it
 * can never introduce one (NEW-058). Null means there is nothing this purpose
 * accepts, which the caller turns into `enrollment_required`.
 */
async function resolveStepUpFactor(
  input: {
    userId: string;
    purpose: StepUpPurpose;
    factorId: string | null;
    channel: StepUpFactorKind | null;
    /** The purpose's kinds as narrowed by the Organization's policy. */
    allowedKinds?: ReadonlyArray<StepUpFactorKind>;
  },
  client: PrismaClient,
): Promise<StepUpFactor | null> {
  const allowed = input.allowedKinds ?? stepUpFactorKindsFor(input.purpose);
  const channel = input.channel;
  if (channel !== null && !allowed.includes(channel)) return null;

  if (allowed.includes("TOTP") && (channel === null || channel === "TOTP")) {
    const totp = await client.mfaFactor.findFirst({
      where: {
        userId: input.userId,
        kind: "TOTP",
        status: "ACTIVE",
        revokedAt: null,
        verifiedAtUtc: { not: null },
        ...(input.factorId ? { id: input.factorId } : {}),
      },
      select: { id: true, generation: true },
      orderBy: { verifiedAtUtc: "desc" },
    });
    if (totp) {
      return {
        method: "TOTP",
        factorId: totp.id,
        generation: totp.generation,
        destinationMask: null,
      };
    }
  }
  // A code factor answers only as one of the code kinds; the ladder kinds are
  // answered by startLadderChallenge, never here.
  if (channel !== null && channel !== "SMS" && channel !== "WHATSAPP") return null;

  const contact = await resolveActiveContactFactor(
    {
      userId: input.userId,
      factorId: input.factorId ?? undefined,
      kind: channel ?? undefined,
    },
    client,
  );
  if (!contact || !allowed.includes(contact.kind)) return null;
  return {
    method: contact.kind,
    factorId: contact.factorId,
    generation: contact.generation,
    destinationMask: contact.destinationMask,
  };
}

/**
 * PV-STEPUP-001 — verify an authenticator code against the factor the
 * challenge is bound to, and CLAIM its time step so the code cannot be
 * accepted again — here, at sign-in, or by a concurrent request
 * (WCC-NEW-008). False for a wrong code, a replayed code, or a factor that
 * is no longer an active authenticator of this user.
 */
async function verifyStepUpTotp(
  input: { userId: string; factorId: string; code: string },
  client: PrismaClient,
): Promise<boolean> {
  const factor = await client.mfaFactor.findFirst({
    where: {
      id: input.factorId,
      userId: input.userId,
      kind: "TOTP",
      status: "ACTIVE",
      revokedAt: null,
    },
    select: {
      id: true,
      secretCiphertext: true,
      secretIv: true,
      secretAuthTag: true,
      secretKekId: true,
      digits: true,
      periodSeconds: true,
    },
  });
  if (!factor) return false;
  const secret = openSecret(requireTotpSecret(factor));
  const step = matchTotpStep(secret, input.code, {
    digits: factor.digits,
    period: factor.periodSeconds,
  });
  if (step === null) return false;
  return claimTotpStep(client, factor.id, step, factor.periodSeconds);
}

/**
 * A refused check: the challenge is spent (one attempt per challenge), the
 * denial is recorded, and the failed-OTP burst detector is told. The caller
 * throws the generic `denied` so no branch is distinguishable from outside.
 */
async function recordStepUpDenial(
  input: { teamId: string; userId: string },
  row: { id: string; purpose: string },
  client: PrismaClient,
): Promise<void> {
  await client.stepUpChallenge.update({
    where: { id: row.id },
    data: { status: prismaPkg.StepUpChallengeStatus.DENIED },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "step_up_denied",
      severity: "WARNING",
      details: { actorUserId: input.userId, purpose: row.purpose },
    },
    client,
  );
  await maybeFireFailedOtpBurst(
    { teamId: input.teamId, userId: input.userId },
    client,
  );
}

function clampTtl(value: number | null): number {
  if (value === null || value === undefined) return STEP_UP_TTL_DEFAULT_SECONDS;
  if (!Number.isFinite(value) || value < 60) return 60;
  return Math.min(STEP_UP_TTL_MAX_SECONDS, Math.floor(value));
}

function mapVerifyErrorToStepUp(code: string): StepUpErrorCode {
  switch (code) {
    case "feature_disabled":
      return "feature_disabled";
    case "invalid_phone":
      return "invalid_phone";
    case "provider_unconfigured":
      return "provider_unconfigured";
    case "provider_unreachable":
      return "provider_unreachable";
    case "rate_limited":
      return "rate_limited";
    default:
      return "provider_rejected";
  }
}

// -----------------------------------------------------------------------------
// Projection
// -----------------------------------------------------------------------------

export function projectStepUpChallenge(c: prismaPkg.StepUpChallenge): {
  id: string;
  purpose: string;
  resourceKind: string | null;
  resourceId: string | null;
  status: string;
  method: string | null;
  expiresAtUtc: string;
  approvedAtUtc: string | null;
  createdAt: string;
} {
  return {
    id: c.id,
    purpose: c.purpose,
    resourceKind: c.resourceKind,
    resourceId: c.resourceId,
    status: c.status,
    method: c.method ?? null,
    expiresAtUtc: c.expiresAtUtc.toISOString(),
    approvedAtUtc: c.approvedAtUtc?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}
