/**
 * Phase M2.1 — C2PA product closure tests.
 *
 * Coverage:
 *   * New bounded enums on result-schema (C2PA_RAW_MANIFEST_EXPORT_STATUSES,
 *     C2PA_GENERATED_ASSERTION_STATUSES) are exported and bounded.
 *   * New warning codes are present.
 *   * Verifier mirrors raw-manifest export status from the summary.
 *   * Verifier counts raw-manifest files actually present in the ZIP.
 *   * Verifier surfaces a warning when a claimed raw manifest file is
 *     missing from the ZIP.
 *   * Verifier mirrors generated-assertion status from the summary.
 *   * Old packages remain compatible (defaults are bounded).
 *   * Source-contract: worker raw-manifest module never reads private
 *     keys, never writes to evidence storage, enforces export cap.
 *   * Source-contract: api operations-c2pa routes file exposes all
 *     documented endpoints.
 *   * Source-contract: operations C2PA page surfaces bounded copy
 *     and never claims authenticity / admissibility / truth.
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
  C2PA_RAW_MANIFEST_EXPORT_STATUSES,
  C2PA_GENERATED_ASSERTION_STATUSES,
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

const SUMMARY_WITH_RAW_PRESENT = JSON.stringify({
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
      itemId: "item-1",
      mediaType: "image/jpeg",
      status: "valid",
      manifestDetected: true,
      validationStatus: "valid",
      claimSignatureStatus: "valid",
      claimGenerator: "Test/1.0",
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
      rawManifest: {
        status: "exported_to_package",
        sha256Hex: "deadbeef",
        sizeBytes: 64,
        packageRelativePath: "provenance/c2pa-manifests/item-1.c2pa",
      },
    },
  ],
  warnings: [],
  limitations: [],
  rawManifestExportStatus: "exported_to_package",
  generatedAssertion: {
    status: "generation_disabled",
    targetKind: "none",
    derivativeArtifactRef: null,
    verificationPackageSha256: null,
  },
  note: null,
});

const SUMMARY_WITH_RAW_CLAIMED_BUT_MISSING = JSON.stringify({
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
      itemId: "item-99",
      mediaType: "image/jpeg",
      status: "valid",
      manifestDetected: true,
      validationStatus: "valid",
      claimSignatureStatus: "valid",
      claimGenerator: "Test/1.0",
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
      rawManifest: {
        status: "exported_to_package",
        sha256Hex: "deadbeef",
        sizeBytes: 64,
        packageRelativePath: "provenance/c2pa-manifests/item-99.c2pa",
      },
    },
  ],
  warnings: [],
  limitations: [],
  rawManifestExportStatus: "exported_to_package",
  generatedAssertion: { status: "not_generated", targetKind: "none" },
  note: null,
});

const SUMMARY_WITH_GENERATED_ASSERTION = JSON.stringify({
  schemaVersion: "PROOVRA_C2PA_RESULT_V1",
  generatedAtUtc: "2026-05-28T00:00:00.000Z",
  evidenceId: "00000000-0000-0000-0000-000000000000",
  providerMode: "embed_supported",
  toolVersion: "0.5.0",
  aggregateStatus: "valid",
  aggregateValidationStatus: "valid",
  itemsChecked: 1,
  files: [],
  warnings: [],
  limitations: [],
  generatedAssertion: {
    status: "generated_for_derivative",
    targetKind: "verification_package",
    derivativeArtifactRef: "verification_package",
    verificationPackageSha256: "deadbeef",
  },
});

describe("M2.1 — bounded enums", () => {
  it("C2PA_RAW_MANIFEST_EXPORT_STATUSES is bounded", () => {
    expect([...C2PA_RAW_MANIFEST_EXPORT_STATUSES].sort()).toEqual(
      [
        "not_exported",
        "exported_to_package",
        "exported_to_artifact_store",
        "too_large_to_export",
        "unsupported",
        "disabled",
        "missing",
      ].sort(),
    );
  });
  it("C2PA_GENERATED_ASSERTION_STATUSES is bounded", () => {
    expect([...C2PA_GENERATED_ASSERTION_STATUSES].sort()).toEqual(
      [
        "not_generated",
        "generated_for_derivative",
        "generation_disabled",
        "generation_unavailable",
        "generation_refused",
      ].sort(),
    );
  });
  it("M2.1 warning codes are present", () => {
    for (const w of [
      "C2PA_RAW_MANIFEST_FILE_MISSING_FROM_PACKAGE",
      "C2PA_RAW_MANIFEST_REFERENCE_MISMATCH",
      "C2PA_GENERATED_ASSERTION_MISSING_BUT_CLAIMED",
    ]) {
      expect(WARNING_CODES).toContain(w);
    }
  });
});

describe("M2.1 — verifier raw-manifest reconciliation", () => {
  it("raw manifest file present in ZIP → status mirrors summary", async () => {
    const rawBytes = utf8("--C2PA RAW MANIFEST BYTES--");
    const files = buildPackage({
      extraIndexed: {
        "provenance/c2pa-summary.json": utf8(SUMMARY_WITH_RAW_PRESENT),
        "provenance/c2pa-manifests/item-1.c2pa": rawBytes,
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.c2pa.rawManifestExportStatus).toBe("exported_to_package");
    expect(r.c2pa.rawManifestFilesClaimed).toBe(1);
    expect(r.c2pa.rawManifestFilesFound).toBe(1);
    expect(r.overall.warnings).not.toContain(
      "C2PA_RAW_MANIFEST_FILE_MISSING_FROM_PACKAGE",
    );
  });

  it("raw manifest claimed but missing → warning + `missing` status", async () => {
    const files = buildPackage({
      extraIndexed: {
        "provenance/c2pa-summary.json": utf8(
          SUMMARY_WITH_RAW_CLAIMED_BUT_MISSING,
        ),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.c2pa.rawManifestExportStatus).toBe("missing");
    expect(r.c2pa.rawManifestFilesClaimed).toBe(1);
    expect(r.c2pa.rawManifestFilesFound).toBe(0);
    expect(r.overall.warnings).toContain(
      "C2PA_RAW_MANIFEST_FILE_MISSING_FROM_PACKAGE",
    );
  });

  it("generated assertion status mirrors the summary", async () => {
    const files = buildPackage({
      extraIndexed: {
        "provenance/c2pa-summary.json": utf8(SUMMARY_WITH_GENERATED_ASSERTION),
      },
    });
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.c2pa.generatedAssertionStatus).toBe("generated_for_derivative");
  });

  it("old package without c2pa-summary still defaults bounded raw + generation", async () => {
    const files = buildPackage();
    const r = await verifyPackage({
      reader: createMemoryPackageReader(files),
      crypto: memoryCryptoAdapter,
    });
    expect(r.c2pa.rawManifestExportStatus).toBe("disabled");
    expect(r.c2pa.generatedAssertionStatus).toBe("not_generated");
    expect(r.overall.status).not.toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf-8");
}

describe("M2.1 — worker raw-manifest module", () => {
  const src = read("services/worker/src/c2pa/raw-manifest.ts");

  it("never reads private signing keys", () => {
    expect(src).not.toMatch(/SIGNING_PRIVATE_KEY/);
    expect(src).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it("enforces the configured raw manifest cap", () => {
    expect(src).toContain("C2PA_RAW_MANIFEST_MAX_BYTES");
    expect(src).toContain("too_large_to_export");
  });

  it("disabled by default — only checks env flag for export gating", () => {
    expect(src).toContain('env.C2PA_RAW_MANIFEST_EXPORT_ENABLED === "true"');
  });

  it("never writes to S3 / network", () => {
    expect(src).not.toMatch(/PutObject|S3Client|fetch\(/);
  });
});

describe("M2.1 — worker generation readiness probe", () => {
  const src = read("services/worker/src/c2pa/generation-readiness.ts");

  it("never reads key bytes (only fs.access readability check)", () => {
    expect(src).toContain("fs.access");
    expect(src).not.toMatch(/readFile\(/);
    expect(src).not.toMatch(/createReadStream\(/);
    expect(src).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it("returns disabled when generation env is off", () => {
    expect(src).toContain('env.C2PA_GENERATE_MANIFESTS !== "true"');
    expect(src).toContain('"disabled"');
  });

  it("returns bounded `ready` only when ALL checks pass", () => {
    expect(src).toContain('"ready"');
    expect(src).toContain('"missing_cert"');
    expect(src).toContain('"missing_key"');
    expect(src).toContain('"tooling_unavailable"');
  });
});

describe("M2.1 — api operations-c2pa routes", () => {
  const src = read("services/api/src/routes/operations-c2pa.routes.ts");

  it("exposes every documented endpoint", () => {
    for (const route of [
      '"/v1/operations/c2pa"',
      '"/v1/operations/c2pa/backfill/preview"',
      '"/v1/operations/c2pa/backfill/start"',
      '"/v1/operations/c2pa/backfill"',
      '"/v1/operations/c2pa/backfill/:id"',
      '"/v1/operations/c2pa/backfill/:id/cancel"',
      '"/v1/operations/c2pa/backfill/:id/tick"',
      '"/v1/operations/c2pa/generation/readiness"',
      '"/v1/operations/c2pa/generate"',
    ]) {
      expect(src).toContain(route);
    }
  });

  it("backfill start is step-up gated under C2PA_BACKFILL_START", () => {
    expect(src).toContain("requireStepUpForSensitiveAction");
    expect(src).toContain("C2PA_BACKFILL_START");
  });

  it("generate endpoint refuses honestly when pipeline is not wired", () => {
    expect(src).toContain("generation_pipeline_not_wired");
  });

  it("audit events recorded with bounded action labels", () => {
    expect(src).toContain("c2pa_backfill_started");
    expect(src).toContain("c2pa_backfill_completed");
    expect(src).toContain("c2pa_backfill_cancelled");
  });
});

describe("M2.1 — api evidence C2PA endpoints", () => {
  const src = read("services/api/src/routes/evidence.routes.ts");

  it("exposes GET /v1/evidence/:id/c2pa", () => {
    expect(src).toContain('"/v1/evidence/:id/c2pa"');
  });

  it("exposes POST /v1/evidence/:id/c2pa/retry", () => {
    expect(src).toContain('"/v1/evidence/:id/c2pa/retry"');
  });

  it("retry endpoint audits the request with a bounded action", () => {
    expect(src).toContain("c2pa_extraction_retry_requested");
  });

  it("retry endpoint surfaces an honest queued/disabled note (no fake success)", () => {
    expect(src).toContain("Retry queued.");
    expect(src).toContain("C2PA provider is disabled.");
  });
});

describe("M2.1 — operations C2PA web page", () => {
  const page = read("apps/web/app/(app)/operations/c2pa/page.tsx");

  it("renders preview / start / cancel controls with bounded testids", () => {
    expect(page).toContain('data-testid="preview-button"');
    expect(page).toContain('data-testid="start-button"');
    expect(page).toContain('data-testid="provider-status-card"');
    expect(page).toContain('data-testid="generation-readiness-card"');
    expect(page).toContain('data-testid="backfill-card"');
    expect(page).toContain('data-testid="standing-limitations-card"');
  });

  it("page never claims content truth / authenticity / admissibility", () => {
    expect(page).not.toMatch(/authentic content proven/i);
    expect(page).not.toMatch(/proof of truth/i);
    expect(page).not.toMatch(/court-admissible/i);
    expect(page).not.toMatch(/proves authenticity/i);
  });

  it("page restates the standing distinction (does NOT determine truth)", () => {
    expect(page).toMatch(/does NOT determine factual truth/);
  });
});

describe("M2.1 — internal evidence C2PA panel", () => {
  const c = read("apps/web/app/(app)/evidence/components/C2paPanel.tsx");

  it("renders a separate `c2pa-panel` testid", () => {
    expect(c).toContain('data-testid="c2pa-panel"');
  });

  it("retries via the bounded retry endpoint", () => {
    expect(c).toContain('/v1/evidence/${evidenceId}/c2pa/retry');
    expect(c).toContain('data-testid="c2pa-retry-button"');
  });

  it("renders bounded standing caption — does NOT determine factual truth", () => {
    expect(c).toMatch(/does not determine factual truth/);
  });

  it("never claims authenticity / admissibility / truth", () => {
    expect(c).not.toMatch(/authentic content proven/i);
    expect(c).not.toMatch(/proof of truth/i);
    expect(c).not.toMatch(/court-admissible/i);
    expect(c).not.toMatch(/proves authenticity/i);
  });
});
