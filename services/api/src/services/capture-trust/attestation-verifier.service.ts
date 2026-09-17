/**
 * Phase 1B — Device Attestation Verifier service.
 *
 * Provider-abstracted verifier for Apple App Attest and Google Play
 * Integrity assertions. Returns a bounded verdict consumed by the
 * mobile-capture ingest route + the provenance projection.
 *
 * Architecture:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ verifyDeviceAttestation(input)               │
 *   │   resolves provider from input.provider      │
 *   │   delegates to:                              │
 *   │     - AppleAppAttestProvider                 │
 *   │     - GooglePlayIntegrityProvider            │
 *   │     - TeeOnlyProvider (no platform attest)   │
 *   │     - NoneProvider (citizen / bulk)          │
 *   │   each provider returns AttestationVerdict   │
 *   │   any provider failure → fail-closed FAILED  │
 *   │   any operational failure → UNVERIFIED       │
 *   │   the result is persisted via                │
 *   │   CaptureDeviceAttestation                   │
 *   └──────────────────────────────────────────────┘
 *
 * Hard rules:
 *   1. Providers NEVER throw to the caller. Operational failures
 *      collapse to bounded `UNVERIFIED` / `FAILED` with a bounded
 *      failure reason — never a stack trace.
 *   2. Replay defense: every assertion carries a `nonceHex`. The
 *      verifier rejects a re-used nonce per (device_id, nonce_hex).
 *   3. Time defense: assertions with `assertedAtUtc` outside the
 *      ±5-minute window of server time are rejected with
 *      `ASSERTION_EXPIRED`. Provider-issued expiry is also honored.
 *   4. No raw assertion bytes leak. The verifier hashes assertions to
 *      `raw_assertion_sha256` (SHA-256 hex) and stores the raw bytes
 *      separately if retention policy requires.
 *   5. Provider configuration is read from env (APPLE_APP_ATTEST_*,
 *      GOOGLE_PLAY_INTEGRITY_*). Missing config → PROVIDER_DISABLED,
 *      verdict `UNVERIFIED`.
 *
 *   6. (UC-0) FAIL CLOSED. No provider in this deployment performs real
 *      cryptographic verification, so no call can return a positive verdict.
 *      Client-supplied `providerMetadata` is persisted for audit and never
 *      influences a verdict.
 */

import { createHash } from "node:crypto";

import {
  ATTESTATION_VERIFIER_VERSION,
  DEVICE_ATTESTATION_FAILURE_REASONS,
  DEVICE_ATTESTATION_VERDICTS,
  type DeviceAttestationFailureReason,
  type DeviceAttestationProvider,
  type DeviceAttestationVerdict,
} from "@proovra/shared";

import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../db.js";

// -----------------------------------------------------------------------------
// Public input + output contract
// -----------------------------------------------------------------------------

export type VerifyAttestationInput = {
  prisma?: PrismaClient;
  teamId: string;
  deviceId: string;
  captureSessionId: string | null;
  /** Bounded provider id (see DEVICE_ATTESTATION_PROVIDERS). */
  provider: DeviceAttestationProvider;
  /**
   * Raw provider assertion bytes (base64). NEVER persisted inline.
   * The verifier consumes them and discards (hashing to fingerprint).
   */
  rawAssertionBase64: string;
  /** UTC ISO at signing time (per assertion). */
  assertedAtUtc: string;
  /** 32-byte hex random nonce (replay-defense). */
  nonceHex: string;
  /** Optional provider-reported expiry. */
  expiresAtUtc: string | null;
  /**
   * Bounded provider metadata (no raw bytes). CLIENT-SUPPLIED: persisted for
   * audit, never read by a provider, never able to influence the verdict.
   */
  providerMetadata?: Record<string, unknown>;
};

