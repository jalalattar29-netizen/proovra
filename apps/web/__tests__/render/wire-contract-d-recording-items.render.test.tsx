/**
 * WIRE CONTRACT D (2026-10-29) — public Verify and the evidence page present
 * ONE continuous screen recording as ONE item. Its stored parts and the
 * system-generated capture record are listed as technical parts with their
 * digests, and the capture record is never "text evidence". A record from an
 * older API (no presentation) keeps one item per part.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

import { ContentPreviewSurface, splitVerifyItems } from "../../app/verify/[token]/VerifyContentReview";
import type { VerifyContentArtifacts, VerifyEvidenceAsset } from "../../app/verify/[token]/_verify-types";
import { groupEvidencePreviewItems } from "../../app/(app)/evidence/[id]/_tabs/recording-items";

afterEach(cleanup);

const sha = (c: string) => c.repeat(64);

function asset(index: number, partPresentation: VerifyEvidenceAsset["partPresentation"], kind: VerifyEvidenceAsset["kind"] = "video"): VerifyEvidenceAsset {
  return {
    id: `part-${index}`,
    index,
    label: partPresentation === "capture_record" ? "Capture record (system-generated)" : `Evidence item ${index + 1}`,
    kind,
    sha256: sha(String(index)),
    isPrimary: index === 0,
    previewable: false,
    downloadable: false,
    displaySizeLabel: "1 KB",
    partPresentation,
  } as VerifyEvidenceAsset;
}

const SEGMENTED_ITEMS = [asset(0, "recording_part"), asset(1, "recording_part"), asset(2, "recording_part"), asset(3, "capture_record", "text")];
const SEGMENTED: VerifyContentArtifacts = {
  userItems: [{ kind: "recording", label: "Screen recording", partIndexes: [0, 1, 2], primaryPartIndex: 0, layout: "SEGMENTED" }],
  technical: { originalPartCount: 3, captureRecordCount: 1, storedPartCount: 4 },
  counts: { userItems: 1 },
  recording: { layout: "SEGMENTED", statement: "The recording is preserved as ordered segments.", audioStatement: "No audio was recorded." },
};

describe("public Verify — one recording item, technical parts listed separately", () => {
  it("renders one recording card and lists every part and the capture record as technical", () => {
    const { getByTestId, queryByRole, getAllByText } = render(
      <ContentPreviewSurface
        items={SEGMENTED_ITEMS}
        artifacts={SEGMENTED}
        summary={{ structure: "single", itemCount: 1 } as never}
        primaryItem={SEGMENTED_ITEMS[0]!}
        defaultPreviewItemId={null}
        previewPolicy={null as never}
        contentAccessPolicy={null as never}
        contentExposureDecision={null as never}
      />,
    );
    // One user item: no item picker at all.
    expect(queryByRole("list", { name: "Evidence items" })).toBeNull();
    expect(getAllByText("Screen recording").length).toBeGreaterThan(0);
    const technical = getByTestId("verify-technical-parts");
    expect(within(technical).getByText("Technical parts (4)")).toBeTruthy();
    for (const i of [0, 1, 2, 3]) expect(technical.textContent).toContain(sha(String(i)));
    expect(within(technical).getAllByText("Recording part (technical)")).toHaveLength(3);
    expect(within(technical).getByText("Capture record (system-generated)")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Text evidence/i);
    expect(document.body.textContent).toContain("No audio was recorded.");
  });

  it("an older API (no presentation) keeps one item per part", () => {
    const legacy = [asset(0, null, "image"), asset(1, null, "image")];
    const split = splitVerifyItems(legacy, null);
    expect(split.cards.map((c) => c.id)).toEqual(["part-0", "part-1"]);
    expect(split.technical).toEqual([]);
    expect(split.recording).toBeNull();
  });
});

describe("evidence page — preview grouping", () => {
  it("groups a single-file recording into one card; the manifest is technical", () => {
    const items = [asset(0, "recording_part"), asset(1, "capture_record", "text")] as never[];
    const grouped = groupEvidencePreviewItems(items, {
      userItems: [{ kind: "recording", label: "Screen recording", partIndexes: [0], primaryPartIndex: 0, layout: "SINGLE_FILE" }],
      technical: { originalPartCount: 1, captureRecordCount: 1, storedPartCount: 2, captureRecordPartIndexes: [1] },
      counts: { userItems: 1 },
    });
    expect(grouped.cards).toHaveLength(1);
    expect(grouped.recording).toEqual({ layout: "SINGLE_FILE", label: "Screen recording", partCount: 1 });
    expect(grouped.technical.map((t) => t.label)).toEqual(["Recording part (technical)", "Capture record (system-generated)"]);
  });
});
