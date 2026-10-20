/**
 * AUD-44 (2026-10-20) — every report surface that speaks about immutable
 * storage reads THE canonical storage verification state
 * (resolveStorageProtectionVerification, carried as
 * evidence.storageProtectionVerification): "verified" only for a successful
 * authoritative read of an in-force COMPLIANCE lock. A lock RECORDED on the row
 * at sealing (the read failed or never happened) is stated as recorded — the
 * appendix row, the storage callout, the readiness summary and the tone never
 * say "Verified" for it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/capture-location-map.js", () => ({
  renderCaptureLocationMapPreviewDataUrl: vi.fn(async () => null),
}));

import { STORAGE_PROTECTION_VERIFICATION_LABELS } from "@proovra/shared";

import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { regressionRecordInput } from "./fixtures/report-layout-variants.js";

const text = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const FUTURE = "2099-01-01T00:00:00.000Z";

async function render(state: string | null) {
  const base = regressionRecordInput();
  const input = {
    ...base,
    evidence: {
      ...base.evidence,
      storageImmutable: true,
      storageObjectLockMode: "COMPLIANCE",
      storageObjectLockRetainUntilUtc: FUTURE,
      storageProtectionVerification: state,
    },
  } as ReportV2Input;
  const vm = await buildReportViewModel(input);
  const html = renderReportHtml(vm);
  return { vm, text: text(html), json: JSON.stringify(vm) };
}

const rowValue = (vm: unknown, label: string): string[] => {
  const out: string[] = [];
  const walk = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    if (r.label === label && typeof r.value === "string") out.push(r.value);
    Object.values(r).forEach(walk);
  };
  walk(vm);
  return out;
};

describe("AUD-44 storage truth on every report surface", () => {
  it("a RECORDED lock (no confirming read) is never printed as Verified, even with COMPLIANCE facts on the row", async () => {
    const r = await render("RECORDED");
    const rows = rowValue(r.vm, "Immutable Storage");
    expect(rows.length).toBeGreaterThan(0);
    for (const v of rows) {
      expect(v).not.toBe("Verified");
      expect(v).toBe(STORAGE_PROTECTION_VERIFICATION_LABELS.RECORDED);
    }
    expect(r.json).not.toContain("Immutable storage verified");
    expect(r.text).not.toContain("Immutable storage verified");
    expect(r.text).toContain(STORAGE_PROTECTION_VERIFICATION_LABELS.RECORDED);
    // The storage callout: recorded, never the verified title or a success tone.
    const callout = (r.vm as unknown as { storageCallouts: Array<{ title: string; tone: string }> }).storageCallouts.find((c) => /storage|retention/i.test(c.title))!;
    expect(callout.title).not.toBe(STORAGE_PROTECTION_VERIFICATION_LABELS.STORAGE_CONFIRMED);
    expect(callout.tone).not.toBe("success");
  });

  it("a missing state (no read, no classification) reads as not confirmed, never Verified", async () => {
    const r = await render(null);
    for (const v of rowValue(r.vm, "Immutable Storage")) expect(v).toBe(STORAGE_PROTECTION_VERIFICATION_LABELS.UNAVAILABLE);
    expect(r.json).not.toContain("Immutable storage verified");
  });

  it("only a STORAGE_CONFIRMED read prints the verified wording", async () => {
    const r = await render("STORAGE_CONFIRMED");
    const rows = rowValue(r.vm, "Immutable Storage");
    for (const v of rows) expect(v).toBe(STORAGE_PROTECTION_VERIFICATION_LABELS.STORAGE_CONFIRMED);
    expect(r.text).toContain(STORAGE_PROTECTION_VERIFICATION_LABELS.STORAGE_CONFIRMED);
  });

  it("FAILED reads as not in force and the storage callout asks for review", async () => {
    const r = await render("FAILED");
    for (const v of rowValue(r.vm, "Immutable Storage")) expect(v).toBe(STORAGE_PROTECTION_VERIFICATION_LABELS.FAILED);
    expect(r.json).toContain("Storage protection requires review");
  });
});