export type AttestationVerificationResult = {
  /** Bounded verdict. */
  verdict: DeviceAttestationVerdict;
  /** Bounded failure reason when verdict ∈ FAILED/UNVERIFIED. */
  failureReason: DeviceAttestationFailureReason | null;
  /** Hex SHA-256 of the raw assertion (for the persisted record). */
  rawAssertionSha256: string;
  /** The persisted CaptureDeviceAttestation row id (when persisted). */
  attestationRecordId: string | null;
};

// -----------------------------------------------------------------------------
// Bounded provider interface
// -----------------------------------------------------------------------------

type ProviderVerifyContext = {
  rawAssertionBytes: Buffer;
  rawAssertionSha256: string;
  assertedAtUtc: string;
  nonceHex: string;
  expiresAtUtc: string | null;
  device: {
    id: string;
    teamId: string;
    publicKeyHex: string;
    publicKeyFingerprint: string;
    attestationProvider: string;
    attestationKeyId: string | null;
    revokedAtUtc: Date | null;
  };
  providerMetadata: Record<string, unknown>;
};

// No provider in this deployment can return a positive verdict (see the
// fail-closed note below). The type says so, so a regression is a compile error.
type ProviderResult = {
  verdict: "FAILED" | "UNVERIFIED";
  reason: DeviceAttestationFailureReason;
};

interface DeviceAttestationProviderImpl {
  readonly id: DeviceAttestationProvider;
  /**
   * Provider readiness probe. Returns null when the provider is fully
   * configured; otherwise a bounded `PROVIDER_DISABLED` reason that
   * collapses the verdict to `UNVERIFIED`.
   */
  readinessCheck(): DeviceAttestationFailureReason | null;
  verify(ctx: ProviderVerifyContext): Promise<ProviderResult>;
}

// -----------------------------------------------------------------------------
// Platform providers — FAIL CLOSED (UC-0, 2026-09-16)
//
// The previous Apple and Google providers returned VERIFIED_STRONG when the
// CLIENT sent `providerMetadata.chainVerifiedByWorker === true` or
// `providerMetadata.deviceIntegrityLabel === "MEETS_STRONG_INTEGRITY"`, and
// VERIFIED_BASIC for any App Attest blob of 64+ bytes. No token was decrypted
// and no certificate chain was validated; the "worker tier" verification those
// comments deferred to was never built. Any authenticated caller could
// therefore manufacture the strongest verdict PROOVRA can express.
//
// This deployment has no server-side cryptographic verifier for either
// platform. Until one exists (decode + verify the Play Integrity JWS and check
// requestHash / package / certificate digest / freshness; parse the App Attest
// CBOR attestation, validate x5c to Apple's root, nonce, RP-ID hash and
// counter), every platform assertion resolves to UNVERIFIED with the bounded
// reason CRYPTOGRAPHIC_VERIFIER_UNAVAILABLE. `providerMetadata` is recorded for
// audit only and is NEVER read by a provider.
//
// A real verifier must be added as its own provider AND its version appended to
// CRYPTOGRAPHIC_ATTESTATION_VERIFIER_VERSIONS in @proovra/shared — the reader
// gate re-projects any positive verdict from an unlisted version as UNVERIFIED.
// -----------------------------------------------------------------------------

class UnverifiablePlatformProvider implements DeviceAttestationProviderImpl {
  constructor(readonly id: DeviceAttestationProvider) {}

  readinessCheck(): DeviceAttestationFailureReason | null {
    return null;
  }

  async verify(ctx: ProviderVerifyContext): Promise<ProviderResult> {
    // An empty assertion is malformed; everything else is unverifiable here,
    // whatever the client claims about it.
    if (ctx.rawAssertionBytes.length === 0) {
      return { verdict: "FAILED", reason: "ASSERTION_MALFORMED" };
    }
    return { verdict: "UNVERIFIED", reason: "CRYPTOGRAPHIC_VERIFIER_UNAVAILABLE" };
  }
}

// -----------------------------------------------------------------------------
// TEE-only provider (hardware key, no platform attestation chain)
// -----------------------------------------------------------------------------

class TeeOnlyProvider implements DeviceAttestationProviderImpl {
  readonly id: DeviceAttestationProvider = "TEE_ONLY";

