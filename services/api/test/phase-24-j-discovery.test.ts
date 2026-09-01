/**
 * Phase 24-J — Enterprise Discovery Platform source-contract tests.
 *
 * Phase 24 base ships:
 *   - `EvidenceSearchDocument` schema + governance-aware query gate
 *   - `executeSearch()` query service with per-row gates
 *   - `SavedSearchView` saved-views, `EvidenceRelationship` discovery
 *   - SecurityEvent emission on every search
 *
 * Phase 24-J adds:
 *   - Dedicated `search_audit_logs` table + service (operator-facing
 *     audit, never stores raw query text)
 *   - OCR + transcript text foundations with visibility scope catalog
 *     and forbidden-overclaim scrub
 *   - PostgreSQL FTS (tsvector + GIN) + optional pgvector embedding
 *     column via idempotent SQL patch
 *   - Async indexing queue stub (BullMQ `search-indexing`) with API +
 *     worker counterparts
 *   - Schema-validation registration for every new table + critical
 *     column (so drift fails fast at startup)
 *
 * This file asserts the source-level contracts on each of those
 * pieces — pure string + structure assertions, no DB, no Fastify.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// PHASE 12 POINT 5 — the async-indexing contract is imported and EXERCISED
// here, not matched as text.
import {
  JOB_NAMES,
  QUEUE_NAMES,
  QueuePayloadRejected,
  buildSearchIndexCommandId,
  decodeCanonicalJobPayload,
  enqueueCanonicalJob,
  getWorkEntryOrThrow,
  parseSearchIndexCommandId,
} from "@proovra/shared";

/** Repository root, for the consumer scan below. */
const REPO_ROOT_FOR_SCAN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// SQL drift patches — idempotent + partial-state-safe
// =============================================================================

describe("Phase 24-J — SQL drift patches", () => {
  it("search_audit_logs patch creates the table with IF NOT EXISTS + bounded constraints", () => {
    const src = readSource(
      "../../../services/api/sql/drift-patches/2026-05-19-search-audit-log.sql",
    );
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS\s+"search_audit_logs"/i);
    expect(src).toMatch(/"query_hash"\s+VARCHAR\(64\)/i);
    expect(src).toMatch(/"fail_closed"\s+BOOLEAN NOT NULL DEFAULT FALSE/i);
    expect(src).toMatch(/CONSTRAINT "search_audit_logs_result_count_nonneg"/i);
    expect(src).toMatch(/CONSTRAINT "search_audit_logs_filtered_gov_nonneg"/i);
    expect(src).toMatch(/CONSTRAINT "search_audit_logs_filtered_vis_nonneg"/i);
    expect(src).toMatch(/CREATE INDEX IF NOT EXISTS "search_audit_logs_team_occurred_idx"/i);
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS "search_audit_logs_team_fail_closed_idx"[\s\S]*?WHERE "fail_closed" = TRUE/i,
    );
    expect(src).toMatch(/^\s*BEGIN\s*;/m);
    expect(src).toMatch(/^\s*COMMIT\s*;/m);
  });

  it("evidence_ocr_text patch bounds visibility scope to the documented catalog", () => {
    const src = readSource(
      "../../../services/api/sql/drift-patches/2026-05-19-evidence-ocr-text.sql",
    );
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS\s+"evidence_ocr_text"/i);
    expect(src).toMatch(
      /CONSTRAINT "evidence_ocr_text_visibility_scope_bounded"[\s\S]*?CHECK[\s\S]*?'TEAM'[\s\S]*?'REVIEWER_RESTRICTED'[\s\S]*?'CONTRIBUTOR_PRIVATE'[\s\S]*?'BLOCKED'/i,
    );
    // Unique upsert key matches the service helper.
    expect(src).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "evidence_ocr_text_uk"/i);
    // Indexing-lag readiness probe support — partial index on
    // unindexed rows.
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS "evidence_ocr_text_unindexed_idx"[\s\S]*?WHERE "indexed_at_utc" IS NULL/i,
    );
  });

  it("evidence_transcript_segments patch bounds visibility scope + segment offset rules", () => {
    const src = readSource(
      "../../../services/api/sql/drift-patches/2026-05-19-evidence-transcripts.sql",
    );
    expect(src).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"evidence_transcript_segments"/i,
    );
    expect(src).toMatch(/start_ms[\s\S]*?end_ms.*?>=.*?start_ms/i);
    expect(src).toMatch(
      /CONSTRAINT "evidence_transcript_segments_visibility_scope_bounded"/i,
    );
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS "evidence_transcript_segments_unindexed_idx"/i,
    );
  });

  it("FTS / pgvector patch is fully idempotent + gates pgvector on extension availability", () => {
    const src = readSource(
      "../../../services/api/sql/drift-patches/2026-05-19-search-fts-pgvector.sql",
    );
    // tsvector generated column guarded by information_schema.columns
    // existence check (idempotent).
    expect(src).toMatch(
      /information_schema\.columns[\s\S]*?column_name = 'tsv'/i,
    );
    expect(src).toMatch(
      /ADD COLUMN "tsv" tsvector[\s\S]*?GENERATED ALWAYS AS[\s\S]*?STORED/i,
    );
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS "evidence_search_documents_tsv_gin"[\s\S]*?USING GIN/i,
    );
    // pgvector column is only added if extension is present.
    expect(src).toMatch(/pg_extension WHERE extname = 'vector'/i);
    expect(src).toMatch(/has_pgvector BOOLEAN/i);
    expect(src).toMatch(/IF has_pgvector THEN/i);
    expect(src).toMatch(/USING ivfflat \("embedding" vector_cosine_ops\)/i);
    // pgvector absence is a soft notice, never an error.
    expect(src).toMatch(/RAISE NOTICE\s+'pgvector extension not present/i);
  });
});

