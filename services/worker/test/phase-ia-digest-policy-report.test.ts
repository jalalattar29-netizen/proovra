/**
 * Phase IA-digest-policy — worker-side digest-source contract for
 * report + verification package rendering.
 *
 * The report's "Timestamped Digest" label MUST be sourced from
 * `evidence.tsaInputKind` (CANONICAL_PACKAGE_SHA256 or FILE_SHA256),
 * NOT hard-coded. The digest VALUE rendered in the mono-block MUST be
 * sourced from `evidence.tsaMessageImprint` or `evidence.tsaInputDigestHex`,
 * NOT re-derived from `evidence.fileSha256`.
 *
 * These tests pin the source contract so a refactor that hard-codes a
 * "lead item SHA-256" label or re-derives the digest from fileSha256
 * trips this suite.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeTsaDigestSource } from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// ============================================================================
// 1. technical-appendix.ts — uses the shared digest-source helper
// ============================================================================

describe("Phase IA-digest-policy — technical appendix label routing", () => {
  const APPENDIX = readSource(
    "../src/report-v2/sections/technical-appendix.ts",
  );

  it("imports describeTsaDigestSource from @proovra/shared", () => {
    expect(APPENDIX).toMatch(
      /import\s*\{[\s\S]{0,200}describeTsaDigestSource[\s\S]{0,200}from\s*["']@proovra\/shared["']/,
    );
  });

  it("derives timestampDigestLabel from vm.technicalAppendix.tsaInputKind via the helper", () => {
    expect(APPENDIX).toMatch(
      /describeTsaDigestSource\(vm\.technicalAppendix\.tsaInputKind\s*\?\?\s*null\)/,
    );
  });

  it("does NOT hard-code the legacy 'lead item SHA-256 for multipart' label", () => {
    // Pre-fix this hard-coded fallback said "lead item SHA-256 for
    // multipart; original file SHA-256 for single" — which lied
    // because the actual tsaInputKind for multipart is
    // CANONICAL_PACKAGE_SHA256, not "lead item".
    expect(APPENDIX).not.toMatch(/lead item SHA-256/);
  });
});

// ============================================================================
// 2. technical-model.ts — sources digests from persisted columns
// ============================================================================

describe("Phase IA-digest-policy — technical model sources digests from persisted columns", () => {
  const MODEL = readSource("../src/report-v2/technical-model.ts");

  it("tsaMessageImprint is read from evidence.tsaMessageImprint", () => {
    expect(MODEL).toMatch(
      /tsaMessageImprint:\s*safe\(evidence\.tsaMessageImprint\)/,
    );
  });

  it("tsaInputDigestHex is read from evidence.tsaInputDigestHex", () => {
    expect(MODEL).toMatch(
      /tsaInputDigestHex:\s*safe\(evidence\.tsaInputDigestHex\)/,
    );
  });

  it("tsaInputKind is read from evidence.tsaInputKind", () => {
    expect(MODEL).toMatch(/tsaInputKind:\s*safe\(evidence\.tsaInputKind\)/);
  });

  it("otsHash is read from evidence.otsHash", () => {
    expect(MODEL).toMatch(/otsHash:\s*safe\(evidence\.otsHash\)/);
  });

  it("NEVER reads fileSha256 as a TSA digest source", () => {
    // The TSA digest fields must NEVER fall back to evidence.fileSha256
    // — that would silently lie on a future label/digest mix-up.
    expect(MODEL).not.toMatch(/tsaMessageImprint:\s*[\s\S]{0,100}fileSha256/);
    expect(MODEL).not.toMatch(/tsaInputDigestHex:\s*[\s\S]{0,100}fileSha256/);
  });
});

// ============================================================================
// 3. build-view-model.ts — snapshot manifest sources digests from persisted columns
// ============================================================================

describe("Phase IA-digest-policy — verification snapshot manifest sources digests from persisted columns", () => {
  const SNAPSHOT_BUILDER = readSource(
    "../src/report-v2/build-view-model.ts",
  );

  it("snapshot manifest tsaMessageImprint is sourced from evidence.tsaMessageImprint", () => {
    expect(SNAPSHOT_BUILDER).toMatch(
      /tsaMessageImprint:\s*input\.evidence\.tsaMessageImprint/,
    );
  });

  it("snapshot manifest otsHash is sourced from the OTS-evidence projection", () => {
    expect(SNAPSHOT_BUILDER).toMatch(/otsHash:\s*otsEvidence\.otsHash/);
  });

  it("snapshot manifest never re-derives a TSA digest from fileSha256", () => {
    expect(SNAPSHOT_BUILDER).not.toMatch(
      /tsaMessageImprint:\s*[\s\S]{0,100}fileSha256/,
    );
  });
});

// ============================================================================
// 4. Shared helper sanity — label mapping
// ============================================================================

describe("Phase IA-digest-policy — describeTsaDigestSource label mapping", () => {
  it("maps CANONICAL_PACKAGE_SHA256 to the canonical-package label", () => {
    expect(describeTsaDigestSource("CANONICAL_PACKAGE_SHA256")).toMatch(
      /canonical package SHA-256/i,
    );
  });

  it("maps FILE_SHA256 to the original-file label", () => {
    expect(describeTsaDigestSource("FILE_SHA256")).toMatch(
      /original file SHA-256/i,
    );
  });

  it("falls back to 'Timestamped digest' for null/unknown kind", () => {
    expect(describeTsaDigestSource(null)).toBe("Timestamped digest");
    expect(describeTsaDigestSource(undefined)).toBe("Timestamped digest");
    expect(describeTsaDigestSource("UNKNOWN_FUTURE_KIND")).toBe(
      "Timestamped digest",
    );
  });
});
