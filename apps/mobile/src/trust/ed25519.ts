/**
 * Phase 1B Closure — Mobile Ed25519 sign + key derivation.
 *
 * Uses `@noble/ed25519` (pure-JS, audited). Wires the noble sync API
 * for sign + getPublicKey. Operates on `Uint8Array`. All hex I/O
 * lowercase.
 *
 * The private key is 32 bytes. The public key is 32 bytes. Signatures
 * are 64 bytes. All match the SPKI Ed25519 encoding the server-side
 * verifier consumes via `ed25519RawPubkeyToPem`.
 *
 * Random key generation uses expo-crypto's CSPRNG. The generated
 * private key is intended to be stored immediately by the caller in
 * expo-secure-store (hardware-backed Keychain on iOS, Keystore on
 * Android).
 */

import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import * as ExpoCrypto from "expo-crypto";

// noble/ed25519 v3 requires a SHA-512 hash function injected at runtime.
// We use @noble/hashes/sha2 which is portable and audited. Tests assert
// this wiring is present.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ed: any = ed25519;
if (ed.hashes && typeof ed.hashes === "object") {
  ed.hashes.sha512 = sha512;
}
if (typeof ed.etc === "object" && ed.etc) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => {
    const h = sha512.create();
    for (const part of m) h.update(part);
    return h.digest();
  };
  ed.etc.sha512Async = async (...m: Uint8Array[]) => ed.etc.sha512Sync(...m);
}

/** Generate a fresh 32-byte Ed25519 private key (CSPRNG via expo-crypto). */
export function generatePrivateKey(): Uint8Array {
  // expo-crypto getRandomBytes is synchronous and CSPRNG-backed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bytes = (ExpoCrypto as any).getRandomBytes(32) as Uint8Array;
  if (!bytes || bytes.length !== 32) {
    throw new Error("ed25519: CSPRNG did not return 32 bytes");
  }
  return bytes;
}

/** Derive the 32-byte Ed25519 public key from the private key. */
export async function publicKeyFromPrivate(priv: Uint8Array): Promise<Uint8Array> {
  return ed25519.getPublicKeyAsync(priv);
}

/** Sign canonical-JSON bytes with the given private key. Returns 64-byte signature. */
export async function signEd25519(
  privateKey: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  return ed25519.signAsync(message, privateKey);
}

/** Verify a signature locally (sanity check before sync). */
export async function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return await ed25519.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** SHA-256 fingerprint of the public key (hex of pubkey-hex bytes). */
export async function publicKeyFingerprintHex(pub: Uint8Array): Promise<string> {
  const pubHex = bytesToHex(pub);
  // The server stores `publicKeyFingerprint = sha256(publicKeyHex)`,
  // not sha256(rawPubkeyBytes). Mirror that exactly here so the
  // mobile-computed fingerprint can be compared without server round-
  // trip.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf = await (ExpoCrypto as any).digestStringAsync(
    "SHA-256",
    pubHex,
    { encoding: "hex" },
  );
  return typeof buf === "string" ? buf.toLowerCase() : "";
}

export function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 1) out += b[i].toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("ed25519: invalid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return out;
}
