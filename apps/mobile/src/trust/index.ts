/**
 * Phase 1B Closure — Mobile capture-trust runtime barrel.
 *
 * Single entry point used by the capture screen. The screen does
 * NOT import individual modules — it composes via this barrel so
 * the surface area stays bounded.
 *
 * The default `captureWithTrust()` helper:
 *   1. ensures the device is registered
 *   2. assembles the trust envelope
 *   3. persists it to the trust queue
 *   4. triggers a sync (best-effort; the queue retries on failure)
 *   5. returns a bounded `CaptureTrustOutcome` for the UI
 *
 * Every failure surfaces a bounded reason string the UI shows
 * verbatim.
 */

import * as ExpoCrypto from "expo-crypto";

import {
  ensureDeviceRegistered,
  type DeviceRegistrationOutcome,
} from "./device-registration";
import {
  getOrCreateDeviceKey,
  getDeviceKeyStatus,
} from "./device-key";
import { assembleTrustEnvelope } from "./envelope";
import {
  enqueueTrustEnvelope,
  listTrustQueueSummary,
  syncTrustQueue,
  markOnline,
} from "./upload-queue";
import type {
  CaptureMode,
  CaptureProvenanceClass,
} from "@proovra/shared";

// Bounded UUID helper — expo-crypto provides a CSPRNG-backed v4.
function makeUuid(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((ExpoCrypto as any).randomUUID?.() as string) ?? fallbackUuid();
}
function fallbackUuid(): string {
  // RFC 4122 v4 from 16 random bytes via expo-crypto.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = (ExpoCrypto as any).getRandomBytes(16) as Uint8Array;
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < b.length; i += 1) hex.push(b[i].toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export {
  ensureDeviceRegistered,
  getDeviceKeyStatus,
  getOrCreateDeviceKey,
  enqueueTrustEnvelope,
  listTrustQueueSummary,
  syncTrustQueue,
  markOnline,
};

export type CaptureWithTrustInput = {
  fileUri: string;
  mimeType: string;
  caseId?: string | null;
  tag?: string | null;
  /** Whether the network is online. The caller measures via NetInfo. */
  online: boolean;
  location?: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    method: "GPS" | "NETWORK" | "MANUAL";
  } | null;
};

export type CaptureWithTrustOutcome =
  | {
      kind: "QUEUED";
      queueId: string;
      provenanceClass: CaptureProvenanceClass;
      offline: boolean;
      attestationAttempted: boolean;
      attestationProvider: string | null;
      assetHash: string;
    }
  | {
      kind: "FAILED";
      reason: string;
      note: string;
    };

const FIXED_CAPTURE_MODE: CaptureMode = "OPERATOR_NATIVE";

/**
 * Default capture trust flow. Always claims the highest class the
 * device mode permits; the server clamps + demotes per verdict.
 */
export async function captureWithTrust(
  input: CaptureWithTrustInput,
): Promise<CaptureWithTrustOutcome> {
  // 1. Device registration (idempotent).
  const reg = await ensureDeviceRegistered();
  const regOutcome = handleRegistration(reg);
  if (regOutcome.kind === "FAILED") return regOutcome;

  // 2. Key material.
  const key = await getOrCreateDeviceKey();

  // 3. Fresh capture session id (UUID).
  const captureSessionId = makeUuid();

  // 4. Assemble the envelope.
  const envelope = await assembleTrustEnvelope({
    fileUri: input.fileUri,
    mimeType: input.mimeType,
    captureMode: FIXED_CAPTURE_MODE,
    assertedClass: "A",
    captureSessionId,
    deviceId: regOutcome.deviceId,
    privateKey: key.privateKey,
    publicKey: key.publicKey,
    caseId: input.caseId ?? null,
    tag: input.tag ?? null,
    networkState: input.online ? "ONLINE" : "OFFLINE",
    location: input.location ?? null,
  });
  if (!envelope.ok) {
    return {
      kind: "FAILED",
      reason: envelope.reason,
      note: envelope.note,
    };
  }

  // 5. Persist + queue.
  const queueId = makeUuid();
  enqueueTrustEnvelope({
    id: queueId,
    captureSessionId,
    deviceId: regOutcome.deviceId,
    provenanceClass: envelope.envelope.payload.provenanceClass,
    payload: envelope.envelope.payload,
    signatureHex: envelope.envelope.signatureHex,
    assetBase64: envelope.envelope.assetBase64,
    assetSha256: envelope.envelope.assetHash,
    sizeBytes: envelope.envelope.sizeBytes,
    attestation: envelope.envelope.attestation,
    attestationFailure: envelope.envelope.attestationFailure,
    online: input.online,
  });

  // 6. Best-effort sync (non-blocking — the queue retries).
  if (input.online) {
    syncTrustQueue().catch(() => {
      /* the queue's retry loop covers failure */
    });
  }

  return {
    kind: "QUEUED",
    queueId,
    provenanceClass: envelope.envelope.payload.provenanceClass,
    offline: !input.online,
    attestationAttempted: envelope.envelope.attestation !== null,
    attestationProvider: envelope.envelope.attestation?.provider ?? null,
    assetHash: envelope.envelope.assetHash,
  };
}

// Canonical alias — the capture screen's contract name for the same real
// runtime. `runTrustCapture(input)` is exactly `captureWithTrust(input)`:
// both registration, key, envelope, queue, and best-effort sync execute.
// Two names co-exist because:
//   * `captureWithTrust` reads well at the trust-runtime layer (verb-noun)
//   * `runTrustCapture` reads well at the camera/recording call site
// No duplicate implementation — `runTrustCapture` IS `captureWithTrust`.
export const runTrustCapture = captureWithTrust;

function handleRegistration(
  reg: DeviceRegistrationOutcome,
):
  | { kind: "OK"; deviceId: string }
  | { kind: "FAILED"; reason: string; note: string } {
  switch (reg.kind) {
    case "REGISTERED":
    case "REUSED":
      return { kind: "OK", deviceId: reg.deviceId };
    case "REVOKED":
      return {
        kind: "FAILED",
        reason: "DEVICE_REVOKED",
        note: "This device has been revoked. Re-register to capture new evidence.",
      };
    case "DENIED":
      return {
        kind: "FAILED",
        reason: reg.reason,
        note: friendlyDenialNote(reg.reason),
      };
  }
}

function friendlyDenialNote(reason: string): string {
  switch (reason) {
    case "WORKSPACE_NOT_FOUND":
      return "Capture trust requires an organization workspace.";
    case "DEVICE_PUBKEY_TAKEN":
      return "Device identity already exists. Re-launch the app to use it.";
    case "DEVICE_KEY_STORAGE_UNAVAILABLE":
      return "Secure key storage is unavailable on this device.";
    case "DEVICE_CSPRNG_UNAVAILABLE":
      return "Secure random number generation is unavailable.";
    default:
      return "Device registration failed. Please try again.";
  }
}
