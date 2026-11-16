/**
 * FREE-USER AUDIT 0ea0 — API-X (worker): the report halves of two client
 * requests.
 *
 *   B4-F-206  a video part whose capture client recorded no audio
 *             (`clientSignals.audioNotCapturedReason`, F-P1-09) says so in the
 *             report's part listing, as the record page does.
 *   B4-F-102  the printed captured-page address never carries a credential /
 *             signature value or a fragment (legacy facts included).
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
import { renderReportHtml } from "../src/report-v2/render-html.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { layoutVariant, regressionRecordInput } from "./fixtures/report-layout-variants.js";

const POLICY = { mode: "preview_only", allowContentView: true, allowDownload: false } as never;
const sha = (c: string) => c.repeat(64);

function part(i: number, mimeType: string, clientSignals: unknown) {
  return {
    id: `p${i}`,
    partIndex: i,
    originalFileName: `file-${i}`,
    mimeType,
    sizeBytes: 1000 + i,
    sha256: sha(String(i)),
    durationMs: mimeType.startsWith("video/") ? 10_000 : null,
    storageBucket: "b",
    storageKey: `k/p${i}`,
    artifactClass: "ORIGINAL",
    clientSignals,
  };
}

describe("B4-F-206 — the report part listing states 'no audio recorded'", () => {
  const content = () =>
    buildReportEvidenceContent({
      accessPolicy: POLICY,
      evidence: {
        id: "ev",
        mimeType: "video/webm",
        sizeBytes: 10,
        storageBucket: "b",
        storageKey: "k/p0",
        fileSha256: sha("c"),
        acquisitionMode: null,
      },
      parts: [
        part(0, "video/webm", { audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" }),
        part(1, "image/jpeg", { captureTimeUtc: "2026-11-01T00:00:00.000Z" }),
      ],
    });

  it("the video part carries the client-stated reason; the other part carries none", () => {
    const c = content();
    const video = c.items.find((i) => i.index === 0)!;
    const photo = c.items.find((i) => i.index === 1)!;
    expect(video.audioNotRecordedStatement).toMatch(/^No audio was recorded: the microphone permission was denied/);
    expect(video.audioNotRecordedStatement).toMatch(/stated by the capture client/);
    expect(photo.audioNotRecordedStatement ?? null).toBeNull();
  });

  it("the gallery prints it on that file's card", async () => {
    const c = content();
    const base = regressionRecordInput("absent");
    const vm = await buildReportViewModel({
      ...base,
      evidence: {
        ...base.evidence,
        itemCount: c.summary.itemCount,
        contentSummary: c.summary as never,
        contentItems: c.items as never,
        captureRecords: c.captureRecords,
        primaryContentItem: c.primaryItem as never,
        defaultPreviewItemId: c.primaryItem?.id ?? null,
        embeddedPreviewsSnapshot: [] as never,
      },
    } as ReportV2Input);
    const gallery = renderGallerySection(vm);
    expect(gallery).toContain("No audio was recorded: the microphone permission was denied");
    expect(gallery.match(/No audio was recorded/g)?.length).toBe(1);
  });
});

describe("B4-F-102 — the report never prints a credential value or a fragment of the captured address", () => {
  it("a legacy manifest fact with a signed URL is printed redacted", async () => {
    const { input } = layoutVariant({ name: "browser capture", mode: "browser_capture" } as never);
    const legacy = {
      ...input,
      captureManifest: {
        ...(input.captureManifest as Record<string, unknown>),
        web: {
          ...((input.captureManifest as { web: Record<string, unknown> }).web),
          sourceUrlPrivate: "https://cdn.example.com/f.pdf?X-Amz-Signature=sig-value-123&page=3#access_token=frag-value",
        },
      },
    } as ReportV2Input;
    const html = renderReportHtml(await buildReportViewModel(legacy));
    expect(html).toContain("https://cdn.example.com/f.pdf?X-Amz-Signature=REDACTED&amp;page=3");
    expect(html).not.toContain("sig-value-123");
    expect(html).not.toContain("frag-value");
  });
});
