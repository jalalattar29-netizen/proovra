/**
 * PASSKEY STEP-UP — the WebAuthn half of the authenticator ladder
 * (Collaboration Team archive, 2026-10-28).
 *
 * CONTRACT (consumed by step-up.service.ts; implemented here):
 *   - `buildPasskeyAssertionOptions` — null when the user holds no ACTIVE,
 *     verified PASSKEY factor; otherwise a fresh random challenge and the
 *     request options naming every such credential, user verification
 *     REQUIRED.
 *   - `verifyPasskeyAssertion` — verifies an assertion against the stored
 *     challenge for THIS user's credential (origin, RP id, challenge,
 *     signature, user-verified flag, counter regression), advances the sign
 *     counter, and returns the owning factor and its generation; null on any
 *     failure. Never throws for a bad assertion.
 *
 * WHAT IS AND IS NOT AN AUTHORITY HERE. The passkey's LIFECYCLE is its owning
 * MfaFactor row (kind PASSKEY): ACTIVE + verified + not revoked is the only
 * state that may answer, and the factor's generation is what the approval is
 * bound to, so revoking the passkey kills an approved-but-unspent step-up at
 * spend time (step-up.service.ts re-reads it there). MfaWebauthnCredential
 * holds only the verification material — the credential id, its COSE public
 * key and the authenticator's signature counter.
 *
 * REPLAY. The challenge is 256 random bits minted per step-up row and cleared
 * by the guarded PENDING -> APPROVED transition, so an assertion signed over
 * it can approve at most one row. The signature counter is a second, weaker
 * line (many platform passkeys always report 0): a counter that does not move
 * forward, when either side is non-zero, is a cloned or replayed
 * authenticator and is refused; the counter is advanced with a compare-and-
 * set so two concurrent assertions cannot both pass on the same value.
 */
import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";

import {
  ACTIVE_PASSKEY_FACTOR,
  PASSKEY_CEREMONY_TIMEOUT_MS,
  activePasskeyCredentials,
  recordPasskeyUse,
  sanitizeTransports,
} from "./passkey.service.js";
import { tryResolveWebauthnConfig } from "./webauthn-config.js";

export type PasskeyAssertionOptions = {
  /** base64url challenge the assertion must sign; persisted on the row. */
  challenge: string;
  /** PublicKeyCredentialRequestOptionsJSON. */
  options: Record<string, unknown>;
};

export async function userHasActivePasskey(
  client: PrismaClient,
  userId: string,
): Promise<boolean> {
  // A passkey is usable only when the RP is configured; an unusable config
  // must not advertise a method that can never pass.
  if (!tryResolveWebauthnConfig()) return false;
  const count = await client.mfaWebauthnCredential.count({
    where: { userId, factor: { userId, ...ACTIVE_PASSKEY_FACTOR } },
  });
  return count > 0;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * `existingChallenge`: rebuild the options around a challenge already stored
 * on a step-up row (the mobile handoff page asks for them separately).
 */
export async function buildPasskeyAssertionOptions(
  client: PrismaClient,
  userId: string,
  existingChallenge?: string,
): Promise<PasskeyAssertionOptions | null> {
  const config = tryResolveWebauthnConfig();
  if (!config) return null;
  const credentials = await activePasskeyCredentials(client, userId);
  if (credentials.length === 0) return null;
  if (existingChallenge !== undefined && !BASE64URL_RE.test(existingChallenge)) return null;
  const challenge = existingChallenge ?? randomBytes(32).toString("base64url");
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    challenge: new Uint8Array(Buffer.from(challenge, "base64url")),
    timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
    userVerification: "required",
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: sanitizeTransports(c.transports),
    })),
  });
  return { challenge, options: options as unknown as Record<string, unknown> };
}

function asAssertion(raw: unknown): AuthenticationResponseJSON | null {
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
    typeof response.authenticatorData !== "string" ||
    typeof response.signature !== "string"
  ) {
    return null;
  }
  return raw as AuthenticationResponseJSON;
}

export async function verifyPasskeyAssertion(
  client: PrismaClient,
  input: { userId: string; expectedChallenge: string; assertion: unknown },
): Promise<{ factorId: string; generation: number } | null> {
  try {
    const config = tryResolveWebauthnConfig();
    if (!config) return null;
    const assertion = asAssertion(input.assertion);
    if (!assertion) return null;

    // The credential must be THIS user's AND its factor ACTIVE. Another
    // person's credential id simply does not resolve — the same null as a
    // wrong signature, so nothing distinguishes the two.
    const stored = await client.mfaWebauthnCredential.findFirst({
      where: {
        credentialId: assertion.id,
        userId: input.userId,
        factor: { userId: input.userId, ...ACTIVE_PASSKEY_FACTOR },
      },
      select: {
        id: true,
        credentialId: true,
        publicKey: true,
        signCount: true,
        transports: true,
        factor: { select: { id: true, generation: true } },
      },
    });
    if (!stored) return null;

    const storedCounter = Number(stored.signCount);
    const verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(stored.publicKey),
        counter: storedCounter,
        transports: sanitizeTransports(stored.transports),
      },
    });
    if (!verification.verified) return null;
    const info = verification.authenticationInfo;
    if (!info.userVerified) return null;
    if (info.credentialID !== stored.credentialId) return null;
    // Counter regression (the library also refuses it; restated here because
    // it is this module's contract, not an implementation detail of theirs).
    const newCounter = info.newCounter;
    if ((newCounter > 0 || storedCounter > 0) && newCounter <= storedCounter) return null;

    // Compare-and-set on the counter we verified against, so a concurrent
    // assertion that read the same value cannot also advance past it.
    const advanced = await client.mfaWebauthnCredential.updateMany({
      where: { id: stored.id, signCount: stored.signCount },
      data: { signCount: BigInt(newCounter), backedUp: info.credentialBackedUp },
    });
    if (advanced.count === 0) return null;
    await recordPasskeyUse(client, stored.factor.id);
    return { factorId: stored.factor.id, generation: stored.factor.generation };
  } catch {
    // A malformed assertion makes the library throw; that is a denial, never
    // an incident.
    return null;
  }
}
