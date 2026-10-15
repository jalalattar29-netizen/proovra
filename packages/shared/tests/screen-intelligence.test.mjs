import assert from "node:assert/strict";
import { test } from "node:test";

import { runScreenIntelligence } from "../dist/screen-intelligence.js";

/** A deterministic local fake OCR provider: imageRef → predefined text rows. */
function fakeOcr(map, opts = {}) {
  return {
    name: opts.name ?? "fake",
    version: "v0",
    local: true,
    async extract({ imageRef }) {
      if (opts.failRefs?.includes(imageRef)) throw new Error("ocr failure");
      const rows = map[imageRef] ?? [];
      return { regions: rows.map((text, i) => ({ text, kind: "TEXT", rowOrder: i })), language: "en" };
    },
  };
}

// One candidate frame per part so keyframe selection keeps exactly one (the first).
const oneKeyframe = (offsetMs = 0) => [{ offsetMs, changeScore: 1 }];
const imageRef = (partIndex, kf) => `p${partIndex}/${kf.variantKey}`;

test("MANDATORY source-lineage E2E: block → observation → keyframe → ORIGINAL part", async () => {
  // Two ORIGINAL segments; a scroll across the boundary shares rows "3","4".
  const map = {
    "p0/kf-0000": ["1", "2", "3", "4"],
    "p1/kf-0000": ["3", "4", "5", "6"],
  };
  const res = await runScreenIntelligence({
    parts: [
      { partIndex: 0, candidates: oneKeyframe() },
      { partIndex: 1, candidates: oneKeyframe() },
    ],
    ocr: fakeOcr(map),
    imageRefForKeyframe: imageRef,
  });

  assert.deepEqual(res.reconstruction.blocks.map((b) => b.text), ["1", "2", "3", "4", "5", "6"]);
  assert.equal(res.ocrProvider.local, true);

  // Pick a reconstructed block and trace it ALL the way back to ORIGINAL parts.
  const block = res.reconstruction.blocks.find((b) => b.text === "3");
  assert.ok(block, "block exists");
  // block → observation(s)
  const obs = res.observations.filter((o) => block.observationIds.includes(o.id));
  assert.ok(obs.length >= 1);
  // observation → keyframe → ORIGINAL part(s)  ("3" was observed scrolling p0→p1)
  const parts = [...new Set(obs.map((o) => o.sourcePartIndex))].sort();
  assert.deepEqual(parts, [0, 1]);
  assert.deepEqual(block.sourcePartIndexes, [0, 1]);
  // Every observation names a keyframe that belongs to its source part.
  for (const o of obs) assert.ok(o.keyframeId.startsWith(`p${o.sourcePartIndex}-`));
  // The shared row is corroborated across two frames → HIGH_OVERLAP.
  assert.equal(block.confidence, "HIGH_OVERLAP");
});

test("UC-2 support: a single-Evidence multi-FRAME part reconstructs with lineage", async () => {
  // UC-2 = N ORIGINAL screen_frame parts (partIndex 0..2), no scroll overlap needed.
  const map = { "p0/kf-0000": ["a"], "p1/kf-0000": ["b"], "p2/kf-0000": ["c"] };
  const res = await runScreenIntelligence({
    parts: [0, 1, 2].map((partIndex) => ({ partIndex, candidates: oneKeyframe() })),
    ocr: fakeOcr(map),
    imageRefForKeyframe: imageRef,
  });
  assert.deepEqual(res.reconstruction.blocks.map((b) => b.text), ["a", "b", "c"]);
  assert.equal(res.observations.length, 3);
  assert.deepEqual(res.reconstruction.blocks.map((b) => b.sourcePartIndexes[0]), [0, 1, 2]);
});

