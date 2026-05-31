/**
 * Phase 1B Closure — Mobile SHA-256 (real, no stubs).
 *
 * Prefers `expo-crypto.digestStringAsync` for native-speed hashing.
 * Falls back to `@noble/hashes/sha256` (pure-JS, deterministic,
 * audited) on platforms where expo-crypto is unavailable.
 *
 * Operates on `Uint8Array`. Returns hex (lowercase).
 *
 * Tests for cross-runtime determinism are in
 * `services/api/test/phase-1b-closure-runtime.test.ts`.
 */

import * as ExpoCrypto from "expo-crypto";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

/** SHA-256 hex of the given bytes. Bounded — never throws to caller. */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  try {
    // expo-crypto offers `digest(algo, ArrayBuffer | Uint8Array)` →
    // returns ArrayBuffer. Available on iOS + Android natively.
    const buf = await ExpoCrypto.digest(
      ExpoCrypto.CryptoDigestAlgorithm.SHA256,
      // expo-crypto signatures expect BufferSource; Uint8Array<ArrayBuffer>
      // satisfies it but TS lib widens to ArrayBufferLike. Cast through
      // ArrayBuffer for type compatibility (no copy).
      bytes as unknown as ArrayBuffer,
    );
    return bytesToHex(new Uint8Array(buf));
  } catch {
    // Fallback to pure-JS noble implementation.
    return bytesToHex(nobleSha256(bytes));
  }
}

/** SHA-256 hex of a UTF-8 string. */
export async function sha256HexOfString(s: string): Promise<string> {
  return sha256HexOfBytes(new TextEncoder().encode(s));
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 1) {
    out += b[i].toString(16).padStart(2, "0");
  }
  return out;
}
