import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWebCaptureManifest, deriveCompleteness } from "./dist/manifest-builder.js";

function artifact(over = {}) {
  return {
    role: "viewport_screenshot",
    partIndex: 0,
    expectedSha256: "a".repeat(64),
    sizeBytes: 1000,
    mediaType: "image/png",
    completeness: "CAPTURED",
    ...over,
  };
}

function input(over = {}) {
  return {
    captureMode: "VIEWPORT",
    captureSessionId: "11111111-1111-4111-8111-111111111111",
    captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
    captureEndedAtUtc: "2026-09-17T10:00:02.000Z",
    sourceUrl: "https://example.com/a?token=secret",
    title: "Example",
    browser: { name: "Chrome", versionBucket: "140", os: "Windows", viewportW: 1280, viewportH: 800, devicePixelRatio: 1 },
    extensionVersion: "1.0.0",
    artifacts: [artifact()],
    pageMutatedDuringCapture: false,
    limitations: [],
    notes: [],
    ...over,
  };
}

test("builds a valid manifest and exposes domain-only, not the full URL, in page.domain", () => {
  const { manifest, manifestJson } = buildWebCaptureManifest(input());
  assert.equal(manifest.page.domain, "example.com");
  // The private URL is retained in sourceUrlPrivate; the domain never leaks the token.
  assert.equal(manifest.page.domain.includes("token"), false);
  assert.equal(typeof manifestJson, "string");
  // The manifest cannot declare itself verified/authentic.
  assert.equal(/verified|authentic|genuine|admissible/i.test(manifestJson), false);
});

test("completeness derives from artifacts, mutation and limitations", () => {
  const clean = { pageMutated: false, limitations: [] };
  assert.equal(deriveCompleteness([artifact()], clean), "CAPTURED");
  assert.equal(deriveCompleteness([artifact()], { ...clean, pageMutated: true }), "PARTIAL");
  assert.equal(deriveCompleteness([artifact()], { ...clean, limitations: ["PAGE_EXCEEDED_CAPTURE_BOUNDS"] }), "PARTIAL");
  assert.equal(deriveCompleteness([artifact({ completeness: "FAILED" })], clean), "FAILED");
  assert.equal(deriveCompleteness([artifact({ completeness: "OMITTED" })], clean), "PARTIAL");
  assert.equal(deriveCompleteness([], clean), "FAILED");
});

test("a page-exceeded-bounds limitation makes the whole capture PARTIAL", () => {
  const { manifest } = buildWebCaptureManifest(input({ limitations: ["PAGE_EXCEEDED_CAPTURE_BOUNDS"] }));
  assert.equal(manifest.completeness, "PARTIAL");
});

test("an invalid manifest is rejected locally before upload", () => {
  assert.throws(() => buildWebCaptureManifest(input({ artifacts: [artifact({ expectedSha256: "nothex" })] })));
});

// UC-EXT-004 — an interrupted capture (time budget / tile failure) and every
// other detected limitation used to leave completeness=CAPTURED.
test("CAPTURE_INTERRUPTED makes the whole capture PARTIAL", () => {
  const { manifest } = buildWebCaptureManifest(input({ limitations: ["CAPTURE_INTERRUPTED"] }));
  assert.equal(manifest.completeness, "PARTIAL");
});

for (const code of [
  "CROSS_ORIGIN_IFRAME_NOT_CAPTURED",
  "SHADOW_DOM_NOT_FULLY_REPRESENTED",
  "PROTECTED_MEDIA_NOT_CAPTURED",
  "DYNAMIC_CONTENT_MAY_BE_INCOMPLETE",
]) {
  test(`${code} makes the capture PARTIAL`, () => {
    const { manifest } = buildWebCaptureManifest(input({ limitations: [code] }));
    assert.equal(manifest.completeness, "PARTIAL");
  });
}

test("a missing DOM snapshot makes the capture PARTIAL and is disclosed in the notes and as DOM_SNAPSHOT_MISSING", () => {
  const { manifest } = buildWebCaptureManifest(input({ domSnapshotMissing: true }));
  assert.equal(manifest.completeness, "PARTIAL");
  assert.ok(manifest.notes.some((n) => /DOM snapshot not produced/.test(n)));
  // UC-EXT-004 — the machine-readable limitation code, not only prose.
  assert.ok(manifest.limitations.includes("DOM_SNAPSHOT_MISSING"));
});

test("a mutated page always carries PAGE_MUTATED_DURING_CAPTURE", () => {
  const { manifest } = buildWebCaptureManifest(input({ pageMutatedDuringCapture: true }));
  assert.ok(manifest.limitations.includes("PAGE_MUTATED_DURING_CAPTURE"));
  assert.equal(manifest.completeness, "PARTIAL");
});