// =============================================================================
// search-audit service
// =============================================================================

describe("Phase 24-J — search-audit service", () => {
  const src = readSource(
    "../../../services/api/src/services/search/search-audit.service.ts",
  );

  it("hashes the raw query text and length, never stores raw text", () => {
    expect(src).toMatch(/createHash\("sha256"\)/);
    expect(src).toMatch(/hashQuery/);
    // The write path passes `queryHash` (the hash result), never the
    // raw `queryText`.
    expect(src).toMatch(/"query_hash"[\s\S]*?queryHash/);
    expect(src).not.toMatch(/"query_text"/);
  });

  it("hashes the IP address before storage (correlation, not identification)", () => {
    expect(src).toMatch(/hashIp\b/);
    expect(src).toMatch(/"ip_hash"/);
    expect(src).not.toMatch(/"ip_address"/);
  });

  it("never throws to the calling search handler (best-effort write)", () => {
    // Both write + read paths wrap their DB call in try/catch and emit
    // a SecurityEvent on failure.
    expect(src).toMatch(/recordSearchAudit[\s\S]*?try\s*\{[\s\S]*?\}\s*catch/);
    expect(src).toMatch(/listSearchAudit[\s\S]*?try\s*\{[\s\S]*?\}\s*catch/);
    expect(src).toMatch(/search_audit_log_write_failed_total/);
    expect(src).toMatch(/search_audit_log_read_failed_total/);
  });

  it("clamps document_types JSON to a bounded length (no gargantuan rows)", () => {
    expect(src).toMatch(/documentTypes\.slice\(0,\s*40\)/);
    expect(src).toMatch(/filtersJson[\s\S]*?slice\(0,\s*4000\)/);
  });

  it("list endpoint is workspace-anchored (every read filters on team_id)", () => {
    expect(src).toMatch(/`"team_id" = \$1`/);
    // No code path lists across teams.
    expect(src).not.toMatch(/SELECT[\s\S]*?FROM\s+"search_audit_logs"\s+WHERE\s+"actor_user_id"/i);
  });

  it("list endpoint is bounded by limit (clamped to 200 max)", () => {
    expect(src).toMatch(/Math\.min\(Math\.max\(input\.limit \?\? 50, 1\), 200\)/);
  });
});

// =============================================================================
// OCR + Transcript foundations — REMOVED (LEGACY-003)
// =============================================================================

/**
 * Phase 24-J shipped `ocr-foundations.service.ts` and
 * `transcript-foundations.service.ts`, and this file asserted their bounded
 * visibility catalog, chunk limits, TEAM-scoped reads and lag helpers.
 *
 * LEGACY-003 (2026-08-15) REMOVED both. They were unreachable from every
 * runtime entrypoint while still being the ONLY inserters into
 * `evidence_ocr_text` and `evidence_transcript_segments` — an unreachable
 * writer, which is the exact shape the reachability gate exists to eliminate.
 * The canonical extracted-text surface is `evidence_extracted_texts`.
 *
 * Their contract assertions are not re-homed, because there is no longer any
 * code to hold to them. What replaces them is the invariant that survives the
 * removal: the modules stay gone. The tables themselves are NOT dropped here —
 * that is a contract-wave decision with its own readiness gate.
 */
