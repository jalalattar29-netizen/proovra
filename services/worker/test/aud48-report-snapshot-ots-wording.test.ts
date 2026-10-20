/**
 * AUD-48 (2026-10-20) — a report is an immutable snapshot. When the Bitcoin
 * chain check could not run at render time, the PDF states that as of issue;
 * it never bakes "temporarily unavailable" (an operational moment) into
 * permanent text. Live surfaces keep the shared live wording.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/capture-location-map.js", () => ({
  renderCaptureLocationMapPreviewDataUrl: vi.fn(async () => null),
}));

import { checkRenderedReportText, OTS_VERIFICATION_LABELS } from "@proovra/shared";

import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { ANCHORED_PROOF, canonicalFactsOf, layoutVariant } from "./fixtures/report-layout-variants.js";
import { chainColumnsFor } from "./fixtures/ots-chain-fixtures.js";

const text = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");

describe("AUD-48 report OTS wording is a snapshot", () => {
  it("an unavailable chain check is stated as of issue, never as 'temporarily unavailable'", async () => {
    const base = layoutVariant({ name: "chain unavailable", ots: "anchored" }).input;
    const input = { ...base, evidence: { ...base.evidence, ...chainColumnsFor(ANCHORED_PROOF, { status: "UNAVAILABLE" }) } as ReportV2Input["evidence"] };
    const vm = await buildReportViewModel(input);
    const t = text(renderReportHtml(vm));
    expect(OTS_VERIFICATION_LABELS.CHAIN_UNAVAILABLE).toMatch(/temporarily/);
    expect(t).not.toMatch(/temporarily unavailable/i);
    expect(t).toContain("not independently checked when this report was issued");
    // The rendered-report gate accepts the snapshot wording (one table for both).
    const findings = checkRenderedReportText(t, canonicalFactsOf(input), { reportVersion: input.version });
    expect(findings.filter((x) => x.check.startsWith("OTS_"))).toEqual([]);
  });
});
