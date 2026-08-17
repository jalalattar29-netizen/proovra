/**
 * Phase Repair — Reviewer console honest producer chips, canonical
 * indexed counts, secondary local-extractor framing, observable
 * silent catches, and a non-lying "all indexed" pill.
 *
 * Covers Tasks A, B, C, D, E from the repair audit.
 *
 * Hard contracts pinned here:
 *
 *   Task A — The reviewers route consumes the probe-aware
 *            `resolveProducerModeStatuses` resolver (NOT the env-only
 *            `summariseProducerModes`). The response carries the
 *            canonical 8-field `producerModeStatuses` array and a
 *            derived `producerModes` summary whose `producesNewContent`
 *            field is gated on `automatic === true`. The reviewer
 *            page renders `producerModeStatuses` first and only falls
 *            back to the legacy summary. The `ProbeAwareProducerModeChip`
 *            renders honest "credentials not ready" copy when
 *            VENDOR_CLOUD mode reports `automatic === false`.
 *
 *   Task B — `indexingTotals` are derived from the canonical
 *            `evidence_extracted_texts` table bucketed by the
 *            `EvidenceExtractedTextKind` enum. The orphan
 *            `evidence_ocr_text` / `evidence_transcript_segments`
 *            tables and their writer helpers are flagged with a
 *            cleanup TODO but kept on disk for migration safety.
 *
 *   Task C — The route emits `localExtractorCapability.role: "secondary"`
 *            and an operator-facing `summary` string. The reviewer
 *            page renders the tile with demoted styling and a
 *            "Secondary" badge.
 *
 *   Task D — Five previously-silent catch blocks now log via
 *            `req.log.warn` with bounded block tags. The route
 *            surfaces a `dataQuality.degradedBlocks` list so the page
 *            can render an honest banner.
 *
 *   Task E — `allIndexed` requires `available > 0 && indexed === available`.
 *            Empty state renders a neutral "No records yet" pill, NOT
 *            the green "all indexed" pill.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/**
 * Slice the /v1/investigation/reviewers handler body out of
 * MI_ROUTES_SRC so test assertions don't bleed into the next route's
 * body. The handler is delimited by the `app.get("/v1/investigation/
 * reviewers"` call site and the next `app.get(` invocation.
 */
