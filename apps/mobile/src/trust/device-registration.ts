/**
 * Phase 1B Closure — Device registration flow.
 *
 *   1. Ensure a device-bound Ed25519 key exists.
 *   2. Call POST /v1/capture/devices with the public key + bounded
 *      device metadata.
 *   3. Persist the server-issued deviceId via expo-secure-store.
 *   4. Re-use the same identity on subsequent launches.
 *
 * Hard rules:
 *   * The registration call is workspace-anchored — the API resolves
 *     the workspace from the session token. A personal-space user
 *     receives a bounded denial; the UI surfaces this as
 *     "Capture trust requires an organization workspace".
 *   * A successful registration is idempotent on the server side
 *     (the public-key fingerprint is the unique key). If the server
 *     returns DEVICE_PUBKEY_TAKEN we treat that as "already
 *     registered" and fetch the existing deviceId via the device
 *     listing endpoint.
 *   * Revoked devices NEVER auto-re-register. The UI surfaces the
 *     revoked state and asks the operator to wipe + re-register
 *     explicitly.
 */

import Constants from "expo-constants";
import { Platform } from "react-native";

import { apiFetch } from "../api";

import {
  getDeviceId,
  getOrCreateDeviceKey,
  setDeviceId,
  type DeviceKeyMaterial,
} from "./device-key";

export type DeviceRegistrationOutcome =
  | {
      kind: "REGISTERED";
      deviceId: string;
      publicKeyFingerprint: string;
      freshlyGenerated: boolean;
    }
  | {
      kind: "REUSED";
      deviceId: string;
      publicKeyFingerprint: string;
    }
  | {
      kind: "REVOKED";
      deviceId: string;
      publicKeyFingerprint: string;
    }
  | {
      kind: "DENIED";
      reason: string;
    };

const DEFAULT_LABEL = "PROOVRA Mobile Capture";

/**
 * Bounded device-metadata snapshot. NOT a persistent identity — just
 * what the server records on the Device row.
 */
function captureDeviceMetadata(label: string | null): {
  label: string;
  deviceModel: string;
  osVersion: string;
  appVersion: string;
  attestationProvider: "APPLE_APP_ATTEST" | "GOOGLE_PLAY_INTEGRITY" | "NONE";
} {
  const platform = Platform.OS; // 'ios' | 'android' | 'web'
  const expo = Constants.expoConfig ?? Constants.manifest ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const native = (Constants as any).nativeBuildVersion ?? "0";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expoVer = ((expo as any).version ?? "0") as string;
  const osVersion = `${platform} ${Platform.Version ?? ""}`.trim();

  const provider: "APPLE_APP_ATTEST" | "GOOGLE_PLAY_INTEGRITY" | "NONE" =
    platform === "ios"
      ? "APPLE_APP_ATTEST"
      : platform === "android"
      ? "GOOGLE_PLAY_INTEGRITY"
      : "NONE";

  return {
    label: label ?? DEFAULT_LABEL,
    deviceModel: `${platform}-device`,
    osVersion: osVersion.length > 0 ? osVersion : "unknown",
    appVersion: `${expoVer}+${native}`,
    attestationProvider: provider,
  };
}

export async function ensureDeviceRegistered(
  opts: { label?: string } = {},
): Promise<DeviceRegistrationOutcome> {
  // 1. Key material.
  let key: DeviceKeyMaterial;
  try {
    key = await getOrCreateDeviceKey();
  } catch (err) {
    return { kind: "DENIED", reason: keyDenialReason(err) };
  }

  // 2. Cached deviceId — re-use if present.
  const cached = await getDeviceId();
  if (cached) {
    return {
      kind: "REUSED",
      deviceId: cached,
      publicKeyFingerprint: key.publicKeyFingerprint,
    };
  }

  // 3. Register.
  const meta = captureDeviceMetadata(opts.label ?? null);
  try {
    const res = await apiFetch("/v1/capture/devices", {
      method: "POST",
      body: JSON.stringify({
        label: meta.label,
        deviceModel: meta.deviceModel,
        osVersion: meta.osVersion,
        appVersion: meta.appVersion,
        signatureAlgorithm: "Ed25519",
        publicKeyHex: key.publicKeyHex,
        attestationProvider: meta.attestationProvider,
      }),
    });
    if (res?.deviceId && typeof res.deviceId === "string") {
      await setDeviceId(res.deviceId);
      return {
        kind: "REGISTERED",
        deviceId: res.deviceId,
        publicKeyFingerprint: key.publicKeyFingerprint,
        freshlyGenerated: key.freshlyGenerated,
      };
    }
    return { kind: "DENIED", reason: "REGISTRATION_RESPONSE_MALFORMED" };
  } catch (err) {
    return await handleRegistrationError(err, key);
  }
}

async function handleRegistrationError(
  err: unknown,
  key: DeviceKeyMaterial,
): Promise<DeviceRegistrationOutcome> {
  const denial = extractDenialReason(err);

  // The server returns 409 + DEVICE_PUBKEY_TAKEN when this fingerprint
  // is already registered (e.g. user reinstalled but the OS preserved
  // the keychain). We recover by looking up the existing deviceId.
  if (denial === "DEVICE_PUBKEY_TAKEN") {
    try {
      const list = await apiFetch("/v1/capture/devices?includeRevoked=true", {
        method: "GET",
      });
      const match = Array.isArray(list?.devices)
        ? list.devices.find(
            (d: { publicKeyFingerprint: string }) =>
              d.publicKeyFingerprint === key.publicKeyFingerprint,
          )
        : null;
      if (match?.id) {
        await setDeviceId(match.id);
        if (match.revokedAtUtc) {
          return {
            kind: "REVOKED",
            deviceId: match.id,
            publicKeyFingerprint: key.publicKeyFingerprint,
          };
        }
        return {
          kind: "REUSED",
          deviceId: match.id,
          publicKeyFingerprint: key.publicKeyFingerprint,
        };
      }
    } catch {
      /* fall through to denied */
    }
  }

  return { kind: "DENIED", reason: denial };
}

function extractDenialReason(err: unknown): string {
  if (!err) return "UNKNOWN";
  if (typeof err === "object" && err !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    if (typeof e.denial === "string") return e.denial;
    if (typeof e.body === "object" && e.body && typeof e.body.denial === "string") {
      return e.body.denial;
    }
    if (typeof e.status === "number" && e.status === 403) {
      return "WORKSPACE_NOT_FOUND";
    }
  }
  return "REGISTRATION_FAILED";
}

function keyDenialReason(err: unknown): string {
  if (err instanceof Error && err.message.includes("CSPRNG")) {
    return "DEVICE_CSPRNG_UNAVAILABLE";
  }
  return "DEVICE_KEY_STORAGE_UNAVAILABLE";
}
