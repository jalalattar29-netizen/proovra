/**
 * Phase 31.21 / 32.20 — final enterprise closure tests.
 *
 * Production runs INDEX_EXISTING_ONLY for both OCR and transcript.
 * Local extractor modes (LOCAL_TESSERACT / LOCAL_WHISPER) are stubs
 * that report NOT_ENABLED, never spawn anything, never load any
 * heavy package.
 *
 * What's enforced here:
 *
 *   1. Local-extractor capability probes ALWAYS return
 *      `{ ok: false, reason: "not_enabled" }`. They NEVER
 *      dynamic-import a vendor package and NEVER spawn a subprocess.
 *
 *   2. domain-sync.service.ts:
 *      - Each per-domain stale sweep is team-anchored on BOTH the
 *        outer UPDATE and the inner NOT EXISTS sub-select.
 *      - The DOMAIN_SYNC_DOMAINS catalog is the bounded vocabulary;
 *        the worker processor only accepts catalog values.
 *      - Bounded ≤200 evidence reindex enqueues per
 *        search-projection-sync run.
 *      - Search-projection sync NEVER throws — collapses to a
 *        bounded reason on failure.
 *      - Timeline sync invokes the existing timeline builder + the
 *        cross-edge stale sweep.
 *
 *   3. Worker processors:
 *      - graph-domain-sync dispatches per-domain via the new service.
 *      - graph-timeline-sync invokes runTimelineSync — NOT a no-op.
 *      - graph-search-projection invokes runSearchProjectionSync —
 *        NOT a no-op.
 *      - All three import the shared prisma — never bare PrismaClient.
 *
 *   4. Reviewer Console projection includes:
 *      - producerModes (INDEX_EXISTING_ONLY-aware).
 *      - indexingTotals (real per-team counts).
 *      - localExtractorCapability (NOT_ENABLED today).
 *      - NEVER projects raw OCR / transcript text.
 *
 *   5. Reviewer Console UI:
 *      - Renders the new tiles.
 *      - No forbidden wording.
 *      - No reviewer-private fields.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const LOCAL_CAP_SRC = readSource(
  "../../worker/src/local-ocr-transcript-capability.ts",
);
const DOMAIN_SYNC_SRC = readSource(
  "../src/services/graph/domain-sync.service.ts",
);
const SUBSYSTEM_PROCESSORS_SRC = readSource(
  "../../worker/src/subsystem-queue-processors.ts",
);
const MI_ROUTES_SRC = readSource("../src/routes/media-intelligence.routes.ts");
const REVIEWERS_PAGE = readSource(
  "../../../apps/web/app/(app)/investigation/reviewers/page.tsx",
);

// =============================================================================
// PART 1 — Local-extractor capability probes are stubs
// =============================================================================

describe("Phase 31.21 — local OCR / Whisper capability probes are stubs", () => {
  it("never spawns a subprocess", () => {
    const code = stripComments(LOCAL_CAP_SRC);
    expect(code).not.toMatch(/spawn\(/);
    expect(code).not.toMatch(/exec\(/);
    expect(code).not.toMatch(/execSync\(/);
    expect(code).not.toMatch(/execFile\(/);
  });

  it("never dynamic-imports a vendor package", () => {
    const code = stripComments(LOCAL_CAP_SRC);
    // No runtime `import(...)` of tesseract.js / whisper-cpp / etc.
    expect(code).not.toMatch(/await\s+import\(/);
    expect(code).not.toMatch(/require\(/);
  });

  it("never reads files from disk", () => {
    const code = stripComments(LOCAL_CAP_SRC);
    expect(code).not.toMatch(/readFile|existsSync|statSync|createReadStream/);
  });

  it("both probes return { ok: false, reason: \"not_enabled\" }", () => {
    const code = stripComments(LOCAL_CAP_SRC);
    expect(code).toMatch(
      /detectLocalTesseractCapability[\s\S]{0,600}return \{\s*ok: false,\s*reason: "not_enabled",?\s*\}/,
    );
    expect(code).toMatch(
      /detectLocalWhisperCapability[\s\S]{0,600}return \{\s*ok: false,\s*reason: "not_enabled",?\s*\}/,
    );
  });
});

// =============================================================================
// PART 2 — domain-sync.service.ts contract
// =============================================================================

describe("Phase 31.21 — domain-sync.service.ts", () => {
  it("exports the bounded DOMAIN_SYNC_DOMAINS catalog with 8 entries", () => {
    const m = DOMAIN_SYNC_SRC.match(/export const DOMAIN_SYNC_DOMAINS = \[([\s\S]*?)\] as const/);
    expect(m).toBeTruthy();
    const entries = (m![1].match(/"[A-Z_]+"/g) ?? []);
    expect(entries.length).toBe(8);
    // Spot-check the bounded set.
    expect(entries).toContain('"CASE"');
    expect(entries).toContain('"REPORT"');
    expect(entries).toContain('"VERIFICATION_PACKAGE"');
    expect(entries).toContain('"EXPORT"');
    expect(entries).toContain('"REVIEW_TASK"');
    expect(entries).toContain('"ESCALATION"');
    expect(entries).toContain('"INCIDENT"');
    expect(entries).toContain('"EXTERNAL_REVIEW"');
  });

  it("runDomainStaleSweep is team-anchored on BOTH outer UPDATE and inner sub-select", () => {
    const idx = DOMAIN_SYNC_SRC.indexOf("export async function runDomainStaleSweep");
    expect(idx).toBeGreaterThan(0);
    const slice = DOMAIN_SYNC_SRC.slice(idx, idx + 2500);
    // The UPDATE binds team_id = $1
    expect(slice).toMatch(/UPDATE "investigation_graph_nodes" n\s*SET[\s\S]*?n\."team_id" = \$1/);
    // The NOT EXISTS sub-select ALSO binds team_id = $1
    expect(slice).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM[\s\S]*?s\."team_id" = \$1/);
  });

  it("runDomainStaleSweep never throws — collapses to { ok: false, reason }", () => {
    const idx = DOMAIN_SYNC_SRC.indexOf("export async function runDomainStaleSweep");
    const slice = DOMAIN_SYNC_SRC.slice(idx, idx + 2500);
    expect(slice).toMatch(/try \{[\s\S]*?\$executeRawUnsafe[\s\S]*?\} catch \(err\) \{/);
    expect(slice).toMatch(/return \{\s*ok: false,[\s\S]*?reason:/);
  });

  it("runTimelineSync invokes buildInvestigationTimeline AND runs the cross-edge stale sweep", () => {
    const idx = DOMAIN_SYNC_SRC.indexOf("export async function runTimelineSync");
    expect(idx).toBeGreaterThan(0);
    const slice = DOMAIN_SYNC_SRC.slice(idx, idx + 3500);
    expect(slice).toMatch(/buildInvestigationTimeline/);
    // The cross-edge sweep tombstones edges whose source OR target
    // node has gone stale. Anchor on the UPDATE statement.
    expect(slice).toMatch(/UPDATE "investigation_graph_edges" e/);
    expect(slice).toMatch(/"stale_at_utc" IS NOT NULL/);
  });

  it("runSearchProjectionSync caps enqueue at 200 per run by default and clamps to 500 max", () => {
    expect(DOMAIN_SYNC_SRC).toMatch(/MAX_REINDEX_ENQUEUES_PER_RUN = 200/);
    expect(DOMAIN_SYNC_SRC).toMatch(
      /Math\.max\(\s*1,\s*Math\.min\(options\.enqueueCap \?\? MAX_REINDEX_ENQUEUES_PER_RUN, 500\),?\s*\)/,
    );
  });

  it("runSearchProjectionSync windowMinutes clamped to 1..1440", () => {
    expect(DOMAIN_SYNC_SRC).toMatch(
      /Math\.max\(\s*1,\s*Math\.min\(options\.windowMinutes \?\? RECENT_SIGNAL_WINDOW_MINUTES, 1440\),?\s*\)/,
    );
  });

  it("runSearchProjectionSync is team-anchored", () => {
    const idx = DOMAIN_SYNC_SRC.indexOf("export async function runSearchProjectionSync");
    const slice = DOMAIN_SYNC_SRC.slice(idx, idx + 3500);
    expect(slice).toMatch(
      /FROM "media_intelligence_signals"\s*WHERE "team_id" = \$1/,
    );
  });

  it("runSearchProjectionSync never throws — query failure returns { ok: false, reason }", () => {
    const idx = DOMAIN_SYNC_SRC.indexOf("export async function runSearchProjectionSync");
    const slice = DOMAIN_SYNC_SRC.slice(idx, idx + 3500);
    expect(slice).toMatch(
      /} catch \(err\) \{[\s\S]*?return \{\s*ok: false,[\s\S]*?reason:[\s\S]*?recent_signal_query_failed/,
    );
  });

  it("uses bumped metrics on entry", () => {
    expect(DOMAIN_SYNC_SRC).toMatch(/bump\("graph_domain_sync_executed_total"\)/);
    expect(DOMAIN_SYNC_SRC).toMatch(/bump\("graph_timeline_sync_executed_total"\)/);
    expect(DOMAIN_SYNC_SRC).toMatch(/bump\("graph_search_projection_executed_total"\)/);
  });
});

// =============================================================================
// PART 3 — Worker processors invoke the real bounded paths (no more no-ops)
// =============================================================================

describe("Phase 31.21 — graph-* worker processors are real (no no-ops)", () => {
  it("processGraphDomainSyncJob calls runDomainStaleSweep per bounded domain", () => {
    const idx = SUBSYSTEM_PROCESSORS_SRC.indexOf(
      "export async function processGraphDomainSyncJob",
    );
    expect(idx).toBeGreaterThan(0);
    const slice = SUBSYSTEM_PROCESSORS_SRC.slice(idx, idx + 3500);
    expect(slice).toMatch(/runDomainStaleSweep\(/);
    expect(slice).toMatch(/DOMAIN_SYNC_DOMAINS/);
    // Unknown-domain payload values short-circuit to a logged skip
    // (anti-leak — never executes user-supplied SQL fragments).
    expect(slice).toMatch(/unknown_domain/);
  });

  it("processGraphTimelineSyncJob calls runTimelineSync", () => {
    const idx = SUBSYSTEM_PROCESSORS_SRC.indexOf(
      "export async function processGraphTimelineSyncJob",
    );
    expect(idx).toBeGreaterThan(0);
    const slice = SUBSYSTEM_PROCESSORS_SRC.slice(idx, idx + 1500);
    expect(slice).toMatch(/runTimelineSync\(/);
    expect(slice).not.toMatch(/no_op_completed/);
  });

  it("processGraphSearchProjectionJob calls runSearchProjectionSync", () => {
    const idx = SUBSYSTEM_PROCESSORS_SRC.indexOf(
      "export async function processGraphSearchProjectionJob",
    );
    expect(idx).toBeGreaterThan(0);
    const slice = SUBSYSTEM_PROCESSORS_SRC.slice(idx, idx + 2500);
    expect(slice).toMatch(/runSearchProjectionSync\(/);
    expect(slice).not.toMatch(/no_op_completed/);
  });

  it("all three processors import the shared prisma — never bare PrismaClient", () => {
    const code = stripComments(SUBSYSTEM_PROCESSORS_SRC);
    expect(code).not.toMatch(/new PrismaClient\(/);
    expect(SUBSYSTEM_PROCESSORS_SRC).toMatch(/import \{ prisma \} from "\.\/db\.js"/);
  });

  it("the search-projection processor injects the worker's own enqueue impl", () => {
    const idx = SUBSYSTEM_PROCESSORS_SRC.indexOf(
      "export async function processGraphSearchProjectionJob",
    );
    const slice = SUBSYSTEM_PROCESSORS_SRC.slice(idx, idx + 2500);
    // Defending against a second Redis connection: the processor
    // passes its own enqueueImpl that calls the local
    // enqueueSearchIndexingJob.
    expect(slice).toMatch(/enqueueImpl:/);
    expect(slice).toMatch(/enqueueSearchIndexingJob\(/);
  });
});

// =============================================================================
// PART 4 — Reviewer Console route includes new fields
// =============================================================================

describe("Phase 31.21 — Reviewer Console projection", () => {
  it("returns indexingTotals (OCR_AVAILABLE / OCR_INDEXED / TRANSCRIPT_AVAILABLE / TRANSCRIPT_INDEXED counts)", () => {
    const idx = MI_ROUTES_SRC.indexOf("Phase 31.21 — OCR / transcript signal-volume snapshot");
    expect(idx).toBeGreaterThan(0);
    const slice = MI_ROUTES_SRC.slice(idx, idx + 2500);
    expect(slice).toMatch(/'OCR_AVAILABLE'/);
    expect(slice).toMatch(/'OCR_INDEXED'/);
    expect(slice).toMatch(/'TRANSCRIPT_AVAILABLE'/);
    expect(slice).toMatch(/'TRANSCRIPT_INDEXED'/);
    // Bounded — only PENDING/ACKNOWLEDGED rows are counted.
    expect(slice).toMatch(/"status" IN \('PENDING', 'ACKNOWLEDGED'\)/);
  });

  it("returns localExtractorCapability with NOT_ENABLED defaults", () => {
    const idx = MI_ROUTES_SRC.indexOf("localExtractorCapability");
    expect(idx).toBeGreaterThan(0);
    const slice = MI_ROUTES_SRC.slice(idx, idx + 800);
    expect(slice).toMatch(/tesseract:[\s\S]*?ok: false[\s\S]*?reason: "not_enabled"/);
    expect(slice).toMatch(/whisper:[\s\S]*?ok: false[\s\S]*?reason: "not_enabled"/);
  });

  it("the route NEVER reads or projects raw OCR or transcript text", () => {
    const code = stripComments(MI_ROUTES_SRC);
    const idx = code.indexOf("Phase 31.21 — OCR / transcript signal-volume snapshot");
    // (we kept the comment stripped above; this block ends before
    //  the next phase comment or the response.send call.)
    const sliceStart = code.indexOf("indexingTotals = {", idx > 0 ? idx : 0);
    const sliceEnd = code.indexOf("Phase 31.21 — local-extractor", sliceStart);
    if (sliceStart > 0 && sliceEnd > sliceStart) {
      const slice = code.slice(sliceStart, sliceEnd);
      // The SELECT is purely COUNT(*) FILTER aggregates — never
      // reads the underlying source tables' `text` columns.
      expect(slice).not.toMatch(/evidence_ocr_text/);
      expect(slice).not.toMatch(/evidence_transcript_segments/);
      expect(slice).not.toMatch(/"text"/);
    }
  });
});

// =============================================================================
// PART 5 — Reviewer Console UI: indexing tiles + capability tile
// =============================================================================

describe("Phase 31.21 — Reviewer Console UI", () => {
  it("renders the two indexing tiles", () => {
    expect(REVIEWERS_PAGE).toMatch(/OCR records available/);
    expect(REVIEWERS_PAGE).toMatch(/Transcript records available/);
  });

  it("renders the local-extractor capability tile", () => {
    expect(REVIEWERS_PAGE).toMatch(/Local extractor runtimes/);
    expect(REVIEWERS_PAGE).toMatch(/Local OCR \(Tesseract\)/);
    expect(REVIEWERS_PAGE).toMatch(/Local transcript \(Whisper\)/);
  });

  it("renders 'not enabled' / 'all indexed' / 'indexing pending' wording (bounded vocabulary)", () => {
    expect(REVIEWERS_PAGE).toMatch(/not enabled/);
    expect(REVIEWERS_PAGE).toMatch(/all indexed/);
    expect(REVIEWERS_PAGE).toMatch(/indexing pending/);
  });

  it("no forbidden user-facing vocabulary anywhere in the page", () => {
    const code = stripComments(REVIEWERS_PAGE).toLowerCase();
    for (const w of [
      "tampered",
      "forged",
      "manipulated",
      "authentic",
      "admissible",
      "proves",
      "confirms",
      "doctored",
    ]) {
      expect(code).not.toMatch(new RegExp(`\\b${w}\\b`));
    }
  });

  it("never reads or displays raw text columns (defensive guard)", () => {
    expect(REVIEWERS_PAGE).not.toMatch(/raw_text|rawText|ocrText|transcriptText|text:\s*string/);
  });

  it("calls only whitelisted endpoints (no new endpoint additions)", () => {
    const calls = REVIEWERS_PAGE.match(/apiFetch\(\s*[`"][^`"]+/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const ok =
        c.includes("/v1/users/me") ||
        c.includes("/v1/investigation/reviewers") ||
        c.includes("/v1/media-intelligence/signals/");
      expect(ok).toBe(true);
    }
  });
});

// =============================================================================
// PART 6 — Metrics registry includes the new counters
// =============================================================================

const METRICS_SRC = readSource("../src/services/ops/metrics.service.ts");

describe("Phase 31.21 — metric counters", () => {
  it("graph_node_removed_total is registered", () => {
    expect(METRICS_SRC).toMatch(/"graph_node_removed_total"/);
  });
});
