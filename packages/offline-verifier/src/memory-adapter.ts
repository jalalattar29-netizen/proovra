/**
 * In-memory adapter — used by tests and by environments without a
 * ZIP library handy. Builds a `PackageReader` from a plain
 * `Map<path, Uint8Array>`. Crypto: uses Node `crypto` via a dynamic
 * import so the module stays browser-loadable.
 */

import type { CryptoAdapter, PackageReader } from "./verifier-core.js";

export function createMemoryPackageReader(
  files: Map<string, Uint8Array>,
): PackageReader {
  return {
    listFiles() {
      return Array.from(files.keys()).sort();
    },
    readBytes(path) {
      return files.get(path) ?? null;
    },
    readText(path) {
      const b = files.get(path);
      if (!b) return null;
      return new TextDecoder("utf-8").decode(b);
    },
  };
}

/**
 * Crypto adapter that uses Node `crypto` when available, falls back
 * to a "no-op verify" returning null when the environment doesn't
 * expose Ed25519. This makes the in-memory tests work without
 * having to wire a real keypair — the verifier core handles
 * `null` from the adapter as `unsupported`.
 */
export const memoryCryptoAdapter: CryptoAdapter = {
  sha256Hex(bytes) {
    // Lazy require; Node only.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const c = require("node:crypto") as typeof import("node:crypto");
    return c.createHash("sha256").update(bytes).digest("hex");
  },
  async verifyEd25519HexMessage() {
    // Test-only adapter: defer real Ed25519 verification to the
    // Node adapter. Tests that exercise signature verification end-
    // to-end use `nodeCryptoAdapter` directly with a real keypair.
    return null;
  },
};
