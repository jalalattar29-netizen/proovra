/**
 * PRO-C1-10 — a recording whose microphone ended or was muted mid-recording
 * says so in the report's part listing (client-stated, labelled so). An
 * uninterrupted clip states nothing.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: { evidencePartDerivedAsset: { findFirst: vi.fn() } } }));
vi.mock("../src/capture-location-map.js", () => ({
  renderCaptureLocationMapPreviewDataUrl: vi.fn(async () => null),
  renderCaptureLocationMapPreviewPng: vi.fn(async () => null),
}));

import { buildReportEvidenceContent } from "../src/processor.js";

const POLICY = { mode: "preview_only", allowContentView: true, allowDownload: false } as never;
const sha = (c: string) => c.repeat(64);

function part(i: number, clientSignals: unknown) {
  return {
    id: `p${i}`,
    partIndex: i,
    originalFileName: `clip-${i}.webm`,
    mimeType: "video/webm",
    sizeBytes: 1000 + i,
    sha256: sha(String(i)),
    durationMs: 10_000,
    storageBucket: "b",
    storageKey: `k/p${i}`,
    artifactClass: "ORIGINAL",
    clientSignals,
  };
}

describe("PRO-C1-10 — the report states an audio interruption", () => {
  const content = () =>
    buildReportEvidenceContent({
      accessPolicy: POLICY,
      evidence: { id: "ev", mimeType: "video/webm", sizeBytes: 10, storageBucket: "b", storageKey: "k/p0", fileSha256: sha("c"), acquisitionMode: null },
      parts: [
        part(0, { audioTracks: ["MICROPHONE"], audioInterrupted: true, audioInterruptedReason: "TRACK_ENDED" }),
        part(1, { audioTracks: ["MICROPHONE"], audioInterrupted: true, audioInterruptedReason: "TRACK_MUTED" }),
        part(2, { audioTracks: ["MICROPHONE"] }),
        part(3, { audioTracks: ["MICROPHONE"], audioInterrupted: false }),
      ],
    });

  it("allowed: an ended or muted microphone is stated, with its reason, as client-stated", () => {
    const c = content();
    const ended = c.items.find((i) => i.index === 0)!;
    const muted = c.items.find((i) => i.index === 1)!;
    expect(ended.audioNotRecordedStatement).toMatch(/^Audio may be missing from part of this video: the microphone stopped/);
    expect(muted.audioNotRecordedStatement).toMatch(/the microphone was muted during the recording/);
    for (const s of [ended.audioNotRecordedStatement, muted.audioNotRecordedStatement]) expect(s).toMatch(/stated by the capture client/);
  });

  it("refused: an uninterrupted clip (or an explicit false) states nothing", () => {
    const c = content();
    expect(c.items.find((i) => i.index === 2)!.audioNotRecordedStatement ?? null).toBeNull();
    expect(c.items.find((i) => i.index === 3)!.audioNotRecordedStatement ?? null).toBeNull();
  });
});
