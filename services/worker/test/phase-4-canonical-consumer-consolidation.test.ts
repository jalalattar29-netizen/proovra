/**
 * PROOVRA Phase 4 — Canonical Consumer Consolidation invariants.
 *
 * These tests pin the Phase 4 deliverables: every consumer that was
 * rewired in this phase must keep consuming canonical materials.
 *
 *   1. Verification Package README contains the three explicit
 *      Evidence-Container boundary statements + describes the new
 *      canonical-record.json file.
 *   2. Report cover renders its "Report Boundary" body from
 *      `vm.canonicalMaterials.legalBoundary.reportBoundary` — no
 *      inline boundary copy remains.
 *
 * Phase 4 explicitly does NOT claim every consumer has been wired;
 * Evidence Detail and dashboard surfaces are documented as Phase 5
 * follow-ups in the final report. This file pins what is delivered
 * so it cannot silently regress.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("Phase 4 — Verification Package README boundary statements", () => {
  const packageSrc = readSrc("../src/verification-package.ts");

  it("README emits the three explicit Evidence-Container boundary lines", () => {
    expect(packageSrc).toContain(
      "This package verifies the exported evidence container.",
    );
    expect(packageSrc).toContain(
      "It does not represent the current live server state.",
    );
    expect(packageSrc).toContain(
      "Use Public Verify to inspect the current live state.",
    );
  });

  it("README describes the new canonical-record.json file", () => {
    // The canonical-record.json file MUST be described in the
    // FILES INCLUDED section so reviewers know what it carries.
    expect(packageSrc).toMatch(
      /canonical-record\.json[\s\S]{0,400}canonical lifecycle material/,
    );
    expect(packageSrc).toMatch(
      /canonical-record\.json[\s\S]{0,800}package-snapshot-only/,
    );
  });
});

describe("Phase 4 — Report cover consumes canonical legal boundary", () => {
  const coverSrc = readSrc("../src/report-v2/sections/cover.ts");

  it("cover renders Report Boundary body from vm.canonicalMaterials.legalBoundary.reportBoundary", () => {
    expect(coverSrc).toContain(
      "vm.canonicalMaterials.legalBoundary.reportBoundary",
    );
  });

  it("cover no longer hardcodes the legacy boundary sentence", () => {
    // The legacy literal text used to live in cover.ts; it must now
    // be sourced from the canonical bundle. The canonical string
    // itself lives in packages/shared/src/canonical-evidence-materials.ts.
    expect(coverSrc).not.toContain(
      "This report verifies integrity state, preservation controls, timestamps,",
    );
  });
});
