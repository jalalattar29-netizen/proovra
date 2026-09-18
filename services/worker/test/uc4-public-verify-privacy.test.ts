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

/**
 * Slice from an anchor to the next SEMANTIC boundary (a later marker such as the
 * next route registration or function), never a fixed character budget — a fixed
 * window silently truncates or over-reads when the source changes.
 */
function regionBetween(src: string, from: string, nextBoundary: RegExp): string {
  const start = src.indexOf(from);
  if (start < 0) return "";
  const rest = src.slice(start + from.length);
  const m = nextBoundary.exec(rest);
  return src.slice(start, m ? start + from.length + m.index : src.length);
}

describe("UC-4 public verify — negative privacy (§49)", () => {
  it("the public verify handler does not read UC-4 derived content", () => {
    // Bound the scan to the public verify handler region (up to the next route).
    const region = regionBetween(
      EVIDENCE_ROUTES,
      '"/public/verify/:id"',
      /app\.(get|post|put|patch|delete)\(/,
    );
    expect(region.length).toBeGreaterThan(0);
    expect(region).not.toMatch(/screen_reconstruction/);
    expect(region).not.toMatch(/OCR_SCREEN/);
    expect(region).not.toMatch(/derived-review/);
    expect(region).not.toMatch(/evidenceExtractedText/);
    expect(region).not.toMatch(/readScreenReconstructionDescriptor/);
  });

  it("the Derived Review read route is auth-gated (never public)", () => {
    const region = regionBetween(
      MI_ROUTES,
      '"/v1/evidence/:evidenceId/derived-review"',
      /\{\s*preHandler/,
    );
    // requireAuth appears in the route registration just after the path.
    expect(MI_ROUTES.slice(MI_ROUTES.indexOf('"/v1/evidence/:evidenceId/derived-review"'))).toMatch(
      /"\/v1\/evidence\/:evidenceId\/derived-review",\s*\{\s*preHandler:\s*requireAuth/,
    );
    expect(region).toBeDefined();
  });

  it("the Derived Review generate route is auth-gated with intelligence.run", () => {
    const region = regionBetween(
      MI_ROUTES,
      '"/v1/evidence/:evidenceId/derived-review/generate"',
      /app\.(get|post|put|patch|delete)\(/,
    );
    expect(region.length).toBeGreaterThan(0);
    expect(region).toMatch(/preHandler:\s*requireAuth/);
    expect(region).toMatch(/permission:\s*"intelligence\.run"/);
  });

  it("the keyframe bytes proxy is auth-gated (private keyframes never public)", () => {
    expect(
      MI_ROUTES.slice(
        MI_ROUTES.indexOf('"/v1/evidence/:evidenceId/derived-assets/:assetId/bytes"'),
      ),
    ).toMatch(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/:assetId\/bytes",\s*\{\s*preHandler:\s*requireAuth/,
    );
  });

  it("the reconstruction package manifest declares no prose field", () => {
    // The builder maps block lineage only; it must never map `text`/`content`.
    const region = regionBetween(
      PACKAGE_INTEL,
      "function buildReconstructionManifest",
      /\nfunction [a-zA-Z]/,
    );
    expect(region.length).toBeGreaterThan(0);
    expect(region).not.toMatch(/\btext:\s/);
    expect(region).not.toMatch(/\bcontent:\s/);
    // It DOES carry the DERIVED_RECONSTRUCTED classification honestly.
    expect(region).toMatch(/DERIVED_RECONSTRUCTED/);
  });
});
