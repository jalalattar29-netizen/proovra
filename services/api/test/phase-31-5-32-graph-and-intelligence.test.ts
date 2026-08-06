/**
 * Phase 31.5 + 32 — Media intelligence completion + investigation graph.
 *
 * Nine layers of coverage:
 *
 *   1. **SQL drift patches** — runs table + graph nodes/edges/manual
 *      relationships are bounded by CHECK constraints, idempotent,
 *      and team-anchored.
 *
 *   2. **Run tracker** — bounded vocabularies, bounded retry,
 *      error-summary sanitization (no stack traces, no URLs).
 *
 *   3. **Enhanced analyzer signals** — VIDEO_DURATION /
 *      AUDIO_METADATA / SIMILAR_FILE_CANDIDATE / OCR_AVAILABLE /
 *      TRANSCRIPT_AVAILABLE all emit safe wording.
 *
 *   4. **Acknowledge/dismiss endpoint** — bounded action vocabulary,
 *      anti-enumeration team check, server-clock acknowledged_at.
 *
 *   5. **Graph catalog** — bounded node kinds + edge types + manual
 *      edge types + traversal depth caps.
 *
 *   6. **Graph builder** — read-only against domain, never throws,
 *      idempotent upserts, stale-edge sweep, team-anchored.
 *
 *   7. **Graph traversal** — bounded depth, bounded result size,
 *      truncated flag, stale-edge filtering, anti-enumeration.
 *
 *   8. **Graph routes** — authorizeOrFail + anti-enumeration +
 *      bounded manual edge vocabulary + self-loop refusal +
 *      anti-leak projection.
 *
 *   9. **Observability + reconciliation wiring** — new counters
 *      registered, runtime subsystem registered, reconcile cron
 *      calls reconcileTeamGraph per-team bounded.
 *
 *  10. **Anti-leak** — no graph code returns storage_key /
 *      multipart_upload_id / signed URLs / raw GPS / private notes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MEDIA_INTELLIGENCE_RUN_KINDS,
  MEDIA_INTELLIGENCE_RUN_STATUSES,
} from "../src/services/media-intelligence/run-tracker.service.js";
import {
  GRAPH_CONFIDENCES,
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_KINDS,
  GRAPH_SOURCE_KINDS,
  GRAPH_VISIBILITY_SCOPES,
  MANUAL_EDGE_TYPES,
  MAX_GRAPH_TRAVERSAL_DEPTH,
  MAX_GRAPH_NODES_PER_RESPONSE,
  MAX_GRAPH_EDGES_PER_RESPONSE,
} from "../src/services/graph/graph-catalog.js";
import {
  safeSummary,
  SIGNAL_METADATA,
} from "../src/services/media-intelligence/signal-catalog.js";
import { mimeFamily } from "../src/services/media-intelligence/analyzer.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — SQL drift patches
// =============================================================================

describe("Phase 31.5 — media_intelligence_runs SQL drift patch", () => {
  const sql = readSource(
    "../../../services/api/sql/drift-patches/2026-05-20-media-intelligence-runs.sql",
  );

  it("BEGIN/COMMIT for partial-state safety", () => {
    expect(sql).toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).toMatch(/^\s*COMMIT\s*;/m);
  });

  it("idempotent CREATE TABLE", () => {
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"media_intelligence_runs"/,
    );
  });

  it("kind CHECK constraint enumerates every catalog value (across all drift patches)", () => {
    // Catalog values may be added by later patches via ALTER TABLE
    // DROP/ADD CONSTRAINT (idempotent). The check is satisfied as long as SOME
    // drift patch in the directory contains the catalog value. Phase 31.8
    // added `extract_exif` via the evidence-part-exif-summaries patch.
    //
    // PHASE 12 — POINT 5: this assertion caught a REAL production defect, and
    // it is worth recording what it was rather than just extending the list.
    //
    // The constraint enumerated eight kinds while the worker implemented
    // twelve. `compute_perceptual_hashes`, `extract_ocr_azure`,
    // `extract_transcript_deepgram` and `extract_technical_metadata` were all
    // enqueued by real producers and all REJECTED by the database, so a run row
    // could not be created for them. That is the root cause behind the optional
    // `runId` on `enqueueMediaIntelligenceAnalysis`: the producer could not
    // create the durable row, so it was allowed to proceed without one, and
    // those jobs ran with nothing to record their state on.
    //
    // The test only started failing when Point 5 widened
    // MEDIA_INTELLIGENCE_RUN_KINDS to match what the worker actually does. The
    // drift was always there; the catalog had been narrowed to hide it.
    const exifPatch = readSource(
      "../../../services/api/sql/drift-patches/2026-05-20-evidence-part-exif-summaries.sql",
    );
    const point5Patch = readSource(
      "../../../services/api/sql/drift-patches/2026-08-04-media-intelligence-kind-catalog.sql",
    );
    const combined = [sql, exifPatch, point5Patch].join("\n");
    for (const kind of MEDIA_INTELLIGENCE_RUN_KINDS) {
      expect(combined, `kind ${kind} missing from any drift patch`).toMatch(
        new RegExp(`'${kind}'`),
      );
    }
  });

  it("the widened CHECK is a strict SUPERSET — no historical row can be orphaned", () => {
    // Narrowing a CHECK constraint on a table with history is a data-loss
    // event dressed as a cleanup: existing rows become unreadable through any
    // path that revalidates. `compute_duplicates` and `compute_lineage` have no
    // producer and no queue, and are retained for exactly this reason.
    const point5Patch = readSource(
      "../../../services/api/sql/drift-patches/2026-08-04-media-intelligence-kind-catalog.sql",
    );
    const previous = [
      "analyze_metadata",
      "extract_exif",
      "extract_assets",
      "compute_duplicates",
      "compute_lineage",
      "wire_ocr_transcript",
      "reindex",
      "reconcile",
    ];
    for (const kind of previous) {
      expect(point5Patch, `${kind} was dropped from the constraint`).toMatch(
        new RegExp(`'${kind}'`),
      );
    }
  });

  it("status CHECK constraint matches the run-tracker vocabulary", () => {
    expect(sql).toMatch(
      /CHECK \("status" IN \('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DISMISSED'\)\)/,
    );
  });

  it("attempt_count is bounded to [0, 5]", () => {
    expect(sql).toMatch(
      /CHECK \("attempt_count" >= 0 AND "attempt_count" <= 5\)/,
    );
  });

  it("last_error bounded to 400 chars (DB defense)", () => {
    expect(sql).toMatch(/"last_error"\s+VARCHAR\(400\)/);
  });

  it("idempotency unique index per-team when key present", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "media_intelligence_runs_team_idemp_uk"[\s\S]*?WHERE "idempotency_key" IS NOT NULL/,
    );
  });
});

describe("Phase 32 — investigation-graph SQL drift patch", () => {
  const sql = readSource(
    "../../../services/api/sql/drift-patches/2026-05-20-investigation-graph.sql",
  );

  it("creates all three tables idempotently", () => {
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"investigation_graph_nodes"/,
    );
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"investigation_graph_edges"/,
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS\s+"manual_relationships"/);
  });

  it("node_kind CHECK matches the catalog exactly", () => {
    for (const kind of GRAPH_NODE_KINDS) {
      expect(sql, `node_kind ${kind} missing`).toMatch(
        new RegExp(`'${kind}'`),
      );
    }
  });

  it("edge_type CHECK matches the catalog exactly", () => {
    for (const t of GRAPH_EDGE_TYPES) {
      expect(sql, `edge_type ${t} missing`).toMatch(new RegExp(`'${t}'`));
    }
  });

  it("manual_relationships edge_type restricted to MANUAL_EDGE_TYPES subset", () => {
    // Check enum values may span multiple lines; verify both
    // values appear inside the constraint declaration.
    expect(sql).toMatch(
      /CONSTRAINT "manual_relationships_edge_type_bounded"[\s\S]*?CHECK[\s\S]*?'REFERENCES_SAME_INCIDENT'[\s\S]*?'MANUALLY_LINKED_TO'/,
    );
  });

  it("upsert keys: nodes (team, kind, ext), edges (team, src, tgt, type)", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "investigation_graph_nodes_team_kind_ext_uk"/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "investigation_graph_edges_team_triple_uk"/,
    );
  });

  it("traversal indexes are stale-aware (partial on stale_at_utc IS NULL)", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "investigation_graph_edges_outbound_idx"[\s\S]*?WHERE "stale_at_utc" IS NULL/,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "investigation_graph_edges_inbound_idx"[\s\S]*?WHERE "stale_at_utc" IS NULL/,
    );
  });

  it("edges cascade on node delete", () => {
    expect(sql).toMatch(
      /REFERENCES "investigation_graph_nodes"\("id"\) ON DELETE CASCADE/,
    );
  });
});

// =============================================================================
// PART 2 — Run tracker source contract
// =============================================================================

describe("Phase 31.5 — run tracker", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/media-intelligence/run-tracker.service.ts",
  );

  it("bounded run kinds match the brief catalog", () => {
    for (const expected of [
      "analyze_metadata",
      "extract_assets",
      "compute_duplicates",
      "compute_lineage",
      "wire_ocr_transcript",
      "reindex",
      "reconcile",
    ]) {
      expect(MEDIA_INTELLIGENCE_RUN_KINDS).toContain(expected as never);
    }
  });

  it("bounded statuses are UPPER_SNAKE_CASE", () => {
    for (const s of MEDIA_INTELLIGENCE_RUN_STATUSES) {
      expect(s).toMatch(/^[A-Z][A-Z_]+$/);
    }
  });

  it("MAX_RETRIES is bounded to 5", () => {
    expect(src).toMatch(/MAX_RETRIES\s*=\s*5/);
  });

  it("markRunFailed strips newlines + URLs + bounds error to 240 chars", () => {
    expect(src).toMatch(/replace\(\/\[\\n\\r\\t\]\/g/);
    expect(src).toMatch(/replace\(\/https\?:\\\/\\\/\[\^\\s\]\+\/g/);
    expect(src).toMatch(/\.slice\(0,\s*240\)/);
  });

  it("idempotency check runs BEFORE insert", () => {
    const enqueueBlock = src.match(
      /enqueueMediaIntelligenceRun[\s\S]*?return\s*\{[\s\S]*?ok:\s*false,\s*reason:\s*"tracker_unavailable"/,
    )?.[0];
    expect(enqueueBlock).toBeTruthy();
    const reuseIdx = enqueueBlock!.indexOf("WHERE \"team_id\" = $1 AND \"idempotency_key\"");
    const insertIdx = enqueueBlock!.indexOf("INSERT INTO \"media_intelligence_runs\"");
    expect(reuseIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(reuseIdx).toBeLessThan(insertIdx);
  });

  it("markRunProcessing refuses when attempt_count >= MAX_RETRIES", () => {
    expect(src).toMatch(/"attempt_count" < \$3/);
    expect(src).toMatch(/max_retries_exceeded/);
  });

  it("NEVER throws — every public function returns a bounded result", () => {
    // Every exported async function wraps its body in try/catch.
    const fnHeaders =
      src.match(/export async function \w+\([\s\S]*?\): Promise<[\s\S]*?>/g) ?? [];
    expect(fnHeaders.length).toBeGreaterThanOrEqual(5);
    for (const header of fnHeaders) {
      // The function body must contain a try { ... } catch { ... } pattern.
      const fnName = header.match(/export async function (\w+)/)?.[1];
      expect(fnName).toBeTruthy();
      const fnBlock = src.match(
        new RegExp(`export async function ${fnName}[\\s\\S]*?^\\}`, "m"),
      )?.[0];
      expect(fnBlock, `${fnName} body not found`).toBeTruthy();
      expect(fnBlock!, `${fnName} missing try`).toMatch(/try\s*\{/);
      expect(fnBlock!, `${fnName} missing catch`).toMatch(/\}\s*catch\s*[{(]/);
    }
  });
});

// =============================================================================
// PART 3 — Enhanced analyzer signals
// =============================================================================

describe("Phase 31.5 — enhanced analyzer signals", () => {
  const forbidden =
    /\b(tamper(ed|ing)?|forged|forgery|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored|verified as real|identity confirmed|proof of)\b/i;

  it("VIDEO_DURATION_OBSERVATION wording is bounded + advisory", () => {
    const out = safeSummary({
      type: "VIDEO_DURATION_OBSERVATION",
      durationSeconds: 125,
    });
    expect(out).toMatch(/duration/i);
    expect(out).toMatch(/advisory/i);
    expect(out).not.toMatch(forbidden);
    expect(out.length).toBeLessThanOrEqual(240);
  });

  it("AUDIO_METADATA_OBSERVATION wording is bounded + advisory", () => {
    const out = safeSummary({
      type: "AUDIO_METADATA_OBSERVATION",
      family: "audio/mp3",
    });
    expect(out).toMatch(/audio/i);
    expect(out).toMatch(/advisory/i);
    expect(out).not.toMatch(forbidden);
  });

  it("SIMILAR_FILE_CANDIDATE explicitly uses 'candidate' (per brief)", () => {
    const out = safeSummary({
      type: "SIMILAR_FILE_CANDIDATE",
      otherMaterialCount: 2,
    });
    expect(out).toMatch(/candidate/i);
    expect(out).toMatch(/review recommended/i);
    expect(out).not.toMatch(forbidden);
  });

  it("VIDEO_DURATION_OBSERVATION / AUDIO_METADATA_OBSERVATION / SIMILAR_FILE_CANDIDATE marked implemented in catalog", () => {
    expect(SIGNAL_METADATA.VIDEO_DURATION_OBSERVATION.implemented).toBe(true);
    expect(SIGNAL_METADATA.AUDIO_METADATA_OBSERVATION.implemented).toBe(true);
    expect(SIGNAL_METADATA.SIMILAR_FILE_CANDIDATE.implemented).toBe(true);
  });

  it("mimeFamily classifies common types + returns null on garbage", () => {
    expect(mimeFamily("image/jpeg")).toBe("image");
    expect(mimeFamily("video/mp4")).toBe("video");
    expect(mimeFamily("audio/mp3")).toBe("audio");
    expect(mimeFamily("application/pdf")).toBe("application");
    expect(mimeFamily("")).toBeNull();
    expect(mimeFamily("not-a-mime")).toBeNull();
    expect(mimeFamily("custom/x-foo")).toBeNull();
  });

  it("analyzer source emits the 4 new signal types + OCR/transcript", () => {
    const src = readSource(
      "../../../packages/shared-runtime/src/media-intelligence/analyzer.service.ts",
    );
    for (const sigType of [
      "SIMILAR_FILE_CANDIDATE",
      "VIDEO_DURATION_OBSERVATION",
      "AUDIO_METADATA_OBSERVATION",
      "OCR_AVAILABLE",
      "TRANSCRIPT_AVAILABLE",
    ]) {
      expect(src, `analyzer doesn't emit ${sigType}`).toContain(
        `signalType: "${sigType}"`,
      );
    }
  });

  it("OCR / TRANSCRIPT availability check queries the existing intelligence-jobs table (no new infra)", () => {
    const src = readSource(
      "../../../packages/shared-runtime/src/media-intelligence/analyzer.service.ts",
    );
    expect(src).toMatch(/FROM "evidence_intelligence_jobs"/);
    expect(src).toMatch(/"kind" = \$2::"EvidenceIntelligenceJobKind"/);
    // Status filter excludes FAILED + SKIPPED (only PENDING/PROCESSING/COMPLETED count).
    expect(src).toMatch(/IN \('PENDING', 'PROCESSING', 'COMPLETED'\)/);
  });

  it("SIMILAR_FILE_CANDIDATE query excludes exact-hash duplicates (no double-counting)", () => {
    const src = readSource(
      "../../../packages/shared-runtime/src/media-intelligence/analyzer.service.ts",
    );
    expect(src).toMatch(
      /findSimilarFilenameSizeCount[\s\S]*?ep\."sha256" IS NULL OR ep\."sha256" <> COALESCE/,
    );
  });
});

// =============================================================================
// PART 4 — Acknowledge / dismiss endpoint
// =============================================================================

describe("Phase 31.5 — signal action endpoint", () => {
  const src = readSource(
    "../../../services/api/src/routes/media-intelligence.routes.ts",
  );

  it("declares POST /v1/media-intelligence/signals/:signalId/action", () => {
    expect(src).toMatch(
      /app\.post\(\s*"\/v1\/media-intelligence\/signals\/:signalId\/action"/,
    );
  });

  it("action enum bounded to ACKNOWLEDGED | DISMISSED (no CONFIRMED/PROVEN)", () => {
    expect(src).toMatch(
      /action:\s*z\.enum\(\["ACKNOWLEDGED",\s*"DISMISSED"\]\)/,
    );
  });

  it("anti-enumeration: signal not in caller's team → 404 not_found", () => {
    expect(src).toMatch(
      /owner\[0\]!\.team_id !== body\.teamId[\s\S]*?reply\.code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"\s*\}/,
    );
  });

  it("acknowledged_at_utc uses NOW() server clock (never client clock)", () => {
    expect(src).toMatch(/"acknowledged_at_utc"\s*=\s*NOW\(\)/);
  });

  it("ack route requires evidence.update_metadata + authorizeOrFail antiEnumeration", () => {
    const ackBlock = src.match(
      /"\/v1\/media-intelligence\/signals\/:signalId\/action"[\s\S]*?\}\s*,\s*\)\s*;/,
    )?.[0];
    expect(ackBlock).toBeTruthy();
    expect(ackBlock!).toMatch(/permission:\s*"evidence\.update_metadata"/);
    expect(ackBlock!).toMatch(/antiEnumeration:\s*true/);
  });

  it("bumps the media_signal_acknowledged_total counter", () => {
    expect(src).toContain('bump("media_signal_acknowledged_total")');
  });
});

// =============================================================================
// PART 5 — Graph catalog
// =============================================================================

describe("Phase 32 — graph catalog", () => {
  it("node kinds match the brief + Phase 13 + Wave 1 renames + deferred kinds (25 entries)", () => {
    // Phase 32 brief had 14 entries. Phase 13 (#300) widened with ENTITY
    // (→ 15). Wave 1 taxonomy adds 5 canonical renames (kept as aliases:
    // REVIEW_TASK/ESCALATION/EXTERNAL_REVIEW/MEDIA_SIGNAL/ENTITY) + 5
    // deferred kinds with no producer (EVIDENCE_PART / CASE_EVIDENCE_LINK
    // / REVIEW_DECISION / MEDIA_INTELLIGENCE_RECORD / CUSTODY_EVENT) for
    // a total of 15 + 10 = 25. Catalog + SQL CHECK + this pin stay in
    // lockstep.
    expect(GRAPH_NODE_KINDS.length).toBe(25);
    for (const expected of [
      "EVIDENCE",
      "CASE",
      "INCIDENT",
      // Wave 1 canonical + deprecated alias.
      "REVIEW_WORKFLOW",
      "REVIEW_TASK",
      "REVIEW_ESCALATION",
      "ESCALATION",
      "LEGAL_HOLD",
      "EXPORT",
      "REPORT",
      "VERIFICATION_PACKAGE",
      "MEDIA_INTELLIGENCE_SIGNAL",
      "MEDIA_SIGNAL",
      "OCR",
      "TRANSCRIPT",
      "EXTERNAL_REVIEWER_GRANT",
      "EXTERNAL_REVIEW",
      "USER_CREATED_ENTITY",
      "EXTRACTED_ENTITY",
      // Phase 13 — extracted-entity legacy alias.
      "ENTITY",
      // Wave 1 deferred — no producer.
      "EVIDENCE_PART",
      "CASE_EVIDENCE_LINK",
      "REVIEW_DECISION",
      "MEDIA_INTELLIGENCE_RECORD",
      "CUSTODY_EVENT",
    ]) {
      expect(GRAPH_NODE_KINDS).toContain(expected as never);
    }
  });

  it("edge types match the brief + Phase 13 EXTRACTED_FROM + Wave 1 deferred edges (21 entries)", () => {
    // Phase 32 brief had 16 entries. Phase 13 (#300) widened with
    // EXTRACTED_FROM (→ 17). Wave 1 taxonomy adds 4 deferred edge types
    // with no producer (HAS_PART / HAS_REVIEW_DECISION / HAS_MEDIA_RECORD
    // / HAS_CUSTODY_EVENT) for a total of 17 + 4 = 21. Catalog + SQL
    // CHECK + this pin stay in lockstep.
    expect(GRAPH_EDGE_TYPES.length).toBe(21);
    for (const expected of [
      "BELONGS_TO_CASE",
      "CAPTURED_IN_SESSION",
      "SAME_HASH_AS",
      "SIMILAR_TO",
      "POSSIBLE_DERIVATIVE_OF",
      "REFERENCES_SAME_INCIDENT",
      "REVIEWED_BY",
      "ESCALATED_FROM",
      "BLOCKED_BY_LEGAL_HOLD",
      "EXPORTED_AS",
      "GENERATED_REPORT",
      "GENERATED_PACKAGE",
      "HAS_MEDIA_SIGNAL",
      "HAS_TRANSCRIPT",
      "HAS_OCR",
      "MANUALLY_LINKED_TO",
      // Phase 13 — ENTITY → EVIDENCE edge.
      "EXTRACTED_FROM",
      // Wave 1 deferred — no producer.
      "HAS_PART",
      "HAS_REVIEW_DECISION",
      "HAS_MEDIA_RECORD",
      "HAS_CUSTODY_EVENT",
    ]) {
      expect(GRAPH_EDGE_TYPES).toContain(expected as never);
    }
  });

  it("manual edge types restricted to two operator-creatable kinds", () => {
    expect([...MANUAL_EDGE_TYPES]).toEqual([
      "REFERENCES_SAME_INCIDENT",
      "MANUALLY_LINKED_TO",
    ]);
  });

  it("source kinds are bounded SYSTEM | MANUAL", () => {
    expect([...GRAPH_SOURCE_KINDS]).toEqual(["SYSTEM", "MANUAL"]);
  });

  it("confidence + visibility scopes are UPPER_SNAKE_CASE", () => {
    for (const v of [...GRAPH_CONFIDENCES, ...GRAPH_VISIBILITY_SCOPES]) {
      expect(v).toMatch(/^[A-Z][A-Z_]+$/);
    }
  });

  it("traversal depth + result caps are bounded constants", () => {
    expect(MAX_GRAPH_TRAVERSAL_DEPTH).toBe(3);
    expect(MAX_GRAPH_NODES_PER_RESPONSE).toBeLessThanOrEqual(1000);
    expect(MAX_GRAPH_EDGES_PER_RESPONSE).toBeLessThanOrEqual(5000);
  });
});

// =============================================================================
// PART 6 — Graph builder source contract
// =============================================================================

describe("Phase 32 — graph builder source contract", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/graph/graph-builder.service.ts",
  );
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("READ-ONLY against Evidence (no .update / .delete on prisma.evidence)", () => {
    expect(noComments).not.toMatch(/client\.evidence\.update/);
    expect(noComments).not.toMatch(/client\.evidence\.delete/);
    expect(noComments).not.toMatch(/prisma\.evidence\.update/);
  });

  it("READ-ONLY against EvidencePart", () => {
    expect(noComments).not.toMatch(/client\.evidencePart\.(update|delete)/);
  });

  it("reconcileTeamGraph NEVER throws — top-level try/catch around the body", () => {
    expect(src).toMatch(
      /export async function reconcileTeamGraph[\s\S]*?try\s*\{[\s\S]*?\}\s*catch\s*\{/,
    );
  });

  it("every node/edge query is team-anchored (no cross-team traversal at builder layer)", () => {
    // Spot-check: the major queries filter by team_id.
    expect(src).toMatch(/WHERE\s+"team_id"\s*=\s*\$1/);
    expect(src).toMatch(/WHERE\s+e\."team_id"\s*=\s*\$1/);
  });

  it("SAME_HASH_AS dedup uses upper-triangle (id < id) to avoid duplicate edges", () => {
    expect(src).toMatch(/epa\."id" < epb\."id"/);
  });

  it("upsertNode + upsertEdge use ON CONFLICT for idempotency", () => {
    expect(src).toMatch(
      /INSERT INTO "investigation_graph_nodes"[\s\S]*?ON CONFLICT[\s\S]*?DO UPDATE SET/,
    );
    expect(src).toMatch(
      /INSERT INTO "investigation_graph_edges"[\s\S]*?ON CONFLICT[\s\S]*?DO UPDATE SET/,
    );
  });

  it("stale-edge sweep marks edges inactive (never DELETE)", () => {
    expect(src).toMatch(
      /UPDATE "investigation_graph_edges"\s*"?e"?[\s\S]*?SET "stale_at_utc" = NOW\(\)/,
    );
    // No DELETE against the edges table — audit trail preserved.
    expect(noComments).not.toMatch(/DELETE FROM "investigation_graph_edges"/);
  });

  it("bounds the dupe-pair join to LIMIT 200", () => {
    expect(src).toMatch(/DISTINCT epa\."evidence_id"[\s\S]*?LIMIT 200/);
  });

  it("manual relationship retraction marks audit row + stales edge (never deletes)", () => {
    expect(src).toMatch(
      /UPDATE "manual_relationships"\s*SET "status" = 'RETRACTED'/,
    );
    expect(noComments).not.toMatch(/DELETE FROM "manual_relationships"/);
  });
});

// =============================================================================
// PART 7 — Graph traversal
// =============================================================================

describe("Phase 32 — graph traversal", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/graph/graph-builder.service.ts",
  );

  it("depth clamped to [0, MAX_GRAPH_TRAVERSAL_DEPTH]", () => {
    expect(src).toMatch(
      /Math\.max\(\s*0,\s*Math\.min\(input\.depth \?\? 2,\s*MAX_GRAPH_TRAVERSAL_DEPTH\)/,
    );
  });

  it("traversal filters stale_at_utc IS NULL on edges + nodes", () => {
    expect(src).toMatch(/"stale_at_utc" IS NULL[\s\S]*?source_node_id/);
    expect(src).toMatch(
      /investigation_graph_nodes[\s\S]*?"stale_at_utc" IS NULL/,
    );
  });

  it("response is bounded by MAX_GRAPH_NODES_PER_RESPONSE + truncated flag", () => {
    expect(src).toMatch(/MAX_GRAPH_NODES_PER_RESPONSE/);
    expect(src).toMatch(/truncated\s*=\s*true/);
  });

  it("seed not found returns empty subgraph (anti-enumeration: same shape as 'no graph yet')", () => {
    expect(src).toMatch(
      /seedRows\.length === 0[\s\S]*?return\s*\{[\s\S]*?nodes:\s*\[\],\s*edges:\s*\[\]/,
    );
  });
});

// =============================================================================
// PART 8 — Graph routes
// =============================================================================

describe("Phase 32 — graph routes", () => {
  const src = readSource("../../../services/api/src/routes/graph.routes.ts");
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("registers all graph routes (Phase 32 base + Phase 32.5 additions)", () => {
    // Phase 32 base
    expect(src).toMatch(
      /app\.get\(\s*"\/v1\/graph\/evidence\/:evidenceId"/,
    );
    expect(src).toMatch(
      /app\.post\(\s*"\/v1\/graph\/relationships\/manual"/,
    );
    expect(src).toMatch(
      /app\.delete\(\s*"\/v1\/graph\/relationships\/manual\/:manualRelationshipId"/,
    );
    // Phase 32.5 additions
    expect(src).toMatch(/app\.get\(\s*"\/v1\/graph\/cases\/:caseId"/);
    expect(src).toMatch(/app\.get\(\s*"\/v1\/graph\/search"/);
    expect(src).toMatch(/app\.get\(\s*"\/v1\/graph\/timeline"/);
  });

  it("every route uses authorizeOrFail + antiEnumeration: true", () => {
    const authorizeCalls = src.match(
      /await authorizeOrFail\(\s*req,\s*reply,\s*\{[\s\S]*?\}\s*\)/g,
    ) ?? [];
    // Phase 32 base (3) + Phase 32.5 additions (3) = 6 +
    // Phase 31.18 additions: /v1/graph/duplicates + /v1/graph/seeds = 2.
    // Wave 2 Phase 2: + POST /v1/graph/duplicates/:edgeId/decision = 9.
    // Wave 1: + POST /v1/graph/reconcile = 10 (Wave 1 used its own
    // requireGraphAdminActor gate, not authorizeOrFail — confirm by reading
    // graph.routes.ts; the actual authorizeOrFail count here pins the
    // routes that route-authorize through the canonical helper).
    // Wave 2 Phase 6: + POST /v1/graph/export + POST /v1/graph/timeline/export
    // + POST /v1/graph/duplicates/export = 12. Each new export endpoint
    // authorizes via authorizeOrFail with evidence.read + antiEnumeration.
    expect(authorizeCalls.length).toBe(12);
    for (const c of authorizeCalls) {
      expect(c).toMatch(/antiEnumeration:\s*true/);
    }
  });

  it("GET uses evidence.read; POST/DELETE use evidence.update_metadata", () => {
    expect(src).toMatch(/permission:\s*"evidence\.read"/);
    const updates =
      src.match(/permission:\s*"evidence\.update_metadata"/g) ?? [];
    // Wave 1: POST /v1/graph/reconcile route added, which also requires
    // evidence.update_metadata — bumping expected count 2 → 3.
    // Wave 2 Phase 2: POST /v1/graph/duplicates/:edgeId/decision added,
    // bumping the expected count 3 → 4. Wave 2 Phase 6 added three new
    // graph endpoints (POST /v1/graph/export, POST /v1/graph/timeline/export,
    // POST /v1/graph/duplicates/export) — all three use evidence.read so
    // the update_metadata count stays at 4.
    expect(updates.length).toBe(4);
  });

  it("manual edge type restricted to MANUAL_EDGE_TYPES Zod enum", () => {
    expect(src).toMatch(/edgeType:\s*z\.enum\(MANUAL_EDGE_TYPES\)/);
  });

  it("POST refuses self-loop (source === target) with bounded 400 code", () => {
    expect(src).toMatch(
      /body\.sourceNodeId === body\.targetNodeId[\s\S]*?code:\s*"self_loop_not_allowed"/,
    );
  });

  it("safeNote bounded to <= 400 chars; reason bounded to <= 240 chars", () => {
    expect(src).toMatch(/safeNote:\s*z\.string\(\)\.min\(1\)\.max\(400\)/);
    expect(src).toMatch(/reason:\s*z\.string\(\)\.min\(1\)\.max\(240\)/);
  });

  it("response projection NEVER leaks raw timestamps / team / created_by / stale fields", () => {
    // PublicNode + PublicEdge shapes are explicitly narrow. Test
    // the projection helpers omit the internal fields.
    expect(noComments).toMatch(/type PublicNode\s*=\s*\{[\s\S]*?\};/);
    const publicNodeType = src.match(/type PublicNode\s*=\s*\{[\s\S]*?\};/)?.[0];
    expect(publicNodeType).toBeTruthy();
    expect(publicNodeType!).not.toContain("teamId");
    expect(publicNodeType!).not.toContain("externalId");
    expect(publicNodeType!).not.toContain("staleAtUtc");
    expect(publicNodeType!).not.toContain("createdAtUtc");
    const publicEdgeType = src.match(/type PublicEdge\s*=\s*\{[\s\S]*?\};/)?.[0];
    expect(publicEdgeType).toBeTruthy();
    expect(publicEdgeType!).not.toContain("teamId");
    expect(publicEdgeType!).not.toContain("createdByUserId");
    expect(publicEdgeType!).not.toContain("staleAtUtc");
  });

  it("self-loop check runs BEFORE authorizeOrFail (bounded body validation first)", () => {
    const postBlock = src.match(
      /"\/v1\/graph\/relationships\/manual"[\s\S]*?retractManual/,
    )?.[0];
    expect(postBlock).toBeTruthy();
    const selfLoopIdx = postBlock!.indexOf("self_loop_not_allowed");
    const authorizeIdx = postBlock!.indexOf("authorizeOrFail");
    expect(selfLoopIdx).toBeGreaterThan(-1);
    expect(authorizeIdx).toBeGreaterThan(selfLoopIdx);
  });
});

// =============================================================================
// PART 9 — Observability + reconciliation wiring
// =============================================================================

describe("Phase 32 — observability + reconciliation wiring", () => {
  const metricsSrc = readSource(
    "../../../packages/shared-runtime/src/ops/metrics.service.ts",
  );

  it("registers all new counters from the brief", () => {
    for (const m of [
      // Newly active
      "media_signal_acknowledged_total",
      "derived_asset_failed_total",
      "graph_node_created_total",
      "graph_reconcile_started_total",
      "graph_reconcile_completed_total",
      "graph_reconcile_failed_total",
      // Already in catalog from earlier phases
      "graph_edge_created_total",
      "graph_edge_removed_total",
      "graph_query_total",
      "graph_query_denied_total",
      "timeline_query_total",
    ]) {
      expect(metricsSrc, `counter ${m} missing`).toContain(`"${m}"`);
    }
  });

  it("runtime-readiness registers investigation_graph subsystem", () => {
    const src = readSource(
      "../../../services/api/src/runtime/runtime-readiness.ts",
    );
    expect(src).toMatch(/\| "investigation_graph"/);
    expect(src).toMatch(/checkInvestigationGraph/);
    expect(src).toMatch(/checkInvestigationGraph\(prisma\)/);
  });

  it("investigation_graph check never reports CRITICAL (advisory layer)", () => {
    const src = readSource(
      "../../../services/api/src/runtime/runtime-readiness.ts",
    );
    const fn = src.match(
      /async function checkInvestigationGraph\([\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).not.toMatch(/status:\s*"CRITICAL"/);
    expect(fn!).toMatch(/status:\s*"HEALTHY"/);
    expect(fn!).toMatch(/status:\s*"UNKNOWN"/);
  });

  it("master reconcile calls reconcileTeamGraph for bounded set of recent teams", () => {
    const src = readSource(
      "../../../services/api/src/routes/ops.routes.ts",
    );
    expect(src).toMatch(
      /prisma\.team\.findMany\(\{\s*orderBy:\s*\{\s*updatedAt:\s*"desc"\s*\},\s*take:\s*10/,
    );
    expect(src).toMatch(/reconcileTeamGraph\(t\.id\)/);
    // Each call wrapped in try/catch so one team's failure can't
    // block the others.
    expect(src).toMatch(
      /for\s*\(const t of recentTeams\)\s*\{[\s\S]*?try\s*\{[\s\S]*?reconcileTeamGraph[\s\S]*?\}\s*catch/,
    );
  });

  it("server.ts mounts the graph routes", () => {
    const src = readSource("../../../services/api/src/server.ts");
    expect(src).toMatch(/graphRoutes/);
    expect(src).toMatch(/app\.register\(graphRoutes\)/);
  });

  it("schema-validation registers all new tables + key indexes", () => {
    const src = readSource(
      "../../../services/api/src/runtime/schema-validation.ts",
    );
    expect(src).toContain('name: "media_intelligence_runs"');
    expect(src).toContain('name: "investigation_graph_nodes"');
    expect(src).toContain('name: "investigation_graph_edges"');
    expect(src).toContain('name: "manual_relationships"');
    expect(src).toContain('"investigation_graph_nodes_team_kind_ext_uk"');
    expect(src).toContain('"investigation_graph_edges_team_triple_uk"');
  });
});

// =============================================================================
// PART 10 — Anti-leak invariants
// =============================================================================

describe("Phase 31.5 + 32 — anti-leak invariants", () => {
  const allSources = [
    "../../../packages/shared-runtime/src/media-intelligence/run-tracker.service.ts",
    "../../../packages/shared-runtime/src/media-intelligence/analyzer.service.ts",
    "../../../packages/shared-runtime/src/graph/graph-builder.service.ts",
    "../../../packages/shared-runtime/src/graph/graph-catalog.ts",
    "../../../services/api/src/routes/graph.routes.ts",
    "../../../services/api/src/routes/media-intelligence.routes.ts",
  ].map(readSource);

  it("no module leaks storage internals / signed URLs / private notes / raw GPS", () => {
    for (let i = 0; i < allSources.length; i++) {
      const noComments = allSources[i]!
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const banned of [
        "storageBucket",
        "storage_bucket",
        "storageKey",
        "storage_key",
        "multipartUploadId",
        "multipart_upload_id",
        "signed_url",
        "signedUrl",
        "presignedUrl",
        "uploadUrl",
        "rawGps",
        "raw_gps",
        "gpsCoordinates",
        "privateReviewerNote",
        "legalNoteBody",
        "privateNote",
      ]) {
        expect(noComments, `source ${i} leaks ${banned}`).not.toContain(banned);
      }
    }
  });

  it("no forbidden truth-claim wording in any source string", () => {
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|verified as real|identity confirmed|manipulated|doctored)\b/i;
    for (let i = 0; i < allSources.length; i++) {
      const literals = allSources[i]!.match(/"[^"\n]+"/g) ?? [];
      for (const lit of literals) {
        expect(
          lit,
          `source ${i} string uses forbidden wording: ${lit}`,
        ).not.toMatch(forbidden);
      }
    }
  });

  it("no graph code uses ETag as integrity (no sha256 = etag pattern)", () => {
    for (let i = 0; i < allSources.length; i++) {
      const noComments = allSources[i]!
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      expect(noComments, `source ${i} treats ETag as hash`).not.toMatch(
        /sha256\w*\s*===\s*\w*[Ee][Tt]ag/,
      );
      expect(noComments, `source ${i} treats ETag as hash`).not.toMatch(
        /\w*[Ee][Tt]ag\s*===\s*sha256/,
      );
    }
  });
});