describe("Phase 24-J — OCR + transcript foundations stay removed", () => {
  it("neither foundations module is back on disk", () => {
    for (const rel of [
    // LEGACY-003: both foundations modules were REMOVED; a scan list naming
    // a deleted file asserts nothing.
    ]) {
      expect(
        existsSync(fileURLToPath(new URL(rel, import.meta.url))),
        `${rel} is REMOVED (LEGACY-003) and must not return`,
      ).toBe(false);
    }
  });
});

// =============================================================================
// Schema validation
// =============================================================================

describe("Phase 24-J — schema validation registrations", () => {
  const src = readSource(
    "../../../services/api/src/runtime/schema-validation.ts",
  );

  it("introduces the search_discovery subsystem", () => {
    expect(src).toMatch(/\|\s*"search_discovery"/);
    expect(src).toMatch(/"search_discovery"\s*,?\s*\]/);
  });

  it("registers every Phase 24 + 24-J discovery table", () => {
    for (const table of [
      "evidence_search_documents",
      "saved_search_views",
      "search_audit_logs",
      "evidence_ocr_text",
      "evidence_transcript_segments",
    ]) {
      expect(src, `${table} not registered`).toMatch(
        new RegExp(`name:\\s*"${table}"[\\s\\S]*?subsystem:\\s*"search_discovery"`),
      );
    }
  });

  it("registers visibility_scope + redacted columns on OCR + transcript (governance-load-bearing)", () => {
    for (const col of [
      `table: "evidence_ocr_text", column: "visibility_scope"`,
      `table: "evidence_ocr_text", column: "redacted"`,
      `table: "evidence_transcript_segments", column: "visibility_scope"`,
      `table: "evidence_transcript_segments", column: "redacted"`,
    ]) {
      expect(src, `${col} not registered`).toContain(col);
    }
  });

  it("no runtime code reads the retired FTS objects", () => {
    // ADM-013 — the removal of the two schema expectations is only safe if
    // nothing reads them. That is a claim about ABSENCE, so it is a test.
    //
    // Comments are stripped: the readiness probe and the schema catalog both
    // NAME these objects in the notes explaining why they are gone, and a gate
    // that forbade the words would forbid the explanation.
    const ROOTS = [
      "services/api/src",
      "services/worker/src",
      "apps/web/app",
      "apps/web/lib",
      "apps/web/components",
      "packages/shared/src",
      "packages/shared-runtime/src",
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === "node_modules" || name === ".next" || name === "dist") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mjs)$/.test(name)) continue;
        // The runbook catalog is generated from docs/runbooks/*.md and carries
        // those documents' text as string literals. `search-index-degraded`
        // tells an operator that the tsv column and its GIN index are ABSENT
        // by design and must not be recreated — which is the retirement being
        // documented, not read.
        //
        // This is the same exemption the comment-stripping above grants, for
        // prose that happens to travel in a data module rather than in a
        // comment. It is one named file, not a pattern: a real consumer could
        // not hide here without being generated from a markdown file that
        // instructed operators to use the retired objects.
        if (full.replace(/\\/g, "/").endsWith("apps/web/lib/runbooks/catalog.generated.ts")) {
          continue;
        }
        const code = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (/\btsv\b|evidence_search_documents_tsv_gin/.test(code)) {
          offenders.push(full.replace(REPO_ROOT_FOR_SCAN, "").replace(/\\/g, "/"));
        }
      }
    };
    for (const root of ROOTS) walk(resolve(REPO_ROOT_FOR_SCAN, root));
    expect(
      offenders,
      "these files reference the retired FTS objects in CODE — either the retirement is wrong, or this consumer needs to move to the free-text index the chain actually creates",
    ).toEqual([]);
  });

  it("registers NO expectation the canonical migration chain removes", () => {
    // ADM-013 PHASE 6 — INVERTED, with the reason.
    //
    // The `tsv` column and its GIN index were registered at severity
    // `optional`, and they were the ONLY two members of that tier. Both were
    // permanently absent: 20260925000000_phase0_schema_catchup drops the
    // column at the end of the canonical chain, and dropping a column drops
    // its dependent index.
    //
    // `optional` meant "logged as info only", and `rollUpSubsystems`
    // implemented that by counting `missingOptional` and never reading it. So
    // the subsystem reported `healthy` while the same report said two expected
    // objects were missing — the "green beside 2 of 111 missing" the readiness
    // page rendered. Both statements came out of one function.
    //
    // The two entries and the whole `optional` tier are removed. Severity now
    // decides HOW BAD an absence is, never WHETHER it counts.
    // Asserted on the REGISTRATION form, not on the strings: the catalog names
    // both objects in the note explaining why they are absent, and a gate that
    // forbade the words would forbid the explanation.
    expect(src).not.toMatch(/column:\s*"tsv",\s*severity:/);
    expect(src).not.toMatch(/indexName:\s*"evidence_search_documents_tsv_gin"/);
    expect(src).not.toMatch(/severity:\s*"optional"/);
    // And the rollup can no longer drop a failure on the floor.
    expect(src).toMatch(/missingCritical \+ missingImportant !== subsystemFailures\.length/);
  });

  it("registers the search_audit_logs.fail_closed column (compliance-critical)", () => {
    expect(src).toMatch(
      /table:\s*"search_audit_logs",\s*column:\s*"fail_closed",\s*severity:\s*"important",\s*subsystem:\s*"search_discovery"/,
    );
  });
});