  readinessCheck(): DeviceAttestationFailureReason | null {
    return null;
  }

  async verify(): Promise<ProviderResult> {
    // "TEE-only" used to be granted to any registered device on the client's
    // word. Without a verified key-attestation chain the server cannot know the
    // key lives in a secure element, so it cannot say so.
    return { verdict: "UNVERIFIED", reason: "CRYPTOGRAPHIC_VERIFIER_UNAVAILABLE" };
  }
}

// -----------------------------------------------------------------------------
// None provider (citizen / bulk)
// -----------------------------------------------------------------------------

class NoneProvider implements DeviceAttestationProviderImpl {
  readonly id: DeviceAttestationProvider = "NONE";

  readinessCheck(): DeviceAttestationFailureReason | null {
    return null;
  }

  async verify(): Promise<ProviderResult> {
    return { verdict: "UNVERIFIED", reason: "PROVIDER_DISABLED" };
  }
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const PROVIDERS: Record<DeviceAttestationProvider, DeviceAttestationProviderImpl> = {
  APPLE_APP_ATTEST: new UnverifiablePlatformProvider("APPLE_APP_ATTEST"),
  GOOGLE_PLAY_INTEGRITY: new UnverifiablePlatformProvider("GOOGLE_PLAY_INTEGRITY"),
  TEE_ONLY: new TeeOnlyProvider(),
  NONE: new NoneProvider(),
};

// -----------------------------------------------------------------------------
// Public verifier
// -----------------------------------------------------------------------------

const FIVE_MIN_MS = 5 * 60 * 1000;

export async function verifyDeviceAttestation(
  input: VerifyAttestationInput,
): Promise<AttestationVerificationResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // Decode + hash raw assertion (NEVER stored inline).
  let rawAssertionBytes: Buffer;
  try {
    rawAssertionBytes = Buffer.from(input.rawAssertionBase64, "base64");
  } catch {
    return materialise(prisma, input, {
      verdict: "FAILED",
      failureReason: "ASSERTION_MALFORMED",
      rawAssertionSha256: "0".repeat(64),
    });
  }
  const rawAssertionSha256 = createHash("sha256")
    .update(rawAssertionBytes)
    .digest("hex");

  // Load the device record (workspace-anchored).
  const device = await prisma.device.findFirst({
    where: { id: input.deviceId, teamId: input.teamId },
  });
  if (!device) {
    return materialise(prisma, input, {
      verdict: "FAILED",
      failureReason: "DEVICE_UNKNOWN",
      rawAssertionSha256,
    });
  }
  if (device.revokedAtUtc !== null) {
    return materialise(prisma, input, {
      verdict: "REVOKED",
      failureReason: "DEVICE_REVOKED",
      rawAssertionSha256,
    });
  }

  // Replay defense — nonce uniqueness per device.
  const replay = await prisma.captureDeviceAttestation.findFirst({
    where: { deviceId: device.id, nonceHex: input.nonceHex },
    select: { id: true },
  });
  if (replay) {
    return materialise(prisma, input, {
      verdict: "FAILED",
      failureReason: "ASSERTION_REPLAYED",
      rawAssertionSha256,
    });
  }

