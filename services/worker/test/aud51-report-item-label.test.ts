/**
 * AUD-51 (2026-10-20) — an issued report names an item the way Public Verify
 * does: from its original file name, or "Evidence item N". A storage key is
 * internal infrastructure and never becomes a label in the report.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

const { buildReportEvidenceContent } = await import("../src/processor.js");

const POLICY = { mode: "preview_only", allowContentView: true, allowDownload: false } as never;

describe("AUD-51 report item labels never come from a storage key", () => {
  it("a part with no original file name is 'Evidence item N', not its key's basename", () => {
    const out = buildReportEvidenceContent({
      accessPolicy: POLICY,
      evidence: { id: "ev", mimeType: "image/jpeg", sizeBytes: 10, storageBucket: "b", storageKey: "evidence/ev/internal-secret-name.jpg", fileSha256: null },
      parts: [
        { id: "p0", partIndex: 0, originalFileName: null, mimeType: "image/jpeg", sizeBytes: 10, sha256: null, durationMs: null, storageBucket: "b", storageKey: "evidence/ev/parts/internal-secret-name.jpg" },
      ],
    });
    expect(out.items[0]!.label).not.toContain("internal-secret-name");
    expect(out.items[0]!.label).toMatch(/^Evidence item 1/);
  });

  it("an original file name is still used", () => {
    const out = buildReportEvidenceContent({
      accessPolicy: POLICY,
      evidence: { id: "ev", mimeType: "image/jpeg", sizeBytes: 10, storageBucket: "b", storageKey: "k", fileSha256: null },
      parts: [{ id: "p0", partIndex: 0, originalFileName: "Roof.jpg", mimeType: "image/jpeg", sizeBytes: 10, sha256: null, durationMs: null, storageBucket: "b", storageKey: "k/p0" }],
    });
    expect(out.items[0]!.label).toBe("Roof.jpg");
  });
});
