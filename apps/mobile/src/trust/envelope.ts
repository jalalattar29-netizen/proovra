/**
 * Phase 1B Closure — Mobile TrustEnvelope assembly.
 *
 *   1. SHA-256 the captured bytes.
 *   2. Build the canonical CaptureSignaturePayload.
 *   3. Sign canonical-JSON(payload) with the Ed25519 device key.
 *   4. Optionally attest the device (Apple App Attest / Google Play
 *      Integrity). Honest NOT_ATTEMPTED when unavailable.
 *   5. Return a TrustEnvelope ready for the upload queue.
 *
 * Hard rules:
 *
 *   * NEVER fakes the verdict. If the SHA-256 fails or the signer
 *     refuses, the envelope is not produced and the caller must
 *     surface the bounded failure.
 *   * Self-verifies the signature locally before returning — a
 *     cheap sanity check that the bytes the server will verify
 *     match the bytes we just signed.
 *   * Generates a fresh nonce per envelope (32 bytes, hex) and binds
 *     attestation to the canonical payload via clientDataHash.
 */

import * as FileSystem from "expo-file-system";
import * as Constants from "expo-constants";
import * as ExpoCrypto from "expo-crypto";
import { Buffer } from "buffer";
import { Platform } from "react-native";

import {
  canonicalJson,
  type CaptureSignaturePayload,
  type CaptureMode,
  type CaptureProvenanceClass,
} from "@proovra/shared";

import { bytesToHex, signEd25519, verifyEd25519 } from "./ed25519";
import { sha256HexOfBytes } from "./sha256";
import { tryAttestation, type AttestationResult } from "./attestation";

export type AssembleTrustEnvelopeInput = {
  /** Captured file URI (local). */
  fileUri: string;
  /** Mime type, e.g. "image/jpeg". */
  mimeType: string;
  /** Capture mode (operator vs SDK). */
  captureMode: CaptureMode;
  /** Provenance class the device claims (clamped server-side). */
  assertedClass: CaptureProvenanceClass;
  /** Capture session id. */
  captureSessionId: string;
  /** Server-issued device id. */
  deviceId: string;
  /** Ed25519 private key bytes (raw, 32 bytes). */
  privateKey: Uint8Array;
  /** Ed25519 public key bytes (raw, 32 bytes). */
  publicKey: Uint8Array;
  /** Optional case binding. */
  caseId?: string | null;
  /** Optional operator-supplied tag. */
  tag?: string | null;
  /** Optional bounded location snapshot. */
  location?: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    method: "GPS" | "NETWORK" | "MANUAL";
  } | null;
  /** Network state at capture time. */
  networkState: "ONLINE" | "OFFLINE" | "UNKNOWN";
  /** Camera context (optional). */
  camera?: {
    facing: "FRONT" | "BACK" | "EXTERNAL" | "UNKNOWN";
    flashOn: boolean;
    focalLengthMm: number | null;
    iso: number | null;
  } | null;
  /** Sensor context (optional). */
  sensor?: {
    batteryPct: number | null;
    orientationDegrees: number | null;
    gravityVector: ReadonlyArray<number> | null;
  } | null;
};

export type AssembleTrustEnvelopeResult =
  | {
      ok: true;
      envelope: {
        payload: CaptureSignaturePayload;
        signatureHex: string;
        assetBase64: string;
        attestation: AttestationResult & { attempted: true } | null;
        attestationFailure: { reason: string; note: string } | null;
        assetHash: string;
        sizeBytes: number;
        canonicalBytes: number;
      };
    }
  | {
      ok: false;
      reason:
        | "FILE_UNAVAILABLE"
        | "HASH_UNAVAILABLE"
        | "SIGN_FAILED"
        | "SELF_VERIFY_FAILED";
      note: string;
    };

/**
 * Real assembly. Reads the captured file, hashes, signs, attests,
 * returns the envelope. No simulation.
 */
