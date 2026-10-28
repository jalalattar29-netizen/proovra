/**
 * PASSKEY ENROLMENT (2026-10-28) — how an account acquires, lists and removes
 * the WebAuthn passkeys / security keys the step-up ladder answers with.
 *
 * ONE AUTHORITY. A passkey IS an MfaFactor (kind PASSKEY). Its lifecycle —
 * ACTIVE / REVOKED, `verifiedAtUtc`, `revokedAt`, `generation` — is the
 * existing factor lifecycle, so everything that already reasons about factors
 * (the step-up spend-time re-check, account lifecycle, admin views) reasons
 * about passkeys without a second store. `MfaWebauthnCredential` carries only
 * what verification needs: the credential id, the COSE public key, the sign
 * counter, transports and the backed-up flag. No private material exists
 * server-side, and nothing secret is ever audited.
 *
 * THE REGISTRATION TICKET. WebAuthn registration is two requests: the options
 * (which carry a random challenge) and the authenticator's response (which
 * signs it). The challenge has to survive between them without a new table, so
 * it travels in a short-lived ticket the server HMAC-signs:
 *
 *   payload = { v, purpose, sub (user), sid (session hash), ch (challenge), exp }
 *
 *   - signed with IDENTITY_SECURITY_HASH_SECRET under a purpose label, so a
 *     ticket cannot be forged and no other signed artefact verifies as one;
 *   - bound to the user AND the session that passed the account step-up, so a
 *     ticket lifted from one session is useless in another;
 *   - lives at most five minutes;
 *   - SINGLE-USE: on a verified response it is spent in the shared rate-limit
 *     store with a bound of one per ticket ("global" bound — when the shared
 *     store cannot answer, registration refuses rather than letting the ticket
 *     be spent twice). The ticket was only ever issued after an account
 *     step-up, so single use means one step-up binds at most one passkey.
 */
import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { resolveSecret } from "../../config/index.js";
import { prisma as defaultPrisma } from "../../db.js";
import {
  conflictRefusal,
  inputRefusal,
  notFoundRefusal,
  providerUnavailable,
  type DomainError,
} from "../../errors.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { enforceRateLimit } from "../rate-limit.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { tryResolveWebauthnConfig, type WebauthnConfig } from "./webauthn-config.js";

/** How long a registration ticket lives. */
export const PASSKEY_REGISTRATION_TICKET_TTL_SECONDS = 5 * 60;
/** A bound on how many ACTIVE passkeys one account may hold. */
export const PASSKEY_MAX_ACTIVE_PER_USER = 20;
/** MfaFactor.label is VARCHAR(60). */
export const PASSKEY_LABEL_MAX = 60;

const TICKET_PURPOSE = "passkey_registration";
const TICKET_SECRET_ENV = "IDENTITY_SECURITY_HASH_SECRET";
const TICKET_HMAC_LABEL = "proovra.passkey-registration-ticket.v1|";

// -----------------------------------------------------------------------------
// Shared reads (the step-up verifier in step-up-passkey.ts uses these too)
// -----------------------------------------------------------------------------

/** How long the browser may wait for the authenticator. */
export const PASSKEY_CEREMONY_TIMEOUT_MS = 60_000;

const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

export function sanitizeTransports(raw: unknown): AuthenticatorTransportFuture[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(raw.filter((t): t is string => typeof t === "string" && KNOWN_TRANSPORTS.has(t))),
  ) as AuthenticatorTransportFuture[];
}

/** The ACTIVE factor predicate every passkey read shares. */
export const ACTIVE_PASSKEY_FACTOR = {
  kind: "PASSKEY",
  status: "ACTIVE",
  revokedAt: null,
  verifiedAtUtc: { not: null },
} as const;

