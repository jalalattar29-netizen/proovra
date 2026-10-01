/**
 * UC-DER-007 / UC-DER-015 / lane-D cross-lane (UC-DER-010, UC-DER-008).
 *
 *   DER-007  the package derived-assets manifest states its true total and a
 *            truncation flag, and keyframes carry variantKey/sourceOffsetMs;
 *            derived/derived-manifest.json states totalCount/truncated.
 *   DER-015  the package's reconstruction digest is the SHA-256 of the bytes
 *            it read (a stale row digest is ignored); the report section
 *            carries and renders the digest + generation time.
 *   DER-010  a NULL-team (legacy Personal) record resolves its owner's
 *            personal workspace in both bridges instead of being skipped.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

const DESCRIPTOR_BYTES = Buffer.from(JSON.stringify({ any: "descriptor bytes" }));
const calls = vi.hoisted(() => ({ teamIds: [] as string[] }));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidence: { findUnique: async () => ({ ownerUserId: "owner-1" }) },
  },
}));
vi.mock("../src/storage.js", () => ({
  getObjectStream: async () => Readable.from([DESCRIPTOR_BYTES]),
}));
vi.mock("@proovra/shared-runtime", async (orig) => ({
  ...(await orig<object>()),
  resolveEvidenceWorkspaceId: async (e: { teamId: string | null; ownerUserId: string | null }) =>
    e.teamId ?? (e.ownerUserId === "owner-1" ? "personal-ws-1" : null),
}));
const descriptor = {
  coverage: "COMPLETE",
  ocrEnabled: false,
  ocrProvider: null,
  acquisitionComplete: true,
  generatedAtUtc: "2026-09-30T10:00:00.000Z",
  stats: { sourcePartCount: 1, keyframeCount: 3, observationCount: 0, blockCount: 2 },
  transformationVersions: { keyframe: "kf/1", ocr: "ocr/1", reconstruction: "recon/1" },
  limitations: [],
  sources: [],
  blocks: [],
};
vi.mock("@proovra/shared-runtime/media-intelligence", () => ({
  projectMediaIntelligenceForReport: async () => ({ signals: [] }),
  listDerivedAssetsForEvidence: async (teamId: string) => {
    calls.teamIds.push(teamId);
    return [
      {
        id: "row-desc",
        evidenceId: "ev-1",
        evidencePartId: "p-1",
        assetKind: "screen_reconstruction",
        status: "COMPLETED",
        derivedSha256: "f".repeat(64), // a STALE row digest
        sizeBytes: 9,
        contentType: "application/json",
        createdAtUtc: "2026-09-30T10:00:00.000Z",
        variantKey: "recon-v1",
        sourceOffsetMs: null,
      },
    ];
  },
  readScreenReconstructionDescriptor: async (
    _teamId: string,
    _evidenceId: string,
    deps: { getObjectBytes: (o: { bucket: string; key: string }) => Promise<Buffer> },
  ) => {
    await deps.getObjectBytes({ bucket: "b", key: "k" });
    return { descriptor };
  },
}));

const { buildVerificationPackageIntelligence } = await import("../src/verification-package-intelligence-bridge.js");
const { buildReportDerivedReview } = await import("../src/report-v2/derived-review-bridge.js");
const { buildDerivedAssetsManifest } = await import("../src/verification-package-intelligence.js");
const { buildDerivedManifest } = await import("../src/verification-package.js");
const { renderDerivedReviewSection } = await import("../src/report-v2/sections/derived-review.js");

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("DER-015 / DER-010 — bridges bind to the bytes read and resolve NULL-team workspaces", () => {
  it("package: digest is sha256(bytes read), not the listed row; NULL-team resolves the personal workspace", async () => {
    calls.teamIds.length = 0;
    const out = await buildVerificationPackageIntelligence({ teamId: null, evidenceId: "ev-1", ownerUserId: "owner-1" });
    expect(calls.teamIds).toEqual(["personal-ws-1"]);
    expect(out?.reconstruction?.descriptorSha256).toBe(sha(DESCRIPTOR_BYTES));
    expect(out?.reconstruction?.descriptorSizeBytes).toBe(DESCRIPTOR_BYTES.length);
  });

  it("report: NULL-team resolves; the section carries the digest + ocrStatus and renders the binding", async () => {
    const section = await buildReportDerivedReview({ teamId: null, evidenceId: "ev-1" });
    expect(section).not.toBeNull();
    expect(section!.descriptorSha256).toBe(sha(DESCRIPTOR_BYTES));
    expect(section!.ocrStatus).toBeDefined();
    const html = renderDerivedReviewSection(section);
    expect(html).toContain(sha(DESCRIPTOR_BYTES));
    expect(html).toContain("2026-09-30T10:00:00.000Z");
  });
});

describe("DER-007 — derived manifests state their bound", () => {
  it("600 derived assets: totalCount 600, truncated, keyframes carry variantKey/sourceOffsetMs", () => {
    const assets = Array.from({ length: 600 }, (_, i) => ({
      id: `a-${i}`,
      assetKind: "video_keyframe" as const,
      sourceEvidenceId: "ev-1",
      sourceMaterialId: "p-1",
      sha256: "c".repeat(64),
      sizeBytes: 10,
      contentType: "image/jpeg",
      createdAtUtc: "2026-09-30T10:00:00.000Z",
      variantKey: `kf-${String(i).padStart(4, "0")}`,
      sourceOffsetMs: i * 500,
    }));
    const m = buildDerivedAssetsManifest(assets) as Record<string, unknown> & { items: Array<Record<string, unknown>> };
    expect(m.totalCount).toBe(600);
    expect(m.truncated).toBe(true);
    expect(m.items.length).toBe(m.count);
    expect(m.items[1]).toMatchObject({ variantKey: "kf-0001", sourceOffsetMs: 500 });
  });

  it("derived/derived-manifest.json states totalCount and truncated from the counted inventory", () => {
    const chain = {
      derivedArtifacts: Array.from({ length: 500 }, () => ({ status: "COMPLETED" })),
      derivedArtifactsTotalCount: 650,
    } as never;
    const m = buildDerivedManifest({ evidenceId: "ev-1", chain });
    expect(m).toMatchObject({ count: 500, totalCount: 650, truncated: true });
  });
});
