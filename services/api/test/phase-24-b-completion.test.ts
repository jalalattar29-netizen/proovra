/**
 * Phase 24-B — Enterprise Search completion source-contract tests.
 *
 * Phase 24-J shipped the foundations (audit table, OCR/transcript
 * stores, FTS / pgvector SQL, async indexing queue stub). Phase 24-B
 * closes the end-to-end loop:
 *
 *   1. `recordSearchAudit` is now called from `executeSearch` on every
 *      successful AND every fail-closed path.
 *   2. The runtime readiness aggregator surfaces a new
 *      `search_indexing` subsystem with bounded HEALTHY / DEGRADED /
 *      CRITICAL / UNKNOWN states + indexing-lag thresholds.
 *   3. The worker processor emits a structured `started` event so the
 *      upstream metrics pipeline can compute throughput.
 *   4. The /v1/search route propagates `surface`, `requestId`, and
 *      `ipAddress` so the audit row has full request context.
 *   5. Observability dashboard surfaces a `Search indexing` summary
 *      tile alongside Worker heartbeat + Queue health.
 *   6. Privacy guards: no path in the audit / indexing surfaces stores
 *      raw query text / raw IP / private notes / signed URLs / GPS /
 *      storage keys.
 *
 * Pure source-contract. No DB. No Fastify.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/**
 * Every production source file in the API and Worker. Enumerated from disk
 * rather than listed, so a new module cannot dodge the writer invariant below
 * simply by not being named here.
 */
const PRODUCTION_SOURCES: string[] = (() => {
  const repo = resolve(__dirname, "../../..");
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) out.push(full);
    }
  };
  walk(join(repo, "services/api/src"));
  walk(join(repo, "services/worker/src"));
  return out;
})();

// =============================================================================
// Audit wiring inside executeSearch
// =============================================================================