test("OCR failure on one keyframe degrades that frame only — pipeline + others survive", async () => {
  const map = { "p0/kf-0000": ["x"], "p1/kf-0000": ["y"] };
  const res = await runScreenIntelligence({
    parts: [
      { partIndex: 0, candidates: oneKeyframe() },
      { partIndex: 1, candidates: oneKeyframe() },
    ],
    ocr: fakeOcr(map, { failRefs: ["p0/kf-0000"] }),
    imageRefForKeyframe: imageRef,
  });
  assert.equal(res.stats.ocrFailedKeyframes, 1);
  assert.deepEqual(res.reconstruction.blocks.map((b) => b.text), ["y"]); // p0 degraded, p1 intact
});

test("keyframe selection is applied per part and stats reflect the bounded set", async () => {
  // Many static candidates → selection keeps far fewer than provided.
  const many = Array.from({ length: 30 }, (_, i) => ({ offsetMs: i * 200, changeScore: 0 }));
  const res = await runScreenIntelligence({
    parts: [{ partIndex: 0, candidates: many }],
    ocr: fakeOcr({}),
    imageRefForKeyframe: imageRef,
  });
  assert.ok(res.keyframesByPart[0].keyframes.length < many.length);
  assert.equal(res.stats.keyframeCount, res.keyframesByPart[0].keyframes.length);
});

// ---------------------------------------------------------------------------
// AUD-003 — OCR outcome truth: zero successful OCR is never COMPLETE.
// ---------------------------------------------------------------------------
import {
  assessScreenOcrOutcome,
  projectScreenIntelligenceForReview,
  resolveScreenOcrTruth,
  screenDerivedCoverage,
  screenOcrLimitations,
  SCREEN_OCR_OUTCOMES,
} from "../dist/screen-intelligence-descriptor.js";
import { reconstructScreenConversation } from "../dist/screen-reconstruction.js";

const twoParts = [
  { partIndex: 0, candidates: oneKeyframe() },
  { partIndex: 1, candidates: oneKeyframe() },
];

test("AUD-003: OCR failing on EVERY keyframe is ATTEMPTED_ALL_FAILED, PARTIAL, with an extraction-failed limitation", async () => {
  const res = await runScreenIntelligence({
    parts: twoParts,
    ocr: fakeOcr({}, { failRefs: ["p0/kf-0000", "p1/kf-0000"] }),
    imageRefForKeyframe: imageRef,
  });
  assert.equal(res.ocrOutcome, "ATTEMPTED_ALL_FAILED");
  assert.deepEqual(res.ocrCounts, { keyframesAttempted: 2, keyframesSucceeded: 0, keyframesFailed: 2 });
  assert.equal(res.coverage, "PARTIAL");
  assert.ok(res.limitations.includes("RECONSTRUCTION_OCR_EXTRACTION_FAILED"));
  assert.ok(res.limitations.includes("RECONSTRUCTION_NO_OBSERVATIONS"));
});

test("AUD-003: a mixed run is PARTIAL_FAILURE, each failed keyframe degrades coverage", async () => {
  const res = await runScreenIntelligence({
    parts: twoParts,
    ocr: fakeOcr({ "p0/kf-0000": ["x"], "p1/kf-0000": ["x", "y"] }, { failRefs: ["p0/kf-0000"] }),
    imageRefForKeyframe: imageRef,
  });
  assert.equal(res.ocrOutcome, "PARTIAL_FAILURE");
  assert.deepEqual(res.ocrCounts, { keyframesAttempted: 2, keyframesSucceeded: 1, keyframesFailed: 1 });
  // The reconstruction of what WAS read proves nothing missing between frames,
  assert.equal(res.reconstruction.coverage, "COMPLETE");
  // but the run is not complete: a frame was never read.
  assert.equal(res.coverage, "PARTIAL");
  assert.ok(res.limitations.includes("RECONSTRUCTION_OCR_EXTRACTION_FAILED"));
});

