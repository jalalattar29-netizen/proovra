/**
 * Phase 15 — Intelligence API tests.
 *
 *   - AI assistance wrapper rejects forbidden phrases + injects
 *     disclaimer + safe-refuses when not configured
 *   - Extraction service no-op fallback marks SKIPPED with
 *     `no_provider_configured`
 *   - Search service excludes non-PUBLISHED rows when scope =
 *     publishable (source-level check)
 *   - Routes use 404 (not 403) for non-members (anti-enumeration
 *     consistent with prior phases)
 *   - Extracted text summary projection NEVER includes raw `text`
 *
 * No DB needed for any of these — service / source-text contract
 * tests.
 */

import { describe, expect, it } from "vitest";

// Phase P2 — ai-assistance wrapper tests removed with the retired stub.
import { projectExtractedTextSummary } from "../src/services/intelligence/extraction.service.js";

describe("extracted text projection — privacy", () => {
  it("summary projection does NOT include the raw text body", () => {
    const projected = projectExtractedTextSummary({
      id: "11111111-1111-4111-8111-111111111111",
      evidenceId: "22222222-2222-4222-8222-222222222222",
      teamId: "33333333-3333-4333-8333-333333333333",
      kind: "OCR_PDF" as never,
      status: "COMPLETED" as never,
      provider: "tesseract",
      providerVersion: "5.3.0",
      language: "en",
      text: "SHOULD NEVER LEAK IN SUMMARY PROJECTION",
      confidence: 0.92,
      wordCount: 80,
      durationMs: 1200,
      errorMessage: null,
      extractedAtUtc: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const json = JSON.stringify(projected);
    expect(json).not.toContain("SHOULD NEVER LEAK");
    expect((projected as Record<string, unknown>).text).toBeUndefined();
    expect(projected.disclaimer).toMatch(/advisory/i);
  });
});

describe("search service — source-level governance scope", () => {
  it("publishable scope adds publicVerifyState = PUBLISHED to the WHERE clause", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/intelligence/search.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/publicVerifyState:\s*"PUBLISHED"/);
    expect(src).toMatch(/deletedAt:\s*null/);
  });

  it("re-fetch path for text/entity hits also runs through baseWhere", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/intelligence/search.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The extras lookup re-applies baseWhere so workspace + publication
    // scope filter to OCR / entity hits too.
    expect(src).toMatch(/id:\s*\{\s*in:\s*Array\.from\(extraIds\)\s*\},\s*\.\.\.baseWhere/);
  });
});

describe("intelligence routes — anti-enumeration + scope", () => {
  it("never responds 403 for non-members", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/intelligence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/reply\.code\(403\)/);
    expect(src).toMatch(/reply\.code\(404\)/);
  });

  it("AI-assist + enqueue + reconcile require reviewer membership", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/intelligence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // Find the three reviewer-required routes by anchoring on
    // requireReviewerMember invocations next to the route path.
    const matches = src.match(/requireReviewerMember/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("workspace scope is enforced before any per-evidence read", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/intelligence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/ev\.teamId\s*!==\s*(?:body|query)\.teamId/);
  });
});

describe("similarity service — wording contract", () => {
  it("upsert path uses the canonical similaritySummaryFor (advisory wording)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/intelligence/similarity.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/similaritySummaryFor\(/);
    // No raw "duplicate confirmed" wording in the service.
    expect(src).not.toMatch(/duplicate\s+confirmed/i);
    expect(src).not.toMatch(/authentic/i);
  });

  it("never auto-merges or deletes — no destructive ops in service", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/intelligence/similarity.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/evidence\.delete\(/);
    expect(src).not.toMatch(/evidence\.deleteMany\(/);
    expect(src).not.toMatch(/evidence\.update\(/);
    expect(src).not.toMatch(/evidence\.updateMany\(/);
  });
});

// Phase P7 — legacy searchSemantic tests removed with the seam.

describe("extraction service — provider abstraction", () => {
  it("no-op providers are the default when env is unset", async () => {
    const prevOcr = process.env.OCR_PROVIDER;
    const prevTranscript = process.env.TRANSCRIPT_PROVIDER;
    delete process.env.OCR_PROVIDER;
    delete process.env.TRANSCRIPT_PROVIDER;
    try {
      const {
        configuredOcrProviderName,
        configuredTranscriptProviderName,
      } = await import(
        "../src/services/intelligence/extraction.service.js"
      );
      expect(configuredOcrProviderName()).toBe("noop");
      expect(configuredTranscriptProviderName()).toBe("noop");
    } finally {
      if (prevOcr === undefined) delete process.env.OCR_PROVIDER;
      else process.env.OCR_PROVIDER = prevOcr;
      if (prevTranscript === undefined)
        delete process.env.TRANSCRIPT_PROVIDER;
      else process.env.TRANSCRIPT_PROVIDER = prevTranscript;
    }
  });
});
