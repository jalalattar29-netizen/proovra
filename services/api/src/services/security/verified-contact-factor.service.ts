/**
 * PHASE 13 (NEW-058) — THE ENROLLED CONTACT FACTOR AUTHORITY.
 *
 * THE DEFECT THIS EXISTS TO REMOVE
 * ---------------------------------------------------------------------------
 * The enterprise step-up gate took its destination from the REQUEST BODY. The
 * route accepted `phone` and the service handed it to the messaging provider
 * verbatim — no lookup against the user, no stored handset, no binding of any
 * kind. So the gate proved possession of a phone the CALLER CHOSE, not
 * possession of the account's second factor: a stolen session supplied the
 * attacker's own number and approved its own challenge, and every
 * step-up-gated mutation in the product inherited that.
 *
 * A second factor that the first factor's holder can choose is not a second
 * factor. This module is where the destination stops being an input.
 *
 * WHY IT LIVES IN `mfa_factors`
 * ---------------------------------------------------------------------------
 * Because that is already the answer to "what does this account hold?", and
 * two identity authorities can disagree. TOTP lives there; a verified handset
 * is the same kind of claim about the same subject, asked at the same moment.
 * The alternative — a second table — would have to be kept in step with the
 * first by remembering, which is the failure mode this programme has spent the
 * most effort removing.
 *
 * WHAT IS NEVER STORED, AND WHAT IS NEVER RETURNED
 * ---------------------------------------------------------------------------
 * The destination is sealed with the SAME envelope scheme as the TOTP secret
 * (`sealSecret` / `openSecret`), because it is PII the product must be able to
 * SEND to and must never be able to DISPLAY back. Only `destinationMask` is
 * ever projected. `destinationHash` is an HMAC — it makes "is this number
 * already enrolled for this user?" answerable without the plaintext, and it is
 * the uniqueness key.
 *
 * The plaintext leaves this module in exactly one direction: into the
 * messaging provider, from `resolveStepUpDestination`. There is no accessor
 * that returns it to a route, and none may be added.
 */

import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import { maskPhonePreview, normaliseToE164 } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { hashRecipientPhone } from "../communications/communication.service.js";
import { openSecret, sealSecret } from "./mfa-secret-storage.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";

export type ContactFactorKind = "SMS" | "WHATSAPP";

export const CONTACT_FACTOR_KINDS: readonly ContactFactorKind[] = [
  "SMS",
  "WHATSAPP",
] as const;

export type VerifiedContactFactorErrorCode =
  | "invalid_destination"
  | "unsupported_channel"
  | "already_enrolled"
  | "factor_not_found"
  | "factor_not_owned"
  | "factor_not_active"
  | "enrollment_not_pending"
  | "enrollment_verification_mismatch";

export class VerifiedContactFactorError extends Error {
  readonly code: VerifiedContactFactorErrorCode;
  constructor(code: VerifiedContactFactorErrorCode) {
    super(code);
    this.code = code;
  }
}

/** What a surface may see. Deliberately carries no destination. */
export type ProjectedContactFactor = {
  factorId: string;
  kind: ContactFactorKind;
  label: string;
  destinationMask: string;
  status: "ENROLLING" | "ACTIVE" | "REVOKED";
  generation: number;
  verifiedAtUtc: string | null;
  revokedAtUtc: string | null;
};

type Db = PrismaClient | Prisma.TransactionClient;

function projected(row: {
  id: string;
  kind: string;
  label: string;
  destinationMask: string | null;
  status: string;
  generation: number;
  verifiedAtUtc: Date | null;
  revokedAt: Date | null;
}): ProjectedContactFactor {
  return {
    factorId: row.id,
    kind: row.kind as ContactFactorKind,
    label: row.label,
    // A contact factor cannot exist without a mask — the database CHECK says
    // so. The fallback is not a default; it is the shape TypeScript needs for
    // a column that is nullable only because TOTP rows share the table.
    destinationMask: row.destinationMask ?? "",
    status: row.status as ProjectedContactFactor["status"],
    generation: row.generation,
    verifiedAtUtc: row.verifiedAtUtc?.toISOString() ?? null,
    revokedAtUtc: row.revokedAt?.toISOString() ?? null,
  };
}

