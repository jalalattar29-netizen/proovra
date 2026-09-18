/**
 * UC-4 — persisted descriptor → review projection (pure).
 *
 * Proves the review projection preserves the DERIVED source lineage the
 * Inspector's "View Source" needs (block → observation → keyframe → ORIGINAL
 * part), carries explicit DERIVED provenance markers, paginates, and never
 * fabricates a whole-conversation truth claim.
 */
import { describe, it, expect } from "vitest";
import {
  projectScreenIntelligenceForReview,
  SCREEN_INTELLIGENCE_DESCRIPTOR_VERSION,
  SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS,
  DERIVED_RECONSTRUCTED_PROVENANCE,
  DERIVED_TEXT_PROVENANCE,
  type ScreenIntelligenceDescriptor,
} from "@proovra/shared";

function descriptor(
  over: Partial<ScreenIntelligenceDescriptor> = {},
): ScreenIntelligenceDescriptor {
  return {
    schemaVersion: SCREEN_INTELLIGENCE_DESCRIPTOR_VERSION,
    descriptorVersion: 1,
    transformation: "screen-conversation-reconstruction/v1",
    transformationVersions: SCREEN_INTELLIGENCE_TRANSFORMATION_VERSIONS,
    generatedAtUtc: "2026-09-18T00:00:00.000Z",
    ocrProvider: { name: "tesseract", version: "5.5.1", local: true },
    ocrEnabled: true,
    acquisitionComplete: true,
    coverage: "COMPLETE",
    limitations: [],
    stats: {
      sourcePartCount: 1,
      keyframeCount: 2,
      ocrRegionCount: 3,
      ocrFailedKeyframes: 0,
      observationCount: 3,
      blockCount: 2,
      derivedBytes: 1234,
    },
    sources: [
      {
        partIndex: 0,
        evidencePartId: "part-A",
        sourceSha256: "sha-A",
        mimeType: "video/mp4",
        acquisitionRole: null,
      },
    ],
    keyframes: [
      {
        keyframeId: "p0-kf-0000",
        partIndex: 0,
        evidencePartId: "part-A",
        variantKey: "kf-0000",
        offsetMs: 0,
        derivedSha256: "kf0",
        derivedAssetId: "asset-kf0",
        reason: "first",
      },
      {
        keyframeId: "p0-kf-0001",
        partIndex: 0,
        evidencePartId: "part-A",
        variantKey: "kf-0001",
        offsetMs: 1500,
        derivedSha256: "kf1",
        derivedAssetId: "asset-kf1",
        reason: "interval",
      },
    ],
    observations: [
      {
        id: "obs-0",
        keyframeId: "p0-kf-0000",
        sourcePartIndex: 0,
        evidencePartId: "part-A",
        sourceOffsetMs: 0,
        frameOrder: 0,
        rowOrder: 0,
        text: "Hello",
        kind: "TEXT",
        fingerprint: null,
        confidence: 0.91,
      },
      {
        id: "obs-1",
        keyframeId: "p0-kf-0001",
        sourcePartIndex: 0,
        evidencePartId: "part-A",
        sourceOffsetMs: 1500,
        frameOrder: 1,
        rowOrder: 0,
        text: "World",
        kind: "TEXT",
        fingerprint: null,
        confidence: 0.88,
      },
    ],
    blocks: [
      {
        blockId: "obs-0",
        sequence: 0,
        kind: "TEXT",
        text: "Hello",
        confidence: "PARTIAL_OVERLAP",
        observationIds: ["obs-0"],
        sourcePartIndexes: [0],
        sourceEvidencePartIds: ["part-A"],
        sourceOffsetMsRange: [0, 0],
        observedInFrames: 1,
      },
      {
        blockId: "obs-1",
        sequence: 1,
        kind: "TEXT",
        text: "World",
        confidence: "PARTIAL_OVERLAP",
        observationIds: ["obs-1"],
        sourcePartIndexes: [0],
        sourceEvidencePartIds: ["part-A"],
        sourceOffsetMsRange: [1500, 1500],
        observedInFrames: 1,
      },
    ],
    ...over,
  };
}

describe("UC-4 review projection — lineage & provenance", () => {
  it("carries explicit DERIVED provenance markers, never an authenticity score", () => {
    const p = projectScreenIntelligenceForReview(descriptor());
    expect(p.provenance.reconstructed).toBe(DERIVED_RECONSTRUCTED_PROVENANCE);
    expect(p.provenance.machineExtracted).toBe(DERIVED_TEXT_PROVENANCE);
    expect(p).not.toHaveProperty("authenticityScore");
  });

  it("resolves each block's View-Source targets (ORIGINAL part + keyframe ids)", () => {
    const p = projectScreenIntelligenceForReview(descriptor());
    const first = p.blocks[0]!;
    expect(first.sources).toHaveLength(1);
    expect(first.sources[0]!.evidencePartId).toBe("part-A");
    expect(first.sources[0]!.keyframeIds).toEqual(["p0-kf-0000"]);
  });

  it("paginates blocks and reports the true total", () => {
    const p = projectScreenIntelligenceForReview(descriptor(), { offset: 1, limit: 1 });
    expect(p.blockTotal).toBe(2);
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0]!.sequence).toBe(1);
    expect(p.page).toEqual({ offset: 1, limit: 1 });
  });

  it("surfaces coverage + limitations + ocrEnabled truthfully", () => {
    const p = projectScreenIntelligenceForReview(
      descriptor({
        coverage: "PARTIAL",
        ocrEnabled: false,
        limitations: ["RECONSTRUCTION_POSSIBLE_GAP"],
      }),
    );
    expect(p.coverage).toBe("PARTIAL");
    expect(p.ocrEnabled).toBe(false);
    expect(p.limitations).toContain("RECONSTRUCTION_POSSIBLE_GAP");
    expect(p.transformationVersions.reconstruction).toBe(
      "screen-conversation-reconstruction/v1",
    );
  });
});
