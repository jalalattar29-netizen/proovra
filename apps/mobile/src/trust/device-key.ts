/**
 * Phase 1B Closure — Mobile device-bound key persistence.
 *
 * Hard rules:
 *
 *   * Private key bytes are stored in expo-secure-store under a
 *     bounded key. On iOS this maps to the Keychain (`Accessible:
 *     AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`); on Android to encrypted
 *     SharedPreferences backed by the Keystore. NEVER stored in
 *     AsyncStorage / plain files.
 *
 *   * Public key bytes + fingerprint + server-issued deviceId are
 *     stored alongside so the app can re-use the same identity after
 *     restart without re-registering.
 *
 *   * Hardware-backing is BEST-EFFORT (the OS decides). We surface
 *     the bounded "hardware-backed" status to the UI via
 *     `getDeviceKeyStatus()`; we never fake STRONG when the storage
 *     is software-only.
 *
 *   * Wiping the key + identity is destructive (`clearDeviceKey`) —
 *     the app must register a new device after wipe.
 */

import * as SecureStore from "expo-secure-store";

import {
  bytesToHex,
  generatePrivateKey,
  hexToBytes,
  publicKeyFingerprintHex,
  publicKeyFromPrivate,
} from "./ed25519";

const KEY_PRIVATE = "proovra.trust.ed25519.privateKey.v1";
const KEY_PUBLIC = "proovra.trust.ed25519.publicKey.v1";
const KEY_FINGERPRINT = "proovra.trust.ed25519.fingerprint.v1";
const KEY_DEVICE_ID = "proovra.trust.deviceId.v1";

export type DeviceKeyMaterial = {
  /** 32-byte Ed25519 private key (raw). */
  privateKey: Uint8Array;
  /** 32-byte Ed25519 public key (raw). */
  publicKey: Uint8Array;
  /** Lowercase hex public key (server uses this format). */
  publicKeyHex: string;
  /** SHA-256(publicKeyHex). */
  publicKeyFingerprint: string;
  /** True iff the key was generated fresh on this call. */
  freshlyGenerated: boolean;
};

export type DeviceKeyStatus = {
  /** Whether a private key exists in secure-store. */
  present: boolean;
  /** Best-effort report on whether the OS keychain is hardware-backed. */
  hardwareBacked: boolean | "unknown";
  /** Cached fingerprint (or null if not stored). */
  publicKeyFingerprint: string | null;
  /** Server-issued deviceId, if registered. */
  deviceId: string | null;
};

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  // After first unlock, this-device-only: matches the Phase 0 device-
  // bound posture.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * Get the existing device key, or generate + persist a fresh one.
 * Public key + fingerprint are cached alongside so subsequent calls
 * do not re-derive.
 */
export async function getOrCreateDeviceKey(): Promise<DeviceKeyMaterial> {
  const existingHex = await SecureStore.getItemAsync(
    KEY_PRIVATE,
    SECURE_OPTIONS,
  );
  if (existingHex && /^[0-9a-f]{64}$/.test(existingHex)) {
    const priv = hexToBytes(existingHex);
    let publicKey: Uint8Array;
    let publicKeyHex: string;
    let publicKeyFingerprint: string;
    const cachedPubHex = await SecureStore.getItemAsync(
      KEY_PUBLIC,
      SECURE_OPTIONS,
    );
    const cachedFp = await SecureStore.getItemAsync(
      KEY_FINGERPRINT,
      SECURE_OPTIONS,
    );
    if (cachedPubHex && cachedFp) {
      publicKey = hexToBytes(cachedPubHex);
      publicKeyHex = cachedPubHex;
      publicKeyFingerprint = cachedFp;
    } else {
      publicKey = await publicKeyFromPrivate(priv);
      publicKeyHex = bytesToHex(publicKey);
      publicKeyFingerprint = await publicKeyFingerprintHex(publicKey);
      await SecureStore.setItemAsync(KEY_PUBLIC, publicKeyHex, SECURE_OPTIONS);
      await SecureStore.setItemAsync(
        KEY_FINGERPRINT,
        publicKeyFingerprint,
        SECURE_OPTIONS,
      );
    }
    return {
      privateKey: priv,
      publicKey,
      publicKeyHex,
      publicKeyFingerprint,
      freshlyGenerated: false,
    };
  }

  // Generate fresh.
  const priv = generatePrivateKey();
  const privHex = bytesToHex(priv);
  const pub = await publicKeyFromPrivate(priv);
  const pubHex = bytesToHex(pub);
  const fp = await publicKeyFingerprintHex(pub);
  await SecureStore.setItemAsync(KEY_PRIVATE, privHex, SECURE_OPTIONS);
  await SecureStore.setItemAsync(KEY_PUBLIC, pubHex, SECURE_OPTIONS);
  await SecureStore.setItemAsync(KEY_FINGERPRINT, fp, SECURE_OPTIONS);
  return {
    privateKey: priv,
    publicKey: pub,
    publicKeyHex: pubHex,
    publicKeyFingerprint: fp,
    freshlyGenerated: true,
  };
}

/** Persist the server-issued deviceId for re-use across launches. */
export async function setDeviceId(deviceId: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_DEVICE_ID, deviceId, SECURE_OPTIONS);
}

/** Read the cached deviceId (null if not registered). */
export async function getDeviceId(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_DEVICE_ID, SECURE_OPTIONS);
}

export async function clearDeviceKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_PRIVATE, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(KEY_PUBLIC, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(KEY_FINGERPRINT, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(KEY_DEVICE_ID, SECURE_OPTIONS);
}

export async function getDeviceKeyStatus(): Promise<DeviceKeyStatus> {
  const present =
    (await SecureStore.getItemAsync(KEY_PRIVATE, SECURE_OPTIONS)) !== null;
  const publicKeyFingerprint = await SecureStore.getItemAsync(
    KEY_FINGERPRINT,
    SECURE_OPTIONS,
  );
  const deviceId = await SecureStore.getItemAsync(
    KEY_DEVICE_ID,
    SECURE_OPTIONS,
  );

  // expo-secure-store does not expose an explicit hardware-backed
  // flag. iOS Keychain entries are hardware-backed when Secure Enclave
  // is present; Android uses Keystore which is hardware-backed on
  // most modern devices. We report "unknown" honestly here; a future
  // wiring layer can use platform-specific probes to lift to true.
  return {
    present,
    hardwareBacked: "unknown",
    publicKeyFingerprint,
    deviceId,
  };
}
