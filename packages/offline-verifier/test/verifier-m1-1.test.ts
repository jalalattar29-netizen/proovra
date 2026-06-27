/**
 * Phase M1.1 — Convergence closure tests.
 *
 *   * Historical verification material file present + verifiable →
 *     `historicalVerification.status === "verified"`.
 *   * Historical material missing → `missing` (NEVER failed).
 *   * Unsupported algorithm → bounded warning.
 *   * `currentTrustStatus.status` is ALWAYS `unknown`.
 *   * Standing limitations include the M1.1 trust distinction.
 *   * Result schema enum invariants for the new types.
 *   * Worker source-contract: new file appended BEFORE checksums.
 *   * Public mount page exists with required testids + privacy copy.
 *   * Forbidden trust-overclaim wording absent from both.
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
  CURRENT_TRUST_STATUSES,
  HISTORICAL_VERIFICATION_STATUSES,
  LIMITATION_CODES,
  WARNING_CODES,
} from "../src/result-schema.js";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

function buildPackage(opts?: {
  extraIndexed?: Record<string, Uint8Array>;
}): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set("package-manifest.json", utf8(JSON.stringify({ schema: "v1" })));
  files.set("evidence/example.txt", utf8("hello world"));
  if (opts?.extraIndexed) {
    for (const [k, v] of Object.entries(opts.extraIndexed)) files.set(k, v);
  }
  const indexed: Array<{ path: string; sizeBytes: number; sha256: string }> =
    [];
  for (const [name, bytes] of files) {
    indexed.push({
      path: name,
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
  }
  indexed.sort((a, b) => a.path.localeCompare(b.path));
  files.set(
    "package-checksums.json",
    utf8(
      JSON.stringify({
        schema: "PROOVRA_PACKAGE_CHECKSUMS",
        version: 1,
        algorithm: "SHA-256",
        fileCount: indexed.length,
        files: indexed,
      }),
    ),
  );
  return files;
}

const HISTORICAL_BODY_VERIFIABLE = {
  schemaVersion: 1,
  schema: "PROOVRA_HISTORICAL_VERIFICATION_MATERIAL",
  generatedAtUtc: "2026-05-28T00:00:00.000Z",
  evidenceId: "00000000-0000-0000-0000-000000000000",
  packageId: null,
  signers: [
    {
      signerPurpose: "report_pdf",
      signerId: "report_pdf:aws_kms:k:1",
      provider: "aws_kms",
      keyId: "k",
      keyVersion: "1",
      algorithm: "ED25519_SHA_512",
      signerStatusAtSigningTime: "active",
      verificationMaterial: {
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n",
        publicMaterialRef: "kms:k",
      },
      verificationMaterialType: "kms_public_key_pem",
      generatedFrom: "aws_kms_get_public_key",
      historicalOnly: true,
    },
    {
      signerPurpose: "verification_package",
      signerId: "verification_package:aws_kms:k:1",
      provider: "aws_kms",
      keyId: "k",
      keyVersion: "1",
      algorithm: "ED25519_SHA_512",
      signerStatusAtSigningTime: "active",
      verificationMaterial: {
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n",
        publicMaterialRef: "kms:k",
      },
      verificationMaterialType: "kms_public_key_pem",
      generatedFrom: "aws_kms_get_public_key",
      historicalOnly: true,
    },
  ],
  trustInterpretation: {
    statement: "Historical only.",
    historicalVerificationMaterialReflectsSigningTimeStateOnly: true,
  },
  revocationAwareness: {
    currentLiveRevocationStatusNotIncluded: true,
    note: "Live status not bundled.",
  },
};

const HISTORICAL_BODY_UNSUPPORTED_ALGO = {
  ...HISTORICAL_BODY_VERIFIABLE,
  signers: HISTORICAL_BODY_VERIFIABLE.signers.map((s) => ({
    ...s,
    algorithm: "RSA_SHA_256",
  })),
};

describe("Phase M1.1 — schema invariants", () => {
  it("historicalVerification has exactly the 5 bounded statuses", () => {
    expect(new Set(HISTORICAL_VERIFICATION_STATUSES)).toEqual(
      new Set(["verified", "partial", "failed", "missing", "unsupported"]),
    );
  });

  it("currentTrustStatus has exactly the 3 bounded statuses", () => {
    expect(new Set(CURRENT_TRUST_STATUSES)).toEqual(
      new Set(["unknown", "not_checked", "unsupported"]),
    );
  });

  it("standing limitations include the M1.1 trust distinction codes", () => {
    expect(LIMITATION_CODES).toContain(
      "HISTORICAL_VERIFICATION_DOES_NOT_IMPLY_CURRENT_TRUST",
    );
    expect(LIMITATION_CODES).toContain(
      "CURRENT_REVOCATION_STATUS_NOT_CHECKED_OFFLINE",
    );
    expect(LIMITATION_CODES).toContain(
      "SIGNER_MAY_HAVE_BEEN_ROTATED_OR_REVOKED_AFTER_SIGNING",
    );
  });

  it("warning code set extended with M1.1 entries", () => {
    expect(WARNING_CODES).toContain("HISTORICAL_VERIFICATION_MATERIAL_MISSING");
    expect(WARNING_CODES).toContain("HISTORICAL_VERIFICATION_PARTIAL_COVERAGE");
    expect(WARNING_CODES).toContain(
      "HISTORICAL_VERIFICATION_UNSUPPORTED_ALGORITHM",
    );
  });
});

describe("Phase M1.1 — verifier semantics", () => {
  it("missing historical material → status=missing + warning, never failed", async () => {
    const files = buildPackage();
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.historicalVerification.status).toBe("missing");
    expect(r.overall.warnings).toContain(
      "HISTORICAL_VERIFICATION_MATERIAL_MISSING",
    );
    expect(r.overall.status).not.toBe("failed");
  });

  it("historical material bundled, all entries verifiable → status=verified", async () => {
    const files = buildPackage({
      extraIndexed: {
        "signers/historical-verification-material.json": utf8(
          JSON.stringify(HISTORICAL_BODY_VERIFIABLE),
        ),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.historicalVerification.status).toBe("verified");
    expect(r.historicalVerification.materialEntriesBundled).toBe(2);
    expect(r.historicalVerification.materialEntriesVerifiable).toBe(2);
  });

  it("unsupported algorithm in historical material → warning + partial/unsupported", async () => {
    const files = buildPackage({
      extraIndexed: {
        "signers/historical-verification-material.json": utf8(
          JSON.stringify(HISTORICAL_BODY_UNSUPPORTED_ALGO),
        ),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.overall.warnings).toContain(
      "HISTORICAL_VERIFICATION_UNSUPPORTED_ALGORITHM",
    );
    expect(["partial", "unsupported"]).toContain(
      r.historicalVerification.status,
    );
  });

  it("currentTrustStatus is ALWAYS unknown offline", async () => {
    const files = buildPackage({
      extraIndexed: {
        "signers/historical-verification-material.json": utf8(
          JSON.stringify(HISTORICAL_BODY_VERIFIABLE),
        ),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.currentTrustStatus.status).toBe("unknown");
    expect(r.currentTrustStatus.note).toContain("offline");
  });

  it("standing limitations always present", async () => {
    const files = buildPackage();
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.overall.limitations).toContain("NO_LEGAL_ADMISSIBILITY_CLAIM");
    expect(r.overall.limitations).toContain(
      "HISTORICAL_VERIFICATION_DOES_NOT_IMPLY_CURRENT_TRUST",
    );
    expect(r.overall.limitations).toContain(
      "CURRENT_REVOCATION_STATUS_NOT_CHECKED_OFFLINE",
    );
    expect(r.overall.limitations).toContain(
      "SIGNER_MAY_HAVE_BEEN_ROTATED_OR_REVOKED_AFTER_SIGNING",
    );
  });
});

describe("Phase M1.1 — old-package compatibility", () => {
  it("pre-P3.1.1 + pre-M1.1 package verifies without faking trust", async () => {
    const files = buildPackage();
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.historicalVerification.status).toBe("missing");
    expect(r.custodyAttestations.status).toBe("missing");
    expect(r.currentTrustStatus.status).toBe("unknown");
    expect(r.overall.status).not.toBe("failed");
  });
});

describe("Phase M1.1 — worker source contract", () => {
  it("historical material module is referenced by the package builder", () => {
    const builder = readSource("../../../services/worker/src/verification-package.ts");
    expect(builder).toContain(
      "buildHistoricalVerificationMaterial",
    );
    expect(builder).toContain('"signers/historical-verification-material.json"');
  });

  it("historical material appended BEFORE package-checksums.json", () => {
    const builder = readSource(
      "../../../services/worker/src/verification-package.ts",
    );
    const histIdx = builder.indexOf(
      '"signers/historical-verification-material.json"',
    );
    const sumIdx = builder.lastIndexOf('"package-checksums.json"');
    expect(histIdx).toBeGreaterThan(-1);
    expect(sumIdx).toBeGreaterThan(-1);
    expect(histIdx).toBeLessThan(sumIdx);
  });

  it("historical material module never returns private keys", () => {
    const src = readSource(
      "../../../services/worker/src/verification-package-historical-material.ts",
    );
    expect(src).not.toMatch(/privateKey/);
    expect(src).not.toMatch(/PRIVATE KEY/);
    expect(src).not.toMatch(/AWS_ACCESS_KEY/);
    expect(src).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
  });

  it("historical material module exports the bounded enums", () => {
    const src = readSource(
      "../../../services/worker/src/verification-package-historical-material.ts",
    );
    expect(src).toContain('"ed25519_spki_pem"');
    expect(src).toContain('"kms_public_key_pem"');
    expect(src).toContain('"unsupported"');
    expect(src).toContain("historicalOnly: true");
    expect(src).toContain("currentLiveRevocationStatusNotIncluded: true");
  });
});

describe("Phase M1.1 — public mount on apps/web", () => {
  const page = readSource(
    "../../../apps/web/app/offline-verifier/page.tsx",
  );

  it("page exists at /offline-verifier", () => {
    expect(page.length).toBeGreaterThan(0);
  });

  it("privacy notice is present and prominent", () => {
    expect(page).toContain('data-testid="privacy-notice"');
    expect(page).toContain("never uploaded");
    expect(page).toContain("PROOVRA does");
  });

  it("file input + verify button + download button exposed", () => {
    expect(page).toContain('data-testid="file-input"');
    expect(page).toContain('data-testid="verify-button"');
    expect(page).toContain('data-testid="download-button"');
  });

  it("current trust panel present", () => {
    expect(page).toContain('data-testid="current-trust"');
    expect(page).toContain("Current trust status");
  });

  it("renders the historical signing-time material section", () => {
    expect(page).toContain("Historical verification (signing-time material)");
  });

  it("JSZip is bundled via npm (no external CDN)", () => {
    // Phase 2026-06-25: CDN replaced with local npm import
    expect(page).toContain('import JSZip from "jszip"');
    expect(page).not.toContain("JSZIP_INTEGRITY");
    // no runtime CDN script tag (comment mentions jsdelivr but no script element)
    expect(page).not.toMatch(/<script[^>]*jsdelivr/);
  });

  it("page never fetches the file to PROOVRA", () => {
    // Heuristic: the verify function must not call any fetch() with
    // the file. The page uses JSZip.loadAsync only.
    expect(page).not.toMatch(/fetch\(.*file/);
    expect(page).not.toMatch(/XMLHttpRequest/);
  });

  it("no legal-admissibility / authenticity / 'currently trusted' wording", () => {
    expect(page).not.toMatch(/legally admissible/i);
    expect(page).not.toMatch(/court[- ]admit/i);
    expect(page).not.toMatch(/proof of truth/i);
    expect(page).not.toMatch(/currently trusted/i);
    expect(page).not.toMatch(/trusted forever/i);
  });
});

// ---------------------------------------------------------------------------

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}
