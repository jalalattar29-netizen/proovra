/**
 * UC-4 DERIVED REVIEW — projections and the record-property gate.
 *
 * The claims that matter:
 *   - the tab appears for exactly the records the web shows it for — an
 *     acquisition CATEGORY of DIRECT_SCREEN_CAPTURE, never a workspace kind;
 *   - the caveats are derived from the projection and are never dropped. This
 *     is text a machine reconstructed from keyframes, and rendering it without
 *     its provenance and coverage presents a reconstruction as a record of
 *     what was on screen;
 *   - an unrecognised status or confidence degrades to the WEAKEST value, never
 *     the strongest. A half-finished run rendered as COMPLETED, or an
 *     unresolved block rendered as consistent, is the failure mode that
 *     matters here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/derived-review.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const D = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const API = "https://api.example.test";

const projection = (over = {}) => ({
  schemaVersion: "1",
  descriptorVersion: 3,
  provenance: {
    reconstructed: "Reconstructed from keyframes; not a recording of the screen.",
    machineExtracted: "Text was machine-extracted and may be wrong.",
  },
  ocrEnabled: true,
  coverage: "COMPLETE",
  acquisitionComplete: true,
  limitations: [],
  generatedAtUtc: "2026-09-21T12:00:00.000Z",
  stats: {
    sourcePartCount: 2,
    keyframeCount: 40,
    ocrRegionCount: 88,
    ocrFailedKeyframes: 0,
    observationCount: 120,
    blockCount: 2,
    derivedBytes: 4096,
  },
  blockTotal: 2,
  page: { offset: 0, limit: 100 },
  blocks: [
    {
      blockId: "b2",
      sequence: 1,
      kind: "TEXT",
      text: "second",
      confidence: "PARTIAL_OVERLAP",
      observedInFrames: 3,
      sources: [{ evidencePartId: "p1", keyframeIds: ["k2"], offsetMsRange: [10, 20] }],
    },
    {
      blockId: "b1",
      sequence: 0,
      kind: "TEXT",
      text: "first",
      confidence: "HIGH_OVERLAP",
      observedInFrames: 9,
      sources: [{ evidencePartId: "p1", keyframeIds: ["k1"], offsetMsRange: [0, 10] }],
    },
  ],
  ...over,
});

const envelope = (over = {}) => ({
  evidenceId: "ev-1",
  status: {
    requested: true,
    status: "COMPLETED",
    lastError: null,
    updatedAtUtc: "2026-09-21T12:00:00.000Z",
    hasDescriptor: true,
  },
  projection: projection(),
  keyframeBytesUrls: { k1: "/v1/keyframes/k1/bytes", k2: null },
  ...over,
});

/* ---------------------------------------------------------------- the gate */

test("the tab is gated on the record's acquisition category, not a workspace kind", () => {
  assert.equal(D.isDerivedReviewEligible("DIRECT_SCREEN_CAPTURE"), true);
  for (const other of [
    "PROOVRA_WEB_UPLOAD",
    "DIRECT_WEB_CAPTURE",
    "PROOVRA_MOBILE_APP",
    "",
    null,
  ]) {
    assert.equal(D.isDerivedReviewEligible(other), false, String(other));
  }
});

/* -------------------------------------------------------------- transport */

test("the paths are the canonical ones, workspace-scoped and paged", () => {
  assert.equal(
    D.buildDerivedReviewPath("ev-1", "team-1"),
    "/v1/evidence/ev-1/derived-review?teamId=team-1&offset=0&limit=100",
  );
  assert.equal(
    D.buildDerivedReviewPath("a/b", "t", 20, 5),
    "/v1/evidence/a%2Fb/derived-review?teamId=t&offset=20&limit=5",
  );
  assert.equal(
    D.buildDerivedReviewGeneratePath("ev-1"),
    "/v1/evidence/ev-1/derived-review/generate",
  );
  assert.deepEqual(D.buildGenerateBody("t", true), { teamId: "t", regenerate: true });
  assert.deepEqual(D.buildGenerateBody("t"), { teamId: "t", regenerate: false });
});

test("keyframe URLs are made absolute against the API base, and nulls survive", () => {
  const urls = D.normalizeKeyframeUrls(
    { a: "/v1/keyframes/a/bytes", b: "https://cdn.test/x", c: null, d: "" },
    API + "/",
  );
  assert.equal(urls.a, `${API}/v1/keyframes/a/bytes`);
  assert.equal(urls.b, "https://cdn.test/x");
  assert.equal(urls.c, null);
  // An empty string is not a URL; it must not become the API base alone.
  assert.equal(urls.d, null);
});

/* ------------------------------------------------------------- projections */

test("blocks are ordered by sequence, not by arrival", () => {
  const r = D.parseDerivedReview(envelope(), API);
  assert.deepEqual(r.projection.blocks.map((b) => b.blockId), ["b1", "b2"]);
  assert.deepEqual(r.projection.blocks[0].keyframeIds, ["k1"]);
});

