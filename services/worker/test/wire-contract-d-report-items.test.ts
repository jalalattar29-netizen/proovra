/**
 * WIRE CONTRACT D (2026-10-29) — the report and the package present ONE
 * continuous screen recording as ONE evidence item. Its stored parts are
 * technical (listed with their own SHA-256), the capture manifest is a
 * "Capture record (system-generated)" in the technical appendix and never
 * "Supporting · Text Evidence", and the multipart digest wording names its
 * separators. Every other record keeps one item per ORIGINAL part.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: { evidencePartDerivedAsset: { findFirst: vi.fn() } } }));
vi.mock("../src/capture-location-map.js", () => ({
  renderCaptureLocationMapPreviewDataUrl: vi.fn(async () => null),
  renderCaptureLocationMapPreviewPng: vi.fn(async () => null),
}));

import { buildReportEvidenceContent } from "../src/processor.js";
import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderGallerySection } from "../src/report-v2/sections/gallery.js";
import { renderTechnicalAppendixSection } from "../src/report-v2/sections/technical-appendix.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { buildDerivedManifest, buildSystemProcessDeclaration } from "../src/verification-package.js";
import { prisma } from "../src/db.js";
import { projectReportCombinedRecording, readReportCombinedRecording } from "../src/report-v2/combined-recording-bridge.js";
import { regressionRecordInput } from "./fixtures/report-layout-variants.js";

const POLICY = { mode: "preview_only", allowContentView: true, allowDownload: false } as never;
const sha = (c: string) => c.repeat(64);

function part(i: number, artifactClass: "ORIGINAL" | "CAPTURE_MANIFEST", mime = "video/mp4") {
  return {
    id: `p${i}`,
    partIndex: i,
    originalFileName: artifactClass === "CAPTURE_MANIFEST" ? "continuous-manifest.json" : `segment-${i}.mp4`,
    mimeType: artifactClass === "CAPTURE_MANIFEST" ? "application/json" : mime,
    sizeBytes: 1000 + i,
    sha256: sha(String(i)),
    durationMs: artifactClass === "CAPTURE_MANIFEST" ? null : 10_000,
    storageBucket: "b",
    storageKey: `k/p${i}`,
    artifactClass,
  };
}

function content(acquisitionMode: string | null, parts: ReturnType<typeof part>[]) {
  return buildReportEvidenceContent({
    accessPolicy: POLICY,
    evidence: {
      id: "ev",
      mimeType: "video/mp4",
      sizeBytes: 10,
      storageBucket: "b",
      storageKey: "k/p0",
      fileSha256: sha("c"),
      acquisitionMode,
    },
    parts,
  });
}

const SEGMENTED = [part(0, "ORIGINAL"), part(1, "ORIGINAL"), part(2, "ORIGINAL"), part(3, "CAPTURE_MANIFEST")];

describe("wire contract D — report content items", () => {
  it("a SEGMENTED screen recording is ONE item with its parts as technical parts", () => {
    const out = content("DIRECT_SCREEN_CAPTURE_IOS", SEGMENTED);
    expect(out.summary.itemCount).toBe(1);
    expect(out.summary.structure).toBe("single");
    expect(out.items).toHaveLength(1);
    const [item] = out.items;
    expect(item!.label).toBe("Screen recording");
    expect(item!.userItemKind).toBe("recording");
    expect(item!.recordingLayout).toBe("SEGMENTED");
    expect(item!.originalFileName).toBeNull();
    expect(item!.technicalParts!.map((p) => [p.partIndex, p.sha256])).toEqual([
      [0, sha("0")],
      [1, sha("1")],
      [2, sha("2")],
    ]);
    expect(item!.sizeBytes).toBe(String(1000 + 1001 + 1002));
    expect(out.captureRecords).toEqual([
      expect.objectContaining({ partIndex: 3, label: "Capture record (system-generated)", sha256: sha("3") }),
    ]);
  });

  it("a SINGLE_FILE recording keeps its own file name and digest", () => {
    const out = content("DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS", [part(0, "ORIGINAL"), part(1, "CAPTURE_MANIFEST")]);
    expect(out.summary.itemCount).toBe(1);
    expect(out.items[0]!.recordingLayout).toBe("SINGLE_FILE");
    expect(out.items[0]!.originalFileName).toBe("segment-0.mp4");
    expect(out.items[0]!.sha256).toBe(sha("0"));
    expect(out.captureRecords).toHaveLength(1);
  });

  it("an ordinary multipart upload keeps one item per ORIGINAL part", () => {
    const out = content("PROOVRA_WEB_UPLOAD", [part(0, "ORIGINAL", "image/jpeg"), part(1, "ORIGINAL", "image/jpeg")]);
    expect(out.summary.itemCount).toBe(2);
    expect(out.items.every((i) => i.userItemKind === undefined)).toBe(true);
    expect(out.captureRecords).toEqual([]);
  });

  it("a web capture's manifest is never an evidence item", () => {
    const out = content("DIRECT_WEB_CAPTURE_EXTENSION", [part(0, "ORIGINAL", "image/png"), part(1, "CAPTURE_MANIFEST")]);
    expect(out.summary.itemCount).toBe(1);
    expect(out.summary.textCount).toBe(0);
    expect(out.items.map((i) => i.index)).toEqual([0]);
    expect(out.captureRecords.map((r) => r.partIndex)).toEqual([1]);
  });
});

function recordingReportInput(): ReportV2Input {
  const base = regressionRecordInput("absent");
  const c = content("DIRECT_SCREEN_CAPTURE_IOS", SEGMENTED);
  return {
    ...base,
    evidence: {
      ...base.evidence,
      acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS",
      itemCount: c.summary.itemCount,
      evidenceStructure: "Single evidence item",
      contentSummary: c.summary as never,
      contentItems: c.items as never,
      captureRecords: c.captureRecords,
      primaryContentItem: c.primaryItem as never,
      defaultPreviewItemId: c.primaryItem?.id ?? null,
      embeddedPreviewsSnapshot: [] as never,
    },
  } as ReportV2Input;
}

describe("wire contract D — PDF presentation", () => {
  it("counts one item, keeps multipart digest semantics, and shows one recording card with its part hashes", async () => {
    const vm = await buildReportViewModel(recordingReportInput());
    expect(vm.contentSummary.itemCount).toBe(1);
    expect(vm.technicalPartCount).toBe(4);
    // Digest semantics follow the stored parts, never the user item count.
    const digestLabels = vm.verificationSummaryRows.map((r) => r.label);
    expect(digestLabels).toContain("Canonical Package Digest (SHA-256)");
    expect(digestLabels).not.toContain("Original File SHA-256");

    const gallery = renderGallerySection(vm);
    expect(gallery).toContain("Screen recording");
    expect(gallery).toContain("Screen Recording");
    expect(gallery).toContain(sha("1"));
    expect(gallery).toContain(sha("2"));
    expect(gallery).toContain("Stored as 3 technical parts");
    // The manifest is not an evidence card.
    expect(gallery).not.toContain(sha("3"));
    expect(gallery).not.toContain("Text Evidence");
    expect(gallery).not.toContain("continuous-manifest.json");
  });

  it("the technical appendix lists the capture record and names both digest separators", async () => {
    const vm = await buildReportViewModel(recordingReportInput());
    const appendix = renderTechnicalAppendixSection(vm);
    expect(appendix).toContain("Capture record (system-generated)");
    expect(appendix).toContain(sha("3"));
    expect(appendix).toContain("joined by &#39;|&#39;");
    expect(appendix).toContain("joined by &#39;\\n&#39; (LF)");
    expect(appendix).toContain("algorithm: SHA-256");
  });
});

describe("wire contract D — package README", () => {
  it("states evidence items and technical files separately", () => {
    const files = [0, 1, 2].map((i) => ({ partIndex: i, artifactClass: "ORIGINAL", name: `p${i}` }))
      .concat([{ partIndex: 3, artifactClass: "CAPTURE_MANIFEST", name: "m" }]) as never;
    const md = buildSystemProcessDeclaration({
      evidenceFiles: files,
      metadata: { acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS" } as never,
    });
    expect(md).toContain("- Evidence items: 1");
    expect(md).toContain("including any system-generated capture record): 4");
    expect(md).not.toContain("Included preserved item count");
  });
});

describe("contract A — the recording's statement and audio, in the shared wording", () => {
  it("the card states the audio and the appendix states the single-file statement", async () => {
    const base = recordingReportInput();
    const vm = await buildReportViewModel({
      ...base,
      evidence: {
        ...base.evidence,
        continuousRecording: {
          layout: "SINGLE_FILE",
          statement: "STATEMENT-PRESERVED-AS-ONE-VIDEO-FILE",
          observedByProovra: "observed",
          audioStatement: "AUDIO-STATEMENT-NO-AUDIO",
        },
      },
    } as ReportV2Input);
    expect(renderGallerySection(vm)).toContain("AUDIO-STATEMENT-NO-AUDIO");
    const appendix = renderTechnicalAppendixSection(vm);
    expect(appendix).toContain("STATEMENT-PRESERVED-AS-ONE-VIDEO-FILE");
    expect(appendix).toContain("Screen recording — one video file");
  });
});

const LINEAGE = {
  schema: "PROOVRA_SCREEN_RECORDING_COMBINE_V1",
  sources: [{ partIndex: 0 }, { partIndex: 1 }, { partIndex: 2 }],
  gaps: [
    { atMs: 10_000, durationMs: 4_000, cause: "SEGMENT_MISSING", missingSequences: [1], limitations: [] },
    { atMs: 20_000, durationMs: 2_500, cause: "SEGMENT_MISSING", missingSequences: [], limitations: [] },
  ],
  completeness: "PARTIAL",
};

describe("COMBINE — the derived combined review video in the report and package", () => {
  it("reads only the newest COMPLETED combined row and projects its lineage facts", async () => {
    const findFirst = (prisma as unknown as { evidencePartDerivedAsset: { findFirst: ReturnType<typeof vi.fn> } })
      .evidencePartDerivedAsset.findFirst;
    findFirst.mockResolvedValueOnce({ derivedSha256: sha("d"), generationParameters: LINEAGE, generatedAtUtc: new Date("2026-10-29T10:00:00Z") });
    const c = await readReportCombinedRecording("ev");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { evidenceId: "ev", assetKind: "screen_recording_combined", status: "COMPLETED" },
        orderBy: [{ generatedAtUtc: { sort: "desc", nulls: "last" } }, { createdAtUtc: "desc" }],
      }),
    );
    expect(c).toEqual({
      derivedSha256: sha("d"),
      sourceSegmentCount: 3,
      completeness: "PARTIAL",
      gapCount: 2,
      gapTotalMs: 6_500,
      gapDurationUnknown: false,
      generatedAtUtc: "2026-10-29T10:00:00.000Z",
    });
    findFirst.mockResolvedValueOnce(null);
    expect(await readReportCombinedRecording("ev")).toBeNull();
    expect(projectReportCombinedRecording({ derivedSha256: null, generationParameters: { schema: "other" }, generatedAtUtc: null })).toBeNull();
  });

  it("the card and the technical appendix state it as derived, never as an original", async () => {
    const base = recordingReportInput();
    const combinedRecording = projectReportCombinedRecording({
      derivedSha256: sha("d"),
      generationParameters: LINEAGE,
      generatedAtUtc: "2026-10-29T10:00:00.000Z",
    });
    const vm = await buildReportViewModel({ ...base, evidence: { ...base.evidence, combinedRecording } } as ReportV2Input);
    const gallery = renderGallerySection(vm);
    expect(gallery).toContain("Combined review video (derived, not an original): sha256 " + sha("d"));
    expect(gallery).toContain("3 source segments, PARTIAL, gaps 2 (total 7 s)");
    const appendix = renderTechnicalAppendixSection(vm);
    expect(appendix).toContain("Combined review video (derived — not an original)");
    expect(appendix).toContain(sha("d"));
    // Counts are unchanged: a derived copy is never an evidence item.
    expect(vm.contentSummary.itemCount).toBe(1);
    expect(vm.technicalPartCount).toBe(4);
  });

  it("a report without a COMPLETED combined video says nothing about one", async () => {
    const vm = await buildReportViewModel(recordingReportInput());
    expect(renderGallerySection(vm)).not.toContain("Combined review video");
    expect(renderTechnicalAppendixSection(vm)).not.toContain("Combined review video");
  });

  it("the package names it in the README and the derived manifest; its bytes are not included", () => {
    const chain = {
      derivedArtifacts: [
        { assetKind: "screen_recording_combined", status: "COMPLETED", derivedSha256: sha("d"), sourcePartIndexes: [0, 1, 2], artifactClass: "DERIVED" },
      ],
    } as never;
    const md = buildSystemProcessDeclaration({
      evidenceFiles: [{ partIndex: 0, artifactClass: "ORIGINAL", name: "p0" }] as never,
      metadata: { acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS" } as never,
      chain,
    });
    expect(md).toContain("## Derived review files");
    expect(md).toContain(`SHA-256 ${sha("d")}, from 3 source segments`);
    expect(md).toContain("the video's bytes are not included in this package");
    const manifest = buildDerivedManifest({ evidenceId: "ev", chain }) as { items: Array<Record<string, unknown>> };
    expect(manifest.items[0]).toEqual(
      expect.objectContaining({ sourcePartIndexes: [0, 1, 2], bytesIncluded: false, label: expect.stringContaining("not an original") }),
    );
    expect(buildSystemProcessDeclaration({ evidenceFiles: [] as never, metadata: {} as never })).not.toContain("Derived review files");
  });
});
