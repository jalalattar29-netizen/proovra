/**
 * UC-4 — search provenance (pure).
 *
 * The canonical search projection must distinguish DERIVED_RECONSTRUCTED review
 * text from DERIVED_MACHINE_EXTRACTED OCR (§40), without leaking either into the
 * result-row title/subtitle/summary (searchableText is a match-only body).
 */
import { describe, it, expect } from "vitest";
import {
  buildEvidenceProjection,
  DERIVED_TEXT_PROVENANCE,
  DERIVED_RECONSTRUCTED_PROVENANCE,
  SEARCH_PROJECTION_VERSION,
} from "@proovra/shared";

const TEAM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EV = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";

function project(chunks: string[]) {
  const r = buildEvidenceProjection({
    teamId: TEAM,
    evidenceId: EV,
    evidence: {
      id: EV,
      teamId: TEAM,
      title: "screen capture",
      displayFileName: "capture.mp4",
      originalFileName: "capture.mp4",
      type: "VIDEO",
      mimeType: "video/mp4",
      captureMethod: "DIRECT_SCREEN_CAPTURE_ANDROID",
      caseId: null,
      deletedAt: null,
      lifecycleState: "ACTIVE",
      archivedAt: null,
      lockedAt: null,
      publicVerifyState: "PUBLISHED",
      storageObjectLockLegalHoldStatus: null,
      retentionPolicySource: null,
      retentionUntilUtc: null,
      reviewReadyAtUtc: null,
      updatedAt: new Date("2026-09-18T00:00:00.000Z"),
    },
    intakeIdentity: null,
    workflowState: null,
    extractedTextChunks: chunks,
  });
  if (!r.ok) throw new Error("projection refused");
  return r.projection;
}

describe("UC-4 search provenance (§40)", () => {
  it("bumped the projection version so existing docs reindex", () => {
    expect(SEARCH_PROJECTION_VERSION).toBeGreaterThanOrEqual(5);
  });

  it("machine-extracted OCR only → derived_text, NOT derived_reconstructed", () => {
    const p = project(["[OCR_SCREEN] hello from a keyframe"]);
    const meta = p.searchableMetadata ?? {};
    expect(meta.textProvenance).toBe(DERIVED_TEXT_PROVENANCE);
    expect(meta.reconstructedProvenance ?? null).toBeNull();
    expect(p.searchableTags).toContain("derived_text");
    expect(p.searchableTags).not.toContain("derived_reconstructed");
    // Findable in the body…
    expect(p.searchableText).toContain("hello from a keyframe");
    // …but never echoed onto the result row.
    expect(p.title).not.toContain("hello from a keyframe");
    expect(p.summary ?? "").not.toContain("hello from a keyframe");
  });

  it("reconstructed text → BOTH markers, distinguishable from plain OCR", () => {
    const p = project([
      "[OCR_SCREEN] raw rows",
      "[SCREEN_RECONSTRUCTION] A B C reconstructed conversation",
    ]);
    const meta = p.searchableMetadata ?? {};
    expect(meta.textProvenance).toBe(DERIVED_TEXT_PROVENANCE);
    expect(meta.reconstructedProvenance).toBe(DERIVED_RECONSTRUCTED_PROVENANCE);
    expect(p.searchableTags).toContain("derived_text");
    expect(p.searchableTags).toContain("derived_reconstructed");
    expect(p.searchableText).toContain("reconstructed conversation");
    expect(p.title).not.toContain("reconstructed conversation");
  });

  it("no derived text → neither marker (backward compatible)", () => {
    const p = project([]);
    const meta = p.searchableMetadata ?? {};
    expect(meta.textProvenance ?? null).toBeNull();
    expect(meta.reconstructedProvenance ?? null).toBeNull();
    expect(p.searchableTags).not.toContain("derived_text");
    expect(p.searchableTags).not.toContain("derived_reconstructed");
  });
});