/** The credentials of this user's ACTIVE, verified, unrevoked passkeys. */
export async function activePasskeyCredentials(
  client: PrismaClient,
  userId: string,
): Promise<Array<{ credentialId: string; transports: string[] }>> {
  return client.mfaWebauthnCredential.findMany({
    where: { userId, factor: { userId, ...ACTIVE_PASSKEY_FACTOR } },
    select: { credentialId: true, transports: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * The one write the step-up verifier needs on the factor: when it was last
 * used. Lives here so this module stays the ONLY passkey writer of
 * mfa_factors (the NEW-058 orchestrator boundary).
 */
export async function recordPasskeyUse(client: PrismaClient, factorId: string): Promise<void> {
  await client.mfaFactor.updateMany({
    where: { id: factorId, ...ACTIVE_PASSKEY_FACTOR },
    data: { lastUsedAt: new Date() },
  });
}

// -----------------------------------------------------------------------------
// Errors — every refusal is a bounded DomainError (EXPECTED_DENIAL), never a
// Sentry incident.
// -----------------------------------------------------------------------------

function unavailable(): DomainError {
  return providerUnavailable({
    code: "PASSKEYS_UNAVAILABLE",
    message: "Passkeys are not available right now.",
    provider: "webauthn",
    reason: "relying party configuration is missing or invalid",
    setting: "WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS / APP_BASE_URL",
  });
}

function registrationRefused(): DomainError {
  // One code for every way a registration can fail to verify — an expired or
  // foreign ticket, a wrong origin, a missing user-verification flag — so the
  // response says nothing about which check caught it.
  return inputRefusal({
    code: "PASSKEY_REGISTRATION_INVALID",
    message: "That passkey could not be registered. Start again.",
  });
}

function requireConfig(): WebauthnConfig {
  const config = tryResolveWebauthnConfig();
  if (!config) throw unavailable();
  return config;
}

// -----------------------------------------------------------------------------
// Ticket
// -----------------------------------------------------------------------------

type TicketPayload = {
  v: 1;
  purpose: typeof TICKET_PURPOSE;
  sub: string;
  sid: string | null;
  ch: string;
  exp: number;
};

function ticketMac(body: string): Buffer {
  return createHmac("sha256", resolveSecret(TICKET_SECRET_ENV))
    .update(TICKET_HMAC_LABEL + body, "utf8")
    .digest();
}

function signTicket(payload: TicketPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${ticketMac(body).toString("base64url")}`;
}

function readTicket(
  ticket: string,
  expect: { userId: string; sessionIdHash: string | null },
): TicketPayload | null {
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const expected = ticketMac(body);
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TicketPayload;
  } catch {
    return null;
  }
  if (
    payload?.v !== 1 ||
    payload.purpose !== TICKET_PURPOSE ||
    payload.sub !== expect.userId ||
    (payload.sid ?? null) !== (expect.sessionIdHash ?? null) ||
    typeof payload.ch !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp * 1000 <= Date.now()
  ) {
    return null;
  }
  return payload;
}

// -----------------------------------------------------------------------------
// List
// -----------------------------------------------------------------------------

export type PasskeySummary = {
  /** The owning MfaFactor id — what DELETE takes. */
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
  transports: string[];
};

/** The caller's own ACTIVE passkeys. Never another person's. */
export async function listOwnPasskeys(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<PasskeySummary[]> {
  const rows = await client.mfaFactor.findMany({
    where: {
      userId,
      kind: "PASSKEY",
      status: "ACTIVE",
      revokedAt: null,
      verifiedAtUtc: { not: null },
      webauthnCredential: { isNot: null },
    },
    select: {
      id: true,
      label: true,
      createdAt: true,
      lastUsedAt: true,
      webauthnCredential: { select: { backedUp: true, transports: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    backedUp: r.webauthnCredential?.backedUp ?? false,
    transports: sanitizeTransports(r.webauthnCredential?.transports ?? []),
  }));
}

// -----------------------------------------------------------------------------
// Registration — options
// -----------------------------------------------------------------------------

/** The WebAuthn user handle: the account id's 16 bytes, never an e-mail. */
function userHandle(userId: string): Uint8Array {
  const hex = userId.replace(/-/g, "");
  return /^[0-9a-f]{32}$/i.test(hex)
    ? new Uint8Array(Buffer.from(hex, "hex"))
    : new Uint8Array(createHash("sha256").update(userId, "utf8").digest().subarray(0, 32));
}

/**
 * The caller MUST already have passed the account-tier step-up
 * (`passkey_register`); the route enforces it before calling this.
 */
export async function beginPasskeyRegistration(
  input: { userId: string; sessionIdHash: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ options: Record<string, unknown>; ticket: string; expiresAt: string }> {
  const config = requireConfig();
  const user = await client.user.findUnique({
    where: { id: input.userId },
    select: { email: true, displayName: true },
  });
  if (!user) throw notFoundRefusal();
  const existing = await activePasskeyCredentials(client, input.userId);
  if (existing.length >= PASSKEY_MAX_ACTIVE_PER_USER) {
    throw conflictRefusal({
      code: "PASSKEY_LIMIT_REACHED",
      message: `An account can hold up to ${PASSKEY_MAX_ACTIVE_PER_USER} passkeys. Remove one first.`,
    });
  }
  const challenge = randomBytes(32).toString("base64url");
  const userName = (user.email ?? user.displayName ?? "PROOVRA account").slice(0, 64);
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName,
    userDisplayName: (user.displayName ?? userName).slice(0, 64),
    userID: userHandle(input.userId) as never,
    challenge: new Uint8Array(Buffer.from(challenge, "base64url")) as never,
    timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: sanitizeTransports(c.transports),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  });
  const exp = Math.floor(Date.now() / 1000) + PASSKEY_REGISTRATION_TICKET_TTL_SECONDS;
  const ticket = signTicket({
    v: 1,
    purpose: TICKET_PURPOSE,
    sub: input.userId,
    sid: input.sessionIdHash ?? null,
    ch: challenge,
    exp,
  });
  return {
    options: options as unknown as Record<string, unknown>,
    ticket,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Registration — verify
// -----------------------------------------------------------------------------

function asRegistration(raw: unknown): RegistrationResponseJSON | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const response = r.response as Record<string, unknown> | undefined;
  if (
    typeof r.id !== "string" ||
    r.id.length === 0 ||
    r.id.length > 1024 ||
    typeof r.rawId !== "string" ||
    r.type !== "public-key" ||
    response === null ||
    typeof response !== "object" ||
    typeof response.clientDataJSON !== "string" ||
    typeof response.attestationObject !== "string"
  ) {
    return null;
  }
  return raw as RegistrationResponseJSON;
}

export async function completePasskeyRegistration(
  input: {
    userId: string;
    sessionIdHash: string | null;
    ticket: string;
    label: string;
    response: unknown;
  },
  client: PrismaClient = defaultPrisma,
): Promise<PasskeySummary> {
  const config = requireConfig();
  const label = input.label.trim();
  if (label.length === 0 || label.length > PASSKEY_LABEL_MAX) {
    throw inputRefusal({
      code: "PASSKEY_LABEL_INVALID",
      message: `Give the passkey a name of 1 to ${PASSKEY_LABEL_MAX} characters.`,
    });
  }
  const ticket = readTicket(input.ticket, {
    userId: input.userId,
    sessionIdHash: input.sessionIdHash,
  });
  const response = asRegistration(input.response);
  if (!ticket || !response) throw registrationRefused();

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ticket.ch,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch {
    throw registrationRefused();
  }
  if (!verification.verified || !verification.registrationInfo.userVerified) {
    throw registrationRefused();
  }
  const info = verification.registrationInfo;
  const credentialId = info.credential.id;

  // Duplicate before spending the ticket: re-presenting an authenticator that
  // is already bound (to anyone) is a conflict the user can act on.
  const duplicate = await client.mfaWebauthnCredential.findUnique({
    where: { credentialId },
    select: { id: true },
  });
  if (duplicate) throw duplicateCredential();

  // Spend the ticket — once, across every instance.
  const spent = await enforceRateLimit({
    key: `passkey-registration-ticket:${createHash("sha256").update(input.ticket).digest("hex")}`,
    max: 1,
    windowSec: PASSKEY_REGISTRATION_TICKET_TTL_SECONDS + 60,
    bound: "global",
  });
  if (!spent.allowed) throw registrationRefused();

  const now = new Date();
  let factorId: string;
  try {
    factorId = await client.$transaction(async (tx) => {
      const factor = await tx.mfaFactor.create({
        data: {
          userId: input.userId,
          kind: "PASSKEY",
          status: "ACTIVE",
          label,
          verifiedAtUtc: now,
          enrolledAt: now,
        },
        select: { id: true },
      });
      await tx.mfaWebauthnCredential.create({
        data: {
          factorId: factor.id,
          userId: input.userId,
          credentialId,
          publicKey: Buffer.from(info.credential.publicKey),
          signCount: BigInt(info.credential.counter),
          transports: sanitizeTransports(info.credential.transports ?? response.response.transports),
          aaguid: info.aaguid?.slice(0, 64) ?? null,
          backedUp: info.credentialBackedUp,
        },
      });
      return factor.id;
    });
  } catch (err) {
    if (err instanceof prismaPkg.Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw duplicateCredential();
    }
    throw err;
  }

  safeEmitSecurityEvent(
    {
      teamId: null,
      eventType: "mfa_factor_added",
      severity: "INFO",
      details: { actorUserId: input.userId, factorId, kind: "PASSKEY" },
    },
    client,
  );
  await emitTenantAudit(
    {
      action: "identity_security.passkey.registered",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.userId,
      resourceType: "mfa_factor",
      resourceId: factorId,
      // Never the credential id or key: the backed-up flag and the AAGUID
      // (an authenticator MODEL identifier, not a device serial) only.
      metadata: { kind: "PASSKEY", backedUp: info.credentialBackedUp, aaguid: info.aaguid ?? null },
    },
    client,
  );

  return {
    id: factorId,
    label,
    createdAt: now.toISOString(),
    lastUsedAt: null,
    backedUp: info.credentialBackedUp,
    transports: sanitizeTransports(info.credential.transports ?? []),
  };
}

function duplicateCredential(): DomainError {
  return conflictRefusal({
    code: "PASSKEY_ALREADY_REGISTERED",
    message: "This passkey is already registered.",
  });
}

// -----------------------------------------------------------------------------
// Revoke
// -----------------------------------------------------------------------------

/**
 * The caller MUST already have passed the account-tier step-up
 * (`passkey_remove`). REVOKED, stamped and — the part that matters for
 * step-up — its GENERATION bumped, so an approval this passkey answered but
 * nobody has spent yet dies at spend time. Only the caller's own ACTIVE
 * passkey moves; anything else is the same 404.
 */
export async function revokeOwnPasskey(
  input: { userId: string; factorId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const moved = await client.mfaFactor.updateMany({
    where: { id: input.factorId, userId: input.userId, kind: "PASSKEY", status: "ACTIVE" },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      revokedReason: "user_revoked",
      generation: { increment: 1 },
    },
  });
  if (moved.count === 0) {
    throw notFoundRefusal({ code: "PASSKEY_NOT_FOUND", message: "No such passkey." });
  }
  safeEmitSecurityEvent(
    {
      teamId: null,
      eventType: "mfa_factor_removed",
      severity: "INFO",
      details: { actorUserId: input.userId, factorId: input.factorId, kind: "PASSKEY", reason: "user_revoked" },
    },
    client,
  );
  await emitTenantAudit(
    {
      action: "identity_security.passkey.revoked",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.userId,
      resourceType: "mfa_factor",
      resourceId: input.factorId,
      metadata: { kind: "PASSKEY", reason: "user_revoked" },
    },
    client,
  );
}
