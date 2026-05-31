/**
 * Phase 1B — Capture Signature Verifier.
 *
 * Server-side verifier of the at-source capture signature:
 *
 *   1. SHA-256 the raw bytes; assert equality with `payload.assetHash`.
 *   2. Deterministically canonicalise the payload via canonical-json
 *      (`canonicalize()`); the bytes signed are exactly this output.
 *   3. Verify the signature against the device-bound public key under
 *      the algorithm declared in the payload (`Ed25519` /
 *      `ECDSA_P256_SHA256`).
 *
 * Hard rules:
 *   * NEVER throws to the caller. Operational + cryptographic
 *     failures collapse to a bounded `CaptureSignatureVerdict`.
 *   * The verifier reads the device's stored public key by id; the
 *     caller has already established the device-workspace binding.
 *   * Algorithm mismatch is a bounded denial — the device's
 *     registered algorithm must match the payload's `algorithm` field.
 *   * Payload schema is structurally validated; structural failures
 *     map to `INVALID_CANONICAL_JSON`.
 *   * Replay defense lives at the attestation layer (nonce uniqueness
 *     per device); the signature verifier focuses on cryptographic
 *     correctness.
 */

import { createHash, createVerify, verify as cryptoVerify } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import {
  CAPTURE_SIGNATURE_ALGORITHMS,
  signatureVerdictIsFatal,
  type CaptureSignaturePayload,
  type CaptureSignatureVerdict,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { canonicalize, CanonicalJsonError } from "./canonical-json.js";

// -----------------------------------------------------------------------------
// Public input/output
// -----------------------------------------------------------------------------

export type VerifyCaptureSignatureInput = {
  prisma?: PrismaClient;
  teamId: string;
  /** Raw payload as received from the mobile/SDK side. */
  payload: CaptureSignaturePayload;
  /** Signature bytes hex (base16). */
  signatureHex: string;
  /** Raw asset bytes (for re-hash). */
  assetBytes: Buffer;
};

export type CaptureSignatureVerificationResult = {
  verdict: CaptureSignatureVerdict;
  /** True when the verdict is fatal (caller must refuse ingest). */
  fatal: boolean;
  /** Computed asset hash, for the caller's records. */
  computedAssetHash: string;
  /** Computed canonical JSON bytes length (audit-friendly). */
  canonicalBytesLength: number;
  /** Device id that was matched (when applicable). */
  deviceId: string | null;
};

// -----------------------------------------------------------------------------
// Public verifier
// -----------------------------------------------------------------------------

export async function verifyCaptureSignature(
  input: VerifyCaptureSignatureInput,
): Promise<CaptureSignatureVerificationResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // Step 0 — schema gate.
  const schemaError = structuralValidate(input.payload);
  if (schemaError) {
    return result("INVALID_CANONICAL_JSON", "", 0, null);
  }

  // Step 1 — re-hash bytes.
  const computedAssetHash = createHash("sha256")
    .update(input.assetBytes)
    .digest("hex");
  if (computedAssetHash !== input.payload.assetHash.toLowerCase()) {
    return result("INVALID_HASH", computedAssetHash, 0, null);
  }

  // Step 2 — algorithm gate.
  if (
    !(CAPTURE_SIGNATURE_ALGORITHMS as ReadonlyArray<string>).includes(
      input.payload.algorithm,
    )
  ) {
    return result("ALGORITHM_UNSUPPORTED", computedAssetHash, 0, null);
  }

  // Step 3 — device lookup.
  const device = await prisma.device.findFirst({
    where: { id: input.payload.deviceKeyId, teamId: input.teamId },
    select: {
      id: true,
      publicKeyHex: true,
      signatureAlgorithm: true,
      revokedAtUtc: true,
    },
  });
  if (!device || device.revokedAtUtc !== null) {
    return result("UNKNOWN_DEVICE", computedAssetHash, 0, null);
  }
  if (device.signatureAlgorithm !== input.payload.algorithm) {
    return result("ALGORITHM_UNSUPPORTED", computedAssetHash, 0, device.id);
  }

  // Step 4 — canonical-JSON of the payload.
  let canonical: string;
  try {
    canonical = canonicalize(input.payload);
  } catch (err) {
    if (err instanceof CanonicalJsonError) {
      return result(
        "INVALID_CANONICAL_JSON",
        computedAssetHash,
        0,
        device.id,
      );
    }
    return result(
      "INVALID_CANONICAL_JSON",
      computedAssetHash,
      0,
      device.id,
    );
  }
  const canonicalBytes = Buffer.from(canonical, "utf8");

  // Step 5 — crypto verify.
  const signatureBytes = (() => {
    try {
      return Buffer.from(input.signatureHex, "hex");
    } catch {
      return null;
    }
  })();
  if (!signatureBytes) {
    return result(
      "INVALID_SIGNATURE",
      computedAssetHash,
      canonicalBytes.length,
      device.id,
    );
  }

  let valid = false;
  try {
    if (input.payload.algorithm === "Ed25519") {
      // Node `crypto.verify(algorithm, data, key, sig)` with `null`
      // algorithm uses the key's algorithm — Ed25519 keys are
      // raw-encoded as 32-byte public keys (or as a SPKI DER). We
      // construct a minimal SPKI-encoded public-key PEM for the
      // verify call.
      const spkiPem = ed25519RawPubkeyToPem(device.publicKeyHex);
      if (!spkiPem) {
        return result(
          "INVALID_SIGNATURE",
          computedAssetHash,
          canonicalBytes.length,
          device.id,
        );
      }
      valid = cryptoVerify(null, canonicalBytes, spkiPem, signatureBytes);
    } else {
      // ECDSA P-256 — public key is uncompressed-point (0x04 || X || Y),
      // 65 bytes → SPKI wrapper.
      const spkiPem = p256RawPubkeyToPem(device.publicKeyHex);
      if (!spkiPem) {
        return result(
          "INVALID_SIGNATURE",
          computedAssetHash,
          canonicalBytes.length,
          device.id,
        );
      }
      const verifier = createVerify("sha256");
      verifier.update(canonicalBytes);
      verifier.end();
      valid = verifier.verify(spkiPem, signatureBytes);
    }
  } catch {
    return result(
      "INVALID_SIGNATURE",
      computedAssetHash,
      canonicalBytes.length,
      device.id,
    );
  }

  return result(
    valid ? "VALID" : "INVALID_SIGNATURE",
    computedAssetHash,
    canonicalBytes.length,
    device.id,
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function result(
  verdict: CaptureSignatureVerdict,
  computedAssetHash: string,
  canonicalBytesLength: number,
  deviceId: string | null,
): CaptureSignatureVerificationResult {
  return {
    verdict,
    fatal: signatureVerdictIsFatal(verdict),
    computedAssetHash,
    canonicalBytesLength,
    deviceId,
  };
}

function structuralValidate(p: unknown): string | null {
  if (typeof p !== "object" || p === null) return "not-object";
  const o = p as Record<string, unknown>;
  if (o["schemaVersion"] !== "PROOVRA_CAPTURE_SIG_V1") return "schema-version";
  if (typeof o["assetHash"] !== "string" || (o["assetHash"] as string).length !== 64) {
    return "asset-hash";
  }
  if (typeof o["captureMode"] !== "string") return "capture-mode";
  if (typeof o["provenanceClass"] !== "string") return "provenance-class";
  if (typeof o["deviceKeyId"] !== "string") return "device-key-id";
  if (typeof o["algorithm"] !== "string") return "algorithm";
  if (typeof o["captureSessionId"] !== "string") return "capture-session-id";
  if (typeof o["signedAtUtc"] !== "string") return "signed-at-utc";
  if (typeof o["signedAtMonotonicNs"] !== "string") return "monotonic";
  if (typeof o["nonceHex"] !== "string" || (o["nonceHex"] as string).length !== 64) {
    return "nonce-hex";
  }
  if (typeof o["metadata"] !== "object" || o["metadata"] === null) return "metadata";
  return null;
}

/**
 * Build a SPKI-PEM-encoded Ed25519 public key from a 32-byte hex string.
 *
 * The SPKI DER structure for Ed25519 (RFC 8410):
 *   30 2A                                        ; SEQUENCE (42 bytes)
 *      30 05                                     ; SEQUENCE (5 bytes)
 *         06 03 2B 65 70                         ; OID 1.3.101.112 (Ed25519)
 *      03 21 00 <32-byte raw pubkey>             ; BIT STRING (33 bytes, 0 unused bits)
 *
 * We construct the full 44-byte DER and base64-encode for PEM.
 */
function ed25519RawPubkeyToPem(hex: string): string | null {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) return null;
  const der = Buffer.concat([
    Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
    raw,
  ]);
  return wrapPem(der, "PUBLIC KEY");
}

/**
 * Build a SPKI-PEM-encoded EC P-256 public key from a 65-byte uncompressed
 * point hex string (`0x04 || X || Y`).
 *
 * The SPKI DER structure for prime256v1 (RFC 5480):
 *   30 59                                        ; SEQUENCE (89 bytes)
 *      30 13                                     ; SEQUENCE (19 bytes)
 *         06 07 2A 86 48 CE 3D 02 01             ; OID 1.2.840.10045.2.1 (ecPublicKey)
 *         06 08 2A 86 48 CE 3D 03 01 07         ; OID 1.2.840.10045.3.1.7 (prime256v1)
 *      03 42 00 <65-byte uncompressed point>    ; BIT STRING (66 bytes, 0 unused bits)
 */
function p256RawPubkeyToPem(hex: string): string | null {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 65 || raw[0] !== 0x04) return null;
  const der = Buffer.concat([
    Buffer.from([
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
      0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03,
      0x42, 0x00,
    ]),
    raw,
  ]);
  return wrapPem(der, "PUBLIC KEY");
}

function wrapPem(der: Buffer, label: string): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
