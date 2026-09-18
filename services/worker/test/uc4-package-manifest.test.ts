/**
 * UC-4 — Verification Package derivative manifests (pure).
 *
 * Proves the package carries a bounded DERIVED manifest for keyframes + the
 * reconstruction with the metadata a validator needs (identity, digest, size,
 * transformation, source EvidencePart, coverage, per-block lineage) and NEVER
 * the reconstructed prose or OCR text (§45/§46/§48).
 */
import { describe, it, expect } from "vitest";
import {
  buildIntelligencePackageManifests,
  type IntelligencePackageInput,
} from "../src/verification-package-intelligence.js";

const derivedAssets: NonNullable<IntelligencePackageInput["derivedAssets"]> = [
  {
    id: "kf-1",
    assetKind: "video_keyframe",
    sourceEvidenceId: "ev-1",
    sourceMaterialId: "part-A",
    sha256: "a".repeat(64),
    sizeBytes: 40000,
    contentType: "image/webp",
    createdAtUtc: "2026-09-18T00:00:00.000Z",
  },
  {
    id: "recon-1",
    assetKind: "screen_reconstruction",
    sourceEvidenceId: "ev-1",
    sourceMaterialId: "part-A",
    sha256: "b".repeat(64),
    sizeBytes: 8000,
    contentType: "application/json",
    createdAtUtc: "2026-09-18T00:00:00.000Z",
  },
];

const reconstruction: NonNullable<IntelligencePackageInput["reconstruction"]> = {
  descriptorSha256: "b".repeat(64),
  descriptorSizeBytes: 8000,
  coverage: "PARTIAL",
  ocrEnabled: true,
  acquisitionComplete: false,
  transformationVersions: {
    keyframe: "video-keyframe/v1",
    ocr: "screen-ocr/v1",
    reconstruction: "screen-conversation-reconstruction/v1",
  },
  sources: [{ evidencePartId: "part-A", sourceSha256: "c".repeat(64) }],
  keyframeCount: 2,
  blockCount: 1,
  blocks: [
    {
      blockId: "obs-0",
      sequence: 0,
      kind: "TEXT",
      sourceEvidencePartIds: ["part-A"],
      sourceOffsetMsRange: [0, 1500],
      observedInFrames: 2,
    },
  ],
};

describe("UC-4 package derivative manifests", () => {
  it("emits the two DERIVED manifests under intelligence/", () => {
    const entries = buildIntelligencePackageManifests({ derivedAssets, reconstruction });
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("intelligence/derived_assets_manifest.json");
    expect(paths).toContain("intelligence/screen_reconstruction_manifest.json");
  });

  it("derived assets carry identity, digest, size, transformation + source part", () => {
    const entries = buildIntelligencePackageManifests({ derivedAssets });
    const m = entries.find((e) => e.path.endsWith("derived_assets_manifest.json"))!
      .json as { items: Array<Record<string, unknown>> };
    const kf = m.items.find((i) => i.assetKind === "video_keyframe")!;
    expect(kf.sha256).toBe("a".repeat(64));
    expect(kf.sizeBytes).toBe(40000);
    expect(kf.transformation).toBe("video-keyframe/v1");
    expect(kf.sourceMaterialId).toBe("part-A");
    const recon = m.items.find((i) => i.assetKind === "screen_reconstruction")!;
    expect(recon.transformation).toBe("screen-conversation-reconstruction/v1");
    // No duplicate derivative identities.
    const ids = m.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reconstruction manifest carries lineage + coverage, DERIVED_RECONSTRUCTED, no prose", () => {
    const entries = buildIntelligencePackageManifests({ reconstruction });
    const m = entries.find((e) =>
      e.path.endsWith("screen_reconstruction_manifest.json"),
    )!.json as Record<string, unknown>;
    expect(m.schema).toBe("PROOVRA_PACKAGE_SCREEN_RECONSTRUCTION");
    expect(m.classification).toBe("DERIVED_RECONSTRUCTED");
    expect(m.coverage).toBe("PARTIAL");
    expect(m.descriptorSha256).toBe("b".repeat(64));
    expect((m.transformationVersions as Record<string, string>).reconstruction).toBe(
      "screen-conversation-reconstruction/v1",
    );
    const blocks = m.blocks as Array<Record<string, unknown>>;
    expect(blocks[0]!.sourceEvidencePartIds).toEqual(["part-A"]);
    expect(blocks[0]!.sourceOffsetMsRange).toEqual([0, 1500]);
    // NO reconstructed prose — blocks carry lineage only, never their text.
    expect(blocks[0]).not.toHaveProperty("text");
    expect(blocks[0]).not.toHaveProperty("content");
  });

  it("emits nothing for evidence with no derived intelligence (byte-stable)", () => {
    expect(buildIntelligencePackageManifests(null)).toEqual([]);
    expect(buildIntelligencePackageManifests({})).toEqual([]);
  });
});