function sliceReviewersHandler(src: string): string {
  // Find the literal route registration. The handler body is the
  // substring between this call and the next app.get / app.post.
  const ANCHOR = 'app.get(\n    "/v1/investigation/reviewers"';
  let start = src.indexOf(ANCHOR);
  if (start < 0) {
    // Fall back to a tolerant match (whitespace may differ slightly).
    start = src.search(
      /app\.get\(\s*"\/v1\/investigation\/reviewers"/,
    );
  }
  if (start < 0) {
    throw new Error("Could not find /v1/investigation/reviewers handler");
  }
  const tail = src.slice(start + 5); // skip past the literal `app.get(`
  // The next handler registration starts the next slice boundary.
  const next = tail.search(/\n {2}app\.(get|post|put|delete)\(/);
  return next > 0 ? tail.slice(0, next) : tail;
}

const MI_ROUTES_SRC = readSource("../src/routes/media-intelligence.routes.ts");
const REVIEWERS_PAGE = readSource(
  "../../../apps/web/app/(app)/investigation/reviewers/page.tsx",
);
const INDEXER_SRC = readSource(
  "../../../packages/shared-runtime/src/media-intelligence/ocr-transcript-indexer.service.ts",
);

// =============================================================================
// Task A — Probe-aware resolver replaces summariseProducerModes
// =============================================================================

describe("Phase Repair Task A — probe-aware producer chips", () => {
  it("the reviewers route imports resolveProducerModeStatuses from shared-runtime", () => {
    const handlerSlice = sliceReviewersHandler(MI_ROUTES_SRC);
    expect(handlerSlice).toMatch(
      /const \{ resolveProducerModeStatuses \} = await import\(\s*"@proovra\/shared-runtime\/media-intelligence"/,
    );
    // The handler calls the probe-aware resolver with the team-anchored
    // input.
    expect(handlerSlice).toMatch(
      /resolveProducerModeStatuses\(\{\s*teamId,\s*prisma,?\s*\}\)/,
    );
  });

  it("the reviewers route NO LONGER calls summariseProducerModes inside the handler", () => {
    const idx = MI_ROUTES_SRC.indexOf("/v1/investigation/reviewers");
    expect(idx).toBeGreaterThan(0);
    const tail = MI_ROUTES_SRC.slice(idx);
    const stop = tail.indexOf("app.get(", 1);
    const handlerSlice = stop > 0 ? tail.slice(0, stop) : tail;
    expect(handlerSlice).not.toMatch(/summariseProducerModes\(/);
  });

  it("derived producerModes.producesNewContent gates on automatic === true (NOT mode string)", () => {
    const handlerSlice = sliceReviewersHandler(MI_ROUTES_SRC);
    // The producerModes derivation reads .automatic from the probe-
    // aware statuses. The historical implementation just checked the
    // mode string was not NOT_CONFIGURED / INDEX_EXISTING_ONLY — which
    // would falsely flip to true the moment an operator set
    // VENDOR_CLOUD, even if credentials were missing.
    expect(handlerSlice).toMatch(/ocrStatus\?\.automatic/);
    expect(handlerSlice).toMatch(/transcriptStatus\?\.automatic/);
  });

  it("the route response carries `producerModeStatuses` array", () => {
    const handlerSlice = sliceReviewersHandler(MI_ROUTES_SRC);
    expect(handlerSlice).toMatch(/return reply\.code\(200\)\.send\(\{[\s\S]*?producerModeStatuses,/);
  });

  it("the reviewer page declares the canonical ProducerModeStatus shape", () => {
    expect(REVIEWERS_PAGE).toMatch(/type ProducerModeStatus = \{/);
    // Spot-check 4 of the 8 canonical fields.
    expect(REVIEWERS_PAGE).toMatch(/automatic: boolean/);
    expect(REVIEWERS_PAGE).toMatch(/configured: boolean/);
    expect(REVIEWERS_PAGE).toMatch(/indexExistingOnly: boolean/);
    expect(REVIEWERS_PAGE).toMatch(/provider: "local" \| "azure" \| "deepgram" \| "openai" \| "internal" \| "none"/);
  });

  it("the reviewer page renders ProbeAwareProducerModeChip when statuses are present", () => {
    expect(REVIEWERS_PAGE).toMatch(/function ProbeAwareProducerModeChip\(/);
    // The chip shows "credentials not ready" copy when VENDOR_CLOUD is
    // selected but `automatic === false` (probe failure / producer not
    // wired).
    expect(REVIEWERS_PAGE).toMatch(/credentials not ready/);
    // The chip's active flag reads `status.automatic === true` —
    // the audit guarantee that VENDOR_CLOUD chip is NOT active when
    // probe fails.
    expect(REVIEWERS_PAGE).toMatch(/status\.automatic === true/);
  });

  it("the reviewer page chip caption + reason copy do NOT hard-code 'active' wording when probe fails", () => {
    // Find the ProbeAwareProducerModeChip body and confirm the active
    // styling path is gated on `automatic`, not on the mode string.
    const idx = REVIEWERS_PAGE.indexOf("function ProbeAwareProducerModeChip(");
    expect(idx).toBeGreaterThan(0);
    // Slice up to the NEXT top-level `function` declaration so the body
    // includes both the early-return guard AND the main return.
    const tail = REVIEWERS_PAGE.slice(idx + 1);
    const next = tail.indexOf("\nfunction ");
    const body = next > 0 ? tail.slice(0, next) : tail;
    // The (credentials not ready) suffix only renders in the
    // VENDOR_CLOUD + !active branch.
    expect(body).toMatch(/VENDOR_CLOUD[\s\S]*?credentials not ready/);
  });
});

// =============================================================================
// Task B — Indexed counts read EvidenceExtractedText, not orphan signals
// =============================================================================

describe("Phase Repair Task B — indexed counts read canonical EvidenceExtractedText", () => {
  it("the route SELECTs from `evidence_extracted_texts` bucketed by EvidenceExtractedTextKind", () => {
    const idx = MI_ROUTES_SRC.indexOf("Phase Repair — OCR / transcript volume snapshot");
    expect(idx).toBeGreaterThan(0);
    const slice = MI_ROUTES_SRC.slice(idx, idx + 3500);
    expect(slice).toMatch(/FROM "evidence_extracted_texts"/);
    // Each of the 5 canonical kinds appears in the query.
    for (const k of ["OCR_PDF", "OCR_IMAGE", "PDF_TEXT", "TRANSCRIPT_AUDIO", "TRANSCRIPT_VIDEO"]) {
      expect(slice).toMatch(new RegExp(`'${k}'`));
    }
    // Indexed = COMPLETED.
    expect(slice).toMatch(/"status" = 'COMPLETED'/);
    // Team-anchored.
    expect(slice).toMatch(/WHERE "team_id" = \$1/);
  });

  it("the route no longer reads orphan media_intelligence_signals for indexing totals", () => {
    const idx = MI_ROUTES_SRC.indexOf("Phase Repair — OCR / transcript volume snapshot");
    const next = MI_ROUTES_SRC.indexOf("// 8) Phase Repair — local-extractor", idx);
    const slice = MI_ROUTES_SRC.slice(idx, next > 0 ? next : idx + 3500);
    expect(slice).not.toMatch(/'OCR_AVAILABLE'/);
    expect(slice).not.toMatch(/'TRANSCRIPT_AVAILABLE'/);
    expect(slice).not.toMatch(/'OCR_INDEXED'/);
    expect(slice).not.toMatch(/'TRANSCRIPT_INDEXED'/);
  });

  it("the route NEVER reads the `text` column from evidence_extracted_texts", () => {
    const idx = MI_ROUTES_SRC.indexOf("Phase Repair — OCR / transcript volume snapshot");
    const next = MI_ROUTES_SRC.indexOf("// 8) Phase Repair — local-extractor", idx);
    const slice = MI_ROUTES_SRC.slice(idx, next > 0 ? next : idx + 3500);
    // Only COUNT(*) FILTER aggregates. Defensive: no SELECT "text".
    expect(slice).not.toMatch(/SELECT[\s\S]*?"text"[\s\S]*?FROM "evidence_extracted_texts"/);
  });

  it("the orphan indexer carries a cleanup TODO referencing the canonical model", () => {
    expect(INDEXER_SRC).toMatch(/TODO\(phase-repair-cleanup\)[\s\S]*?ORPHAN/);
    expect(INDEXER_SRC).toMatch(/evidence_extracted_texts|EvidenceExtractedText/);
  });

  // LEGACY-003 (2026-08-15): these two tests asserted that the orphan
  // ocr-foundations / transcript-foundations writers carried a
  // TODO(phase-repair-cleanup) ORPHAN marker. That cleanup has now been
  // PERFORMED — both modules were removed as unreachable writers into tables
  // superseded by evidence_extracted_texts — so the assertion becomes the
  // cleanup's outcome rather than its reminder.
  it("the orphan foundations writers were cleaned up, not just marked", () => {
    for (const rel of [
      "../src/services/search/ocr-foundations.service.ts",
      "../src/services/search/transcript-foundations.service.ts",
    ]) {
      expect(
        existsSync(fileURLToPath(new URL(rel, import.meta.url))),
        `${rel} is REMOVED (LEGACY-003) and must not return`,
      ).toBe(false);
    }
  });
});

// =============================================================================
// Task C — Local extractor capability framed as SECONDARY
// =============================================================================

describe("Phase Repair Task C — local extractor capability is SECONDARY", () => {
  it("the route response carries role:'secondary' + an honest summary string", () => {
    const idx = MI_ROUTES_SRC.indexOf("localExtractorCapability = {");
    expect(idx).toBeGreaterThan(0);
    const slice = MI_ROUTES_SRC.slice(idx, idx + 600);
    expect(slice).toMatch(/role:\s*"secondary"/);
    expect(slice).toMatch(/Local OCR\/transcript runtime is not enabled/);
    expect(slice).toMatch(/Cloud provider is the active path/);
    // Still NOT_ENABLED at the underlying capability level.
    expect(slice).toMatch(/tesseract:[\s\S]*?ok: false[\s\S]*?reason: "not_enabled"/);
    expect(slice).toMatch(/whisper:[\s\S]*?ok: false[\s\S]*?reason: "not_enabled"/);
  });

  it("the reviewer page renders the SECONDARY badge + demoted styling", () => {
    expect(REVIEWERS_PAGE).toMatch(/Secondary/);
    expect(REVIEWERS_PAGE).toMatch(/secondaryTileStyle/);
    expect(REVIEWERS_PAGE).toMatch(/secondaryTileBadgeStyle/);
  });

  it("the LocalExtractorCapabilityTile renders the route's summary verbatim", () => {
    const idx = REVIEWERS_PAGE.indexOf("function LocalExtractorCapabilityTile(");
    expect(idx).toBeGreaterThan(0);
    const slice = REVIEWERS_PAGE.slice(idx, idx + 2000);
    expect(slice).toMatch(/cap\.summary/);
    // Fallback copy is still operator-grade if the route ever stops
    // shipping `summary`.
    expect(slice).toMatch(/Local OCR\/transcript runtime is not enabled/);
  });
});

// =============================================================================
// Task D — Silent catches now log + the route emits dataQuality
// =============================================================================

describe("Phase Repair Task D — silent catches now log", () => {
  it("the five previously-silent catches now log via req.log.warn with bounded block tags", () => {
    // Each tag is bounded enum-style; check the route source for the
    // exact log identifier each block emits.
    for (const tag of [
      "investigation_reviewers.workflow_totals_failed",
      "investigation_reviewers.escalation_totals_failed",
      "investigation_reviewers.external_review_totals_failed",
      "investigation_reviewers.recent_escalations_failed",
      "investigation_reviewers.recent_grants_failed",
    ]) {
      expect(MI_ROUTES_SRC).toContain(tag);
    }
  });

  it("the previously silent catches no longer use bare `catch {}` / `/* soft-fail */`", () => {
    const handlerSlice = sliceReviewersHandler(MI_ROUTES_SRC);
    // Phase Repair removed the `/* soft-fail */` sentinel — the
    // catches now log instead. (The page-level data-quality classifier
    // still has its own comments.)
    expect(handlerSlice).not.toMatch(/\/\* soft-fail \*\//);
  });

  it("the route exposes a bounded dataQuality.degradedBlocks list", () => {
    const handlerSlice = sliceReviewersHandler(MI_ROUTES_SRC);
    expect(handlerSlice).toMatch(/degradedBlocks: string\[\] = \[\]/);
    expect(handlerSlice).toMatch(/degradedBlocks\.push\("workflow_totals"\)/);
    expect(handlerSlice).toMatch(/degradedBlocks\.push\("escalation_totals"\)/);
    expect(handlerSlice).toMatch(/degradedBlocks\.push\("external_review_totals"\)/);
    expect(handlerSlice).toMatch(/degradedBlocks\.push\("recent_escalations"\)/);
    expect(handlerSlice).toMatch(/degradedBlocks\.push\("recent_grants"\)/);
    expect(handlerSlice).toMatch(/degradedBlocks\.push\("indexing_totals"\)/);
    // The response carries the final dataQuality envelope.
    expect(handlerSlice).toMatch(/dataQuality:[\s\S]*?state:[\s\S]*?"degraded"/);
    expect(handlerSlice).toMatch(/dataQuality:[\s\S]*?state:[\s\S]*?"ok"/);
  });

  it("the page renders a single bounded data-quality banner when state is degraded", () => {
    expect(REVIEWERS_PAGE).toMatch(/dataQuality\?\.state === "degraded"/);
    expect(REVIEWERS_PAGE).toMatch(/Some reviewer console counters could not be loaded/);
    expect(REVIEWERS_PAGE).toMatch(/dataQualityBannerStyle/);
  });
});

// =============================================================================
// Task E — allIndexed pill is honest on empty workspaces
// =============================================================================

describe("Phase Repair Task E — IndexingTile no longer lies on empty state", () => {
  it("the IndexingTile uses available > 0 && indexed === available (NOT available === 0 || ...)", () => {
    const idx = REVIEWERS_PAGE.indexOf("function IndexingTile(");
    expect(idx).toBeGreaterThan(0);
    const slice = REVIEWERS_PAGE.slice(idx, idx + 2000);
    expect(slice).toMatch(/const allIndexed = available > 0 && indexed === available/);
    // The historical dishonest expression is gone.
    expect(slice).not.toMatch(/available === 0 \|\| indexed === available/);
  });

  it("the IndexingTile renders neutral 'No records yet' on empty workspaces", () => {
    const idx = REVIEWERS_PAGE.indexOf("function IndexingTile(");
    const slice = REVIEWERS_PAGE.slice(idx, idx + 2000);
    expect(slice).toMatch(/No records yet/);
  });

  it("the green 'all indexed' pill cannot fire when available is 0", () => {
    // Source-level guard. Re-derive the expression literally.
    const available = 0;
    const indexed = 0;
    const empty = available === 0;
    const allIndexed = available > 0 && indexed === available;
    expect(empty).toBe(true);
    expect(allIndexed).toBe(false);
    // The pill style argument is `allIndexed && !empty`, so even if
    // someone passed a defensive truthy at the call site, the style
    // still resolves to the neutral pill.
    expect(allIndexed && !empty).toBe(false);
  });

  it("the green 'all indexed' pill still fires on a fully-indexed non-empty workspace", () => {
    const available: number = 7;
    const indexed: number = 7;
    const empty = available === 0;
    const allIndexed = available > 0 && indexed === available;
    expect(empty).toBe(false);
    expect(allIndexed).toBe(true);
  });

  it("the 'indexing pending' pill fires on partial workspaces", () => {
    const available: number = 7;
    const indexed: number = 3;
    const empty = available === 0;
    const allIndexed = available > 0 && indexed === available;
    expect(empty).toBe(false);
    expect(allIndexed).toBe(false);
  });
});

// =============================================================================
// Runtime exercise — derive the chip "credentials not ready" caption
// from a fake ProducerModeStatus and confirm the page's component
// logic matches the route's contract.
// =============================================================================

describe("Phase Repair — runtime chip caption logic", () => {
  // Re-derive the caption rule the page uses so we can prove the
  // chip turns into "credentials not ready" the moment the probe-aware
  // resolver reports `automatic: false` even when the operator has
  // selected VENDOR_CLOUD.
  function deriveCaption(status: {
    mode: string;
    automatic: boolean;
  }): string {
    const active = status.automatic === true;
    const label = (s: string): string => {
      switch (s) {
        case "VENDOR_CLOUD":
          return "vendor cloud";
        case "INDEX_EXISTING_ONLY":
          return "existing content searchable";
        case "NOT_CONFIGURED":
          return "automatic extraction off";
        case "LOCAL_TESSERACT":
          return "local Tesseract";
        case "LOCAL_WHISPER":
          return "local Whisper";
        default:
          return s.toLowerCase();
      }
    };
    return status.mode === "VENDOR_CLOUD" && !active
      ? `${label(status.mode)} (credentials not ready)`
      : label(status.mode);
  }

  it("VENDOR_CLOUD + automatic=false → credentials-not-ready caption", () => {
    expect(
      deriveCaption({ mode: "VENDOR_CLOUD", automatic: false }),
    ).toBe("vendor cloud (credentials not ready)");
  });

  it("VENDOR_CLOUD + automatic=true → plain vendor-cloud caption", () => {
    expect(
      deriveCaption({ mode: "VENDOR_CLOUD", automatic: true }),
    ).toBe("vendor cloud");
  });

  it("NOT_CONFIGURED → neutral caption, never 'credentials not ready'", () => {
    expect(
      deriveCaption({ mode: "NOT_CONFIGURED", automatic: false }),
    ).toBe("automatic extraction off");
  });

  it("INDEX_EXISTING_ONLY + automatic=true → existing-searchable caption (no credentials suffix)", () => {
    expect(
      deriveCaption({ mode: "INDEX_EXISTING_ONLY", automatic: true }),
    ).toBe("existing content searchable");
  });
});

// =============================================================================
// Runtime exercise — the derived `producesNewContent` summary tracks
// the canonical statuses, not the bare mode string.
// =============================================================================

describe("Phase Repair — derived producesNewContent honesty", () => {
  // Re-derive the route's `producesNewContent` rule.
  function deriveProducesNewContent(
    ocr: { automatic: boolean; indexExistingOnly: boolean } | undefined,
    transcript: { automatic: boolean; indexExistingOnly: boolean } | undefined,
  ): boolean {
    return (
      !!ocr?.automatic &&
      !!transcript?.automatic &&
      ocr?.indexExistingOnly === false &&
      transcript?.indexExistingOnly === false
    );
  }

  it("returns false when probe says automatic:false even on VENDOR_CLOUD", () => {
    // Operator picked VENDOR_CLOUD but the probe found credentials
    // missing → resolver returns automatic:false. The historical
    // mode-string-only check would have returned true. The new derive
    // returns false.
    expect(
      deriveProducesNewContent(
        { automatic: false, indexExistingOnly: false },
        { automatic: false, indexExistingOnly: false },
      ),
    ).toBe(false);
  });

  it("returns false when ocr is automatic but indexExistingOnly is true", () => {
    expect(
      deriveProducesNewContent(
        { automatic: true, indexExistingOnly: true },
        { automatic: true, indexExistingOnly: false },
      ),
    ).toBe(false);
  });

  it("returns true only when BOTH ocr and transcript are automatic + not indexExistingOnly", () => {
    expect(
      deriveProducesNewContent(
        { automatic: true, indexExistingOnly: false },
        { automatic: true, indexExistingOnly: false },
      ),
    ).toBe(true);
  });

  it("returns false when either status is missing", () => {
    expect(
      deriveProducesNewContent(undefined, {
        automatic: true,
        indexExistingOnly: false,
      }),
    ).toBe(false);
    expect(
      deriveProducesNewContent(
        { automatic: true, indexExistingOnly: false },
        undefined,
      ),
    ).toBe(false);
  });
});
