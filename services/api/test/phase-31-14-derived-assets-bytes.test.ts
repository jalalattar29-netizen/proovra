/**
 * Phase 31.14 — Derived asset bytes serving + real UI rendering +
 * report/package coherence wiring.
 *
 * Layers covered:
 *
 *   1. GET projection now attaches `bytesUrl` (workspace-internal
 *      proxy URL) for COMPLETED assets; null for non-completed.
 *   2. Bytes proxy route — bounded auth, anti-enumeration, status
 *      gate, bounded error codes, never exposes storage internals.
 *   3. UI hook + panel use the `bytesUrl` field, never storage
 *      keys. Real `<img>` renders; loading/error/failed states.
 *   4. Preview modal: keyboard accessible, Escape closes, body
 *      scroll suppressed.
 *   5. Report projection: real derived thumbnails embedded as
 *      bounded data URLs. PDF byte budget enforced.
 *   6. Verification package: bridge populates derived_assets
 *      manifest from real DB rows. Asset-kind enum narrowed to
 *      package vocabulary.
 *   7. Anti-leak across all 6 surfaces.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Bytes proxy route
// =============================================================================

describe("Phase 31.14 — derived-assets bytes proxy route", () => {
  const src = readSource(
    "../src/routes/media-intelligence.routes.ts",
  );

  it("route registered at /v1/evidence/:evidenceId/derived-assets/:assetId/bytes", () => {
    expect(src).toMatch(
      /app\.get\(\s*"\/v1\/evidence\/:evidenceId\/derived-assets\/:assetId\/bytes"/,
    );
  });

  it("gated by authorizeOrFail + evidence.read + antiEnumeration", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/:assetId\/bytes"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/authorizeOrFail/);
    expect(block!).toMatch(/permission:\s*"evidence\.read"/);
    expect(block!).toMatch(/antiEnumeration:\s*true/);
  });

  it("anti-enumeration on evidence: cross-team id returns 404 `not_found`", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/:assetId\/bytes"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/evidence\.teamId !== teamId/);
    expect(block!).toMatch(
      /reply\.code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"\s*\}/,
    );
  });

  it("asset row team + evidence binding (anti-enumeration)", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/:assetId\/bytes"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(
      /WHERE "id" = \$1[\s\S]*?AND "team_id" = \$2[\s\S]*?AND "evidence_id" = \$3/,
    );
  });

  it("status gate: only COMPLETED serves bytes (PENDING/etc → 404 asset_not_ready)", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/:assetId\/bytes"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/row\.status !== "COMPLETED"/);
    expect(block!).toMatch(/code:\s*"asset_not_ready"/);
  });

  it("storage failures → 503 storage_unavailable, never leaks bucket/key", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/:assetId\/bytes"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/code:\s*"storage_unavailable"/);
    // Defence in depth: no storage internals in the route handler body.
    const noComments = block!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageBucket",
      "storageKey",
      "presignedUrl",
      "signedUrl",
    ]) {
      expect(noComments, `bytes route leaks ${banned}`).not.toContain(banned);
    }
  });

  it("uses internal _getDerivedAssetStorageReference helper (worker-side bytes serving pattern)", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/:assetId\/bytes"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/_getDerivedAssetStorageReference/);
  });

  it("response headers: content-type, content-length, cache-control immutable, etag, security defence", () => {
    const block = src.match(
      /"\/v1\/evidence\/:evidenceId\/derived-assets\/:assetId\/bytes"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/reply\.header\(\s*"content-type"/);
    expect(block!).toMatch(/reply\.header\(\s*"content-length"/);
    expect(block!).toMatch(/reply\.header\(\s*"cache-control"[\s\S]*?immutable/);
    expect(block!).toMatch(/reply\.header\(\s*"etag"/);
    expect(block!).toMatch(/x-content-type-options.*nosniff/);
    expect(block!).toMatch(/referrer-policy.*no-referrer/);
  });

  it("GET list projection attaches bytesUrl for COMPLETED + null otherwise", () => {
    expect(src).toMatch(
      /bytesUrl:[\s\S]*?a\.status === "COMPLETED"[\s\S]*?:\s*null/,
    );
  });

  it("bytesUrl is an INTERNAL proxy path (NOT a storage URL)", () => {
    expect(src).toMatch(
      /`\/v1\/evidence\/\$\{encodeURIComponent\(evidenceId\)\}\/derived-assets\/\$\{encodeURIComponent\(a\.id\)\}\/bytes/,
    );
  });
});

// =============================================================================
// PART 2 — UI hook
// =============================================================================

describe("Phase 31.14 — useDerivedAssets hook", () => {
  const src = readSource(
    "../../../apps/web/lib/media-intelligence/useDerivedAssets.ts",
  );

  it("DerivedAssetRow type carries bytesUrl: string | null", () => {
    expect(src).toMatch(/bytesUrl:\s*string\s*\|\s*null/);
  });
});

// =============================================================================
// PART 3 — Panel UI: real images + modal
// =============================================================================

describe("Phase 31.14 — MediaIntelligencePanel real-image rendering", () => {
  const src = readSource(
    "../../../apps/web/components/media-intelligence/MediaIntelligencePanel.tsx",
  );

  it("renders <img> from bytesUrl (not from storage_key / signed URL)", () => {
    expect(src).toMatch(/<img\s[\s\S]*?src=\{asset\.bytesUrl\}/);
  });

  it("button is keyboard accessible — has aria-label + type='button'", () => {
    const thumb = src.match(
      /function DerivedAssetThumbnail[\s\S]*?return \([\s\S]*?\);\s*\n\}/,
    )?.[0];
    expect(thumb).toBeTruthy();
    expect(thumb!).toMatch(/type="button"/);
    expect(thumb!).toMatch(/aria-label=\{`Open[\s\S]*?preview`\}/);
  });

  it("loading / loaded / failed state machine (no infinite loop on image error)", () => {
    expect(src).toMatch(/setImageState\("loaded"\)/);
    expect(src).toMatch(/setImageState\("failed"\)/);
  });

  it("preview modal: dialog role + aria-modal + Escape-to-close + body scroll suppression", () => {
    const modal = src.match(
      /function DerivedAssetPreviewModal[\s\S]*?return \([\s\S]*?\);\s*\n\}/,
    )?.[0];
    expect(modal).toBeTruthy();
    expect(modal!).toMatch(/role="dialog"/);
    expect(modal!).toMatch(/aria-modal="true"/);

    // Esc + body overflow suppression live in the strip's effect.
    const strip = src.match(
      /function DerivedAssetsStrip[\s\S]*?\n\}\s*\n/,
    )?.[0];
    expect(strip).toBeTruthy();
    expect(strip!).toMatch(/e\.key === "Escape"/);
    expect(strip!).toMatch(/document\.body\.style\.overflow = "hidden"/);
  });

  it("preview modal disclaimer: advisory + not-substitute-for-original + canonical-custody", () => {
    const flat = src.replace(/\s+/g, " ");
    expect(flat).toMatch(/operator-facing rendering/);
    expect(flat).toMatch(/advisory aid only/);
    expect(flat).toMatch(/canonical custody record/);
  });

  it("'derived' label appears on every thumbnail card (never imply original)", () => {
    const thumb = src.match(
      /function DerivedAssetThumbnail[\s\S]*?return \([\s\S]*?\);\s*\n\}/,
    )?.[0];
    expect(thumb!).toMatch(/\(derived\)/);
  });

  it("no storage internals or signed-URL references anywhere in the panel", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageKey",
      "storage_key",
      "storageBucket",
      "storage_bucket",
      "signedUrl",
      "signed_url",
      "presignedUrl",
    ]) {
      expect(noComments, `panel leaks ${banned}`).not.toContain(banned);
    }
  });

  it("no forbidden vocabulary in user-facing literals", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(lit, `panel forbidden wording: ${lit}`).not.toMatch(forbidden);
    }
  });
});

// =============================================================================
// PART 4 — Report projection extension
// =============================================================================

describe("Phase 31.14 — report projection derivedThumbnails wiring", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/media-intelligence/report-projection.service.ts",
  );

  it("now returns null only when BOTH signals + thumbnails are empty", () => {
    expect(src).toMatch(
      /signals\.length === 0 && derivedThumbnails\.length === 0/,
    );
  });

  it("loadDerivedThumbnailsForReport: bounded thumbnail count + byte cap", () => {
    expect(src).toMatch(/MAX_REPORT_THUMBNAILS\s*=\s*6/);
    expect(src).toMatch(
      /MAX_REPORT_THUMBNAIL_BYTES\s*=\s*256\s*\*\s*1024/,
    );
  });

  it("SELECTs only COMPLETED image_thumbnail assets", () => {
    const fn = src.match(
      /async function loadDerivedThumbnailsForReport[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/"asset_kind" = 'image_thumbnail'/);
    expect(fn!).toMatch(/"status" = 'COMPLETED'/);
  });

  it("uses _getDerivedAssetStorageReference (internal) to fetch bytes; never exposes storage keys in the projection", () => {
    const fn = src.match(
      /async function loadDerivedThumbnailsForReport[\s\S]*?\n\}/,
    )?.[0];
    expect(fn!).toMatch(/_getDerivedAssetStorageReference/);
    // Output shape mirrors the renderer input: { materialId, dataUrl, assetKind }.
    expect(fn!).toMatch(/materialId:\s*row\.evidence_part_id/);
    expect(fn!).toMatch(/dataUrl:\s*`data:\$\{contentType\};base64,/);
  });

  it("single-asset failure is non-fatal — other thumbnails still ship", () => {
    const fn = src.match(
      /async function loadDerivedThumbnailsForReport[\s\S]*?\n\}/,
    )?.[0];
    expect(fn!).toMatch(/catch\s*\{[\s\S]*?continue;/);
  });

  it("never throws — outer try/catch returns []", () => {
    const fn = src.match(
      /async function loadDerivedThumbnailsForReport[\s\S]*?\n\}/,
    )?.[0];
    expect(fn!).toMatch(/catch\s*\{[\s\S]*?return\s+\[\]/);
  });

  it("anti-leak: no storage_bucket / storage_key referenced", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storage_bucket",
      "storageBucket",
      "storage_key",
      "storageKey",
      "signedUrl",
      "presignedUrl",
    ]) {
      expect(noComments, `report projection leaks ${banned}`).not.toContain(
        banned,
      );
    }
  });
});

// =============================================================================
// PART 5 — Verification package bridge
// =============================================================================

describe("Phase 31.14 — verification package intelligence bridge", () => {
  const src = readSource(
    "../../../services/worker/src/verification-package-intelligence-bridge.ts",
  );

  it("imports canonical prisma from worker db.js (NEVER bare PrismaClient)", () => {
    expect(src).toMatch(/import\s*\{\s*prisma\s*\}\s*from\s*"\.\/db\.js"/);
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/new\s+PrismaClient\s*\(/);
  });

  it("never throws — returns null on any error", () => {
    expect(src).toMatch(
      /try\s*\{[\s\S]*?\}\s*catch\s*\(err\)[\s\S]*?return\s+null/,
    );
  });

  it("refuses without teamId (anti-enumeration)", () => {
    expect(src).toMatch(/if\s*\(!input\.teamId\)\s*\{?\s*return\s+null/);
  });

  it("filters derived assets to COMPLETED + bounded size + non-null hash + supported kind", () => {
    expect(src).toMatch(/a\.status === "COMPLETED"/);
    expect(src).toMatch(/a\.derivedSha256 != null/);
    expect(src).toMatch(/a\.sizeBytes != null/);
    expect(src).toMatch(/MAX_PACKAGE_THUMBNAIL_BYTES/);
    expect(src).toMatch(/PACKAGE_ASSET_KINDS\.has\(a\.assetKind\)/);
  });

  it("compact_review_preview is NOT in the package asset-kind allow list (reserved)", () => {
    const setDecl = src.match(/PACKAGE_ASSET_KINDS = new Set\(\[[\s\S]*?\]\)/)?.[0];
    expect(setDecl).toBeTruthy();
    expect(setDecl!).toContain('"image_thumbnail"');
    expect(setDecl!).toContain('"video_frame"');
    expect(setDecl!).toContain('"audio_waveform"');
    expect(setDecl!).toContain('"low_res_proxy"');
    expect(setDecl!).not.toContain("compact_review_preview");
  });

  it("returns null when there are no signals AND no derived assets", () => {
    expect(src).toMatch(
      /mediaSignals\.length === 0 && derivedAssets\.length === 0[\s\S]*?return\s+null/,
    );
  });

  it("anti-leak: no storage internals referenced in bridge source", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storage_bucket",
      "storageBucket",
      "storage_key",
      "storageKey",
      "signedUrl",
      "presignedUrl",
    ]) {
      expect(noComments, `bridge leaks ${banned}`).not.toContain(banned);
    }
  });
});

describe("Phase 31.14 — worker processor wires verification-package intelligence", () => {
  const src = readSource("../../../services/worker/src/processor.ts");

  it("imports the bridge", () => {
    expect(src).toMatch(
      /import\s*\{\s*buildVerificationPackageIntelligence\s*\}\s*from\s*"\.\/verification-package-intelligence-bridge\.js"/,
    );
  });

  it("call site populates intelligence on createVerificationPackage", () => {
    expect(src).toMatch(/buildVerificationPackageIntelligence\(\{/);
    expect(src).toMatch(
      /createVerificationPackage\(\{[\s\S]*?intelligence:\s*verificationPackageIntelligence/,
    );
  });
});

// =============================================================================
// PART 6 — Anti-leak across all new surfaces
// =============================================================================

describe("Phase 31.14 — cross-source anti-leak", () => {
  const sources = [
    "../src/routes/media-intelligence.routes.ts",
    "../../../packages/shared-runtime/src/media-intelligence/report-projection.service.ts",
    "../../../services/worker/src/verification-package-intelligence-bridge.ts",
    "../../../apps/web/lib/media-intelligence/useDerivedAssets.ts",
    "../../../apps/web/components/media-intelligence/MediaIntelligencePanel.tsx",
  ].map(readSource);

  it("no forbidden truth-claim vocabulary in any source literal", () => {
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (let i = 0; i < sources.length; i++) {
      const noComments = sources[i]!
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const literals = noComments.match(/"[^"\n]+"/g) ?? [];
      for (const lit of literals) {
        expect(lit, `src ${i} forbidden wording: ${lit}`).not.toMatch(
          forbidden,
        );
      }
    }
  });
});
