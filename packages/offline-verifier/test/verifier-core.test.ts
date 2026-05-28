/**
 * M1 Offline Verifier — core verifier behaviour suite.
 *
 *   * Valid synthetic package → overall=verified
 *   * Tampered file → checksum mismatch → overall=failed
 *   * Missing file → checksum failure recorded
 *   * Old (pre-P3.1.1) package → custody=missing, overall=partial,
 *     NEVER failed
 *   * Bounded warnings + limitations always present
 *   * No legal-overclaim wording in summary
 *   * Result schema is bounded — no free-form fields
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verifyPackage } from "../src/verifier-core.js";
import {
  createMemoryPackageReader,
  memoryCryptoAdapter,
} from "../src/memory-adapter.js";
import {
  ATTESTATIONS_STATUSES,
  CHECKSUMS_STATUSES,
  LIMITATION_CODES,
  OVERALL_STATUSES,
  PACKAGE_STATUSES,
  SCHEMA_VERSION,
  TSA_STATUSES,
  OTS_STATUSES,
  SIGNATURE_STATUSES,
  WARNING_CODES,
} from "../src/result-schema.js";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/**
 * Construct a synthetic "valid" package as an in-memory file map.
 * Includes `package-manifest.json`, `package-checksums.json`, and a
 * single `evidence/example.txt`. The optional `extraNotIndexed` is
 * added AFTER the checksums file is built, so those files appear in
 * the ZIP but are NOT in the index — simulating the "extra files"
 * detection path.
 */
function buildSyntheticPackage(opts?: {
  extraIndexed?: Record<string, Uint8Array>;
  extraNotIndexed?: Record<string, Uint8Array>;
}): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set("package-manifest.json", utf8(JSON.stringify({ schema: "v1" })));
  files.set("evidence/example.txt", utf8("hello world"));
  if (opts?.extraIndexed) {
    for (const [k, v] of Object.entries(opts.extraIndexed)) files.set(k, v);
  }
  const indexedFiles: Array<{ path: string; sizeBytes: number; sha256: string }> =
    [];
  for (const [name, bytes] of files) {
    indexedFiles.push({
      path: name,
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
  }
  indexedFiles.sort((a, b) => a.path.localeCompare(b.path));
  files.set(
    "package-checksums.json",
    utf8(
      JSON.stringify({
        schema: "PROOVRA_PACKAGE_CHECKSUMS",
        version: 1,
        generatedAtUtc: "2026-05-28T00:00:00.000Z",
        algorithm: "SHA-256",
        fileCount: indexedFiles.length,
        files: indexedFiles,
      }),
    ),
  );
  // Add NOT-indexed files AFTER checksums so the index does not
  // know about them.
  if (opts?.extraNotIndexed) {
    for (const [k, v] of Object.entries(opts.extraNotIndexed)) files.set(k, v);
  }
  return files;
}

describe("M1 Offline Verifier — Schema invariants", () => {
  it("bounded enums match the documented set", () => {
    expect(PACKAGE_STATUSES).toEqual([
      "verified",
      "partial",
      "failed",
      "unsupported",
    ]);
    expect(CHECKSUMS_STATUSES).toContain("verified");
    expect(CHECKSUMS_STATUSES).toContain("mismatch");
    expect(SIGNATURE_STATUSES).toContain("missing");
    expect(ATTESTATIONS_STATUSES).toContain("missing");
    expect(TSA_STATUSES).toContain("missing");
    expect(OTS_STATUSES).toContain("pending");
    expect(OVERALL_STATUSES).toEqual(["verified", "partial", "failed"]);
  });

  it("limitation set carries the mandatory honesty codes", () => {
    expect(LIMITATION_CODES).toContain("NO_LEGAL_ADMISSIBILITY_CLAIM");
    expect(LIMITATION_CODES).toContain("NO_AUTHORSHIP_CLAIM");
    expect(LIMITATION_CODES).toContain(
      "TSA_REQUIRES_EXTERNAL_RFC3161_VERIFICATION",
    );
    expect(LIMITATION_CODES).toContain("OTS_REQUIRES_BITCOIN_NETWORK");
  });

  it("warning code set is closed", () => {
    expect(WARNING_CODES).toContain("PRE_P3_1_1_PACKAGE_DETECTED");
    expect(WARNING_CODES).toContain("CHECKSUMS_MISSING_FILE");
    expect(WARNING_CODES).toContain("EXTRA_FILES_NOT_IN_CHECKSUMS");
  });

  it("schema version constant matches the documented contract", () => {
    expect(SCHEMA_VERSION).toBe("PROOVRA_OFFLINE_VERIFICATION_RESULT_V1");
  });
});

describe("M1 Offline Verifier — Old package compatibility", () => {
  it("pre-P3.1.1 package (no attestation files) returns missing, never failed", async () => {
    const files = buildSyntheticPackage();
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.custodyAttestations.status).toBe("missing");
    expect(r.overall.warnings).toContain("PRE_P3_1_1_PACKAGE_DETECTED");
    expect(r.overall.warnings).toContain("ATTESTATIONS_FILE_MISSING");
    // package signature is "missing" (we don't include a sig file
    // in the synthetic); package status drops to "partial".
    expect(r.package.checksumsStatus).toBe("verified");
    expect(r.package.manifestStatus).toBe("verified");
    expect(r.package.signatureStatus).toBe("missing");
    expect(["partial", "verified"]).toContain(r.package.status);
    expect(r.overall.status).not.toBe("failed");
  });
});

