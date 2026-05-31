/**
 * Phase 1B Closure — Mobile device attestation interface.
 *
 * Pluggable provider model. Two real providers (Apple App Attest +
 * Google Play Integrity) sit behind a bounded interface. When the
 * corresponding native module is NOT linked into the build (the
 * default Expo Go / dev-client posture), the provider honestly
 * returns `NOT_ATTEMPTED` — never a fake STRONG verdict.
 *
 * Hard rules:
 *
 *   1. NEVER pretend a verdict. If the platform native module isn't
 *      present, the verdict is `NOT_ATTEMPTED` with a bounded
 *      reason (`PROVIDER_UNAVAILABLE`). The server treats this as
 *      an honest "no attestation attempted" and clamps the
 *      provenance class accordingly.
 *
 *   2. Nonce is generated client-side via expo-crypto's CSPRNG and is
 *      single-use. It is woven into both the capture-signature
 *      payload (so the server can correlate) and the attestation
 *      request (so the attestation binds to this capture).
 *
 *   3. When a native module IS linked, this file is the single hook
 *      point that lights up STRONG verdicts without further code
 *      change in the capture pipeline.
 *
 * Native module integration (Phase 2):
 *   * iOS: `expo-app-integrity` or a custom EAS-built native module
 *     that calls `DCAppAttestService.attestKey(_:clientDataHash:)`.
 *   * Android: `react-native-google-play-integrity` (or the
 *     equivalent EAS module) that calls
 *     `IntegrityManager.requestIntegrityToken(...)`.
 *
 * The bounded `tryNativeAttestation` hook below loads these via
 * dynamic `require` so the absence of the module does not fail the
 * import graph.
 */

import * as ExpoCrypto from "expo-crypto";
import { Platform } from "react-native";

import { bytesToHex } from "./ed25519";

export type AttestationResult =
  | {
      attempted: true;
      provider: "APPLE_APP_ATTEST" | "GOOGLE_PLAY_INTEGRITY";
      /** Base64-encoded raw provider assertion bytes — forwarded to server. */
      rawAssertionBase64: string;
      assertedAtUtc: string;
      nonceHex: string;
      expiresAtUtc: string | null;
      providerMetadata: Record<string, unknown>;
    }
  | {
      attempted: false;
      reason:
        | "PROVIDER_UNAVAILABLE"
        | "PLATFORM_UNSUPPORTED"
        | "USER_DECLINED"
        | "NETWORK_UNAVAILABLE"
        | "TIMEOUT";
      /** Bounded note (≤120 chars). */
      note: string;
    };

/** Bounded nonce — 32 random bytes hex (64 chars). */
export function generateAttestationNonceHex(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bytes = (ExpoCrypto as any).getRandomBytes(32) as Uint8Array;
  return bytesToHex(bytes);
}

export type AttestationRequest = {
  /** Bound to this capture; used as nonce in the attestation token. */
  nonceHex: string;
  /** Server-issued device id (the capture binds attestation to this device). */
  deviceId: string;
  /** SHA-256 hex of the canonical capture payload — binds attestation to capture. */
  clientDataHashHex: string;
};

/**
 * Try to attest the device. Returns a bounded `AttestationResult`.
 * Never throws.
 */
export async function tryAttestation(
  req: AttestationRequest,
): Promise<AttestationResult> {
  // Web (PWA, citizen capture path) — never attests.
  if (Platform.OS === "web") {
    return {
      attempted: false,
      reason: "PLATFORM_UNSUPPORTED",
      note: "Browser captures cannot produce device attestation.",
    };
  }

  if (Platform.OS === "ios") {
    return tryAppleAppAttest(req);
  }
  if (Platform.OS === "android") {
    return tryGooglePlayIntegrity(req);
  }
  return {
    attempted: false,
    reason: "PLATFORM_UNSUPPORTED",
    note: `Platform ${Platform.OS} is not supported.`,
  };
}

// ---------------------------------------------------------------------------
// Apple App Attest provider — pluggable
// ---------------------------------------------------------------------------