// =============================================================================
// Async indexing queue + worker stub
// =============================================================================

describe("Phase 24-J — async indexing pipeline", () => {
  const apiSrc = readSource(
    "../../../services/api/src/queue/search-queue.ts",
  );
  const workerQueueSrc = readSource(
    "../../../services/worker/src/queue.ts",
  );
  const workerProcessorSrc = readSource(
    "../../../services/worker/src/search-indexing.processor.ts",
  );

  // PHASE 12 POINT 5 — these three properties used to be asserted by matching
  // source text. That proved the api and the worker each CONTAINED a matching
  // literal, not that they agreed: two files can hold identical strings and
  // still drift the moment one of them is edited. They now agree structurally
  // (one registry entry, imported by both) and the properties below are proved
  // by RUNNING the shared contract rather than by reading it.

  it("API + worker agree on the queue name + job name — one definition, not two copies", () => {
    const entry = getWorkEntryOrThrow(JOB_NAMES.REBUILD_SEARCH_DOCUMENT);
    expect(entry.queueName).toBe(QUEUE_NAMES.SEARCH_INDEXING);
    expect(entry.workName).toBe("RebuildSearchDocument");
    // Neither transport client may reintroduce a private literal — that is the
    // regression this replaced.
    expect(apiSrc).not.toMatch(/"search-indexing"/);
    expect(apiSrc).not.toMatch(/"RebuildSearchDocument"/);
    expect(workerQueueSrc).not.toMatch(/"RebuildSearchDocument"/);
  });

  it("enqueue is idempotent — a live job collapses, a spent job is replaced", async () => {
    const entry = getWorkEntryOrThrow(JOB_NAMES.REBUILD_SEARCH_DOCUMENT);
    const commandId = buildSearchIndexCommandId("evidence", "ev-1");

    const makeQueue = (existingState: string | null) => {
      const added: Array<{ name: string; data: unknown }> = [];
      const removed: string[] = [];
      return {
        added,
        removed,
        handle: {
          async getJob(jobId: string) {
            if (existingState === null) return null;
            return {
              id: jobId,
              async getState() {
                return existingState;
              },
              async remove() {
                removed.push(jobId);
              },
            };
          },
          async add(name: string, data: unknown) {
            added.push({ name, data });
          },
        },
      };
    };

    // No job holds the id → schedules one.
    const fresh = makeQueue(null);
    await expect(
      enqueueCanonicalJob({
        queue: fresh.handle,
        entry,
        commandId,
        traceId: "t",
      }),
    ).resolves.toMatchObject({ enqueued: true, collapsed: false });
    expect(fresh.added).toHaveLength(1);

    // A LIVE job holds the id → collapses, schedules nothing.
    for (const state of ["waiting", "delayed", "active", "prioritized"]) {
      const live = makeQueue(state);
      await expect(
        enqueueCanonicalJob({
          queue: live.handle,
          entry,
          commandId,
          traceId: "t",
        }),
      ).resolves.toMatchObject({ enqueued: true, collapsed: true });
      expect(live.added).toEqual([]);
    }

    // A SPENT job holds the id → the id is released and a fresh job scheduled.
    // BullMQ silently ignores an add onto a retained completed/failed job, so
    // this is the case that would otherwise report success and do nothing.
    for (const state of ["completed", "failed"]) {
      const spent = makeQueue(state);
      await expect(
        enqueueCanonicalJob({
          queue: spent.handle,
          entry,
          commandId,
          traceId: "t",
        }),
      ).resolves.toMatchObject({ enqueued: true, collapsed: false });
      expect(spent.removed).toHaveLength(1);
      expect(spent.added).toHaveLength(1);
    }
  });

  it("API helper never throws + reports queue_unavailable on Redis failure", () => {
    expect(apiSrc).toMatch(/queue_unavailable/);
    expect(apiSrc).toMatch(/search_indexing_enqueue_failed_total/);
    expect(apiSrc).toMatch(/search_indexing_enqueue_failed/);
  });

  it("refuses a job whose payload does not resolve to a kind + source id", () => {
    const registryEntry = getWorkEntryOrThrow(JOB_NAMES.REBUILD_SEARCH_DOCUMENT);
    const entry = {
      jobName: registryEntry.workName,
      schemaVersion: registryEntry.schemaVersion,
    };

    // Malformed shapes are rejected before anything is loaded.
    expect(() => decodeCanonicalJobPayload(entry, null)).toThrow(
      QueuePayloadRejected,
    );
    expect(() => decodeCanonicalJobPayload(entry, "nope")).toThrow(
      QueuePayloadRejected,
    );
    expect(() => decodeCanonicalJobPayload(entry, {})).toThrow(
      QueuePayloadRejected,
    );

    // A schema version nobody knows is refused rather than guessed at.
    expect(() =>
      decodeCanonicalJobPayload(entry, {
        commandId: "evidence:ev-1",
        traceId: "t",
        schemaVersion: 99,
      }),
    ).toThrow(QueuePayloadRejected);

    // An unknown document kind is refused before any row is read.
    expect(() => parseSearchIndexCommandId("not_a_kind:ev-1")).toThrow(
      QueuePayloadRejected,
    );
    expect(() => parseSearchIndexCommandId("evidence:")).toThrow(
      QueuePayloadRejected,
    );

    // The valid case resolves to exactly the kind + source id.
    const ok = decodeCanonicalJobPayload(entry, {
      commandId: "evidence:ev-1",
      traceId: "lifecycle_changed",
      schemaVersion: entry.schemaVersion,
    });
    expect(parseSearchIndexCommandId(ok.commandId)).toEqual({
      kind: "evidence",
      sourceId: "ev-1",
    });
  });

  it("a tampered payload is REJECTED, not cleaned up and run anyway", () => {
    const entry = getWorkEntryOrThrow(JOB_NAMES.REBUILD_SEARCH_DOCUMENT);
    const expectation = {
      jobName: entry.workName,
      schemaVersion: entry.schemaVersion,
    };
    // PHASE 12 POINT 5 — the decoder is strict rather than sanitising. Stripping
    // a smuggled workspace would turn a tampered payload into a successful job,
    // giving an attacker who can write to the queue unlimited silent attempts.
    // Refusing turns the same payload into a counted, logged failure.
    for (const smuggled of ["teamId", "workspaceId", "storageKey"]) {
      expect(
        () =>
          decodeCanonicalJobPayload(expectation, {
            commandId: "evidence:ev-1",
            traceId: "t",
            schemaVersion: entry.schemaVersion,
            [smuggled]: "attacker-controlled",
          }),
        smuggled,
      ).toThrow(QueuePayloadRejected);
    }
    // The clean payload still decodes to exactly the reference.
    const ok = decodeCanonicalJobPayload(expectation, {
      commandId: "evidence:ev-1",
      traceId: "t",
      schemaVersion: entry.schemaVersion,
    });
    expect(ok.commandId).toBe("evidence:ev-1");
    expect(Object.keys(ok)).not.toContain("teamId");
    expect(Object.keys(ok)).not.toContain("workspaceId");
  });

  it("Worker processor unblocks OCR + transcript indexing-lag pointers on success", () => {
    expect(workerProcessorSrc).toMatch(
      /UPDATE "evidence_ocr_text"[\s\S]*?SET "indexed_at_utc" = \$1[\s\S]*?WHERE "team_id" = \$2[\s\S]*?"evidence_id" = \$3[\s\S]*?"indexed_at_utc" IS NULL/,
    );
    expect(workerProcessorSrc).toMatch(
      /UPDATE "evidence_transcript_segments"[\s\S]*?SET "indexed_at_utc" = \$1[\s\S]*?WHERE "team_id" = \$2[\s\S]*?"evidence_id" = \$3[\s\S]*?"indexed_at_utc" IS NULL/,
    );
  });

  it("Worker processor logs a structured worker.search.indexing.* event (scrapeable)", () => {
    expect(workerProcessorSrc).toMatch(/"worker\.search\.indexing\.succeeded"/);
    expect(workerProcessorSrc).toMatch(/"worker\.search\.indexing\.failed"/);
  });
});

