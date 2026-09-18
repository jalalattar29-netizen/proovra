/**
 * UC-4 — Public Verify negative privacy (§49) + auth-gating (source contract).
 *
 * A public verify token is NOT authorization for private derived content:
 *   * the public verify endpoint must not read or emit OCR text, reconstructed
 *     conversation, or keyframe bytes;
 *   * the Derived Review read + the keyframe bytes proxy must be requireAuth;
 *   * the verification-package derivative manifests carry lineage/integrity
 *     metadata only — never reconstructed prose or OCR text.
 *
 * These are enforced by construction (nothing UC-4 was added to the public
 * path); this test is the guard that keeps it that way.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repo = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");

const EVIDENCE_ROUTES = repo("services/api/src/routes/evidence.routes.ts");
const MI_ROUTES = repo("services/api/src/routes/media-intelligence.routes.ts");
const PACKAGE_INTEL = repo("services/worker/src/verification-package-intelligence.ts");

describe("UC-4 public verify — negative privacy (§49)", () => {
  it("the public verify handler does not read UC-4 derived content", () => {
    // Bound the scan to the public verify handler region.
    const start = EVIDENCE_ROUTES.indexOf('"/public/verify/:id"');
    expect(start).toBeGreaterThan(-1);
    const region = EVIDENCE_ROUTES.slice(start, start + 6000);
    expect(region).not.toMatch(/screen_reconstruction/);
    expect(region).not.toMatch(/OCR_SCREEN/);
    expect(region).not.toMatch(/derived-review/);
    expect(region).not.toMatch(/evidenceExtractedText/);
    expect(region).not.toMatch(/readScreenReconstructionDescriptor/);
  });

  it("the Derived Review read route is auth-gated (never public)", () => {
    const start = MI_ROUTES.indexOf('"/v1/evidence/:evidenceId/derived-review"');
    expect(start).toBeGreaterThan(-1);
    // requireAuth appears in the route registration just after the path.
    const region = MI_ROUTES.slice(start, start + 300);
    expect(region).toMatch(/preHandler:\s*requireAuth/);
  });

  it("the Derived Review generate route is auth-gated with intelligence.run", () => {
    const start = MI_ROUTES.indexOf(
      '"/v1/evidence/:evidenceId/derived-review/generate"',
    );
    expect(start).toBeGreaterThan(-1);
    const region = MI_ROUTES.slice(start, start + 900);
    expect(region).toMatch(/preHandler:\s*requireAuth/);
    expect(region).toMatch(/permission:\s*"intelligence\.run"/);
  });

  it("the keyframe bytes proxy is auth-gated (private keyframes never public)", () => {
    const start = MI_ROUTES.indexOf(
      '"/v1/evidence/:evidenceId/derived-assets/:assetId/bytes"',
    );
    expect(start).toBeGreaterThan(-1);
    const region = MI_ROUTES.slice(start, start + 300);
    expect(region).toMatch(/preHandler:\s*requireAuth/);
  });

  it("the reconstruction package manifest declares no prose field", () => {
    // The builder maps block lineage only; it must never map `text`/`content`.
    const start = PACKAGE_INTEL.indexOf("function buildReconstructionManifest");
    expect(start).toBeGreaterThan(-1);
    const region = PACKAGE_INTEL.slice(start, start + 2000);
    expect(region).not.toMatch(/\btext:\s/);
    expect(region).not.toMatch(/\bcontent:\s/);
    // It DOES carry the DERIVED_RECONSTRUCTED classification honestly.
    expect(region).toMatch(/DERIVED_RECONSTRUCTED/);
  });
});
