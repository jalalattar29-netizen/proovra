/**
 * Phase 31.20 / 32.19 — source-contract tests for the final closure
 * pass:
 *   * ffmpeg-derived asset producers (video_frame, audio_waveform,
 *     low_res_proxy) dispatched from the existing derived-assets
 *     processor.
 *   * OCR / transcript INDEX_EXISTING_ONLY producer that surfaces
 *     OCR_AVAILABLE / OCR_INDEXED / TRANSCRIPT_AVAILABLE /
 *     TRANSCRIPT_INDEXED signals from evidence_ocr_text +
 *     evidence_transcript_segments.
 *   * The final three isolated subsystem queues
 *     (graph-domain-sync, graph-timeline-sync, graph-search-projection).
 *
 * Goals enforced here:
 *   - bounded, capability-aware, fail-safe dispatch.
 *   - never reads raw OCR / transcript text into a signal label.
 *   - redacted / blocked rows excluded.
 *   - team-anchored at every read.
 *   - idempotent signal upsert.
 *   - new signal types registered in the catalog AND in the SQL
 *     CHECK constraint AND in the safeSummary library.
 *   - final 3 queues isolated + safeRegisterWorker + shutdown-aware.
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

const SIGNAL_CATALOG_SRC = readSource(
  "../src/services/media-intelligence/signal-catalog.ts",
);
const INDEXER_SRC = readSource(
  "../src/services/media-intelligence/ocr-transcript-indexer.service.ts",
);
const INDEXED_SIGNALS_SQL = readSource(
  "../sql/drift-patches/2026-05-20-ocr-transcript-indexed-signals.sql",
);

// =============================================================================
// PART 1 — new signal types are everywhere they need to be
// =============================================================================

describe("Phase 31.20 — OCR_INDEXED / TRANSCRIPT_INDEXED signal types", () => {
  it("catalog includes OCR_INDEXED and TRANSCRIPT_INDEXED", () => {
    expect(SIGNAL_CATALOG_SRC).toMatch(/"OCR_INDEXED"/);
    expect(SIGNAL_CATALOG_SRC).toMatch(/"TRANSCRIPT_INDEXED"/);
  });

  it("SIGNAL_METADATA has entries for the new types", () => {
    // Each metadata entry is keyed by the bare identifier (e.g.
    // OCR_INDEXED: { ... }). The source contains both spellings.
    expect(SIGNAL_CATALOG_SRC).toMatch(
      /OCR_INDEXED:\s*\{[^}]*displayLabel:\s*"OCR text indexed for search"/,
    );
    expect(SIGNAL_CATALOG_SRC).toMatch(
      /TRANSCRIPT_INDEXED:\s*\{[^}]*displayLabel:\s*"Transcript indexed for search"/,
    );
  });

  it("safeSummary library produces bounded wording for the new types", () => {
    // The summary text must include the bounded chunk_count / segment_count
    // and the advisory-only suffix. NEVER includes raw OCR or transcript
    // text — those columns aren't even available to the wording helper.
    expect(SIGNAL_CATALOG_SRC).toMatch(
      /case "OCR_INDEXED":[\s\S]*?OCR content indexed for search \(\$\{input\.chunkCount\}/,
    );
    expect(SIGNAL_CATALOG_SRC).toMatch(
      /case "TRANSCRIPT_INDEXED":[\s\S]*?Transcript content indexed for search \(\$\{input\.segmentCount\}/,
    );
  });

  it("SQL CHECK constraint patch lists both new signal types", () => {
    expect(INDEXED_SIGNALS_SQL).toMatch(/'OCR_INDEXED'/);
    expect(INDEXED_SIGNALS_SQL).toMatch(/'TRANSCRIPT_INDEXED'/);
    // Idempotent — DROP IF EXISTS then ADD.
    expect(INDEXED_SIGNALS_SQL).toMatch(
      /ALTER TABLE "media_intelligence_signals"[\s\S]*?DROP CONSTRAINT IF EXISTS "media_intelligence_signals_signal_type_bounded"/,
    );
    expect(INDEXED_SIGNALS_SQL).toMatch(
      /ALTER TABLE "media_intelligence_signals"[\s\S]*?ADD CONSTRAINT "media_intelligence_signals_signal_type_bounded"/,
    );
    // BEGIN / COMMIT — fully transactional patch.
    expect(INDEXED_SIGNALS_SQL).toMatch(/^BEGIN;/m);
    expect(INDEXED_SIGNALS_SQL).toMatch(/^COMMIT;/m);
  });
});

// =============================================================================
// PART 2 — OCR / transcript INDEX_EXISTING_ONLY producer
// =============================================================================

describe("Phase 31.20 — OCR / transcript indexer producer service", () => {
  it("filters to non-redacted, non-BLOCKED rows", () => {
    const code = stripComments(INDEXER_SRC);
    // OCR query filter
    expect(code).toMatch(
      /FROM "evidence_ocr_text"[\s\S]*?"redacted" = false[\s\S]*?"visibility_scope" <> 'BLOCKED'/,
    );
    // Transcript query filter
    expect(code).toMatch(
      /FROM "evidence_transcript_segments"[\s\S]*?"redacted" = false[\s\S]*?"visibility_scope" <> 'BLOCKED'/,
    );
  });

  it("team-anchored at every read", () => {
    const code = stripComments(INDEXER_SRC);
    // Every SQL query binds team_id = $1.
    const teamBindings = code.match(/"team_id" = \$1/g) ?? [];
    expect(teamBindings.length).toBeGreaterThanOrEqual(2);
  });

  it("NEVER reads the raw text column into the indexer's output", () => {
    const code = stripComments(INDEXER_SRC);
    // The SQL queries SELECT only bounded count aggregates — never
    // the `text` column from either source table.
    expect(code).not.toMatch(/SELECT[\s\S]{0,200}"text"/);
    // The result type explicitly excludes a text field.
    const resultMatch = code.match(/export type IndexExistingResult = \{[\s\S]*?\};/);
    expect(resultMatch).toBeTruthy();
    expect(resultMatch![0]).not.toMatch(/text:/);
  });

  it("idempotent upsert: ON CONFLICT keyed on (evidence_id, material_id, signal_type)", () => {
    expect(INDEXER_SRC).toMatch(
      /ON CONFLICT \(\s*"evidence_id",\s*COALESCE\("material_id", '00000000-0000-0000-0000-000000000000'::uuid\),\s*"signal_type"\s*\) DO UPDATE/,
    );
  });

  it("emits OCR_INDEXED only when at least one row is indexed", () => {
    const code = stripComments(INDEXER_SRC);
    // The gating condition is `if (r.indexed_count > 0)`.
    expect(code).toMatch(/if \(r\.indexed_count > 0\) \{[\s\S]*?"OCR_INDEXED"/);
    expect(code).toMatch(/if \(r\.indexed_count > 0\) \{[\s\S]*?"TRANSCRIPT_INDEXED"/);
  });

  it("bounded batch size — Math.max(1, Math.min(input.evidenceBatchSize ?? 500, 5000))", () => {
    expect(INDEXER_SRC).toMatch(
      /Math\.max\(\s*1,\s*Math\.min\(input\.evidenceBatchSize \?\? 500, 5000\),?\s*\)/,
    );
  });

  it("uses material_id = NULL for whole-evidence signals", () => {
    // The INSERT explicitly binds NULL for material_id so the
    // whole-evidence scope is unambiguous.
    expect(INDEXER_SRC).toMatch(
      /VALUES \(\$1, \$2, NULL, \$3, \$4, \$5, \$6, NULL\)/,
    );
  });

  it("never throws — collapses failures to { ok: false, reason }", () => {
    const code = stripComments(INDEXER_SRC);
    // Every $queryRawUnsafe is wrapped in try { ... } catch (err) { return empty(...) }
    const tryWraps = code.match(/try \{[\s\S]*?\$queryRawUnsafe[\s\S]*?\} catch/g) ?? [];
    expect(tryWraps.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// PART 3 — ffmpeg producer module source contract
// =============================================================================

const FFMPEG_PRODUCERS_SRC = readSource(
  "../../worker/src/ffmpeg-derived-assets.ts",
);

describe("Phase 31.20 — ffmpeg-derived asset producers", () => {
  it("exports the three producers", () => {
    expect(FFMPEG_PRODUCERS_SRC).toMatch(/export async function produceVideoFrame/);
    expect(FFMPEG_PRODUCERS_SRC).toMatch(/export async function produceAudioWaveform/);
    expect(FFMPEG_PRODUCERS_SRC).toMatch(/export async function produceLowResProxy/);
  });

  it("each producer probes ffmpeg capability before spawning", () => {
    const code = stripComments(FFMPEG_PRODUCERS_SRC);
    const calls = code.match(/await detectFfmpegCapability\(\)/g) ?? [];
    // Three producers × one probe call each.
    expect(calls.length).toBe(3);
  });

  it("each producer returns UNSUPPORTED (not FAILED) when ffmpeg is missing", () => {
    const code = stripComments(FFMPEG_PRODUCERS_SRC);
    // Three places where we check `!cap.ok` and return unsupported.
    const matches = code.match(/if \(!cap\.ok\) \{\s*return \{ status: "unsupported"/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it("producers reject wrong-MIME inputs with UNSUPPORTED (anti-leak)", () => {
    const code = stripComments(FFMPEG_PRODUCERS_SRC);
    // video_frame + low_res_proxy require video/*.
    expect(code).toMatch(
      /produceVideoFrame[\s\S]*?startsWith\("video\/"\)[\s\S]*?status: "unsupported"/,
    );
    expect(code).toMatch(
      /produceLowResProxy[\s\S]*?startsWith\("video\/"\)[\s\S]*?status: "unsupported"/,
    );
  });

  it("subprocess is bounded by FFMPEG_SUBPROCESS_TIMEOUT_MS", () => {
    expect(FFMPEG_PRODUCERS_SRC).toMatch(
      /const FFMPEG_SUBPROCESS_TIMEOUT_MS = \d+_000/,
    );
    expect(FFMPEG_PRODUCERS_SRC).toMatch(/child\.kill\("SIGKILL"\)/);
  });

  it("output size is bounded per asset kind", () => {
    expect(FFMPEG_PRODUCERS_SRC).toMatch(
      /video_frame:\s*\d+\s*\*\s*1024\s*\*\s*1024/,
    );
    expect(FFMPEG_PRODUCERS_SRC).toMatch(
      /audio_waveform:\s*\d+\s*\*\s*1024,?/,
    );
    expect(FFMPEG_PRODUCERS_SRC).toMatch(
      /low_res_proxy:\s*\d+\s*\*\s*1024\s*\*\s*1024/,
    );
    // Each producer checks the output against its budget and
    // returns failed with `output_oversize` when exceeded.
    expect(FFMPEG_PRODUCERS_SRC).toMatch(/output_oversize/);
  });

  it("hash of derived bytes is computed (separate SHA-256 — never the source hash)", () => {
    const code = stripComments(FFMPEG_PRODUCERS_SRC);
    expect(code).toMatch(
      /const derivedSha256 = createHash\("sha256"\)\.update\(outBytes\)\.digest\("hex"\)/,
    );
  });

  it("temp files cleaned up via try/finally", () => {
    expect(FFMPEG_PRODUCERS_SRC).toMatch(/} finally \{[\s\S]*?rm\(dir, \{ recursive: true, force: true \}\)/);
  });

  it("low_res_proxy capped to 30 seconds + 480p", () => {
    expect(FFMPEG_PRODUCERS_SRC).toMatch(/"-t"\s*,\s*"30"/);
    expect(FFMPEG_PRODUCERS_SRC).toMatch(/"-vf"\s*,\s*"scale=-2:480"/);
  });

  it("audio_waveform uses bounded showwavespic filter (no audio fingerprint)", () => {
    expect(FFMPEG_PRODUCERS_SRC).toMatch(
      /showwavespic=s=600x80/,
    );
  });
});

// =============================================================================
// PART 4 — derived-assets processor dispatch
// =============================================================================

const DERIVED_ASSETS_PROCESSOR_SRC = readSource(
  "../../worker/src/derived-assets.processor.ts",
);

describe("Phase 31.20 — derived-assets processor dispatch", () => {
  it("dispatches video_frame / audio_waveform / low_res_proxy to ffmpeg pipeline", () => {
    const code = stripComments(DERIVED_ASSETS_PROCESSOR_SRC);
    expect(code).toMatch(/assetKind === "video_frame"[\s\S]*?handleFfmpegAssetKind/);
    expect(code).toMatch(/assetKind === "audio_waveform"/);
    expect(code).toMatch(/assetKind === "low_res_proxy"/);
  });

  it("compact_review_preview stays UNSUPPORTED (reserved)", () => {
    expect(DERIVED_ASSETS_PROCESSOR_SRC).toMatch(
      /assetKind === "compact_review_preview"[\s\S]*?kind_reserved_for_future_phase/,
    );
  });

  it("ffmpeg engine version is distinct from sharp engine version (provenance)", () => {
    expect(DERIVED_ASSETS_PROCESSOR_SRC).toMatch(
      /FFMPEG_ENGINE_VERSION = "ffmpeg-v0-phase31-20"/,
    );
    // The persistence call accepts an optional engineVersion override.
    expect(DERIVED_ASSETS_PROCESSOR_SRC).toMatch(
      /engineVersion:\s*FFMPEG_ENGINE_VERSION/,
    );
  });

  it("source bytes are pulled from getObjectRange with per-kind budget", () => {
    expect(DERIVED_ASSETS_PROCESSOR_SRC).toMatch(
      /SOURCE_READ_BUDGET\[assetKind\]/,
    );
  });

  it("derived bytes are written to a SEPARATE key (never the source key)", () => {
    const code = stripComments(DERIVED_ASSETS_PROCESSOR_SRC);
    // The derived key helper is the single source of truth for
    // derived asset keys — it ALWAYS prefixes derived-assets/.
    expect(code).toMatch(/DERIVED_ASSET_S3_PREFIX = "derived-assets"/);
    expect(code).toMatch(/`\$\{DERIVED_ASSET_S3_PREFIX\}\/\$\{input\.evidenceId\}/);
  });
});

// =============================================================================
// PART 5 — graph-reconcile sidecar invokes the indexer
// =============================================================================

const SUBSYSTEM_PROCESSORS_SRC = readSource(
  "../../worker/src/subsystem-queue-processors.ts",
);

describe("Phase 31.20 — graph-reconcile invokes OCR/transcript indexer", () => {
  it("imports and conditionally invokes the indexer service", () => {
    expect(SUBSYSTEM_PROCESSORS_SRC).toMatch(
      /import\([\s\S]*?ocr-transcript-indexer\.service\.js[\s\S]*?\)/,
    );
    expect(SUBSYSTEM_PROCESSORS_SRC).toMatch(
      /const indexerResult = await indexExistingOcrAndTranscript\(\s*\{\s*teamId: job\.data\.teamId/,
    );
  });

  it("gates on producer mode (skip when both modes are NOT_CONFIGURED)", () => {
    expect(SUBSYSTEM_PROCESSORS_SRC).toMatch(
      /modes\.ocr !== "NOT_CONFIGURED" \|\| modes\.transcript !== "NOT_CONFIGURED"/,
    );
    expect(SUBSYSTEM_PROCESSORS_SRC).toMatch(
      /graph_reconcile\.ocr_transcript_indexer_skipped_not_configured/,
    );
  });

  it("indexer failure is non-fatal — never throws to BullMQ", () => {
    // The indexer call is wrapped in try { … } catch (err) { logger.warn(...) }
    expect(SUBSYSTEM_PROCESSORS_SRC).toMatch(
      /graph_reconcile\.ocr_transcript_indexer_failed_non_fatal/,
    );
  });
});

// =============================================================================
// PART 6 — final 3 isolated queues
// =============================================================================

const QUEUE_SRC = readSource("../../worker/src/queue.ts");
const INDEX_SRC = readSource("../../worker/src/index.ts");

describe("Phase 31.20 — final 3 isolated queues", () => {
  it("queue.ts declares graph-domain-sync / graph-timeline-sync / graph-search-projection", () => {
    expect(QUEUE_SRC).toMatch(/graphDomainSyncQueueName = "graph-domain-sync"/);
    expect(QUEUE_SRC).toMatch(
      /graphTimelineSyncQueueName = "graph-timeline-sync"/,
    );
    expect(QUEUE_SRC).toMatch(
      /graphSearchProjectionQueueName = "graph-search-projection"/,
    );
  });

  it("each new queue has a deterministic idempotent job-id builder", () => {
    expect(QUEUE_SRC).toMatch(
      /function buildGraphDomainSyncJobId\(\s*teamId: string,\s*domain: string \| null \| undefined,?\s*\): string/,
    );
    expect(QUEUE_SRC).toMatch(
      /function buildGraphTimelineSyncJobId\(teamId: string\): string \{\s*return `graph-timeline-sync-\$\{teamId\}`/,
    );
    expect(QUEUE_SRC).toMatch(
      /function buildGraphSearchProjectionJobId\(teamId: string\): string \{\s*return `graph-search-projection-\$\{teamId\}`/,
    );
  });

  it("each enqueue helper routes through genericIdempotentEnqueue", () => {
    expect(QUEUE_SRC).toMatch(
      /export async function enqueueGraphDomainSyncJob[\s\S]*?genericIdempotentEnqueue\(/,
    );
    expect(QUEUE_SRC).toMatch(
      /export async function enqueueGraphTimelineSyncJob[\s\S]*?genericIdempotentEnqueue\(/,
    );
    expect(QUEUE_SRC).toMatch(
      /export async function enqueueGraphSearchProjectionJob[\s\S]*?genericIdempotentEnqueue\(/,
    );
  });

  it("graph-domain-sync payload allows bounded domain filter (catalog enum only)", () => {
    expect(QUEUE_SRC).toMatch(
      /domain\?:\s*\|\s*"CASE"\s*\|\s*"REPORT"\s*\|\s*"VERIFICATION_PACKAGE"\s*\|\s*"EXPORT"\s*\|\s*"REVIEW_TASK"\s*\|\s*"ESCALATION"\s*\|\s*"INCIDENT"\s*\|\s*"EXTERNAL_REVIEW"\s*\|\s*null/,
    );
  });

  it("index.ts registers each new worker via safeRegisterWorker", () => {
    expect(INDEX_SRC).toMatch(/safeRegisterWorker\(\s*"graph-domain-sync"/);
    expect(INDEX_SRC).toMatch(/safeRegisterWorker\(\s*"graph-timeline-sync"/);
    expect(INDEX_SRC).toMatch(/safeRegisterWorker\(\s*"graph-search-projection"/);
  });

  it("WorkerKind union includes the 3 new kinds", () => {
    const idx = INDEX_SRC.indexOf("type WorkerKind");
    const slice = INDEX_SRC.slice(idx, idx + 800);
    expect(slice).toMatch(/"graph-domain-sync"/);
    expect(slice).toMatch(/"graph-timeline-sync"/);
    expect(slice).toMatch(/"graph-search-projection"/);
  });

  it("shutdown closes each new worker (null-checked) and each new queue", () => {
    expect(INDEX_SRC).toMatch(/await graphDomainSyncQueue\.close\(\)/);
    expect(INDEX_SRC).toMatch(/await graphTimelineSyncQueue\.close\(\)/);
    expect(INDEX_SRC).toMatch(/await graphSearchProjectionQueue\.close\(\)/);
    expect(INDEX_SRC).toMatch(/graphDomainSyncWorker/);
    expect(INDEX_SRC).toMatch(/graphTimelineSyncWorker/);
    expect(INDEX_SRC).toMatch(/graphSearchProjectionWorker/);
  });
});

describe("Phase 31.20 — final 3 queue processors", () => {
  // Phase 31.21 — these processors now invoke REAL bounded work
  // (per-domain stale sweep, timeline build + cross-edge sweep,
  //  recent-signal-activity reindex enqueue). The Phase 31.20
  //  tests below were updated to reflect the upgrade. The full
  //  per-processor contract is enforced by the dedicated
  //  phase-31-21-enterprise-closure.test.ts.
  it("graph-domain-sync invokes the bounded per-domain stale sweep", () => {
    const idx = SUBSYSTEM_PROCESSORS_SRC.indexOf(
      "export async function processGraphDomainSyncJob",
    );
    expect(idx).toBeGreaterThan(0);
    const slice = SUBSYSTEM_PROCESSORS_SRC.slice(idx, idx + 3500);
    expect(slice).toMatch(/runDomainStaleSweep\(/);
    expect(slice).toMatch(/DOMAIN_SYNC_DOMAINS/);
  });

  it("graph-timeline-sync invokes the real bounded timeline sync", () => {
    const idx = SUBSYSTEM_PROCESSORS_SRC.indexOf(
      "export async function processGraphTimelineSyncJob",
    );
    expect(idx).toBeGreaterThan(0);
    const slice = SUBSYSTEM_PROCESSORS_SRC.slice(idx, idx + 1500);
    expect(slice).toMatch(/runTimelineSync\(/);
  });

  it("graph-search-projection invokes the real recent-signal-activity reindex", () => {
    const idx = SUBSYSTEM_PROCESSORS_SRC.indexOf(
      "export async function processGraphSearchProjectionJob",
    );
    expect(idx).toBeGreaterThan(0);
    const slice = SUBSYSTEM_PROCESSORS_SRC.slice(idx, idx + 2500);
    expect(slice).toMatch(/runSearchProjectionSync\(/);
  });

  it("all 3 processors import the shared prisma — no bare PrismaClient", () => {
    const code = stripComments(SUBSYSTEM_PROCESSORS_SRC);
    expect(code).not.toMatch(/new PrismaClient\(/);
    expect(SUBSYSTEM_PROCESSORS_SRC).toMatch(/import \{ prisma \} from "\.\/db\.js"/);
  });
});

// =============================================================================
// PART 7 — Metrics registry (new counters)
// =============================================================================

const METRICS_SRC = readSource("../src/services/ops/metrics.service.ts");

describe("Phase 31.20 — bounded metric names registered", () => {
  it("registers ocr indexer + 3 new graph subsystem counters", () => {
    expect(METRICS_SRC).toMatch(/"ocr_indexer_started_total"/);
    expect(METRICS_SRC).toMatch(/"ocr_indexer_completed_total"/);
    expect(METRICS_SRC).toMatch(/"graph_domain_sync_executed_total"/);
    expect(METRICS_SRC).toMatch(/"graph_timeline_sync_executed_total"/);
    expect(METRICS_SRC).toMatch(/"graph_search_projection_executed_total"/);
  });
});