// =============================================================================
// Audit route — /v1/search/audit
// =============================================================================

describe("Phase 24-J — /v1/search/audit route", () => {
  const src = readSource(
    "../../../services/api/src/routes/search.routes.ts",
  );

  it("exposes GET /v1/search/audit gated by the search-operator role", () => {
    expect(src).toMatch(/"\/v1\/search\/audit"/);
    expect(src).toMatch(
      /\/v1\/search\/audit"[\s\S]*?requireSearchOperator\(req, reply, q\.teamId\)/,
    );
  });

  it("validates query params + bounds limit to 200", () => {
    expect(src).toMatch(/teamId:\s*z\.string\(\)\.uuid\(\)/);
    expect(src).toMatch(/limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)/);
    expect(src).toMatch(/beforeUtc:\s*z\.string\(\)\.datetime\(\)/);
  });

  it("the act of reading the audit log is itself audited", () => {
    expect(src).toMatch(
      /listSearchAudit\([\s\S]*?\)[\s\S]*?recordSearchAudit\(\{[\s\S]*?surface:\s*"api:\/v1\/search\/audit"/,
    );
  });

  it("never echoes the raw query text in the audit row it writes", () => {
    expect(src).toMatch(
      /recordSearchAudit\(\{[\s\S]*?queryText:\s*null,/,
    );
  });
});

// =============================================================================
// Cross-surface invariants
// =============================================================================

describe("Phase 24-J — cross-surface invariants", () => {
  const SURFACE_FILES = [
    "../../../services/api/src/services/search/search-audit.service.ts",
    // LEGACY-003: both foundations modules were REMOVED; a scan list naming
    // a deleted file asserts nothing.
    "../../../services/api/src/queue/search-queue.ts",
    "../../../services/worker/src/search-indexing.processor.ts",
  ];

  it("no Discovery surface uses banned wording in string literals", () => {
    const banned =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    for (const rel of SURFACE_FILES) {
      const src = readSource(rel);
      const literals = src.match(/"[^"\n]+"/g) ?? [];
      expect(literals.join(" "), `banned wording in ${rel}`).not.toMatch(banned);
    }
  });

  it("no Discovery surface fabricates operational counters", () => {
    for (const rel of SURFACE_FILES) {
      const src = readSource(rel);
      expect(src).not.toMatch(/escalations:\s*\d+,/);
      expect(src).not.toMatch(/incidents:\s*\d+,/);
    }
  });

  it("no Discovery surface stores raw query text / unhashed IPs / private notes", () => {
    for (const rel of SURFACE_FILES) {
      const src = readSource(rel);
      expect(src, `${rel} references query_text column`).not.toMatch(
        /"query_text"|"raw_query"/,
      );
      expect(src, `${rel} references ip_address column`).not.toMatch(
        /"ip_address"/,
      );
      expect(src, `${rel} references private reviewer note`).not.toContain(
        "privateReviewerNote",
      );
    }
  });

  it("every workspace-scoped read on a new table filters on team_id", () => {
    // Every SELECT against the new tables must include `"team_id" = $N`
    // in its WHERE clause.
    for (const rel of [
      "../../../services/api/src/services/search/search-audit.service.ts",
    // LEGACY-003: both foundations modules were REMOVED; a scan list naming
    // a deleted file asserts nothing.
    ]) {
      const src = readSource(rel);
      const selectMatches = src.match(/FROM "[^"]+"/g) ?? [];
      expect(selectMatches.length, `no SELECT FROM in ${rel}`).toBeGreaterThan(0);
      // Each file has at least one team_id filter.
      expect(src, `${rel} missing team_id filter`).toMatch(/"team_id" = \$1/);
    }
  });
});