async function tryAppleAppAttest(
  req: AttestationRequest,
): Promise<AttestationResult> {
  const native = loadAppleAppAttestModule();
  if (!native) {
    return {
      attempted: false,
      reason: "PROVIDER_UNAVAILABLE",
      note:
        "Apple App Attest native module not linked. Build with expo-app-integrity or an EAS dev-client to enable.",
    };
  }
  try {
    const supported = await native.isSupported();
    if (!supported) {
      return {
        attempted: false,
        reason: "PLATFORM_UNSUPPORTED",
        note: "App Attest is not supported on this device.",
      };
    }
    // Bind the assertion to the canonical-JSON payload hash.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assertion = await native.attest({
      deviceKeyId: req.deviceId,
      challenge: req.nonceHex,
      clientDataHashHex: req.clientDataHashHex,
    });
    if (!assertion || typeof assertion.rawAssertionBase64 !== "string") {
      return {
        attempted: false,
        reason: "PROVIDER_UNAVAILABLE",
        note: "App Attest module returned an invalid result.",
      };
    }
    return {
      attempted: true,
      provider: "APPLE_APP_ATTEST",
      rawAssertionBase64: assertion.rawAssertionBase64,
      assertedAtUtc: new Date().toISOString(),
      nonceHex: req.nonceHex,
      expiresAtUtc: assertion.expiresAtUtc ?? null,
      providerMetadata: {
        teamId: assertion.teamId ?? null,
        bundleId: assertion.bundleId ?? null,
        devicePublicKeyFingerprint: assertion.publicKeyFingerprint ?? null,
        chainVerifiedByWorker: false,
      },
    };
  } catch {
    return {
      attempted: false,
      reason: "PROVIDER_UNAVAILABLE",
      note: "App Attest attestation failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Google Play Integrity provider — pluggable
// ---------------------------------------------------------------------------

async function tryGooglePlayIntegrity(
  req: AttestationRequest,
): Promise<AttestationResult> {
  const native = loadPlayIntegrityModule();
  if (!native) {
    return {
      attempted: false,
      reason: "PROVIDER_UNAVAILABLE",
      note:
        "Play Integrity native module not linked. Build with the EAS Play Integrity module to enable.",
    };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await native.requestIntegrityToken({
      nonceHex: req.nonceHex,
      clientDataHashHex: req.clientDataHashHex,
    });
    if (!verdict || typeof verdict.rawIntegrityTokenBase64 !== "string") {
      return {
        attempted: false,
        reason: "PROVIDER_UNAVAILABLE",
        note: "Play Integrity module returned an invalid result.",
      };
    }
    return {
      attempted: true,
      provider: "GOOGLE_PLAY_INTEGRITY",
      rawAssertionBase64: verdict.rawIntegrityTokenBase64,
      assertedAtUtc: new Date().toISOString(),
      nonceHex: req.nonceHex,
      expiresAtUtc: null,
      providerMetadata: {
        packageName: verdict.packageName ?? null,
        deviceIntegrityLabel: verdict.deviceIntegrityLabel ?? null,
      },
    };
  } catch {
    return {
      attempted: false,
      reason: "PROVIDER_UNAVAILABLE",
      note: "Play Integrity attestation failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Native module loaders — single hook point for Phase 2 wiring.
// ---------------------------------------------------------------------------

interface AppleAppAttestModule {
  isSupported(): Promise<boolean>;
  attest(input: {
    deviceKeyId: string;
    challenge: string;
    clientDataHashHex: string;
  }): Promise<{
    rawAssertionBase64: string;
    teamId?: string;
    bundleId?: string;
    publicKeyFingerprint?: string;
    expiresAtUtc?: string | null;
  }>;
}

interface PlayIntegrityModule {
  requestIntegrityToken(input: {
    nonceHex: string;
    clientDataHashHex: string;
  }): Promise<{
    rawIntegrityTokenBase64: string;
    packageName?: string;
    deviceIntegrityLabel?:
      | "MEETS_STRONG_INTEGRITY"
      | "MEETS_DEVICE_INTEGRITY"
      | "MEETS_BASIC_INTEGRITY";
  }>;
}

function loadAppleAppAttestModule(): AppleAppAttestModule | null {
  try {
    // Single hook point: a Phase 2 build can ship the real module
    // under this exact path. Until then, the require throws and we
    // honestly return null.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const mod: any = require("../trust-native/apple-app-attest");
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

function loadPlayIntegrityModule(): PlayIntegrityModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const mod: any = require("../trust-native/google-play-integrity");
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}
