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
  type StepUpPurpose,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import {
  VerificationError,
  checkVerification,
  startVerification,
} from "../communications/verification.service.js";
import { maybeFireFailedOtpBurst } from "./risk.service.js";

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
  phoneE164OrRaw: string;
  channel: "SMS" | "WHATSAPP";
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
};

export async function startStepUpChallenge(
  input: StartStepUpInput,
  client: PrismaClient = defaultPrisma,
): Promise<StartStepUpResult> {
  // Translate Verify errors -> StepUpError codes so the route surface
  // is uniform.
  let verification;
  try {
    verification = await startVerification(
      {
        teamId: input.teamId,
        channel: input.channel,
        phoneE164OrRaw: input.phoneE164OrRaw,
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
      verificationAttemptId: verification.attempt.id,
      expiresAtUtc: expiresAt,
      reason: input.reason?.slice(0, 400) ?? null,
      sessionIdHash: input.sessionIdHash ?? null,
      organizationId: workspace?.organizationId ?? null,
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
      resourceKind: input.resourceKind ?? null,
      resourceId: input.resourceId ?? null,
    },
  }, client);
  return { challenge };
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
  phoneE164OrRaw: string;
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

  let verifyResult;
  try {
    verifyResult = await checkVerification(
      {
        teamId: input.teamId,
        phoneE164OrRaw: input.phoneE164OrRaw,
        code: input.code,
        initiatedByUserId: input.userId,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      client,
    );
  } catch (err) {
    if (err instanceof VerificationError) {
      // Don't leak Verify's exact code surface; surface a generic
      // denial. Phase 18 already audited the specific reason.
      await client.stepUpChallenge.update({
        where: { id: row.id },
        data: { status: prismaPkg.StepUpChallengeStatus.DENIED },
      });
      safeEmitSecurityEvent(
        {
          teamId: input.teamId,
          eventType: "step_up_denied",
          severity: "WARNING",
          details: {
            actorUserId: input.userId,
            purpose: row.purpose,
          },
        },
        client,
      );
      // Fire a FAILED_OTP_BURST signal best-effort.
      await maybeFireFailedOtpBurst(
        { teamId: input.teamId, userId: input.userId },
        client,
      );
      throw new StepUpError("denied");
    }
    throw err;
  }
  if (verifyResult.status !== "approved") {
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
    throw new StepUpError("denied");
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