test("AUD-003: no keyframes reaching OCR is NO_FRAMES_PROCESSED, never COMPLETE", async () => {
  const res = await runScreenIntelligence({ parts: [], ocr: fakeOcr({}), imageRefForKeyframe: imageRef });
  assert.equal(res.ocrOutcome, "NO_FRAMES_PROCESSED");
  assert.equal(res.coverage, "PARTIAL");
  assert.equal(res.reconstruction.coverage, "PARTIAL");
  assert.ok(res.limitations.includes("RECONSTRUCTION_NO_OBSERVATIONS"));
});

test("AUD-003: successful OCR that recognised nothing is NO_TEXT_PRESENT, distinct from failure, still not COMPLETE", async () => {
  const res = await runScreenIntelligence({ parts: twoParts, ocr: fakeOcr({}), imageRefForKeyframe: imageRef });
  assert.equal(res.ocrOutcome, "NO_TEXT_PRESENT");
  assert.deepEqual(res.ocrCounts, { keyframesAttempted: 2, keyframesSucceeded: 2, keyframesFailed: 0 });
  assert.equal(res.coverage, "PARTIAL");
  assert.ok(!res.limitations.includes("RECONSTRUCTION_OCR_EXTRACTION_FAILED"));
});

test("AUD-003: every frame read with text and continuity proven is the ONLY COMPLETE path", async () => {
  const res = await runScreenIntelligence({
    parts: twoParts,
    ocr: fakeOcr({ "p0/kf-0000": ["1", "2", "3"], "p1/kf-0000": ["2", "3", "4"] }),
    imageRefForKeyframe: imageRef,
  });
  assert.equal(res.ocrOutcome, "TEXT_FOUND");
  assert.equal(res.coverage, "COMPLETE");
});

test("AUD-003: an empty reconstruction is PARTIAL with RECONSTRUCTION_NO_OBSERVATIONS", () => {
  const r = reconstructScreenConversation([]);
  assert.equal(r.coverage, "PARTIAL");
  assert.deepEqual(r.limitations, ["RECONSTRUCTION_NO_OBSERVATIONS"]);
});

test("AUD-003/019: policy, engine and language unavailability are three different outcomes", () => {
  const zero = { keyframesAttempted: 0, keyframesSucceeded: 0, keyframesFailed: 0 };
  assert.equal(assessScreenOcrOutcome({ ocrStatus: "DISABLED_BY_POLICY", counts: zero, observationCount: 0 }), "OCR_DISABLED");
  assert.equal(assessScreenOcrOutcome({ ocrStatus: "RUNTIME_UNAVAILABLE", counts: zero, observationCount: 0 }), "ENGINE_UNAVAILABLE");
  const noLang = { requested: "eng+ara+deu", effective: null, missing: ["eng", "ara", "deu"] };
  const lang = assessScreenOcrOutcome({ ocrStatus: "RUNTIME_UNAVAILABLE", counts: zero, observationCount: 0, languages: noLang });
  assert.equal(lang, "LANGUAGE_UNAVAILABLE");
  const lims = screenOcrLimitations({ outcome: lang, counts: zero, observationCount: 0, languages: noLang });
  assert.ok(lims.includes("RECONSTRUCTION_OCR_LANGUAGE_UNAVAILABLE"));
  assert.ok(!lims.includes("RECONSTRUCTION_OCR_RUNTIME_UNAVAILABLE"));
  // Some requested languages missing: OCR runs with the rest, the gap is stated.
  const some = { requested: "eng+ara+deu", effective: "eng+ara", missing: ["deu"] };
  const ok = { keyframesAttempted: 1, keyframesSucceeded: 1, keyframesFailed: 0 };
  const out = assessScreenOcrOutcome({ ocrStatus: "ENABLED", counts: ok, observationCount: 3, languages: some });
  assert.equal(out, "TEXT_FOUND");
  const l2 = screenOcrLimitations({ outcome: out, counts: ok, observationCount: 3, languages: some });
  assert.deepEqual(l2, ["RECONSTRUCTION_OCR_LANGUAGE_UNAVAILABLE"]);
  assert.equal(
    screenDerivedCoverage({ outcome: out, acquisitionComplete: true, reconstructionCoverage: "COMPLETE", limitations: l2 }),
    "PARTIAL",
  );
});

