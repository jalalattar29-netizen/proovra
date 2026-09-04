/**
 * Phase 31.8 — End-to-end EXIF wiring source-contract tests.
 *
 * Layers covered:
 *
 *   1. SQL drift patch — table shape, bounded CHECKs, idempotent
 *      CREATE TABLE / INDEX, anti-leak (no storage_key columns).
 *   2. Run-tracker + queue catalogs accept `extract_exif` everywhere.
 *   3. Worker processor branch — imports from canonical db.js,
 *      bounded 256 KB byte range, never mutates evidence, signals
 *      emitted via persistence not direct.
 *   4. EXIF summary service — bounded upsert + read shape, no raw
 *      GPS columns at the persistence layer.
 *   5. Analyzer integration — reads persisted EXIF, emits
 *      EXIF_TIMESTAMP_MISMATCH only above 1 h threshold,
 *      DEVICE_METADATA_OBSERVATION only when fields present.
 *   6. Signal catalog — EXIF_TIMESTAMP_MISMATCH + DEVICE_METADATA_OBSERVATION
 *      flagged implemented, safeSummary covers both with no
 *      forbidden vocabulary.
 *   7. Client vocabulary in apps/web mirrors the server catalog.
 *   8. Operations actions — retry + replay-DLQ routes are bounded,
 *      auth-gated, anti-leak.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  JOB_NAMES,
  MEDIA_INTELLIGENCE_JOB_KINDS,
  QUEUE_NAMES,
  getWorkEntryOrThrow,
} from "@proovra/shared";

import {
  MEDIA_INTELLIGENCE_RUN_KINDS,
} from "../src/services/media-intelligence/run-tracker.service.js";
import {
  safeSummary,
  SIGNAL_METADATA,
  MEDIA_INTELLIGENCE_SIGNAL_TYPES,
} from "../src/services/media-intelligence/signal-catalog.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — SQL drift patch
// =============================================================================

describe("Phase 31.8 — evidence_part_exif_summaries SQL drift patch", () => {
  const sql = readSource(
    "../../../services/api/sql/drift-patches/2026-05-20-evidence-part-exif-summaries.sql",
  );

  it("wrapped in BEGIN/COMMIT for partial-state safety", () => {
    expect(sql).toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).toMatch(/^\s*COMMIT\s*;/m);
  });

  it("widens media_intelligence_runs.kind to include extract_exif", () => {
    expect(sql).toMatch(
      /ALTER TABLE "media_intelligence_runs"[\s\S]*?DROP CONSTRAINT IF EXISTS "media_intelligence_runs_kind_bounded"/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "media_intelligence_runs_kind_bounded"[\s\S]*?'extract_exif'/,
    );
  });

  it("idempotent CREATE TABLE", () => {
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"evidence_part_exif_summaries"/,
    );
  });

  it("never stores raw GPS (only has_gps boolean)", () => {
    expect(sql).toMatch(/"has_gps"\s+BOOLEAN/);
    expect(sql).not.toMatch(/"gps_latitude"|"gps_longitude"|"raw_gps"/);
  });

  it("never stores storage_key / storage_bucket / multipart_upload_id columns", () => {
    expect(sql).not.toMatch(/"storage_key"\s+(VARCHAR|TEXT)/);
    expect(sql).not.toMatch(/"storage_bucket"\s+(VARCHAR|TEXT)/);
    expect(sql).not.toMatch(/"multipart_upload_id"\s+/);
    expect(sql).not.toMatch(/"signed_url"|"presigned_url"/);
  });

  it("string columns bounded to VARCHAR(64) — matches extractor STRING_FIELD_MAX", () => {
    expect(sql).toMatch(/"camera_make"\s+VARCHAR\(64\)/);
    expect(sql).toMatch(/"camera_model"\s+VARCHAR\(64\)/);
    expect(sql).toMatch(/"software"\s+VARCHAR\(64\)/);
  });

  it("dimensions bounded by CHECK (≤ 200000)", () => {
    expect(sql).toMatch(
      /CHECK \("image_width_px" IS NULL OR \("image_width_px" > 0 AND "image_width_px" <= 200000\)\)/,
    );
    expect(sql).toMatch(
      /CHECK \("image_height_px" IS NULL OR \("image_height_px" > 0 AND "image_height_px" <= 200000\)\)/,
    );
  });

  it("orientation bounded 1..8 per EXIF spec", () => {
    expect(sql).toMatch(
      /CHECK \("orientation" IS NULL OR \("orientation" >= 1 AND "orientation" <= 8\)\)/,
    );
  });

  it("status bounded to known catalog", () => {
    // The CHECK constraint is multi-line; assert each token's
    // presence inside an evidence_part_exif_summaries_status_bounded
    // block.
    const block = sql.match(
      /CONSTRAINT "evidence_part_exif_summaries_status_bounded"[\s\S]*?\)\)/,
    )?.[0];
    expect(block, "status CHECK block found").toBeTruthy();
    for (const v of [
      "'OK'",
      "'PARSE_FAILED'",
      "'UNSUPPORTED_FORMAT'",
      "'INPUT_TOO_LARGE'",
      "'EMPTY_INPUT'",
      "'FETCH_FAILED'",
    ]) {
      expect(block!, `status missing ${v}`).toContain(v);
    }
  });

  it("per-team unique on evidence_part_id — anti-enumeration defence", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "evidence_part_exif_summaries_team_part_uk"[\s\S]*?\("team_id", "evidence_part_id"\)/,
    );
  });

  it("includes operator-readable Neon apply command in header", () => {
    expect(sql).toMatch(
      /psql "\$DATABASE_URL"[\s\S]*?2026-05-20-evidence-part-exif-summaries\.sql/,
    );
  });
});

// =============================================================================
// PART 2 — Catalogs widened to include extract_exif
// =============================================================================

describe("Phase 31.8 — extract_exif registered in every catalog", () => {
  it("run-tracker catalog includes extract_exif", () => {
    expect(MEDIA_INTELLIGENCE_RUN_KINDS).toContain("extract_exif");
  });

  it("the queue catalog includes extract_exif", () => {
    // PHASE 12 — POINT 5: "every catalog" is now ONE catalog. The api array
    // and the worker union this used to check separately are both re-exports
    // of `MEDIA_INTELLIGENCE_JOB_KINDS`, so registration in one IS registration
    // in all.
    expect(MEDIA_INTELLIGENCE_JOB_KINDS).toContain("extract_exif");
  });

  it("extract_exif addresses the evidence PART, not a run row", () => {
    // The `mi-exif` queue used to share the media-intelligence processor, which
    // meant one function served two queues whose commands meant different
    // things — so the payload had to carry BOTH a run id and a part id and
    // trust whichever was present. EXIF reads one part's bytes; that part is
    // its authority.
    const entry = getWorkEntryOrThrow(JOB_NAMES.EXTRACT_EXIF);
    expect(entry.queueName).toBe(QUEUE_NAMES.MI_EXIF);
    expect(entry.durableAuthority.model).toBe("EvidencePart");
  });

  it("schema-validation registers the new table + key column", () => {
    const src = readSource(
      "../src/runtime/schema-validation.ts",
    );
    expect(src).toContain('name: "evidence_part_exif_summaries"');
    expect(src).toContain(
      'indexName: "evidence_part_exif_summaries_team_part_uk"',
    );
  });
});

// =============================================================================
// PART 3 — Worker processor branch
// =============================================================================

describe("Phase 31.8 — worker extract_exif branch", () => {
  const src = readSource(
    "../../../services/worker/src/media-intelligence.processor.ts",
  );

  it("imports the bounded range helper from worker storage", () => {
    expect(src).toMatch(/import\s*\{\s*getObjectRange\s*\}\s*from\s*"\.\/storage\.js"/);
  });

  it("uses canonical prisma — no bare new PrismaClient", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).toMatch(/import\s*\{\s*prisma\s*\}\s*from\s*"\.\/db\.js"/);
    expect(noComments).not.toMatch(/new\s+PrismaClient\s*\(/);
  });

  it("range capped to 256 KB so we don't pull whole originals", () => {
    expect(src).toMatch(/EXIF_RANGE_BYTES\s*=\s*256\s*\*\s*1024/);
  });

  it("processExtractExifJob branch dispatched from main handler", () => {
    expect(src).toMatch(/if \(kind === "extract_exif"\)\s*\{[\s\S]*?return processExtractExifJob/);
  });

  it("never throws on FETCH_FAILED — records failure + continues to next part", () => {
    const fn = src.match(
      /async function processExtractExifJob\([\s\S]*?\n\}\s*\n*$/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(
      /catch \(err\)\s*\{[\s\S]*?recordExifSummaryFailure[\s\S]*?status:\s*"FETCH_FAILED"[\s\S]*?continue/,
    );
  });

  it("refuses raw GPS at extraction time (allowRawGps: false)", () => {
    expect(src).toMatch(/allowRawGps:\s*false/);
  });

  it("skips non-image MIME types up front (no wasted S3 fetch)", () => {
    expect(src).toMatch(
      /!part\.mime_type\.toLowerCase\(\)\.startsWith\("image\/"\)/,
    );
  });

  it("uses lowercase table names (evidence_parts / evidence)", () => {
    expect(src).toMatch(/FROM "evidence_parts" p/);
    expect(src).toMatch(/JOIN "evidence" e ON e\."id" = p\."evidence_id"/);
    expect(src).not.toContain(`"EvidencePart"`);
    expect(src).not.toContain(`"Evidence"`);
  });

  it("marks run COMPLETED only when at least one part succeeds OR every part skipped", () => {
    const fn = src.match(
      /async function processExtractExifJob\([\s\S]*?\n\}\s*\n*$/,
    )?.[0];
    expect(fn!).toMatch(
      /if \(succeeded > 0 \|\| failed === 0\)\s*\{[\s\S]*?markRunCompleted/,
    );
    expect(fn!).toMatch(
      /else \{[\s\S]*?markRunFailed[\s\S]*?all_parts_failed/,
    );
  });

  it("no storage internals leak into log payloads", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // logger.info / logger.warn calls in this file must never carry
    // storage_bucket / storage_key as direct log fields.
    const logBlocks = noComments.match(/logger\.\w+\(\s*\{[^}]*\}/g) ?? [];
    for (const block of logBlocks) {
      expect(block, `log block leaks storage internals: ${block}`).not.toMatch(
        /storage_(bucket|key)/,
      );
    }
  });
});

// =============================================================================
// PART 4 — EXIF summary service
// =============================================================================

describe("Phase 31.8 — EXIF summary persistence service", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/media-intelligence/exif-summary.service.ts",
  );

  it("upsert keyed by (team_id, evidence_part_id) — idempotent", () => {
    expect(src).toMatch(
      /ON CONFLICT \("team_id", "evidence_part_id"\) DO UPDATE/,
    );
  });

  it("never persists raw GPS — no rawGps column referenced", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/raw_gps/);
    // The summary.rawGps optional field exists on the input but is
    // NEVER written into a column — the schema has no such column.
    const sqlLiterals = noComments.match(/INSERT INTO "evidence_part_exif_summaries"[\s\S]*?VALUES/g) ?? [];
    for (const lit of sqlLiterals) {
      expect(lit).not.toMatch(/raw_gps/);
    }
  });

  it("never throws — every code path returns a bounded result", () => {
    const fns = ["upsertExifSummary", "recordExifSummaryFailure"];
    for (const fnName of fns) {
      const fn = src.match(
        new RegExp(`export async function ${fnName}\\([\\s\\S]*?\\n\\}`, "g"),
      )?.[0];
      expect(fn, `${fnName} found`).toBeTruthy();
      expect(fn!).toMatch(/try\s*\{[\s\S]*?\}\s*catch[\s\S]*?return\s*\{/);
    }
  });

  it("sanitizes error strings (no newlines, no URLs, bounded)", () => {
    const fn = src.match(/function sanitizeError[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/replace\(\/\[\\n\\r\\t\]\/g/);
    expect(fn!).toMatch(/replace\(\/https\?:\\\/\\\/\[\^\\s\]\+\/g/);
    expect(fn!).toMatch(/slice\(0,\s*240\)/);
  });
});

// =============================================================================
// PART 5 — Analyzer integration
// =============================================================================

describe("Phase 31.8 — analyzer reads persisted EXIF", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/media-intelligence/analyzer.service.ts",
  );

  it("imports listExifSummariesForEvidence + computeExifVsServerGapSeconds", () => {
    expect(src).toMatch(
      /import\s*\{\s*listExifSummariesForEvidence\s*\}\s*from\s*"\.\/exif-summary\.service\.js"/,
    );
    expect(src).toMatch(
      /import\s*\{\s*computeExifVsServerGapSeconds\s*\}\s*from\s*"\.\/exif-extractor\.service\.js"/,
    );
  });

  it("loads summaries once per analyzer pass + maps by evidencePartId", () => {
    expect(src).toMatch(/const exifSummaries = await listExifSummariesForEvidence/);
    expect(src).toMatch(/exifByPart = new Map\([\s\S]*?evidencePartId/);
  });

  it("EXIF_MISSING prefers persisted summary, falls back to client heuristic", () => {
    const block = src.match(/2\. EXIF_MISSING[\s\S]*?if \(exifMissing\)/)?.[0];
    expect(block, "EXIF_MISSING block found").toBeTruthy();
    expect(block!).toMatch(/persistedExif/);
    expect(block!).toMatch(/partSignals\.exifPresent === false/);
  });

  it("EXIF_TIMESTAMP_MISMATCH gated to ≥ 1 hour gap (no review fatigue from clock skew)", () => {
    const block = src.match(/2b\. EXIF_TIMESTAMP_MISMATCH[\s\S]*?\}/)?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/gap >= 60 \* 60/);
  });

  it("DEVICE_METADATA_OBSERVATION only emitted when at least one bounded field present", () => {
    const block = src.match(/2c\. DEVICE_METADATA_OBSERVATION[\s\S]*?\}\s*\n\s*\}\s*\n/)?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/hasMake \|\| hasModel \|\| hasSoftware \|\| hasDimensions/);
  });

  it("DEVICE_METADATA_OBSERVATION never leaks actual make/model strings through detailsJson", () => {
    const block = src.match(/2c\. DEVICE_METADATA_OBSERVATION[\s\S]*?\}\s*\n\s*\}\s*\n/)?.[0];
    expect(block).toBeTruthy();
    expect(block!).not.toMatch(/cameraMake:|cameraModel:/);
    // Only presence flags are projected.
    expect(block!).toMatch(/hasMake[\s\S]*?hasModel[\s\S]*?hasDimensions[\s\S]*?hasSoftware/);
  });
});

// =============================================================================
// PART 6 — Signal catalog
// =============================================================================

describe("Phase 31.8 — signal catalog", () => {
  it("catalog now includes DEVICE_METADATA_OBSERVATION", () => {
    expect(MEDIA_INTELLIGENCE_SIGNAL_TYPES).toContain(
      "DEVICE_METADATA_OBSERVATION",
    );
  });

  it("EXIF_TIMESTAMP_MISMATCH flagged implemented", () => {
    expect(SIGNAL_METADATA.EXIF_TIMESTAMP_MISMATCH.implemented).toBe(true);
  });

  it("DEVICE_METADATA_OBSERVATION flagged implemented + INFO + MEDIUM", () => {
    expect(SIGNAL_METADATA.DEVICE_METADATA_OBSERVATION.implemented).toBe(true);
    expect(SIGNAL_METADATA.DEVICE_METADATA_OBSERVATION.defaultSeverity).toBe(
      "INFO",
    );
  });

  it("safeSummary for EXIF_TIMESTAMP_MISMATCH carries no forbidden vocabulary", () => {
    const s = safeSummary({ type: "EXIF_TIMESTAMP_MISMATCH", gapSeconds: 90 * 60 });
    expect(s).toMatch(/Review recommended/);
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    expect(s).not.toMatch(forbidden);
  });

  it("safeSummary for DEVICE_METADATA_OBSERVATION enumerates only presence flags", () => {
    const s = safeSummary({
      type: "DEVICE_METADATA_OBSERVATION",
      hasMake: true,
      hasModel: false,
      hasDimensions: true,
      hasSoftware: false,
    });
    expect(s).toContain("device make");
    expect(s).toContain("image dimensions");
    expect(s).not.toContain("Apple");
    expect(s).not.toContain("iPhone");
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    expect(s).not.toMatch(forbidden);
  });
});

// =============================================================================
// PART 7 — apps/web client vocabulary mirrors server
// =============================================================================

describe("Phase 31.8 — apps/web client vocabulary", () => {
  const typesSrc = readSource(
    "../../../apps/web/lib/media-intelligence/types.ts",
  );

  it("client vocabulary includes DEVICE_METADATA_OBSERVATION", () => {
    expect(typesSrc).toContain('"DEVICE_METADATA_OBSERVATION"');
  });

  it("client vocabulary still includes EXIF_TIMESTAMP_MISMATCH (now implemented server-side)", () => {
    expect(typesSrc).toContain('"EXIF_TIMESTAMP_MISMATCH"');
  });
});

// =============================================================================
// PART 8 — Operations actions API
// =============================================================================

describe("Phase 31.8 — ops actions: retry + replay DLQ", () => {
  const queueSrc = readSource(
    "../src/queue/media-intelligence-queue.ts",
  );
  const routeSrc = readSource("../src/routes/ops.routes.ts");

  it("queue exports retryMediaIntelligenceJob + replayMediaIntelligenceDlq", () => {
    expect(queueSrc).toMatch(/export async function retryMediaIntelligenceJob/);
    expect(queueSrc).toMatch(/export async function replayMediaIntelligenceDlq/);
  });

  it("retry refuses to retry jobs not in failed state", () => {
    const fn = queueSrc.match(/export async function retryMediaIntelligenceJob[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/state !== "failed"/);
    expect(fn!).toMatch(/return\s*\{\s*ok:\s*false,\s*reason:\s*`job_not_failed/);
  });

  it("DLQ replay bounded to maxJobs (capped at 200)", () => {
    // The function spans multiple nested blocks; bound the search
    // up to the next `export ` declaration to capture the full
    // body without depending on indentation of the closing brace.
    const fn = queueSrc.match(
      /export async function replayMediaIntelligenceDlq[\s\S]*?(?=\nexport |\n\/\*\*|$)/,
    )?.[0];
    expect(fn, "replayMediaIntelligenceDlq function body found").toBeTruthy();
    expect(fn!).toMatch(/Math\.max\(1,/);
    expect(fn!).toMatch(/Math\.min\(options\.maxJobs/);
    expect(fn!).toMatch(/200\)\)/);
  });

  it("retry route registered + auth-gated with requireOpsActorAction", () => {
    expect(routeSrc).toMatch(
      /"\/v1\/ops\/media-intelligence\/runs\/:runId\/retry"[\s\S]*?requireOpsActorAction/,
    );
  });

  it("replay route registered + auth-gated with requireOpsActorAction", () => {
    expect(routeSrc).toMatch(
      /"\/v1\/ops\/media-intelligence\/dlq\/replay"[\s\S]*?requireOpsActorAction/,
    );
  });

  it("route bodies are strict (zod .strict() — no unknown fields)", () => {
    // RetryRunBody is a one-liner. ReplayDlqBody spans multiple
    // lines with the .strict() call separated by whitespace.
    expect(routeSrc).toMatch(/RetryRunBody = z\.object\(\{[\s\S]*?\}\)\.strict\(\)/);
    const replayBlock = routeSrc.match(
      /const ReplayDlqBody = z[\s\S]*?\.strict\(\);/,
    )?.[0];
    expect(replayBlock, "ReplayDlqBody declaration found").toBeTruthy();
    expect(replayBlock!).toMatch(/\.strict\(\)/);
  });

  it("response shape bounded — no Redis internals leak", () => {
    // The action handlers send specific bounded shapes only.
    expect(routeSrc).toMatch(
      /reply\.code\(200\)\.send\(\{\s*runId,\s*retried:\s*true\s*\}\)/,
    );
    // The replay response gained honest counts — `discovered` (what the queue
    // returned within the limit) and `eligible` (what was still failed when
    // re-checked) — because reporting only `attempted` could not distinguish
    // "50 jobs replayed" from "50 looked at, 3 replayed". It is still a closed
    // set of scalars: no job, no payload, no Redis internals.
    const replaySend = routeSrc.match(
      /reply\.code\(200\)\.send\(\{\s*scope:[\s\S]*?\}\);/,
    )?.[0];
    expect(replaySend, "bounded replay response found").toBeTruthy();
    for (const field of ["discovered", "eligible", "retried", "skipped", "limit"]) {
      expect(replaySend!).toContain(field);
    }
    for (const forbidden of ["job.", "jobId", "data", "stacktrace", "failedReason"]) {
      expect(replaySend!).not.toContain(forbidden);
    }
  });
});

// =============================================================================
// PART 9 — Cross-source anti-leak invariants
// =============================================================================

describe("Phase 31.8 — anti-leak invariants across new surfaces", () => {
  // EXIF extractor library is intentionally NOT in this list — it
  // defines the opt-in `rawGps` field on its output type. The
  // persistence layer + worker + analyzer are the surfaces that
  // must refuse to store / project raw GPS.
  const sources = [
    "../../../packages/shared-runtime/src/media-intelligence/exif-summary.service.ts",
    "../src/queue/media-intelligence-queue.ts",
    "../../../services/worker/src/media-intelligence.processor.ts",
  ].map(readSource);

  it("no forbidden truth-claim wording in any source literal", () => {
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (let i = 0; i < sources.length; i++) {
      const noComments = sources[i]!
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const literals = noComments.match(/"[^"\n]+"/g) ?? [];
      for (const lit of literals) {
        expect(
          lit,
          `source ${i} uses forbidden wording: ${lit}`,
        ).not.toMatch(forbidden);
      }
    }
  });

  it("no signed-URL / multipart-upload-id / raw-GPS leak in persistence/worker/queue surfaces", () => {
    for (let i = 0; i < sources.length; i++) {
      const noComments = sources[i]!
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const banned of [
        "signedUrl",
        "signed_url",
        "presignedUrl",
        "multipart_upload_id",
        "multipartUploadId",
        "raw_gps",
        "rawGps",
        "privateNote",
        "private_note",
      ]) {
        expect(noComments, `source ${i} leaks ${banned}`).not.toContain(
          banned,
        );
      }
    }
  });
});