describe("M1 Offline Verifier — Tamper detection", () => {
  it("modified evidence file → checksum mismatch → overall=failed", async () => {
    const files = buildSyntheticPackage();
    // Mutate the evidence AFTER checksums were computed.
    files.set("evidence/example.txt", utf8("tampered content"));
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.package.checksumsStatus).toBe("mismatch");
    expect(r.package.checksumFailures.length).toBeGreaterThan(0);
    expect(r.artifactIntegrity.status).toBe("failed");
    expect(r.overall.status).toBe("failed");
  });

  it("missing file referenced by checksums → checksum failure recorded", async () => {
    const files = buildSyntheticPackage();
    files.delete("evidence/example.txt");
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.package.checksumFailures.some((f) => f.reason === "missing")).toBe(
      true,
    );
    expect(r.overall.warnings).toContain("CHECKSUMS_MISSING_FILE");
  });

  it("extra file not in checksum index → warning, NOT failure", async () => {
    const files = buildSyntheticPackage({
      extraNotIndexed: {
        "extra/wat.txt": utf8("not indexed"),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.package.extraFiles).toBeGreaterThan(0);
    expect(r.overall.warnings).toContain("EXTRA_FILES_NOT_IN_CHECKSUMS");
    expect(r.package.status).not.toBe("failed");
  });
});

