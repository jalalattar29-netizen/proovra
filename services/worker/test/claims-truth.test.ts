/**
 * OPS-001, CRYPTO-006, 007, 008 — what a report, a package and the worker claim.
 */
import { readFileSync } from "node:fs";

import { OTS_ANCHORING_COPY } from "@proovra/shared";
import { describe, expect, it } from "vitest";

import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { nextOtsChainCheckDelayMs } from "../src/ots-state.js";
import { layoutVariant } from "./fixtures/report-layout-variants.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-01T00:00:00Z");
const anchored = (status: string, ageMs: number) =>
  ({ state: "ANCHORED", chain: { status }, anchoredAtUtc: new Date(NOW - ageMs).toISOString() }) as never;

describe("OPS-001 — only a recorded anchor is stated", () => {
  it("a report with no anchor row names no provider, whatever the environment says", async () => {
    process.env.ANCHOR_PROVIDER = "PROOVRA Anchor Ready";
    process.env.ANCHOR_MODE = "active";
    try {
      const { input } = layoutVariant({ name: "no anchor" });
      (input.evidence as { anchor?: unknown }).anchor = { mode: "off", provider: null, configured: false, anchorHash: null, transactionId: null, anchoredAtUtc: null };
      const html = renderReportHtml(await buildReportViewModel(input));
      expect(html).not.toContain("PROOVRA Anchor Ready");
      expect(html).not.toContain("External Anchor Provider");
    } finally {
      delete process.env.ANCHOR_PROVIDER;
      delete process.env.ANCHOR_MODE;
    }
  });

  it("the worker and the API take no provider from configuration", () => {
    for (const f of ["../src/processor.ts", "../../api/src/routes/evidence.routes.ts"]) {
      expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toMatch(/process\.env\.ANCHOR_PROVIDER/);
    }
  });
});

describe("CRYPTO-006, 007 — one word per fact", () => {
  it("a chain check names who ran it, in every language", () => {
    for (const copy of Object.values(OTS_ANCHORING_COPY) as Array<{ facts: { digest: string } }>) {
      expect(JSON.stringify(copy)).toContain("PROOVRA");
    }
    expect(JSON.stringify(OTS_ANCHORING_COPY.en)).not.toContain("Independently verified");
  });

  it("the fingerprint the proof commits to is not called the evidence digest", () => {
    expect(OTS_ANCHORING_COPY.en.facts.digest).toBe("Record fingerprint (SHA-256)");
    const src = readFileSync(new URL("../src/verification-package.ts", import.meta.url), "utf8");
    expect(src).toContain("Certified file digest (package-manifest.json");
    expect(src).not.toContain("The proof commits to the evidence digest");
  });
});

describe("CRYPTO-008 — an unavailable verifier backs off", () => {
  it("hourly at first, then every six hours, then the record's own follow-ups park (the sweep re-enqueues when the verifier answers)", () => {
    expect(nextOtsChainCheckDelayMs(anchored("UNAVAILABLE", HOUR), NOW)).toBe(HOUR);
    expect(nextOtsChainCheckDelayMs(anchored("UNAVAILABLE", 2 * 24 * HOUR), NOW)).toBe(6 * HOUR);
    expect(nextOtsChainCheckDelayMs(anchored("UNAVAILABLE", 90 * 24 * HOUR), NOW)).toBeNull();
  });

  it("an outage appends nothing to a record's custody", () => {
    const src = readFileSync(new URL("../src/ots-upgrade.processor.ts", import.meta.url), "utf8");
    expect(src).toContain('if (transition.phase === "chain_verification_unavailable") return won;');
  });
});