  // Time defense — assertedAtUtc must fall within ±5 min of server time.
  const assertedMs = new Date(input.assertedAtUtc).getTime();
  if (
    !Number.isFinite(assertedMs) ||
    Math.abs(Date.now() - assertedMs) > FIVE_MIN_MS
  ) {
    return materialise(prisma, input, {
      verdict: "FAILED",
      failureReason: "ASSERTION_EXPIRED",
      rawAssertionSha256,
    });
  }
  if (input.expiresAtUtc) {
    const expiresMs = new Date(input.expiresAtUtc).getTime();
    if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
      return materialise(prisma, input, {
        verdict: "FAILED",
        failureReason: "ASSERTION_EXPIRED",
        rawAssertionSha256,
      });
    }
  }

  const provider = PROVIDERS[input.provider];

  // Provider readiness check — fail-soft to UNVERIFIED.
  const readinessReason = provider.readinessCheck();
  if (readinessReason !== null) {
    return materialise(prisma, input, {
      verdict: "UNVERIFIED",
      failureReason: readinessReason,
      rawAssertionSha256,
    });
  }

  // Delegate to provider.
  let result: ProviderResult;
  try {
    result = await provider.verify({
      rawAssertionBytes,
      rawAssertionSha256,
      assertedAtUtc: input.assertedAtUtc,
      nonceHex: input.nonceHex,
      expiresAtUtc: input.expiresAtUtc,
      device: {
        id: device.id,
        teamId: device.teamId,
        publicKeyHex: device.publicKeyHex,
        publicKeyFingerprint: device.publicKeyFingerprint,
        attestationProvider: device.attestationProvider,
        attestationKeyId: device.attestationKeyId,
        revokedAtUtc: device.revokedAtUtc,
      },
      providerMetadata: input.providerMetadata ?? {},
    });
  } catch {
    result = { verdict: "UNVERIFIED", reason: "PROVIDER_UNAVAILABLE" };
  }

  // Sanity: clamp verdict / failureReason to bounded enum.
  const verdict: DeviceAttestationVerdict = (
    DEVICE_ATTESTATION_VERDICTS as ReadonlyArray<string>
  ).includes(result.verdict)
    ? (result.verdict as DeviceAttestationVerdict)
    : "UNVERIFIED";

  const failureReason: DeviceAttestationFailureReason = (
    DEVICE_ATTESTATION_FAILURE_REASONS as ReadonlyArray<string>
  ).includes(result.reason)
    ? result.reason
    : "UNKNOWN";

  return materialise(prisma, input, {
    verdict,
    failureReason,
    rawAssertionSha256,
  });
}

async function materialise(
  prisma: PrismaClient,
  input: VerifyAttestationInput,
  outcome: {
    verdict: DeviceAttestationVerdict;
    failureReason: DeviceAttestationFailureReason | null;
    rawAssertionSha256: string;
  },
): Promise<AttestationVerificationResult> {
  // Persist the bounded outcome. Failures still persist for audit.
  try {
    const record = await prisma.captureDeviceAttestation.create({
      data: {
        deviceId: input.deviceId,
        teamId: input.teamId,
        captureSessionId: input.captureSessionId,
        provider: input.provider,
        verdict: outcome.verdict,
        failureReason: outcome.failureReason,
        nonceHex: input.nonceHex,
        rawAssertionSha256: outcome.rawAssertionSha256,
        // attestedAtUtc is the legacy required column; assertedAtUtc is the R7-additive
        // canonical column. Write both so legacy auditors + the verifier-side ASSERTION_EXPIRED
        // re-check both read consistent values.
        attestedAtUtc: new Date(input.assertedAtUtc),
        assertedAtUtc: new Date(input.assertedAtUtc),
        expiresAtUtc: input.expiresAtUtc ? new Date(input.expiresAtUtc) : null,
        // R7-capture-trust additive: providerMetadata is JSONB. Use Prisma.JsonNull for null
        // (so the row stores SQL NULL not JSON-null) and Prisma.InputJsonValue for present.
        providerMetadata:
          input.providerMetadata === null || input.providerMetadata === undefined
            ? Prisma.JsonNull
            : (input.providerMetadata as Prisma.InputJsonValue),
        verifierVersion: ATTESTATION_VERIFIER_VERSION,
      },
      select: { id: true },
    });
    return {
      verdict: outcome.verdict,
      failureReason: outcome.failureReason,
      rawAssertionSha256: outcome.rawAssertionSha256,
      attestationRecordId: record.id,
    };
  } catch {
    // Persisting failed — still return the verdict so the ingest can
    // proceed with an honest result.
    return {
      verdict: outcome.verdict,
      failureReason: outcome.failureReason,
      rawAssertionSha256: outcome.rawAssertionSha256,
      attestationRecordId: null,
    };
  }
}