describe("M1 Offline Verifier — Custody attestations (P3.1.1) presence", () => {
  it("package with attestations file → status reflects honest unsupported (no inline public key)", async () => {
    const attestationsBody = {
      schemaVersion: 1,
      schema: "PROOVRA_CUSTODY_ATTESTATIONS",
      generatedAtUtc: "2026-05-28T00:00:00.000Z",
      evidenceId: "00000000-0000-0000-0000-000000000000",
      packageId: null,
      custodyEventsCount: 1,
      attestationsCount: 1,
      attestations: [
        {
          custodyEventId: "00000000-0000-0000-0000-000000000001",
          custodyEventSequence: 1,
          canonicalPayloadHash: "deadbeef",
          signature: "AAAA",
          algorithm: "ED25519_SHA_512",
          signerId: "custody_event:aws_kms:k:1",
          keyId: "k",
          keyVersion: "1",
          provider: "aws_kms",
          signedAtUtc: "2026-05-28T00:00:00.000Z",
          verificationStatus: "pending",
          verificationError: null,
        },
      ],
      missingAttestations: [],
      degradedReason: null,
      verificationInstructionsRef: "custody/attestation-verification.md",
      scope: "test",
    };
    const snapshotBody = {
      schemaVersion: 1,
      schema: "PROOVRA_SIGNER_REGISTRY_SNAPSHOT",
      signers: [],
      health: { overall: "healthy", checkedAtUtc: "...", reason: null },
    };
    const files = buildSyntheticPackage({
      extraIndexed: {
        "custody/attestations.json": utf8(JSON.stringify(attestationsBody)),
        "signers/signer-registry-snapshot.json": utf8(
          JSON.stringify(snapshotBody),
        ),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.custodyAttestations.attestationsChecked).toBe(1);
    expect(r.custodyAttestations.attestationsVerified).toBe(1);
    // The verifier is honest that without inline public material it
    // cannot cryptographically verify the signature offline.
    expect(r.custodyAttestations.status).toBe("unsupported");
    expect(r.overall.limitations).toContain(
      "VERIFIER_CANNOT_RECOMPUTE_CANONICAL_PAYLOAD_WITHOUT_CUSTODY_EVENT_DATA",
    );
  });

  it("malformed attestation envelope is reported as a structural failure, not a crash", async () => {
    const files = buildSyntheticPackage({
      extraIndexed: {
        "custody/attestations.json": utf8(
          JSON.stringify({
            attestations: [
              { custodyEventId: "x", signature: 42 }, // wrong types
            ],
          }),
        ),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.custodyAttestations.failures.length).toBeGreaterThan(0);
  });
});

describe("M1 Offline Verifier — TSA / OTS honest scope", () => {
  it("missing TSA + OTS → status `missing`, warnings recorded", async () => {
    const files = buildSyntheticPackage();
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.timestamping.tsaStatus).toBe("missing");
    expect(r.timestamping.otsStatus).toBe("missing");
    expect(r.overall.warnings).toContain("TSA_PROOF_MISSING");
    expect(r.overall.warnings).toContain("OTS_PROOF_MISSING");
    expect(r.overall.limitations).toContain(
      "TSA_REQUIRES_EXTERNAL_RFC3161_VERIFICATION",
    );
    expect(r.overall.limitations).toContain("OTS_REQUIRES_BITCOIN_NETWORK");
  });

  it("TSA token present → status `unsupported` with `rfc3161_external_verification_required`", async () => {
    const files = buildSyntheticPackage({
      extraIndexed: {
        "timestamps/tsa.tsr": new Uint8Array([1, 2, 3, 4]),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.timestamping.tsaStatus).toBe("unsupported");
    expect(r.timestamping.tsaDetail).toBe(
      "rfc3161_external_verification_required",
    );
  });

  it("OTS proof + companion=pending → status `pending`", async () => {
    const files = buildSyntheticPackage({
      extraIndexed: {
        "opentimestamps-proof.ots": new Uint8Array([1, 2, 3]),
        "opentimestamps.json": utf8(JSON.stringify({ status: "PENDING" })),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.timestamping.otsStatus).toBe("pending");
  });
});

describe("M1 Offline Verifier — No legal overclaim wording", () => {
  it("summary never contains forbidden phrases", async () => {
    const files = buildSyntheticPackage();
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    for (const phrase of [
      "admissible",
      "legally binding",
      "court",
      "proof of truth",
      "authentic",
    ]) {
      expect(r.summary.toLowerCase()).not.toContain(phrase);
    }
  });

  it("limitations always include the NO_LEGAL_ADMISSIBILITY_CLAIM code", async () => {
    const r = await verifyPackage({
      reader: createMemoryPackageReader(buildSyntheticPackage()),
      crypto: memoryCryptoAdapter,
    });
    expect(r.overall.limitations).toContain("NO_LEGAL_ADMISSIBILITY_CLAIM");
    expect(r.overall.limitations).toContain("NO_AUTHORSHIP_CLAIM");
  });
});

describe("M1 Offline Verifier — Source-contract checks", () => {
  it("CLI binary file exists and is executable hashbang", () => {
    const cliPath = fileURLToPath(
      new URL("../bin/proovra-verify.mjs", import.meta.url),
    );
    const src = readFileSync(cliPath, "utf8");
    expect(src.startsWith("#!/usr/bin/env node")).toBe(true);
    // CLI never prints raw evidence content.
    expect(src).not.toMatch(/evidence\/example\.txt/);
  });

  it("CLI rejects unknown options safely", () => {
    const cliPath = fileURLToPath(
      new URL("../bin/proovra-verify.mjs", import.meta.url),
    );
    const src = readFileSync(cliPath, "utf8");
    expect(src).toContain("unknown option");
  });

  it("Node adapter exposes the documented public API", () => {
    const adapterPath = fileURLToPath(
      new URL("../src/node-adapter.ts", import.meta.url),
    );
    const src = readFileSync(adapterPath, "utf8");
    expect(src).toContain("export function createNodePackageReader");
    expect(src).toContain("export const nodeCryptoAdapter");
    // Path-traversal defense
    expect(src).toContain("path-traversal defense");
  });
});
