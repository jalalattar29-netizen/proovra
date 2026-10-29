/**
 * 2026-10-29 — which parts a combined recording is built from (pure).
 *
 * The manifest is the part the seal's facts name, with the facts' digest; a
 * segment is admitted only when its sealed digest AND size equal the
 * manifest's; a disagreement fails closed; a listed-but-absent segment is a
 * MISSING segment; a SINGLE_FILE recording and a non-continuous record are
 * UNSUPPORTED (nothing to combine).
 */
import { describe, expect, it } from "vitest";

import { decideCombineInputs, locateCombineManifest, type CombinePartRow } from "../src/combined-recording/combine-inputs.js";
import { planScreenRecordingCombine, type ProbedSegment } from "../src/combined-recording/combine-recording.js";

const H = (c: string) => c.repeat(64);
const MANIFEST_SHA = H("f");

function part(i: number, over: Partial<CombinePartRow> = {}): CombinePartRow {
  return {
    id: `p${i}`,
    partIndex: i,
    storageBucket: "b",
    storageKey: `k${i}`,
    storageVersionId: `v${i}`,
    sizeBytes: 1000 + i,
    mimeType: "video/mp4",
    sha256: H(String(i)),
    artifactClass: "ORIGINAL",
    ...over,
  };
}
const manifestPart = part(9, { mimeType: "application/json", sha256: MANIFEST_SHA, artifactClass: "CAPTURE_MANIFEST", sizeBytes: 500 });
const seg = (i: number, over: Record<string, unknown> = {}) => ({
  role: "screen_segment",
  partIndex: i,
  sequence: i,
  expectedSha256: H(String(i)),
  sizeBytes: 1000 + i,
  mediaType: "video/mp4",
  startedAtOffsetMs: i * 1000,
  durationMs: 1000,
  widthPx: 1080,
  heightPx: 1920,
  orientation: "portrait",
  ...over,
});
const manifest = (segments: unknown[], over: Record<string, unknown> = {}) => ({
  schemaVersion: "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V2",
  recordedSegmentCount: segments.length,
  totalDurationMs: segments.length * 1000,
  sessionCompleteness: "COMPLETE_SESSION",
  limitations: [],
  segments,
  ...over,
});
const FACTS = { kind: "SCREEN_CONTINUOUS", manifestPartIndex: 9, manifestSha256: MANIFEST_SHA };

