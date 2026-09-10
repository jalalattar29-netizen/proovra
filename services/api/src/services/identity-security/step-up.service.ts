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
import {
  STEP_UP_TTL_DEFAULT_SECONDS,
  STEP_UP_TTL_MAX_SECONDS,
  purposeSatisfies,
  stepUpFactorKindsFor,
  type StepUpFactorKind,
  type StepUpPurpose,
} from "@proovra/shared";
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
  | "denied";

export class StepUpError extends Error {
  readonly code: StepUpErrorCode;
  constructor(code: StepUpErrorCode) {
    super(code);
    this.code = code;
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
};

export type StartStepUpResult = {
  challenge: prismaPkg.StepUpChallenge;
  /** PV-STEPUP-001 — the factor kind this challenge is answered with. */
  method: StepUpFactorKind;
  /** The enrolled phone's mask when a code was sent; null for TOTP. */
  destinationMask: string | null;
};

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
  const factor = await resolveStepUpFactor(
    {
      userId: input.userId,
      purpose: input.purpose,
      factorId: input.factorId ?? null,
      channel: input.channel ?? null,
    },
    client,
  );
  if (!factor) throw new StepUpError("enrollment_required");

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

  const ttl = clampTtl(input.ttlSeconds ?? null);
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
  code: string;
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
    select: { generation: true },
  });
  if (!spendingFactor || spendingFactor.generation !== row.factorGeneration) {
    throw new StepUpError("challenge_not_found");
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
  },
  client: PrismaClient,
): Promise<StepUpFactor | null> {
  const allowed = stepUpFactorKindsFor(input.purpose);
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
  if (channel === "TOTP") return null;

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
    expiresAtUtc: c.expiresAtUtc.toISOString(),
    approvedAtUtc: c.approvedAtUtc?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}
