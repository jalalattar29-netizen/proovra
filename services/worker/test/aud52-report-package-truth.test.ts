/**
 * AUD-52 (2026-10-20) — two facts a reader could otherwise take for something
 * they are not:
 *   - a capture channel recorded LATER (a backfill from a proven link) is
 *     stated as such on the report, never as recorded at creation;
 *   - a part's free-text source label is the SUBMITTER's text, and the package
 *     says so beside it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/capture-location-map.js", () => ({
  renderCaptureLocationMapPreviewDataUrl: vi.fn(async () => null),
  renderCaptureLocationMapPreviewPng: vi.fn(async () => null),
}));

import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { buildOriginalLinkage } from "../src/verification-package.js";
import { regressionRecordInput } from "./fixtures/report-layout-variants.js";

function withAcquisition(acquisitionMode: string, acquisitionModeSource: string | null): ReportV2Input {
  const input = regressionRecordInput("absent");
  return { ...input, evidence: { ...input.evidence, acquisitionMode, acquisitionModeSource } } as ReportV2Input;
}

const captureMethodValues = (vm: unknown) => {
  const out: string[] = [];
  const walk = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    if (r.label === "Capture Method" && typeof r.value === "string") out.push(r.value);
    Object.values(r).forEach(walk);
  };
  walk(vm);
  return out;
};

describe("AUD-52 report — how the capture channel was recorded", () => {
  it("a backfilled channel says it was recorded later", async () => {
    const vm = await buildReportViewModel(withAcquisition("SECURE_INTAKE_LINK", "BACKFILL_INTAKE_SESSION_LINK"));
    const values = captureMethodValues(vm);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toMatch(/\(recorded later, from the secure-intake session link\)$/);
  });

  it("a channel recorded at creation reads plainly", async () => {
    const vm = await buildReportViewModel(withAcquisition("SECURE_INTAKE_LINK", "RECORDED_AT_CREATION"));
    for (const v of captureMethodValues(vm)) expect(v).not.toMatch(/recorded later/);
  });
});

describe("AUD-52 package — the submitter's source label is labelled as theirs", () => {
  const file = (sourceLabel: string | null) =>
    ({ finalName: "photo.jpg", partIndex: 0, sha256: "a".repeat(64), sizeBytes: 3, mimeType: "image/jpeg", sourceLabel }) as never;

  it("a source label carries SUBMITTER_TEXT_NOT_VERIFIED beside it", () => {
    const linkage = buildOriginalLinkage([file("Front door camera")], {} as never) as { files?: Array<Record<string, unknown>> };
    const f = JSON.stringify(linkage);
    expect(f).toContain("\"sourceLabel\":\"Front door camera\"");
    expect(f).toContain("\"sourceLabelBasis\":\"SUBMITTER_TEXT_NOT_VERIFIED\"");
  });

  it("no label, no basis", () => {
    const f = JSON.stringify(buildOriginalLinkage([file(null)], {} as never));
    expect(f).toContain("\"sourceLabelBasis\":null");
  });
});