describe("Phase 24-B — executeSearch calls recordSearchAudit", () => {
  const src = readSource(
    "../../../services/api/src/services/search/evidence-search.service.ts",
  );

  it("imports recordSearchAudit from the dedicated audit service", () => {
    expect(src).toMatch(
      /import\s*\{\s*recordSearchAudit\s*\}\s*from\s*"\.\/search-audit\.service\.js"/,
    );
  });

  it("calls recordSearchAudit on the happy (non-failclosed) path", () => {
    // The success path must include a `void recordSearchAudit({...,
    // failClosed: false, ...})` call.
    expect(src).toMatch(
      /void recordSearchAudit\(\s*\{[\s\S]*?failClosed:\s*false[\s\S]*?\}\s*,\s*client,?\s*\)/,
    );
  });

  it("calls recordSearchAudit on the fail-closed (caught error) path", () => {
    // The catch block of the Prisma findMany call must record an audit
    // row with `failClosed: true`.
    expect(src).toMatch(
      /void recordSearchAudit\(\s*\{[\s\S]*?failClosed:\s*true[\s\S]*?\}\s*,\s*client,?\s*\)/,
    );
  });

  it("bumps search_fail_closed_engaged_total on the catch path", () => {
    expect(src).toMatch(/bump\("search_fail_closed_engaged_total"\)/);
  });

  it("propagates surface / requestId / ipAddress from the calling route", () => {
    // The route handler passes these three context fields.
    const routeSrc = readSource(
      "../../../services/api/src/routes/search.routes.ts",
    );
    expect(routeSrc).toMatch(
      /executeSearch\(\{[\s\S]*?surface:\s*"api:\/v1\/search"[\s\S]*?requestId:\s*req\.id[\s\S]*?ipAddress:\s*req\.ip[\s\S]*?\}\)/,
    );
  });

  it("buildSafeFilterSnapshot strips raw `q` and `cursor` but keeps governance metadata", () => {
    // The snapshot helper persists structural filters (documentTypes,
    // legal hold, retention, etc.) but never the raw query text.
    expect(src).toMatch(/function buildSafeFilterSnapshot\(/);
    expect(src).toMatch(
      /buildSafeFilterSnapshot[\s\S]*?documentTypes[\s\S]*?onLegalHold[\s\S]*?hasQueryText:\s*filter\.q\s*\?\s*true\s*:\s*false/,
    );
    // Snapshot must NOT include `q` directly.
    expect(src).not.toMatch(/buildSafeFilterSnapshot[\s\S]*?return\s*\{\s*q:\s*filter\.q/);
  });

  it("the audit call passes queryText (raw) — the service hashes it internally", () => {
    // The contract is: caller passes raw text, service hashes. This
    // keeps the hashing logic in ONE place so a future change cannot
    // diverge between callers.
    expect(src).toMatch(/queryText:\s*filter\.q\s*\?\?\s*null/);
  });

  it("bumps search_result_returned_total with the actual safe-row count", () => {
    expect(src).toMatch(
      /if \(safeRows\.length > 0\) \{\s*bump\("search_result_returned_total", safeRows\.length\)/,
    );
  });
});

// =============================================================================
// Runtime readiness — search_indexing subsystem
// =============================================================================

describe("Phase 24-B — runtime readiness surfaces search_indexing", () => {
  const src = readSource(
    "../../../services/api/src/runtime/runtime-readiness.ts",
  );

  it("introduces a `search_indexing` SubsystemId", () => {
    expect(src).toMatch(/\|\s*"search_indexing"/);
  });

  it("declares the checkSearchIndexing async helper", () => {
    expect(src).toMatch(
      /async function checkSearchIndexing\([\s\S]*?\): Promise<SubsystemReadiness>/,
    );
  });

  it("the aggregator runs the search_indexing check in parallel with the others", () => {
    // Phase 32.7 — the local was renamed from `subsystems` to
    // `rawSubsystems` to make room for a `.map(...)` step that
    // injects `affectedDomain` per subsystem before the result is
    // returned. The Promise.all parallel structure is unchanged.
    expect(src).toMatch(
      /(raw)?[Ss]ubsystems(?::\s*SubsystemReadiness\[\])?\s*=\s*await Promise\.all\(\[[\s\S]*?checkSearchIndexing\(prisma\)/,
    );
  });

  it("CRITICAL when evidence_search_documents OR search_audit_logs tables are missing", () => {
    expect(src).toMatch(/to_regclass\('public\.search_audit_logs'\)/);
    expect(src).toMatch(/to_regclass\('public\.evidence_search_documents'\)/);
    expect(src).toMatch(/reasonCode:\s*"audit_log_missing"|"search_documents_missing"/);
    expect(src).toMatch(/status:\s*"CRITICAL"[\s\S]*?audit_log_missing/);
  });

  it("DEGRADED when the free-text index that backs the query path is missing", () => {
    // ADM-013 PHASE 6 — INVERTED, with the reason.
    //
    // This pinned `reasonCode: "fts_column_missing"`, a DEGRADED that fired on
    // every environment and could never clear:
    //
    //   * 20260620100000_phase24_31_consolidated_drift_patches creates
    //     `evidence_search_documents.tsv` as a STORED generated column;
    //   * 20260925000000_phase0_schema_catchup then DROPS it, because it was
    //     generated by `prisma migrate diff --to-schema schema.prisma` and
    //     Prisma has no way to express a Postgres GENERATED column, so the diff
    //     reads it as drift;
    //   * no query reads it — evidence-search.service.ts runs free text through
    //     Prisma `contains`, which is ILIKE, and says so in its own comment.
    //
    // So the probe reported a fault about a PLAN rather than about the
    // platform, permanently. A DEGRADED that cannot clear teaches operators
    // that DEGRADED means nothing, which is the more expensive defect.
    //
    // What IS worth probing is the index that backs the query path that
    // exists. Its absence is real, clearable, and makes every free-text query
    // a sequential scan.
    expect(src).toMatch(/reasonCode:\s*[^"]*"free_text_index_missing"/);
    expect(src).toMatch(/status:\s*"DEGRADED"[\s\S]*?free_text_index_missing/);
    // The probed object must be one the canonical chain actually creates.
    // Verified against a clean PostgreSQL 16 database with all migrations
    // applied: this index is present and `tsv` is not.
    expect(src).toMatch(/evidence_search_documents_searchable_text_trgm_idx/);
    // The unclearable arm must not come back.
    expect(src).not.toMatch(/reasonCode:\s*[^"]*"fts_column_missing"/);
  });

  it("CRITICAL when indexing lag exceeds 24h, DEGRADED when over 30 min", () => {
    expect(src).toMatch(
      /SEARCH_INDEXING_LAG_DEGRADED_SECONDS\s*=\s*30 \* 60/,
    );
    expect(src).toMatch(
      /SEARCH_INDEXING_LAG_CRITICAL_SECONDS\s*=\s*24 \* 60 \* 60/,
    );
    expect(src).toMatch(/reasonCode:\s*"indexing_lag_critical"/);
    expect(src).toMatch(/"indexing_lag_degraded"/);
  });

  it("UNKNOWN when the readiness probe itself fails (never silent HEALTHY)", () => {
    expect(src).toMatch(/status:\s*"UNKNOWN"[\s\S]*?readiness_probe_failed/);
  });

  it("never leaks secret values in the metadata bag", () => {
    // The metadata bag bounded to safe primitives only.
    expect(src).not.toMatch(/process\.env\.[A-Z_]+_TOKEN/);
    expect(src).not.toMatch(/process\.env\.[A-Z_]+_SECRET/);
  });
});

// =============================================================================
// Worker processor — started event
// =============================================================================

describe("Phase 24-B — worker emits a started event for upstream metrics", () => {
  const src = readSource(
    "../../../services/worker/src/search-indexing.processor.ts",
  );

  it("emits worker.search.indexing.started on every job receipt", () => {
    expect(src).toMatch(/"worker\.search\.indexing\.started"/);
  });

  it("the started event carries attempt + kind + teamId for correlation", () => {
    expect(src).toMatch(
      /"worker\.search\.indexing\.started"[\s\S]*?attempt: job\.attemptsMade \+ 1|attempt: job\.attemptsMade \+ 1[\s\S]*?"worker\.search\.indexing\.started"/,
    );
  });

  it("never logs the raw OCR or transcript text in structured events", () => {
    // Phase 25 rewired the worker to consume OCR + transcript text via
    // raw SQL (`SELECT "text" FROM evidence_ocr_text WHERE …`) and
    // feed it into the shared projection builder. The column-name
    // reference inside the SQL string is legitimate; what we forbid
    // is shipping the raw text out via a logger call. We assert two
    // hard rules:
    //   1. No `logger.<level>(...)` call body contains a `text:` field
    //      (which would be a destructured row field being logged).
    //   2. No worker code reads `r.text` / `row.text` / `job.data.text`
    //      OUTSIDE the SQL projection / shared builder feed.
    const loggerCalls = src.match(/logger\.\w+\([\s\S]*?\)/g) ?? [];
    for (const call of loggerCalls) {
      expect(call, `logger call leaks raw text field: ${call}`).not.toMatch(
        /\btext:\s/,
      );
    }
    // Direct reads of row.text outside the extractedTextChunks build
    // path are forbidden. The shared builder consumes the chunks via
    // the typed `extractedTextChunks` array.
    expect(src).not.toMatch(/job\.data\.text/);
  });
});

// =============================================================================
// Observability dashboard — search_indexing summary tile
// =============================================================================

describe("Phase 24-B — observability dashboard surfaces a Search indexing tile", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/admin/platform/observability/page.tsx",
  );

  it("reads the search_indexing subsystem from the readiness payload", () => {
    expect(src).toMatch(
      /readiness\?\.subsystems\.find\(\(s\) => s\.id === "search_indexing"\)/,
    );
  });

  it("renders a `Search indexing` SummaryTile alongside the existing operational tiles", () => {
    expect(src).toMatch(/label="Search indexing"/);
  });

  it("the tile uses the same severity tone vocabulary as Worker / Queue tiles", () => {
    // Same status → tone mapping pattern (CRITICAL → critical, DEGRADED
    // → warning, UNKNOWN → unknown, HEALTHY → healthy).
    const slice = src.slice(
      src.indexOf('label="Search indexing"'),
      src.indexOf('label="Search indexing"') + 900,
    );
    expect(slice).toMatch(
      /status === "CRITICAL"[\s\S]*?"critical"[\s\S]*?"DEGRADED"[\s\S]*?"warning"/,
    );
  });
});

// =============================================================================
// Metric catalog
// =============================================================================

describe("Phase 24-B — metric catalog completeness", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/ops/metrics.service.ts",
  );

  it("registers the full Phase 24-B operational counters", () => {
    for (const counter of [
      "search_executed_total",
      "search_result_returned_total",
      "search_governance_filtered_total",
      "search_visibility_filtered_total",
      "search_fail_closed_engaged_total",
      "search_audit_log_written_total",
      "search_audit_log_write_failed_total",
      "search_indexing_enqueued_total",
      "search_indexing_started_total",
      "search_indexing_succeeded_total",
      "search_indexing_failed_total",
      "search_indexing_backlog",
      "search_indexing_lag_seconds",
      "search_ocr_text_recorded_total",
      "search_ocr_unindexed_rows",
      "search_transcript_segment_recorded_total",
      "search_transcript_unindexed_rows",
    ]) {
      expect(src, `metric ${counter} not registered`).toContain(
        `"${counter}"`,
      );
    }
  });
});

// =============================================================================
// Privacy invariants — the whole Discovery surface
// =============================================================================

describe("Phase 24-B — privacy + governance invariants across Discovery surfaces", () => {
  const SURFACES = [
    "../../../services/api/src/services/search/evidence-search.service.ts",
    "../../../services/api/src/services/search/evidence-indexing.service.ts",
    "../../../services/api/src/services/search/search-audit.service.ts",
    // LEGACY-003: ocr-foundations / transcript-foundations were REMOVED as
    // unreachable writers. A scan list naming a deleted file proves nothing —
    // their final disposition is asserted below instead.
    "../../../services/api/src/queue/search-queue.ts",
    "../../../services/worker/src/search-indexing.processor.ts",
    "../../../services/api/src/runtime/runtime-readiness.ts",
  ];

  it("no Discovery surface references privateReviewerNote in executable code (doc-comments allowed)", () => {
    for (const rel of SURFACES) {
      const src = readSource(rel);
      // Strip doc-comments + line-comments before checking. The
      // indexer service legitimately documents the privateReviewerNote
      // invariant in its top-of-file rule block; the rule is "no
      // *executable* reference", not "no mention".
      const noComments = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      expect(
        noComments,
        `${rel} references privateReviewerNote in executable code`,
      ).not.toContain("privateReviewerNote");
    }
  });

  it("no Discovery surface references legal-note bodies (legalNoteBody / legal_note_body)", () => {
    for (const rel of SURFACES) {
      const src = readSource(rel);
      expect(src, `${rel} references legalNoteBody`).not.toMatch(
        /legalNoteBody|legal_note_body/,
      );
    }
  });

  it("no Discovery surface references storage keys / signed URLs / GPS coordinates", () => {
    for (const rel of SURFACES) {
      const src = readSource(rel);
      expect(src, `${rel} references storage keys`).not.toMatch(
        /\bstorageKey\b|\bsigned_url\b|\braw_gps\b|\bgpsCoordinates\b/,
      );
    }
  });

  it("no Discovery surface stores raw query text or raw IP in the SQL", () => {
    for (const rel of SURFACES) {
      const src = readSource(rel);
      expect(src, `${rel} writes raw query_text`).not.toMatch(/"query_text"/);
      expect(src, `${rel} writes raw ip_address`).not.toMatch(/"ip_address"/);
    }
  });

  it("audit row writer never persists OTPs, passwords, tokens, or session ids", () => {
    const src = readSource(
      "../../../services/api/src/services/search/search-audit.service.ts",
    );
    expect(src).not.toMatch(
      /password|otp|sessionToken|api_token|JWT|access_token/i,
    );
  });

  // LEGACY-003 (2026-08-15) — this test used to assert that the OCR and
  // transcript foundations read fail-closed (TEAM scope + non-redacted).
  // Both modules were REMOVED: they were the ONLY inserters into
  // `evidence_ocr_text` / `evidence_transcript_segments`, they were
  // unreachable from every runtime entrypoint, and the canonical text surface
  // is `evidence_extracted_texts`. Asserting a fail-closed predicate inside a
  // deleted file would be a control over nothing, so the assertion is replaced
  // by the invariant that actually protects those tables now: nothing writes
  // them. If a future change re-introduces a writer, it must come with its own
  // fail-closed proof rather than inheriting this one.
  it("the superseded OCR/transcript foundations stay removed and unwritten", () => {
    for (const rel of [
      "../../../services/api/src/services/search/ocr-foundations.service.ts",
      "../../../services/api/src/services/search/transcript-foundations.service.ts",
    ]) {
      expect(
        existsSync(fileURLToPath(new URL(rel, import.meta.url))),
        `${rel} is REMOVED (LEGACY-003) and must not return`,
      ).toBe(false);
    }

    // The worker still stamps `indexed_at_utc` on any rows that exist — that
    // is a lag pointer, not a writer, and it tolerates matching none.
    const inserters = PRODUCTION_SOURCES.filter((file) =>
      /INSERT\s+INTO\s+"(evidence_ocr_text|evidence_transcript_segments)"/i.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(inserters).toEqual([]);
  });

  it("Discovery surfaces never use banned wording (tamper / forged / altered content)", () => {
    const banned =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    for (const rel of SURFACES) {
      const src = readSource(rel);
      const literals = src.match(/"[^"\n]+"/g) ?? [];
      expect(literals.join(" "), `banned wording in ${rel}`).not.toMatch(
        banned,
      );
    }
  });

  it("no Discovery surface fabricates operational counters", () => {
    for (const rel of SURFACES) {
      const src = readSource(rel);
      expect(src).not.toMatch(/escalations:\s*\d+,/);
      expect(src).not.toMatch(/incidents:\s*\d+,/);
      expect(src).not.toMatch(/overdue:\s*\d+,/);
    }
  });
});

// =============================================================================
// Workspace isolation
// =============================================================================

describe("Phase 24-B — workspace isolation invariant", () => {
  it("evidence-search service anchors every Prisma query on teamId", () => {
    const src = readSource(
      "../../../services/api/src/services/search/evidence-search.service.ts",
    );
    // Every `where` clause includes `teamId`.
    expect(src).toMatch(
      /where:\s*prismaPkg\.Prisma\.EvidenceSearchDocumentWhereInput\s*=\s*\{\s*teamId:\s*filter\.teamId/,
    );
  });

  it("relationship discovery refuses cross-team reads (anti-enumeration)", () => {
    const src = readSource(
      "../../../services/api/src/services/search/evidence-search.service.ts",
    );
    expect(src).toMatch(
      /client\.evidence\.findFirst\(\{\s*where:\s*\{\s*id:\s*input\.evidenceId,\s*teamId:\s*input\.teamId/,
    );
    // Returns empty array on team mismatch (never a 403 echo that
    // proves the record exists).
    expect(src).toMatch(/if \(!ev\) return \[\]/);
  });

  it("relationship CREATE refuses when source or target evidence belongs to a different team", () => {
    const src = readSource(
      "../../../services/api/src/services/search/evidence-search.service.ts",
    );
    expect(src).toMatch(
      /Promise\.all\(\[\s*client\.evidence\.findFirst\(\{[\s\S]*?id:\s*input\.sourceEvidenceId,\s*teamId:\s*input\.teamId/,
    );
    expect(src).toMatch(/if \(!src \|\| !tgt\) return null/);
  });
});
