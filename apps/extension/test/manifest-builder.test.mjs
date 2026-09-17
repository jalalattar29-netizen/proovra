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

test("completeness derives from artifacts, mutation and truncation", () => {
  assert.equal(deriveCompleteness([artifact()], false, false), "CAPTURED");
  assert.equal(deriveCompleteness([artifact()], true, false), "PARTIAL");
  assert.equal(deriveCompleteness([artifact()], false, true), "PARTIAL");
  assert.equal(deriveCompleteness([artifact({ completeness: "FAILED" })], false, false), "FAILED");
  assert.equal(deriveCompleteness([artifact({ completeness: "OMITTED" })], false, false), "PARTIAL");
});

test("a page-exceeded-bounds limitation makes the whole capture PARTIAL", () => {
  const { manifest } = buildWebCaptureManifest(input({ limitations: ["PAGE_EXCEEDED_CAPTURE_BOUNDS"] }));
  assert.equal(manifest.completeness, "PARTIAL");
});

test("an invalid manifest is rejected locally before upload", () => {
  assert.throws(() => buildWebCaptureManifest(input({ artifacts: [artifact({ expectedSha256: "nothex" })] })));
});
