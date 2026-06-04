/**
 * Wave 5 — Worker → API internal extract callback (source-contract).
 *
 * The Wave 4 implementation introduced two worker branches
 * (extract_ocr_azure / extract_transcript_deepgram) that reached into
 * the API source tree via cross-package dynamic imports of
 * `../../api/src/services/intelligence/...`. That broke the worker
 * Docker build because the image deliberately omits services/api/src.
 *
 * Wave 5 replaces those cross-imports with an HTTP callback:
 *
 *   worker  →  POST /v1/internal/media-intelligence/extract
 *               (X-Internal-Service-Token bearer)
 *           ←  { success, partsProcessed, recordsCreated,
 *                extractedTextChars, error? }
 *
 * This file is a source-contract test (regex against file text). It
 * does NOT boot the worker, hit Redis, or call the API. The goal is
 * to lock the wiring so a future refactor cannot silently re-introduce
 * a cross-import or weaken the auth shape.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

function readWorker(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../worker/${rel}`, import.meta.url)),
    "utf8",
  );
}

describe("Wave 5 — worker bundle no longer cross-imports api/src", () => {
  const processor = readWorker("src/media-intelligence.processor.ts");

  it("has ZERO active `import(\"../../api/src/...\")` calls", () => {
    // Catches both static and dynamic-import forms. Comment lines
    // (lines starting with whitespace + //) are tolerated so the
    // file can keep historical references in comments.
    const lines = processor.split("\n");
    const violating = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
      return /["']\.\.\/\.\.\/api\/src\//.test(line);
    });
    expect(violating).toEqual([]);
  });

  it("does NOT contain the old extraction.service.js cross-import string", () => {
    // Same guard as above but anchored to the specific file path the
    // bug verification flagged. Even a single re-introduction breaks
    // the Docker image.
    const lines = processor.split("\n");
    const violating = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
      return /extraction\.service\.js/.test(line);
    });
    expect(violating).toEqual([]);
  });

  it("imports the new internal-api-client helper", () => {
    expect(processor).toMatch(
      /from\s+["']\.\/internal-api-client(?:\.js)?["']/,
    );
    expect(processor).toMatch(/callInternalMediaIntelligenceExtract/);
  });
});

describe("Wave 5 — worker internal-api-client.ts", () => {
  const client = readWorker("src/internal-api-client.ts");

  it("reads INTERNAL_API_URL (or fallback) from process.env", () => {
    expect(client).toMatch(/process\.env\.INTERNAL_API_URL/);
  });

  it("reads INTERNAL_SERVICE_TOKEN from process.env", () => {
    expect(client).toMatch(/process\.env\.INTERNAL_SERVICE_TOKEN/);
  });

  it("sends X-Internal-Service-Token header (lower-case canonical)", () => {
    expect(client).toMatch(/x-internal-service-token/);
  });

  it("uses AbortController for a bounded timeout", () => {
    expect(client).toMatch(/AbortController/);
    expect(client).toMatch(/controller\.abort\(\)/);
    expect(client).toMatch(/signal:\s*controller\.signal/);
  });

  it("posts to /v1/internal/media-intelligence/extract", () => {
    expect(client).toMatch(/\/v1\/internal\/media-intelligence\/extract/);
  });

  it("uses POST + json content-type", () => {
    expect(client).toMatch(/method:\s*["']POST["']/);
    expect(client).toMatch(/content-type/i);
  });

  it("THROWS on 5xx for BullMQ backoff (does NOT swallow)", () => {
    // 5xx branch throws; this regex finds the throw inside the
    // response.status >= 500 guard.
    expect(client).toMatch(/status\s*>=\s*500[\s\S]{0,200}throw/);
  });

  it("returns { success: false } on 4xx (does NOT throw)", () => {
    // 4xx branch returns a structured failure shape.
    expect(client).toMatch(/status\s*>=\s*400[\s\S]{0,400}success:\s*false/);
  });

  it("NEVER logs the raw token value", () => {
    // No log line should reference the token variable name as a logged
    // field. We allow it in the header object only.
    const lines = client.split("\n");
    const bad = lines.filter((line) => {
      // Capture log lines that include the literal substring `token`
      // as a key (anything like `token:`, `token,` outside a header)
      if (!/logger\.\w+/.test(line)) return false;
      return /\btoken\b/.test(line);
    });
    expect(bad).toEqual([]);
  });
});

describe("Wave 5 — new API internal route registered", () => {
  const server = readApi("src/server.ts");
  const route = readApi(
    "src/routes/internal-media-intelligence-extract.routes.ts",
  );

  it("server.ts imports internalMediaIntelligenceExtractRoutes", () => {
    expect(server).toMatch(/internalMediaIntelligenceExtractRoutes/);
  });

  it("server.ts registers the route via app.register", () => {
    expect(server).toMatch(
      /app\.register\(internalMediaIntelligenceExtractRoutes\)/,
    );
  });

  it("route declares POST /v1/internal/media-intelligence/extract", () => {
    expect(route).toMatch(/\/v1\/internal\/media-intelligence\/extract/);
    expect(route).toMatch(/app\.post\s*\(/);
  });

  it("route uses requireInternalServiceAuth pre-handler", () => {
    expect(route).toMatch(/requireInternalServiceAuth/);
  });

  it("route body schema bounds kind to ocr_azure | transcript_deepgram", () => {
    expect(route).toMatch(
      /z\.enum\(\[\s*["']ocr_azure["']\s*,\s*["']transcript_deepgram["']\s*\]\)/,
    );
  });

  it("route delegates to runProviderOperation + runExtractionInline", () => {
    expect(route).toMatch(
      /from\s+["'][^"']*media-intelligence\.service(?:\.js)?["']/,
    );
    expect(route).toMatch(/runProviderOperation\(/);
    expect(route).toMatch(
      /from\s+["'][^"']*extraction\.service(?:\.js)?["']/,
    );
    expect(route).toMatch(/runExtractionInline\(/);
  });

  it("response shape NEVER returns raw extracted text", () => {
    // Defensive: search for any `extractedText:` key in a response
    // send. Only `extractedTextChars` (a count) is allowed.
    const sendMatches = route.match(/reply\.code\(200\)\.send\(\{[\s\S]*?\}\)/g) ?? [];
    for (const sendBlock of sendMatches) {
      expect(sendBlock).not.toMatch(/\bextractedText\s*:/);
    }
    expect(route).toMatch(/extractedTextChars/);
  });

  it("route bounds error preview to <= 240 chars", () => {
    expect(route).toMatch(/ERROR_PREVIEW_MAX_CHARS\s*=\s*240/);
  });

  it("route maps thrown provider errors to bounded error (never raw stack)", () => {
    // The boundedError helper is the single coercion point.
    expect(route).toMatch(/function\s+boundedError/);
    // And it slices to the bound (no raw .stack returns).
    expect(route).not.toMatch(/\.stack\b/);
  });
});

describe("Wave 5 — internal-service-auth middleware", () => {
  const mw = readApi("src/middleware/internal-service-auth.ts");

  it("reads INTERNAL_SERVICE_TOKEN env var (>= 16 chars guard)", () => {
    expect(mw).toMatch(/INTERNAL_SERVICE_TOKEN/);
    expect(mw).toMatch(/length\s*>=\s*16/);
  });

  it("uses constant-time comparison (timingSafeEqual)", () => {
    expect(mw).toMatch(/timingSafeEqual/);
    expect(mw).toMatch(/createHmac/);
  });

  it("returns 503 fail-closed in production when token unset", () => {
    expect(mw).toMatch(/503/);
    expect(mw).toMatch(/CONFIGURATION_ERROR/);
  });

  it("returns 401 on mismatch", () => {
    expect(mw).toMatch(/401/);
    expect(mw).toMatch(/UNAUTHORIZED/);
  });

  it("reads header X-Internal-Service-Token (lower-case canonical)", () => {
    expect(mw).toMatch(/x-internal-service-token/);
  });
});

describe("Wave 5 — worker branches use the helper and never throw on body.success===false", () => {
  const processor = readWorker("src/media-intelligence.processor.ts");

  it("OCR branch calls callInternalMediaIntelligenceExtract with kind: 'ocr_azure'", () => {
    // The OCR branch invokes the helper with the kind literal. We
    // permit the formatter to put the key on the same or a different
    // line by collapsing whitespace.
    const collapsed = processor.replace(/\s+/g, " ");
    expect(collapsed).toMatch(
      /callInternalMediaIntelligenceExtract\(\s*\{[^}]*kind:\s*["']ocr_azure["']/,
    );
  });

  it("Transcript branch calls helper with kind: 'transcript_deepgram'", () => {
    const collapsed = processor.replace(/\s+/g, " ");
    expect(collapsed).toMatch(
      /callInternalMediaIntelligenceExtract\(\s*\{[^}]*kind:\s*["']transcript_deepgram["']/,
    );
  });

  it("OCR branch enqueues search-indexing on success", () => {
    expect(processor).toMatch(
      /reason:\s*["']ocr_extracted["']/,
    );
  });

  it("Transcript branch enqueues search-indexing on success", () => {
    expect(processor).toMatch(
      /reason:\s*["']transcript_extracted["']/,
    );
  });

  it("Both branches mark the run FAILED (no retry) on body.success === false", () => {
    // The post-call branch reads `result.success` and calls
    // markRunFailed in the failure path.
    expect(processor).toMatch(/if\s*\(\s*result\.success\s*\)/);
    expect(processor).toMatch(/markRunFailed\(/);
  });

  it("Both branches return ok: true (never throw to BullMQ on permanent failure)", () => {
    // The processor returns { ok: true, signalsEmitted: 0 } at the
    // permanent-failure return site — pinned by the comment + return shape.
    expect(processor).toMatch(/signalsEmitted:\s*0\s*\}/);
  });
});

describe("Wave 5 — deferral note for archive-tier-auto-transition.worker", () => {
  // Verification flagged services/worker/src/governance/archive-tier-auto-transition.worker.ts:105
  // as another cross-import, but it is shielded by `.catch(() => null)`
  // and a fallback PENDING-row writer. It is deferred per the
  // recommendation; this test acts as a tripwire so the deferral is
  // visible and the file is not assumed clean.
  const arch = readWorker(
    "src/governance/archive-tier-auto-transition.worker.ts",
  );

  it("still contains the deferred cross-import (out of scope this PR)", () => {
    expect(arch).toMatch(/api\/src\/services\/lifecycle\/archive-tier\.service/);
  });

  it("the cross-import is shielded by .catch(() => null) so it cannot crash the worker", () => {
    expect(arch).toMatch(/\.catch\(\s*\(\)\s*=>\s*null\s*\)/);
  });
});