test("an unknown run status is NOT_REQUESTED, never COMPLETED", () => {
  const r = D.parseDerivedReview(
    envelope({ status: { status: "SOMETHING_ELSE", requested: true } }),
    API,
  );
  assert.equal(r.run.status, "NOT_REQUESTED");
});

test("an unknown block confidence is UNRESOLVED, never the strongest value", () => {
  const r = D.parseDerivedReview(
    envelope({
      projection: projection({
        blocks: [
          { blockId: "b1", sequence: 0, kind: "TEXT", text: "x", confidence: "VERY_SURE" },
        ],
      }),
    }),
    API,
  );
  assert.equal(r.projection.blocks[0].confidence, "UNRESOLVED");
});

test("no projection means nothing has been reconstructed, not an empty one", () => {
  const r = D.parseDerivedReview(envelope({ projection: null }), API);
  assert.equal(r.projection, null);
  assert.equal(r.run.status, "COMPLETED");
});

/* ----------------------------------------------------------------- polling */

test("polling runs only while a run is in flight", () => {
  const run = (status) => ({ status });
  assert.equal(D.shouldPoll(run("PENDING")), true);
  assert.equal(D.shouldPoll(run("PROCESSING")), true);
  for (const s of ["NOT_REQUESTED", "COMPLETED", "FAILED", "DISMISSED"]) {
    assert.equal(D.shouldPoll(run(s)), false, s);
  }
});

test("every run status has a label and a tone, and failure is never verified", () => {
  for (const s of [
    "NOT_REQUESTED",
    "PENDING",
    "PROCESSING",
    "COMPLETED",
    "FAILED",
    "DISMISSED",
  ]) {
    const run = { status: s };
    assert.ok(D.runStatusLabel(run), s);
    assert.ok(D.runStatusTone(run), s);
  }
  assert.equal(D.runStatusTone({ status: "FAILED" }), "risk");
  assert.equal(D.runStatusTone({ status: "COMPLETED" }), "verified");
});

/* ----------------------------------------------------------------- caveats */

test("the caveats state the provenance the projection carries", () => {
  const caveats = D.derivedReviewCaveats(
    D.parseDerivedReview(envelope(), API).projection,
  );
  assert.ok(caveats.some((c) => /Reconstructed from keyframes/.test(c)));
  assert.ok(caveats.some((c) => /machine-extracted/.test(c)));
});

test("every degraded condition adds a caveat rather than passing silently", () => {
  const r = D.parseDerivedReview(
    envelope({
      projection: projection({
        coverage: "PARTIAL",
        acquisitionComplete: false,
        ocrEnabled: false,
        limitations: ["A limitation the server stated."],
        stats: { ...projection().stats, ocrFailedKeyframes: 4 },
      }),
    }),
    API,
  );

  const caveats = D.derivedReviewCaveats(r.projection);
  assert.ok(caveats.some((c) => /Coverage is partial/i.test(c)));
  assert.ok(caveats.some((c) => /acquisition .* is incomplete/i.test(c)));
  assert.ok(caveats.some((c) => /Text extraction was not enabled/i.test(c)));
  assert.ok(caveats.some((c) => /4 keyframe\(s\) could not be read/.test(c)));
  // The server's own limitations are appended, never replaced.
  assert.ok(caveats.includes("A limitation the server stated."));
});

test("a clean projection still states what it is", () => {
  // Even at COMPLETE coverage with no failures, the provenance lines stand.
  const caveats = D.derivedReviewCaveats(
    D.parseDerivedReview(envelope(), API).projection,
  );
  assert.ok(caveats.length >= 2, "a derived surface with no caveats at all");
});

test("T-12: each block keeps its source parts and offsets, and names up to six keyframes", () => {
  const r = D.parseDerivedReview(envelope(), API);
  const withSource = r.projection.blocks.find((b) => b.sources.length > 0);
  assert.ok(withSource, "the block sources were dropped");
  assert.equal(D.sourceLine(withSource.sources[0]), `Source part ${withSource.sources[0].evidencePartId.slice(0, 8)}…${
    withSource.sources[0].startMs !== null ? ` · ${(withSource.sources[0].startMs / 1000).toFixed(1)}s–${(withSource.sources[0].endMs / 1000).toFixed(1)}s` : ""
  }`);
  const urls = D.blockKeyframeUrls({ keyframeIds: ["a", "b", "a", "c", "d", "e", "f", "g"] }, { a: "u1", b: null, c: "u3", d: "u4", e: "u5", f: "u6", g: "u7" });
  assert.deepEqual(urls, ["u1", "u3", "u4", "u5", "u6", "u7"], "missing urls skipped, duplicates dropped, at most six");
});