describe("locateCombineManifest", () => {
  it("names the facts' part only when its sealed digest is the facts' digest", () => {
    const parts = [part(0), part(1), manifestPart];
    expect(locateCombineManifest({ acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS", facts: FACTS, parts })).toMatchObject({
      ok: true,
      manifestSha256: MANIFEST_SHA,
    });
    expect(
      locateCombineManifest({ acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS", facts: { ...FACTS, manifestSha256: H("e") }, parts }),
    ).toEqual({ ok: false, outcome: "failed", reason: "manifest_digest_mismatch" });
    expect(locateCombineManifest({ acquisitionMode: "UPLOAD", facts: FACTS, parts })).toMatchObject({ outcome: "unsupported" });
    expect(locateCombineManifest({ acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS", facts: null, parts })).toMatchObject({
      outcome: "unsupported",
    });
  });
});

describe("decideCombineInputs", () => {
  const base = { manifestPartIndex: 9, manifestSha256: MANIFEST_SHA };

  it("admits sealed segments in sequence order", () => {
    const d = decideCombineInputs({ ...base, manifestJson: manifest([seg(1), seg(0)]), parts: [part(0), part(1), manifestPart] });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.sources.map((s) => [s.partIndex, s.sequence, s.storageVersionId])).toEqual([[0, 0, "v0"], [1, 1, "v1"]]);
    expect(d.missingInRecord).toEqual([]);
    expect(d.manifest).toMatchObject({ partIndex: 9, sha256: MANIFEST_SHA, recordedSegmentCount: 2 });
  });

  it("fails closed when a sealed digest or size disagrees with the manifest", () => {
    const parts = [part(0), part(1, { sha256: H("a") }), manifestPart];
    expect(decideCombineInputs({ ...base, manifestJson: manifest([seg(0), seg(1)]), parts })).toEqual({
      ok: false,
      outcome: "failed",
      reason: "segment_digest_mismatch:1",
    });
    expect(
      decideCombineInputs({ ...base, manifestJson: manifest([seg(0), seg(1, { sizeBytes: 5 })]), parts: [part(0), part(1), manifestPart] }),
    ).toEqual({ ok: false, outcome: "failed", reason: "segment_size_mismatch:1" });
  });

  it("a listed segment the record does not hold is MISSING, not an error", () => {
    const d = decideCombineInputs({ ...base, manifestJson: manifest([seg(0), seg(1), seg(2)]), parts: [part(0), part(2), manifestPart] });
    expect(d.ok && d.missingInRecord).toEqual([1]);
  });

  it("SINGLE_FILE and a single held segment have nothing to combine", () => {
    expect(
      decideCombineInputs({ ...base, manifestJson: manifest([seg(0)], { recordingLayout: "SINGLE_FILE" }), parts: [part(0), manifestPart] }),
    ).toEqual({ ok: false, outcome: "unsupported", reason: "single_file_recording" });
    expect(decideCombineInputs({ ...base, manifestJson: manifest([seg(0)]), parts: [part(0), manifestPart] })).toMatchObject({
      outcome: "unsupported",
      reason: "fewer_than_two_segments",
    });
  });
});

describe("planScreenRecordingCombine — missing segments and tails", () => {
  const probed = (sequence: number, start: number, over: Partial<ProbedSegment> = {}): ProbedSegment => ({
    partIndex: sequence,
    sequence,
    sha256: H(String(sequence)),
    sizeBytes: 1,
    versionId: null,
    startedAtOffsetMs: start,
    durationMs: 1000,
    probe: {
      durationMs: 1000,
      video: { codec: "h264", profile: "High", pixFmt: "yuv420p", codedWidthPx: 1080, codedHeightPx: 1920, rotationDeg: 0, displayWidthPx: 1080, displayHeightPx: 1920, fps: 12 },
      audio: null,
      videoStreamCount: 1,
      audioStreamCount: 0,
      otherStreamCount: 0,
      formatName: "mov,mp4",
    },
    packets: 12,
    parameterSetsSha256: H("9"),
    actualDurationMs: 1000,
    ...over,
  });

  it("a lost tail is TAIL_MISSING with the stated remaining time; PARTIAL", () => {
    const plan = planScreenRecordingCombine({
      manifest: { partIndex: 9, sha256: MANIFEST_SHA, schemaVersion: "v2", recordedSegmentCount: 4, totalDurationMs: 4000, sessionCompleteness: "INTERRUPTED_SESSION", limitations: ["SEGMENT_UPLOAD_LOST"] },
      segments: [probed(0, 0), probed(1, 1000)],
      missingInRecord: [],
    });
    expect(plan.mode).toBe("REMUX");
    expect(plan.gaps).toEqual([
      { atMs: null, durationMs: 2000, cause: "TAIL_MISSING", missingSequences: [2, 3], limitations: ["SEGMENT_UPLOAD_LOST"] },
    ]);
    expect(plan.completeness).toBe("PARTIAL");
  });

  it("contiguous segments of one encoding in a complete session: REMUX, COMPLETE, no gaps", () => {
    const plan = planScreenRecordingCombine({
      manifest: { partIndex: 9, sha256: MANIFEST_SHA, schemaVersion: "v2", recordedSegmentCount: 2, totalDurationMs: 2000, sessionCompleteness: "COMPLETE_SESSION", limitations: [] },
      segments: [probed(0, 0), probed(1, 1040)],
      missingInRecord: [],
    });
    expect(plan).toMatchObject({ mode: "REMUX", completeness: "COMPLETE", gaps: [], slotMs: [1040] });
  });

  it("differing parameter sets force TRANSCODE (never a remux that would mis-decode)", () => {
    const plan = planScreenRecordingCombine({
      manifest: { partIndex: 9, sha256: MANIFEST_SHA, schemaVersion: "v2", recordedSegmentCount: 2, totalDurationMs: 2000, sessionCompleteness: "COMPLETE_SESSION", limitations: [] },
      segments: [probed(0, 0), probed(1, 1000, { parameterSetsSha256: H("8") })],
      missingInRecord: [],
    });
    expect(plan.mode).toBe("TRANSCODE");
    expect(plan.canvas).toEqual({ widthPx: 1080, heightPx: 1920, letterboxed: false });
  });
});