export async function assembleTrustEnvelope(
  input: AssembleTrustEnvelopeInput,
): Promise<AssembleTrustEnvelopeResult> {
  // Step 1 — read file bytes (base64 via FileSystem; bounded by
  // upstream size policy).
  let assetBase64: string;
  let sizeBytes: number;
  let assetBytes: Uint8Array;
  try {
    assetBase64 = await FileSystem.readAsStringAsync(input.fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    assetBytes = new Uint8Array(Buffer.from(assetBase64, "base64"));
    sizeBytes = assetBytes.length;
    if (sizeBytes === 0) {
      return { ok: false, reason: "FILE_UNAVAILABLE", note: "Empty file." };
    }
  } catch (err) {
    return {
      ok: false,
      reason: "FILE_UNAVAILABLE",
      note: err instanceof Error ? err.message : "Read failed",
    };
  }

  // Step 2 — SHA-256.
  let assetHash: string;
  try {
    assetHash = await sha256HexOfBytes(assetBytes);
  } catch (err) {
    return {
      ok: false,
      reason: "HASH_UNAVAILABLE",
      note: err instanceof Error ? err.message : "Hash failed",
    };
  }

  // Step 3 — build canonical payload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonceBytes = (ExpoCrypto as any).getRandomBytes(32) as Uint8Array;
  const nonceHex = bytesToHex(nonceBytes);

  const monotonicNs = (() => {
    if (
      typeof globalThis !== "undefined" &&
      typeof (globalThis as { performance?: { now?: () => number } }).performance
        ?.now === "function"
    ) {
      const ms = (globalThis as { performance: { now: () => number } }).performance.now();
      return Math.round(ms * 1_000_000).toString();
    }
    return Date.now().toString() + "000000";
  })();

  const deviceModel = `${Platform.OS}-device`;
  const osVersion = `${Platform.OS} ${Platform.Version ?? ""}`.trim();
  const expoCfg = Constants.default?.expoConfig ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expoVer = ((expoCfg as any).version ?? "0") as string;

  const payload: CaptureSignaturePayload = {
    schemaVersion: "PROOVRA_CAPTURE_SIG_V1",
    assetHash,
    captureMode: input.captureMode,
    provenanceClass: input.assertedClass,
    deviceKeyId: input.deviceId,
    algorithm: "Ed25519",
    captureSessionId: input.captureSessionId,
    signedAtUtc: new Date().toISOString(),
    signedAtMonotonicNs: monotonicNs,
    nonceHex,
    metadata: {
      deviceModel,
      osVersion: osVersion.length > 0 ? osVersion : "unknown",
      appVersion: expoVer,
      networkState: input.networkState,
      locationPolicy: input.location ? "COARSE" : "OFF",
      location: input.location ?? null,
      camera: input.camera ?? null,
      sensor: input.sensor ?? null,
      operatorContext:
        input.caseId || input.tag
          ? { caseId: input.caseId ?? null, tag: input.tag ?? null }
          : null,
    },
  };

  // Step 4 — canonical JSON + sign.
  const canonical = canonicalJson(payload);
  const canonicalBytes = new TextEncoder().encode(canonical);
  let signature: Uint8Array;
  try {
    signature = await signEd25519(input.privateKey, canonicalBytes);
  } catch (err) {
    return {
      ok: false,
      reason: "SIGN_FAILED",
      note: err instanceof Error ? err.message : "Sign failed",
    };
  }

  // Step 5 — local self-verify (cheap sanity).
  const selfOk = await verifyEd25519(input.publicKey, canonicalBytes, signature);
  if (!selfOk) {
    return {
      ok: false,
      reason: "SELF_VERIFY_FAILED",
      note: "Signature did not self-verify before sync. Refusing to ship envelope.",
    };
  }

  const signatureHex = bytesToHex(signature);

  // Step 6 — optional attestation.
  const clientDataHash = await sha256HexOfBytes(canonicalBytes);
  const attestResult = await tryAttestation({
    nonceHex,
    deviceId: input.deviceId,
    clientDataHashHex: clientDataHash,
  });

  return {
    ok: true,
    envelope: {
      payload,
      signatureHex,
      assetBase64,
      attestation: attestResult.attempted ? attestResult : null,
      attestationFailure: attestResult.attempted
        ? null
        : { reason: attestResult.reason, note: attestResult.note },
      assetHash,
      sizeBytes,
      canonicalBytes: canonicalBytes.length,
    },
  };
}
