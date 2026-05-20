/**
 * Phase 31.11 — Report caller-wiring contracts.
 *
 * Source-contract + behaviour tests for the two-layer wiring that
 * makes the report-v2 "Media Intelligence Observations" section
 * actually appear in generated PDFs:
 *
 *   1. `services/api/src/services/media-intelligence/report-projection.service.ts`
 *      — the canonical projection that reads from the DB.
 *   2. `services/worker/src/media-intelligence-report-bridge.ts`
 *      — the worker-side lazy-import + try/catch isolation that the
 *      processor calls.
 *   3. `services/worker/src/processor.ts` — the two call sites
 *      where `buildReportPdfV2` is invoked.
 *
 * Layers covered:
 *
 *   * Empty teamId / evidenceId → null (refusal at entry).
 *   * Bounded result types (no leak of internal columns).
 *   * DISMISSED signals filtered out (operator dismissed for a
 *     reason; the PDF should not surface them).
 *   * Severity sort: ATTENTION first, then REVIEW_RECOMMENDED,
 *     then INFO; newest first within a tier.
 *   * Material filename sanitised + length-bounded.
 *   * Bounded LIMIT in SQL (DoS prevention).
 *   * Anti-leak invariants in projection source.
 *   * No forbidden vocabulary in projection source literals.
 *   * Bridge: lazy-imports projection, never throws, returns null
 *     on import failure, uses canonical prisma from db.js.
 *   * Processor wiring: BOTH call sites pass mediaIntelligence
 *     through ReportBuildParams; ReportBuildParams type includes
 *     the field; the field is OPTIONAL (legacy callers OK).
 *   * Behaviour: projectMediaIntelligenceForReport returns null on
 *     malformed/empty input, returns shaped result on valid input.
 *
 * The actual SQL execution is exercised by the worker test that
 * builds a full report VM — this file focuses on the contracts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  projectMediaIntelligenceForReport,
  type ProjectedSignal,
} from "../src/services/media-intelligence/report-projection.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Refusal at entry
// =============================================================================

describe("Phase 31.11 — projectMediaIntelligenceForReport: refusal at entry", () => {
  it("returns null when teamId is empty", async () => {
    const r = await projectMediaIntelligenceForReport({
      teamId: "",
      evidenceId: "00000000-0000-0000-0000-000000000001",
    });
    expect(r).toBeNull();
  });

  it("returns null when evidenceId is empty", async () => {
    const r = await projectMediaIntelligenceForReport({
      teamId: "00000000-0000-0000-0000-000000000001",
      evidenceId: "",
    });
    expect(r).toBeNull();
  });

  it("returns null when both are empty", async () => {
    const r = await projectMediaIntelligenceForReport({
      teamId: "",
      evidenceId: "",
    });
    expect(r).toBeNull();
  });
});

// =============================================================================
// PART 2 — Projection source contract
// =============================================================================

describe("Phase 31.11 — projection source contract", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/media-intelligence/report-projection.service.ts",
  );

  it("declared to never throw — try/catch returns null on error", () => {
    expect(src).toMatch(/try\s*\{[\s\S]*?\}\s*catch\s*\{[\s\S]*?return\s+null/);
  });

  it("DISMISSED signals filtered out at the SQL layer (legal distribution invariant)", () => {
    expect(src).toMatch(
      /s\."status" IN \('PENDING','ACKNOWLEDGED'\)/,
    );
    expect(src).not.toMatch(/s\."status" IN \([^)]*'DISMISSED'/);
  });

  it("severity-ordered SQL: ATTENTION → REVIEW_RECOMMENDED → INFO", () => {
    expect(src).toMatch(
      /CASE s\."severity"[\s\S]*?WHEN 'ATTENTION' THEN 0[\s\S]*?WHEN 'REVIEW_RECOMMENDED' THEN 1[\s\S]*?ELSE 2/,
    );
  });

  it("bounded LIMIT (no unbounded result set)", () => {
    expect(src).toMatch(/LIMIT \$\{MAX_SIGNALS_PROJECTED\}/);
    expect(src).toMatch(/MAX_SIGNALS_PROJECTED\s*=\s*\d+/);
  });

  it("material label sanitised — charset + bounded length", () => {
    const fn = src.match(/function sanitizeMaterialLabel[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    // Charset narrow enough to refuse HTML / shell injection: only
    // \w (letters/digits/underscore), whitespace, dash, dot, slash,
    // parentheses. The charset literal lives in a JS regex so the
    // source contains `\\w` etc. — assert presence of the safe-set
    // markers rather than a full regex match.
    expect(fn!).toContain("\\w");
    expect(fn!).toContain("\\s");
    expect(fn!).toMatch(/\.test\(trimmed\)/);
    expect(fn!).toMatch(/slice\(0,\s*MAX_MATERIAL_LABEL_CHARS\)/);
  });

  it("safe summary bounded to 240 chars (matches renderer cap)", () => {
    expect(src).toMatch(/MAX_SAFE_SUMMARY_CHARS\s*=\s*240/);
    expect(src).toMatch(/safe_summary\.slice\(0,\s*MAX_SAFE_SUMMARY_CHARS\)/);
  });

  it("unknown severity / confidence / status fold to null (defence in depth)", () => {
    expect(src).toMatch(/ALLOWED_SEVERITIES\.has\(/);
    expect(src).toMatch(/ALLOWED_CONFIDENCES\.has\(/);
    expect(src).toMatch(/ALLOWED_STATUSES\.has\(/);
    expect(src).toMatch(/if\s*\([^)]*\)\s*\{\s*return\s+null/);
  });

  it("no storage internals / signed URLs / private notes referenced", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageKey",
      "storage_key",
      "storageBucket",
      "storage_bucket",
      "multipartUploadId",
      "multipart_upload_id",
      "signedUrl",
      "signed_url",
      "presignedUrl",
      "rawGps",
      "raw_gps",
      "privateNote",
      "private_note",
      "legalNote",
      "legalNoteBody",
      "acknowledged_by_user_id",
    ]) {
      expect(noComments, `projection leaks ${banned}`).not.toContain(banned);
    }
  });

  it("no forbidden truth-claim vocabulary in any source literal", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(
        lit,
        `projection uses forbidden wording: ${lit}`,
      ).not.toMatch(forbidden);
    }
  });

  it("OCR/transcript subprojection still returns empty (deferred); derivedThumbnails now populated via Phase 31.14 helper", () => {
    // Phase 31.11 shipped signals only. Phase 31.14 wires derived
    // thumbnails through `loadDerivedThumbnailsForReport`. OCR /
    // transcript subprojection remains empty until that pipeline
    // ships — the renderer's subsection guard returns "" for the
    // empty array, so the report emits zero extra HTML there.
    expect(src).toMatch(/ocrTranscript:\s*\[\]/);
    expect(src).toMatch(/derivedThumbnails,\s*\n/);
    expect(src).toMatch(/async function loadDerivedThumbnailsForReport/);
  });
});

// =============================================================================
// PART 3 — Result types are bounded (compile-time guard)
// =============================================================================

describe("Phase 31.11 — bounded result types", () => {
  it("ProjectedSignal carries ONLY the bounded report-side fields", () => {
    // Compile-time guard via a sample object that must satisfy the
    // type without any extra keys.
    const sample: ProjectedSignal = {
      id: "x",
      signalType: "EXIF_MISSING",
      materialId: null,
      materialLabel: null,
      severity: "INFO",
      confidence: "MEDIUM",
      safeSummary: "x",
      status: "PENDING",
      createdAtUtc: "2026-05-20T00:00:00.000Z",
    };
    expect(sample.id).toBe("x");
    // Excess-property check: the spread below would be a TS error if
    // ProjectedSignal accepted arbitrary fields. We assert at
    // runtime that no unexpected keys are present.
    const allowed = new Set([
      "id",
      "signalType",
      "materialId",
      "materialLabel",
      "severity",
      "confidence",
      "safeSummary",
      "status",
      "createdAtUtc",
    ]);
    for (const k of Object.keys(sample)) {
      expect(allowed.has(k), `unexpected key on ProjectedSignal: ${k}`).toBe(
        true,
      );
    }
  });
});

// =============================================================================
// PART 4 — Worker bridge source contract
// =============================================================================

describe("Phase 31.11 — worker report bridge", () => {
  const src = readSource(
    "../../../services/worker/src/media-intelligence-report-bridge.ts",
  );

  it("imports the canonical prisma from db.js (no bare new PrismaClient)", () => {
    expect(src).toMatch(/import\s*\{\s*prisma\s*\}\s*from\s*"\.\/db\.js"/);
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/new\s+PrismaClient\s*\(/);
  });

  it("returns null when teamId is missing (anti-enumeration)", () => {
    expect(src).toMatch(/if\s*\(!input\.teamId\)\s*\{\s*return\s+null/);
  });

  it("lazy-imports the projection service via @proovra/shared-runtime (Phase 31.22 boundary fix)", () => {
    expect(src).toMatch(
      /await import\(\s*"@proovra\/shared-runtime\/media-intelligence"/,
    );
  });

  it("never throws — try/catch around the entire projection call returns null on failure", () => {
    expect(src).toMatch(
      /try\s*\{[\s\S]*?\}\s*catch \(err\)[\s\S]*?return\s+null/,
    );
  });

  it("bounded log line on failure (no stack traces / no storage internals)", () => {
    const fn = src.match(/catch \(err\)\s*\{[\s\S]*?return\s+null;\s*\}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/err\.message\.slice\(0,\s*80\)/);
    expect(fn!).not.toMatch(/storage_(key|bucket)/);
    expect(fn!).not.toMatch(/signed_?[Uu]rl/);
  });

  it("passes worker's prisma explicitly to the projection (so the api default isn't used)", () => {
    // Allow a trailing comma on the prisma arg + flexible whitespace.
    expect(src).toMatch(
      /projectMediaIntelligenceForReport\(\s*\{[\s\S]*?\},\s*prisma,?\s*\)/,
    );
  });
});

// =============================================================================
// PART 5 — Processor wiring source contract
// =============================================================================

describe("Phase 31.11 — processor wiring", () => {
  const src = readSource("../../../services/worker/src/processor.ts");

  it("imports buildReportMediaIntelligence from the worker bridge", () => {
    expect(src).toMatch(
      /import\s*\{\s*buildReportMediaIntelligence\s*\}\s*from\s*"\.\/media-intelligence-report-bridge\.js"/,
    );
  });

  it("ReportBuildParams type carries OPTIONAL mediaIntelligence field (legacy callers unaffected)", () => {
    expect(src).toMatch(
      /mediaIntelligence\?:\s*Parameters<typeof buildReportPdfV2>\[0\]\["mediaIntelligence"\]/,
    );
  });

  it("BOTH buildReportPdfV2 call sites attach mediaIntelligence", () => {
    const calls = src.match(/buildReportPdfV2\(/g) ?? [];
    expect(calls.length).toBe(2);
    // Both call-site blocks reference buildReportMediaIntelligence
    // immediately before their buildReportPdfV2 invocation.
    const occurrences =
      src.match(/buildReportMediaIntelligence\(/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("projection runs against evidence.teamId — anti-enumeration", () => {
    expect(src).toMatch(
      /buildReportMediaIntelligence\(\s*\{[\s\S]*?teamId:\s*evidence\.teamId\s*\?\?\s*null/,
    );
  });

  it("projection result attached as `mediaIntelligence:` on the ReportBuildParams payload", () => {
    // The provisional-report path uses a `reportBuildParams` const,
    // the finalized-report path inlines the object literal. Both
    // must carry the field.
    expect(src).toMatch(
      /mediaIntelligence:\s*reportMediaIntelligence/,
    );
    expect(src).toMatch(
      /mediaIntelligence:\s*finalizedReportMediaIntelligence/,
    );
  });
});

// =============================================================================
// PART 6 — Behaviour: projection never throws on invalid input
// =============================================================================

describe("Phase 31.11 — projection never throws", () => {
  it("returns null when given garbage uuids (Prisma may throw)", async () => {
    // The projection wraps the query in try/catch and returns null
    // on any failure — including Prisma's "invalid UUID syntax"
    // throws when the input doesn't conform to UUID format.
    const r = await projectMediaIntelligenceForReport({
      teamId: "not-a-uuid",
      evidenceId: "also-not-a-uuid",
    });
    expect(r).toBeNull();
  });
});
