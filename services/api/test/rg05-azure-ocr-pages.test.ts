/**
 * PRO-AI1C-02 — Azure OCR usage is the page count Azure ANALYSED (its billed
 * unit), not a guess from the length of the recognised text. At the base SHA
 * a 12-page scanned PDF with little text was recorded as 1 page.
 */
import { describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ result: null as unknown }));

vi.mock("../src/services/redaction/providers/azure-document-intelligence-client.js", () => ({
  analyzeDocumentLayout: async () => H.result,
  probeAzureDocumentIntelligence: () => ({ state: "READY", reason: null }),
}));

import { azureDocumentIntelligenceAdapter } from "../src/services/intelligence/providers/azure-document-intelligence-adapter.js";

describe("PRO-AI1C-02 — Azure OCR bills analysed pages", () => {
  it("a 12-page scan with little text records 12 PAGE units", async () => {
    H.result = { state: "READY", reason: null, rows: [], extractedText: "Page 1 stamp", analyzedPages: 12 };
    const out = await azureDocumentIntelligenceAdapter.ocrDocument!({ bytes: new Uint8Array([1]), url: null, contentType: "application/pdf" } as never);
    expect(out.ok).toBe(true);
    expect(out.usage).toMatchObject({ unit: "PAGE", units: 12, estimatedCostUsdMicros: 12 * 1500 });
  });

  it("falls back to the text heuristic only when the page list is absent", async () => {
    H.result = { state: "READY", reason: null, rows: [], extractedText: "x".repeat(12_000) };
    const out = await azureDocumentIntelligenceAdapter.ocrDocument!({ bytes: new Uint8Array([1]), url: null, contentType: "application/pdf" } as never);
    expect(out.usage).toMatchObject({ units: 3 });
  });
});