const SELECT = {
  id: true,
  kind: true,
  label: true,
  destinationMask: true,
  status: true,
  generation: true,
  verifiedAtUtc: true,
  revokedAt: true,
} as const;

// ===========================================================================
// Read
// ===========================================================================

/** Every contact factor the user holds, in whatever state. */
export async function listContactFactors(
  userId: string,
  client: Db = defaultPrisma,
): Promise<ProjectedContactFactor[]> {
  const rows = await (client as PrismaClient).mfaFactor.findMany({
    where: { userId, kind: { in: CONTACT_FACTOR_KINDS as unknown as never } },
    select: SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(projected);
}

/**
 * The factor a step-up challenge would use, or null when the account has
 * enrolled none.
 *
 * `null` is the whole point of the enrollment-required denial: it is the
 * difference between "this account cannot elevate yet" and the old behaviour,
 * which was "this account elevates against whatever number it sends".
 */
export async function resolveActiveContactFactor(
  input: { userId: string; kind?: ContactFactorKind; factorId?: string },
  client: Db = defaultPrisma,
): Promise<ProjectedContactFactor | null> {
  const row = await (client as PrismaClient).mfaFactor.findFirst({
    where: {
      userId: input.userId,
      status: "ACTIVE",
      verifiedAtUtc: { not: null },
      revokedAt: null,
      kind: input.kind
        ? (input.kind as unknown as never)
        : ({ in: CONTACT_FACTOR_KINDS } as unknown as never),
      // A factor id supplied by a caller narrows; it never authorises. The
      // ownership, status and verification predicates above still apply, so a
      // factor belonging to another user simply does not match.
      ...(input.factorId ? { id: input.factorId } : {}),
    },
    select: SELECT,
    orderBy: { verifiedAtUtc: "desc" },
  });
  return row ? projected(row) : null;
}

/**
 * The plaintext destination for a factor, for the messaging provider ONLY.
 *
 * Re-reads and re-checks the factor rather than trusting anything the caller
 * carried: a factor revoked between challenge issue and send must not receive
 * a code. The returned value is never projected, logged or returned to a
 * route.
 */
export async function resolveStepUpDestination(
  input: { userId: string; factorId: string },
  client: Db = defaultPrisma,
): Promise<{ destination: string; generation: number; kind: ContactFactorKind }> {
  const row = await (client as PrismaClient).mfaFactor.findFirst({
    where: {
      id: input.factorId,
      userId: input.userId,
      status: "ACTIVE",
      verifiedAtUtc: { not: null },
      revokedAt: null,
      kind: { in: CONTACT_FACTOR_KINDS } as unknown as never,
    },
    select: {
      generation: true,
      kind: true,
      destinationCiphertext: true,
      destinationIv: true,
      destinationAuthTag: true,
      destinationKekId: true,
    },
  });
  if (!row) throw new VerifiedContactFactorError("factor_not_active");
  if (
    !row.destinationCiphertext ||
    !row.destinationIv ||
    !row.destinationAuthTag ||
    !row.destinationKekId
  ) {
    // The CHECK constraint makes this unreachable; treating it as a hard error
    // rather than a fallback means a future schema change that broke the
    // invariant would fail closed here instead of sending to nowhere.
    throw new VerifiedContactFactorError("factor_not_active");
  }
  const destination = openSecret({
    ciphertext: row.destinationCiphertext,
    iv: row.destinationIv,
    authTag: row.destinationAuthTag,
    kekId: row.destinationKekId,
  }).toString("utf8");
  return {
    destination,
    generation: row.generation,
    kind: row.kind as ContactFactorKind,
  };
}

/**
 * The destination of a factor that is still ENROLLING, for the verification
 * check that will activate it.
 *
 * Separate from {@link resolveStepUpDestination} on purpose: that one requires
 * ACTIVE and would refuse a pending enrolment, and this one must never be
 * usable to elevate. Returns `null` — never throws — for every failure mode
 * (missing, not this user's, not pending), so the route can answer one generic
 * denial and disclose nothing about which it was.
 */
export async function resolveEnrollingDestination(
  input: { userId: string; factorId: string },
  client: Db = defaultPrisma,
): Promise<{ destination: string } | null> {
  const row = await (client as PrismaClient).mfaFactor.findFirst({
    where: {
      id: input.factorId,
      userId: input.userId,
      status: "ENROLLING",
      kind: { in: CONTACT_FACTOR_KINDS } as unknown as never,
    },
    select: {
      destinationCiphertext: true,
      destinationIv: true,
      destinationAuthTag: true,
      destinationKekId: true,
    },
  });
  if (
    !row ||
    !row.destinationCiphertext ||
    !row.destinationIv ||
    !row.destinationAuthTag ||
    !row.destinationKekId
  ) {
    return null;
  }
  return {
    destination: openSecret({
      ciphertext: row.destinationCiphertext,
      iv: row.destinationIv,
      authTag: row.destinationAuthTag,
      kekId: row.destinationKekId,
    }).toString("utf8"),
  };
}

// ===========================================================================
// Enrollment
// ===========================================================================

/**
 * Begin enrolling a destination. Creates the factor in ENROLLING — never
 * ACTIVE — so nothing can elevate against it until the code comes back.
 *
 * Idempotent on (user, kind, destination): re-starting an enrollment for a
 * number already pending returns the same row rather than creating a second
 * one, which is what stops a caller racing two enrollments and using either
 * code for either row.
 */
export async function startContactFactorEnrollment(
  input: {
    userId: string;
    kind: ContactFactorKind;
    destinationRaw: string;
    label?: string;
  },
  client: Db = defaultPrisma,
): Promise<{ factor: ProjectedContactFactor; destinationE164: string }> {
  if (!CONTACT_FACTOR_KINDS.includes(input.kind)) {
    throw new VerifiedContactFactorError("unsupported_channel");
  }
  const e164 = normaliseToE164(input.destinationRaw);
  if (!e164) throw new VerifiedContactFactorError("invalid_destination");

  const destinationHash = hashRecipientPhone(e164);
  const db = client as PrismaClient;

  const existing = await db.mfaFactor.findFirst({
    where: { userId: input.userId, kind: input.kind as unknown as never, destinationHash },
    select: { ...SELECT, revokedAt: true },
  });
  if (existing && existing.status === "ACTIVE") {
    throw new VerifiedContactFactorError("already_enrolled");
  }
  if (existing && existing.status === "ENROLLING") {
    return { factor: projected(existing), destinationE164: e164 };
  }

  const sealed = sealSecret(Buffer.from(e164, "utf8"));
  const row = await db.mfaFactor.upsert({
    where: {
      userId_kind_destinationHash: {
        userId: input.userId,
        kind: input.kind as unknown as never,
        destinationHash,
      },
    },
    create: {
      userId: input.userId,
      kind: input.kind as unknown as never,
      status: "ENROLLING",
      label: (input.label ?? `${input.kind} ${maskPhonePreview(e164)}`).slice(0, 60),
      destinationCiphertext: Buffer.from(sealed.ciphertext),
      destinationIv: Buffer.from(sealed.iv),
      destinationAuthTag: Buffer.from(sealed.authTag),
      destinationKekId: sealed.kekId,
      destinationHash,
      destinationMask: maskPhonePreview(e164).slice(0, 32),
    },
    update: {
      // A previously REVOKED enrolment being restarted: the row returns to
      // ENROLLING and its generation moves, so any challenge minted against
      // the old generation is already unspendable.
      status: "ENROLLING",
      verifiedAtUtc: null,
      revokedAt: null,
      revokedReason: null,
      generation: { increment: 1 },
      destinationCiphertext: Buffer.from(sealed.ciphertext),
      destinationIv: Buffer.from(sealed.iv),
      destinationAuthTag: Buffer.from(sealed.authTag),
      destinationKekId: sealed.kekId,
      destinationMask: maskPhonePreview(e164).slice(0, 32),
    },
    select: SELECT,
  });

  safeEmitSecurityEvent(
    {
      teamId: null,
      eventType: "mfa_contact_factor_enrollment_started",
      severity: "INFO",
      details: {
        actorUserId: input.userId,
        factorId: row.id,
        kind: input.kind,
        destinationMask: row.destinationMask,
      },
    },
    client as PrismaClient,
  );

  return { factor: projected(row), destinationE164: e164 };
}

/**
 * Activate an enrolment, ONCE, and only for the verification attempt this
 * enrolment started.
 *
 * The `verificationAttemptId` predicate is what stops one challenge approving
 * another: two concurrent enrolments on the same account each carry their own
 * attempt, and a code minted for one cannot satisfy the other. The transition
 * is a conditional UPDATE on `status = 'ENROLLING'`, so two concurrent
 * completions produce exactly one activation.
 */
export async function completeContactFactorEnrollment(
  input: { userId: string; factorId: string },
  client: Db = defaultPrisma,
): Promise<ProjectedContactFactor> {
  const db = client as PrismaClient;
  const now = new Date();
  const result = await db.mfaFactor.updateMany({
    where: {
      id: input.factorId,
      userId: input.userId,
      status: "ENROLLING",
    },
    data: {
      status: "ACTIVE",
      verifiedAtUtc: now,
      enrolledAt: now,
    },
  });
  if (result.count !== 1) {
    // Either the factor is not this user's, or it is not pending — both mean
    // "this activation did not happen", and neither may be reported as
    // success. A second concurrent completion lands here.
    throw new VerifiedContactFactorError("enrollment_not_pending");
  }

  const row = await db.mfaFactor.findUniqueOrThrow({
    where: { id: input.factorId },
    select: SELECT,
  });

  safeEmitSecurityEvent(
    {
      teamId: null,
      eventType: "mfa_contact_factor_enrolled",
      severity: "INFO",
      details: {
        actorUserId: input.userId,
        factorId: row.id,
        kind: row.kind,
        destinationMask: row.destinationMask,
        generation: row.generation,
      },
    },
    client as PrismaClient,
  );
  return projected(row);
}

/** Revoke a factor. Bumps the generation, so pending challenges die with it. */
export async function revokeContactFactor(
  input: { userId: string; factorId: string; reason?: string },
  client: Db = defaultPrisma,
): Promise<ProjectedContactFactor> {
  const db = client as PrismaClient;
  const result = await db.mfaFactor.updateMany({
    where: { id: input.factorId, userId: input.userId, revokedAt: null },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      revokedReason: (input.reason ?? "user_revoked").slice(0, 120),
      generation: { increment: 1 },
    },
  });
  if (result.count !== 1) throw new VerifiedContactFactorError("factor_not_found");

  const row = await db.mfaFactor.findUniqueOrThrow({
    where: { id: input.factorId },
    select: SELECT,
  });
  safeEmitSecurityEvent(
    {
      teamId: null,
      eventType: "mfa_contact_factor_revoked",
      severity: "WARNING",
      details: {
        actorUserId: input.userId,
        factorId: row.id,
        kind: row.kind,
        generation: row.generation,
      },
    },
    client as PrismaClient,
  );
  return projected(row);
}

/**
 * A stable, non-disclosing fingerprint of a destination, for tests and audit
 * correlation. Never reversible, never the hash used for lookup.
 */
export function destinationFingerprint(e164: string): string {
  return createHash("sha256").update(e164).digest("hex").slice(0, 16);
}