test("AUD-003 property: COMPLETE is never derived without successful OCR on every attempted frame and observed text", () => {
  const statuses = ["ENABLED", "DISABLED_BY_POLICY", "RUNTIME_UNAVAILABLE"];
  let completes = 0;
  for (const ocrStatus of statuses)
    for (let attempted = 0; attempted <= 4; attempted += 1)
      for (let failed = 0; failed <= attempted; failed += 1)
        for (const observationCount of [0, 1, 7])
          for (const acquisitionComplete of [true, false])
            for (const reconstructionCoverage of ["COMPLETE", "PARTIAL"])
              for (const missing of [[], ["deu"]]) {
                const counts = { keyframesAttempted: attempted, keyframesSucceeded: attempted - failed, keyframesFailed: failed };
                const languages = { requested: "eng+deu", effective: missing.length ? "eng" : "eng+deu", missing };
                const outcome = assessScreenOcrOutcome({ ocrStatus, counts, observationCount, languages });
                assert.ok(SCREEN_OCR_OUTCOMES.includes(outcome));
                const limitations = screenOcrLimitations({ outcome, counts, observationCount, languages });
                const c = screenDerivedCoverage({ outcome, acquisitionComplete, reconstructionCoverage, limitations });
                if (c === "COMPLETE") {
                  completes += 1;
                  assert.equal(ocrStatus, "ENABLED");
                  assert.ok(counts.keyframesSucceeded > 0 && counts.keyframesFailed === 0);
                  assert.ok(observationCount > 0 && acquisitionComplete && reconstructionCoverage === "COMPLETE");
                  assert.equal(missing.length, 0);
                }
              }
  assert.ok(completes > 0, "the property is vacuous: COMPLETE is never reachable");
});

test("AUD-003: a LEGACY descriptor that stored COMPLETE over total OCR failure is corrected on read, bytes untouched", () => {
  const legacy = {
    schemaVersion: "PROOVRA_SCREEN_INTELLIGENCE_V1",
    descriptorVersion: 1,
    transformation: "screen-conversation-reconstruction/v1",
    transformationVersions: {},
    generatedAtUtc: "2026-09-01T00:00:00.000Z",
    ocrProvider: { name: "tesseract", version: "5.3.4", local: true, language: "eng+ara" },
    ocrEnabled: true,
    ocrStatus: "ENABLED",
    acquisitionComplete: true,
    coverage: "COMPLETE",
    limitations: [],
    stats: { sourcePartCount: 1, keyframeCount: 3, ocrRegionCount: 0, ocrFailedKeyframes: 3, observationCount: 0, blockCount: 0, derivedBytes: 10 },
    sources: [],
    keyframes: [],
    observations: [],
    blocks: [],
  };
  const frozen = JSON.stringify(legacy);
  const truth = resolveScreenOcrTruth(legacy);
  assert.equal(truth.ocrOutcome, "ATTEMPTED_ALL_FAILED");
  assert.deepEqual(truth.ocrCounts, { keyframesAttempted: 3, keyframesSucceeded: 0, keyframesFailed: 3 });
  assert.equal(truth.coverage, "PARTIAL");
  const p = projectScreenIntelligenceForReview(legacy);
  assert.equal(p.coverage, "PARTIAL");
  assert.equal(p.ocrOutcome, "ATTEMPTED_ALL_FAILED");
  assert.ok(p.limitations.includes("RECONSTRUCTION_OCR_EXTRACTION_FAILED"));
  assert.equal(JSON.stringify(legacy), frozen, "the stored descriptor was mutated");
});
