import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateWebCaptureManifest,
  publicDomainFromUrl,
  redactUrlForLog,
  WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
  WEB_CAPTURE_MANIFEST_BOUNDS,
} from "../dist/web-capture-manifest.js";

function goodManifest(over = {}) {
  return {
    schemaVersion: WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
    captureMode: "VIEWPORT",
    captureSessionId: "11111111-1111-4111-8111-111111111111",
    captureStartedAtUtc: "2026-09-17T10:00:00.000Z",
    captureEndedAtUtc: "2026-09-17T10:00:02.000Z",
    page: { domain: "example.com", sourceUrlPrivate: "https://example.com/a?token=secret", title: "Example" },
    browser: { name: "Chrome", versionBucket: "140", os: "Windows", viewportW: 1280, viewportH: 800, devicePixelRatio: 1 },
    extensionVersion: "1.0.0",
    artifacts: [
      { role: "viewport_screenshot", partIndex: 0, expectedSha256: "a".repeat(64), sizeBytes: 1000, mediaType: "image/png", completeness: "CAPTURED" },
      { role: "dom_snapshot", partIndex: 1, expectedSha256: "b".repeat(64), sizeBytes: 500, mediaType: "text/html", completeness: "CAPTURED" },
    ],
    completeness: "CAPTURED",
    pageMutatedDuringCapture: false,
    limitations: [],
    notes: [],
    ...over,
  };
}

test("a well-formed manifest validates", () => {
  const r = validateWebCaptureManifest(goodManifest());
  assert.equal(r.ok, true);
});

test("session id mismatch is refused", () => {
  const r = validateWebCaptureManifest(goodManifest(), { expectedSessionId: "different" });
  assert.equal(r.ok, false);
});

test("session id match is accepted", () => {
  const r = validateWebCaptureManifest(goodManifest(), {
    expectedSessionId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(r.ok, true);
});

test("bad digest, unknown mode, bad enum, duplicate partIndex are refused", () => {
  assert.equal(validateWebCaptureManifest(goodManifest({ captureMode: "SCROLL" })).ok, false);
  const badDigest = goodManifest();
  badDigest.artifacts[0].expectedSha256 = "nothex";
  assert.equal(validateWebCaptureManifest(badDigest).ok, false);
  const dupPart = goodManifest();
  dupPart.artifacts[1].partIndex = 0;
  assert.equal(validateWebCaptureManifest(dupPart).ok, false);
  const badLimit = goodManifest({ limitations: ["NOT_A_CODE"] });
  assert.equal(validateWebCaptureManifest(badLimit).ok, false);
});

test("an oversized manifest is refused before parsing", () => {
  const huge = goodManifest({ notes: [] });
  huge.notes = Array.from({ length: 5 }, () => "x".repeat(WEB_CAPTURE_MANIFEST_BOUNDS.maxNoteLen));
  // Push it over the size ceiling with a giant (bounded-count) artifact list.
  huge.artifacts = Array.from({ length: WEB_CAPTURE_MANIFEST_BOUNDS.maxArtifacts }, (_, i) => ({
    role: "page_tile",
    partIndex: i,
    expectedSha256: "c".repeat(64),
    sizeBytes: 1,
    mediaType: "image/png",
    completeness: "CAPTURED",
    tileIndex: i,
    scrollOffsetY: i * 800,
    padding: "y".repeat(1100),
  }));
  const r = validateWebCaptureManifest(huge);
  assert.equal(r.ok, false);
});

test("non-object and wrong schema version are refused", () => {
  assert.equal(validateWebCaptureManifest(null).ok, false);
  assert.equal(validateWebCaptureManifest("x").ok, false);
  assert.equal(validateWebCaptureManifest(goodManifest({ schemaVersion: "OTHER" })).ok, false);
});

test("publicDomainFromUrl returns domain only, never path/query/token", () => {
  assert.equal(publicDomainFromUrl("https://Example.com/secret/path?token=abc#frag"), "example.com");
  assert.equal(publicDomainFromUrl("http://sub.example.co.uk:8443/x"), "sub.example.co.uk");
  assert.equal(publicDomainFromUrl("not a url"), null);
  assert.equal(publicDomainFromUrl("ftp://example.com/x"), null);
  assert.equal(publicDomainFromUrl(""), null);
  assert.equal(publicDomainFromUrl(null), null);
});

test("redactUrlForLog never leaks a path or query", () => {
  assert.equal(redactUrlForLog("https://example.com/p?token=x"), "example.com");
  assert.equal(redactUrlForLog("garbage"), "(unparseable-url)");
});
