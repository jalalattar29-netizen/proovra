/**
 * Phase M2 — C2PA provenance closure tests.
 *
 * Coverage:
 *   * Result schema bounded enums for C2PA status / validation status /
 *     provider mode.
 *   * New warning + limitation codes.
 *   * Old packages without `provenance/c2pa-summary.json` →
 *     `c2pa.status === "missing"` (NEVER failed).
 *   * Packages with `disabled` summary → bounded `disabled`.
 *   * Packages with `not_present` summary → bounded.
 *   * Packages with `valid` summary → reported as `valid`.
 *   * Packages with `invalid` summary → warning surfaces but overall
 *     status does NOT degrade to `failed` solely because of C2PA.
 *   * Schema-invalid summary file → bounded `error`.
 *   * Standing C2PA limitations injected on every result.
 *   * Worker source contract — C2PA summary appended BEFORE
 *     `package-checksums.json`.
 *   * Worker source contract — provider module never reads private
 *     key material from disk.
 *   * Worker source contract — `evaluateEvidenceC2pa` short-circuits
 *     on `C2PA_ENABLED=false`.
 *   * Public mount page surfaces a separate C2PA panel and uses
 *     bounded copy that does not promote C2PA into the core verdict.
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
  C2PA_STATUSES,
  C2PA_VALIDATION_STATUSES,
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

const C2PA_SUMMARY_DISABLED = JSON.stringify({
  schemaVersion: "PROOVRA_C2PA_RESULT_V1",
  generatedAtUtc: "2026-05-28T00:00:00.000Z",
  evidenceId: "00000000-0000-0000-0000-000000000000",
  providerMode: "disabled",
  toolVersion: null,
  aggregateStatus: "disabled",
  aggregateValidationStatus: "not_checked",
  itemsChecked: 0,
  files: [],
  warnings: [],
  limitations: [
    "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
    "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
    "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
    "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
    "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
  ],
  note: "C2PA provenance evaluation is operationally disabled at this PROOVRA deployment. PROOVRA hash/custody integrity is unaffected.",
});

const C2PA_SUMMARY_NOT_PRESENT = JSON.stringify({
  schemaVersion: "PROOVRA_C2PA_RESULT_V1",
  generatedAtUtc: "2026-05-28T00:00:00.000Z",
  evidenceId: "00000000-0000-0000-0000-000000000000",
  providerMode: "detect_only",
  toolVersion: "0.5.0",
  aggregateStatus: "not_present",
  aggregateValidationStatus: "not_checked",
  itemsChecked: 1,
  files: [
    {
      itemId: null,
      mediaType: "image/jpeg",
      status: "not_present",
      manifestDetected: false,
      validationStatus: "not_checked",
      claimSignatureStatus: "not_evaluated",
      claimGenerator: null,
      ingredientsCount: 0,
      assertionsSummary: {
        total: 0,
        actionsCount: 0,
        thumbnailCount: 0,
        hashCount: 0,
        customCount: 0,
      },
      claimTimestampUtc: null,
      failureReason: null,
      warnings: [],
    },
  ],
  warnings: [],
  limitations: [
    "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
    "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
    "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
    "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
    "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
  ],
  note: null,
});

const C2PA_SUMMARY_VALID = JSON.stringify({
  schemaVersion: "PROOVRA_C2PA_RESULT_V1",
  generatedAtUtc: "2026-05-28T00:00:00.000Z",
  evidenceId: "00000000-0000-0000-0000-000000000000",
  providerMode: "validate",
  toolVersion: "0.5.0",
  aggregateStatus: "valid",
  aggregateValidationStatus: "valid",
  itemsChecked: 1,
  files: [
    {
      itemId: null,
      mediaType: "image/jpeg",
      status: "valid",
      manifestDetected: true,
      validationStatus: "valid",
      claimSignatureStatus: "valid",
      claimGenerator: "Test Generator/1.0",
      ingredientsCount: 0,
      assertionsSummary: {
        total: 1,
        actionsCount: 1,
        thumbnailCount: 0,
        hashCount: 0,
        customCount: 0,
      },
      claimTimestampUtc: null,
      failureReason: null,
      warnings: [],
    },
  ],
  warnings: [],
  limitations: [],
  note: null,
});

const C2PA_SUMMARY_INVALID = JSON.stringify({
  schemaVersion: "PROOVRA_C2PA_RESULT_V1",
  generatedAtUtc: "2026-05-28T00:00:00.000Z",
  evidenceId: "00000000-0000-0000-0000-000000000000",
  providerMode: "validate",
  toolVersion: "0.5.0",
  aggregateStatus: "invalid",
  aggregateValidationStatus: "invalid",
  itemsChecked: 1,
  files: [],
  warnings: [],
  limitations: [],
  note: null,
});

describe("M2 — bounded enums", () => {
  it("C2PA_STATUSES is bounded to the documented set", () => {
    expect([...C2PA_STATUSES].sort()).toEqual(
      [
        "not_present",
        "present",
        "valid",
        "invalid",
        "unsupported",
        "disabled",
        "error",
        "missing",
      ].sort(),
    );
  });
  it("C2PA_VALIDATION_STATUSES is bounded", () => {
    expect([...C2PA_VALIDATION_STATUSES].sort()).toEqual(
      ["not_checked", "valid", "invalid", "unsupported", "error"].sort(),
    );
  });
  it("M2 warning codes are present", () => {
    for (const w of [
      "C2PA_SUMMARY_FILE_MISSING",
      "C2PA_SUMMARY_SCHEMA_INVALID",
      "C2PA_PROVIDER_REPORTED_INVALID_MANIFEST",
      "C2PA_PROVIDER_REPORTED_EXTRACTION_ERROR",
    ]) {
      expect(WARNING_CODES).toContain(w);
    }
  });
  it("M2 standing limitations are present", () => {
    for (const code of [
      "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
      "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
      "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
      "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
      "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
      "C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE",
    ]) {
      expect(LIMITATION_CODES).toContain(code);
    }
  });
});

describe("M2 — verifier-core runtime", () => {
  it("missing C2PA summary file → `missing`, warning, never failed", async () => {
    const files = buildPackage();
    const result = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(result.c2pa.status).toBe("missing");
    expect(result.c2pa.validationStatus).toBe("not_checked");
    expect(result.overall.warnings).toContain("C2PA_SUMMARY_FILE_MISSING");
    // C2PA must NEVER cause overall failure on its own.
    expect(result.overall.status).not.toBe("failed");
  });

  it("disabled summary → bounded `disabled`", async () => {
    const files = buildPackage({
      extraIndexed: {
        "provenance/c2pa-summary.json": utf8(C2PA_SUMMARY_DISABLED),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.c2pa.status).toBe("disabled");
    expect(r.c2pa.providerMode).toBe("disabled");
    expect(r.c2pa.itemsChecked).toBe(0);
  });

  it("not_present summary → bounded `not_present`", async () => {
    const files = buildPackage({
      extraIndexed: {
        "provenance/c2pa-summary.json": utf8(C2PA_SUMMARY_NOT_PRESENT),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.c2pa.status).toBe("not_present");
    expect(r.c2pa.validationStatus).toBe("not_checked");
    expect(r.c2pa.itemsChecked).toBe(1);
    expect(r.c2pa.providerMode).toBe("detect_only");
  });

  it("valid summary → bounded `valid`", async () => {
    const files = buildPackage({
      extraIndexed: {
        "provenance/c2pa-summary.json": utf8(C2PA_SUMMARY_VALID),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.c2pa.status).toBe("valid");
    expect(r.c2pa.validationStatus).toBe("valid");
    expect(r.c2pa.providerMode).toBe("validate");
  });

  it("invalid summary → bounded `invalid` + warning, but core integrity NOT promoted to failed", async () => {
    const files = buildPackage({
      extraIndexed: {
        "provenance/c2pa-summary.json": utf8(C2PA_SUMMARY_INVALID),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.c2pa.status).toBe("invalid");
    expect(r.overall.warnings).toContain(
      "C2PA_PROVIDER_REPORTED_INVALID_MANIFEST",
    );
    // Critical: invalid C2PA does NOT cascade to failed overall.
    expect(r.overall.status).not.toBe("failed");
  });

  it("schema-invalid C2PA summary → bounded `error`", async () => {
    const files = buildPackage({
      extraIndexed: {
        "provenance/c2pa-summary.json": utf8("not json at all"),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.c2pa.status).toBe("error");
    expect(r.c2pa.validationStatus).toBe("error");
    expect(r.overall.warnings).toContain("C2PA_SUMMARY_SCHEMA_INVALID");
    expect(r.overall.status).not.toBe("failed");
  });

  it("EVERY result carries the six standing C2PA limitations", async () => {
    const files = buildPackage();
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    for (const code of [
      "C2PA_DOES_NOT_PROVE_CONTENT_TRUTH",
      "C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY",
      "C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY",
      "MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY",
      "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
      "C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE",
    ] as const) {
      expect(r.overall.limitations).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// Source-contract checks: worker module
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function readRepoFile(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf-8");
}

describe("M2 — worker source contracts", () => {
  it("verification-package.ts wires C2PA summary BEFORE package-checksums.json", () => {
    const src = readRepoFile("services/worker/src/verification-package.ts");
    const c2paIdx = src.indexOf("provenance/c2pa-summary.json");
    // Use the actual archive-append call site for the checksums file
    // so we measure ZIP-write order, not type-declaration order.
    const checksumsIdx = src.indexOf(
      'jsonBuffer(buildPackageChecksums(packageEntries))',
    );
    expect(c2paIdx).toBeGreaterThan(0);
    expect(checksumsIdx).toBeGreaterThan(0);
    expect(c2paIdx).toBeLessThan(checksumsIdx);
  });

  it("verification-package.ts also bundles the C2PA verification README", () => {
    const src = readRepoFile("services/worker/src/verification-package.ts");
    expect(src).toContain("provenance/c2pa-verification.md");
  });

  it("provider.ts NEVER reads private key material from disk", () => {
    const src = readRepoFile("services/worker/src/c2pa/provider.ts");
    // No `SIGNING_PRIVATE_KEY_PATH`, no PEM PRIVATE KEY string literals,
    // no readFileSync on signing keys.
    expect(src).not.toMatch(/SIGNING_PRIVATE_KEY_PATH/);
    expect(src).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(src).not.toMatch(/BEGIN RSA PRIVATE KEY/);
  });

  it("provider.ts short-circuits to `disabled` when C2PA_ENABLED is false", () => {
    const src = readRepoFile("services/worker/src/c2pa/provider.ts");
    expect(src).toContain('env.C2PA_ENABLED !== "true"');
    expect(src).toContain('return "disabled"');
  });

  it("package-summary.ts never opens evidence bytes during package build", () => {
    const src = readRepoFile("services/worker/src/c2pa/package-summary.ts");
    expect(src).not.toMatch(/getObjectRange|getObject\(|readFileSync\(/);
    expect(src).toContain("buildDisabledC2paSummary");
  });

  it("package builder accepts an optional `c2paSummary` and falls back to bounded default", () => {
    const src = readRepoFile("services/worker/src/verification-package.ts");
    expect(src).toMatch(/c2paSummary\??:/);
    expect(src).toContain("buildC2paPackageSummary");
    expect(src).toContain("existingSummary:");
  });
});

// ---------------------------------------------------------------------------
// Source-contract checks: public offline-verifier mount page
// ---------------------------------------------------------------------------

describe("M2 — offline-verifier public mount", () => {
  const page = readRepoFile("apps/web/app/offline-verifier/page.tsx");

  it("page reads `provenance/c2pa-summary.json`", () => {
    expect(page).toContain("provenance/c2pa-summary.json");
  });

  it("page renders a SEPARATE C2PA panel with bounded copy", () => {
    expect(page).toContain('data-testid="c2pa-panel"');
    expect(page).toMatch(/C2PA provenance is an interoperability signal/);
  });

  it("page does NOT promote C2PA into the overall integrity verdict", () => {
    // No code path should set `overall = "verified"` purely because
    // C2PA is valid. We check by ensuring no assignment of `overall`
    // mentions `c2pa`.
    const overallAssignments = page.match(/overall\s*=\s*[^;]+/g) ?? [];
    for (const a of overallAssignments) {
      expect(a.toLowerCase()).not.toMatch(/c2pa/);
    }
  });

  it("page does NOT contain forbidden authenticity / truth wording", () => {
    expect(page).not.toMatch(/authentic content proven/i);
    expect(page).not.toMatch(/proof of truth/i);
    expect(page).not.toMatch(/court-admissible/i);
    expect(page).not.toMatch(/court-admit/i);
    // Hyphenless variant (e.g. "court admit")
    expect(page).not.toMatch(/court admit/i);
    expect(page).not.toMatch(/proves authenticity/i);
  });
});

// ---------------------------------------------------------------------------
// Source-contract checks: API public verify
// ---------------------------------------------------------------------------

describe("M2 — public verify payload", () => {
  const src = readRepoFile("services/api/src/routes/evidence.routes.ts");

  it("public verify response includes a SEPARATE `c2paProvenance` field", () => {
    expect(src).toContain("c2paProvenance");
  });

  it("c2paProvenance carries the bounded standing limitations", () => {
    expect(src).toContain("C2PA_DOES_NOT_PROVE_CONTENT_TRUTH");
    expect(src).toContain("MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY");
    expect(src).toContain(
      "INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION",
    );
  });
});

// ---------------------------------------------------------------------------
// Backward-compatibility
// ---------------------------------------------------------------------------

describe("M2 — old packages remain verifiable", () => {
  it("a package with no C2PA file and no historical file still verifies overall", async () => {
    const files = buildPackage();
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    // Overall is bounded (not failed) and C2PA surfaces `missing`.
    expect(["partial", "verified"]).toContain(r.overall.status);
    expect(r.c2pa.status).toBe("missing");
  });
});
