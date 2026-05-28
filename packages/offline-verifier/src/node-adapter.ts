/**
 * Node adapter — runs entirely offline. Wraps `adm-zip` for ZIP reading
 * and Node's built-in `crypto` module for SHA-256 + Ed25519 verify.
 */

import AdmZip from "adm-zip";
import { createHash, createPublicKey, verify } from "node:crypto";

import type { CryptoAdapter, PackageReader } from "./verifier-core.js";

export function createNodePackageReader(zipPath: string): PackageReader {
  const zip = new AdmZip(zipPath);
  // Materialise once so the listing is stable.
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const byName = new Map<string, AdmZip.IZipEntry>();
  for (const e of entries) byName.set(normalisePath(e.entryName), e);
  return {
    listFiles(): ReadonlyArray<string> {
      return Array.from(byName.keys()).sort();
    },
    readBytes(path: string): Uint8Array | null {
      const e = byName.get(normalisePath(path));
      if (!e) return null;
      const buf = e.getData();
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    readText(path: string): string | null {
      const bytes = this.readBytes(path);
      if (!bytes) return null;
      // Bounded — refuse to decode > 32 MB of text. Operators with
      // larger manifest files should treat that as anomalous.
      if (bytes.byteLength > 32 * 1024 * 1024) return null;
      return Buffer.from(bytes).toString("utf8");
    },
  };
}

export const nodeCryptoAdapter: CryptoAdapter = {
  sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  },
  async verifyEd25519HexMessage(input) {
    try {
      const pub = createPublicKey({
        key: input.publicKeyPem,
        format: "pem",
      });
      const ok = verify(
        null,
        Buffer.from(input.messageHex, "hex"),
        pub,
        Buffer.from(input.signatureBase64, "base64"),
      );
      return ok;
    } catch {
      return null;
    }
  },
};

function normalisePath(p: string): string {
  // ZIP-slip / path-traversal defense: refuse absolute paths and
  // strip `..` segments before exposing to the verifier.
  const cleaned = p
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((seg) => seg !== ".." && seg !== ".")
    .join("/");
  return cleaned;
}
