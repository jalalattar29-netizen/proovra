/**
 * Phase 31.6 + 32.5 — Async orchestration + graph completion contracts.
 *
 * Source-level invariants for the new surfaces introduced in this
 * phase. Tests never reach Redis / Postgres — they assert on file
 * contents so the contracts hold even when infra is unavailable.
 *
 * Layers covered:
 *
 *   1. Metrics catalog — new counters + gauges are registered.
 *   2. API producer (services/api/src/queue/media-intelligence-queue.ts)
 *      — lazy Redis init, bounded job-id pattern, never throws to
 *      caller, bumps enqueue counters.
 *   3. /run async branch — 202 response, runId payload, bounded
 *      payload shape, both sync + async paths preserved.
 *   4. Worker processor — bumps started/completed/failed/deferred/
 *      dlq counters; shares Prisma via canonical import; deferred
 *      kinds drain cleanly.
 *   5. Graph routes — three new endpoints exist + bump their
 *      counters (case_subgraph, search, timeline).
 *   6. runtime-readiness `checkMediaIntelligence` — surfaces runs
 *      lifecycle gauges + DEGRADED branch on backlog/stale.
 *   7. apps/web hook + panel — bounded vocabularies, never throws,
 *      no forbidden truth-claim wording, no storage internals.
 *   8. Run tracker dismissRun — bumps the new dismissed counter.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Metrics catalog
// =============================================================================

describe("Phase 31.6 — metrics catalog (counters)", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/ops/metrics.service.ts",
  );

  it("registers every new Phase 31.6 counter", () => {
    for (const m of [
      "media_intelligence_enqueue_total",
      "media_intelligence_enqueue_failed_total",
      "media_intelligence_processor_started_total",
      "media_intelligence_processor_completed_total",
      "media_intelligence_processor_failed_total",
      "media_intelligence_processor_deferred_total",
      "media_intelligence_dlq_total",
      "media_intelligence_run_dismissed_total",
    ]) {
      expect(src, `counter ${m} missing`).toContain(`"${m}"`);
    }
  });

  it("registers every Phase 32.5 graph query counter", () => {
    for (const m of [
      "graph_search_executed_total",
      "graph_timeline_executed_total",
      "graph_case_subgraph_loaded_total",
    ]) {
      expect(src, `counter ${m} missing`).toContain(`"${m}"`);
    }
  });
});

describe("Phase 31.6 — metrics catalog (gauges)", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/ops/metrics.service.ts",
  );

  it("registers every new Phase 31.6 gauge", () => {
    for (const m of [
      "media_intelligence_runs_pending",
      "media_intelligence_runs_processing",
      "media_intelligence_runs_failed",
      "media_intelligence_oldest_pending_age_seconds",
      "media_intelligence_queue_depth",
    ]) {
      expect(src, `gauge ${m} missing`).toContain(`"${m}"`);
    }
  });
});

// =============================================================================
// PART 2 — API producer
// =============================================================================

describe("Phase 31.6 — API enqueue producer", () => {
  const src = readSource(
    "../../../services/api/src/queue/media-intelligence-queue.ts",
  );

  it("lazy-inits the Redis connection (so importing the module without REDIS_URL doesn't crash tests)", () => {
    expect(src).toMatch(/let _queue:\s*Queue\s*\|\s*null\s*=\s*null/);
    expect(src).toMatch(/function getQueue\(\):\s*Queue/);
    expect(src).toMatch(/if \(_queue\) return _queue/);
  });

  it("buildMediaIntelligenceJobId uses the bounded mi-<kind>-<evidenceId> pattern", () => {
    expect(src).toMatch(
      /export function buildMediaIntelligenceJobId\([\s\S]*?return `mi-\$\{kind\}-\$\{evidenceId\}`/,
    );
  });

  it("enqueue returns { enqueued: false, reason } on Redis outage — never throws", () => {
    expect(src).toMatch(/queue_unavailable/);
    // The function signature must be Promise<EnqueueResult> not Promise<void>
    // and the catch paths must return — not rethrow.
    expect(src).toMatch(
      /catch \(err\)\s*\{[\s\S]*?return\s*\{\s*enqueued:\s*false,\s*reason:/,
    );
  });

  it("bumps media_intelligence_enqueue_total on success + on idempotent collapse", () => {
    expect(src).toMatch(/bump\("media_intelligence_enqueue_total"\)/);
  });

  it("bumps media_intelligence_enqueue_failed_total on outage / failure paths", () => {
    expect(src).toMatch(/bump\("media_intelligence_enqueue_failed_total"\)/);
  });

  it("idempotently collapses repeat triggers (re-uses queued/active/delayed job)", () => {
    expect(src).toMatch(/getJob\(jobId\)/);
    expect(src).toMatch(/state === "waiting"/);
    expect(src).toMatch(/state === "active"/);
    expect(src).toMatch(/state === "delayed"/);
  });

  it("MEDIA_INTELLIGENCE_JOB_KINDS catalog exposes all 7 kinds", () => {
    for (const kind of [
      "analyze_metadata",
      "extract_assets",
      "compute_duplicates",
      "compute_lineage",
      "wire_ocr_transcript",
      "reindex",
      "reconcile",
    ]) {
      expect(src, `kind ${kind} missing`).toContain(`"${kind}"`);
    }
  });
});

// =============================================================================
// PART 3 — /run async branch
// =============================================================================

describe("Phase 31.6 — /run route async branch", () => {
  const src = readSource(
    "../../../services/api/src/routes/media-intelligence.routes.ts",
  );

  it("RunBody accepts optional async flag (default off preserves Phase 31)", () => {
    expect(src).toMatch(/async:\s*z\.boolean\(\)\.optional\(\)/);
  });

  it("async path enqueues both a run row AND a BullMQ job", () => {
    expect(src).toMatch(/enqueueMediaIntelligenceRun/);
    expect(src).toMatch(/enqueueMediaIntelligenceAnalysis/);
  });

  it("async response includes mode + queued + runId", () => {
    expect(src).toMatch(/mode:\s*"async"/);
    expect(src).toMatch(/runId:\s*runResult\.run\.id/);
    expect(src).toMatch(/queued:/);
  });

  it("async returns 202 on success (Accepted, work pending)", () => {
    expect(src).toMatch(/reply\.code\(202\)\.send\(\{[\s\S]*?mode:\s*"async"/);
  });

  it("Redis-down → 202 with queued=false + reason (NOT 5xx, NEVER throws)", () => {
    expect(src).toMatch(/queued:\s*false,[\s\S]*?reason:\s*enq\.reason/);
  });

  it("sync path still defaults to mode:'sync' (back-compat with Phase 31)", () => {
    expect(src).toMatch(/mode:\s*"sync"/);
  });

  it("idempotency key collapses duplicate triggers per evidence row", () => {
    expect(src).toMatch(/idempotencyKey:\s*`analyze:\$\{evidenceId\}`/);
  });
});

// =============================================================================
// PART 4 — Worker processor
// =============================================================================

describe("Phase 31.6 — worker processor", () => {
  const src = readSource(
    "../../../services/worker/src/media-intelligence.processor.ts",
  );

  it("imports prisma from ./db.js (canonical, NEVER constructs its own)", () => {
    expect(src).toMatch(/import\s*\{\s*prisma\s*\}\s*from\s*"\.\/db\.js"/);
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/new\s+PrismaClient\s*\(/);
  });

  it("bumps started_total at the top of the processor", () => {
    expect(src).toMatch(
      /tryBump\("media_intelligence_processor_started_total"\)/,
    );
  });

  it("bumps deferred_total for the 4 reserved kinds (extract/compute/reindex)", () => {
    expect(src).toMatch(
      /tryBump\("media_intelligence_processor_deferred_total"\)/,
    );
  });

  it("bumps completed_total on the success path", () => {
    expect(src).toMatch(
      /tryBump\("media_intelligence_processor_completed_total"\)/,
    );
  });

  it("bumps failed_total + dlq_total on the failure path", () => {
    expect(src).toMatch(
      /tryBump\("media_intelligence_processor_failed_total"\)/,
    );
    expect(src).toMatch(/tryBump\("media_intelligence_dlq_total"\)/);
  });

  it("never throws to BullMQ on analyzer refusal (returns success-from-queue)", () => {
    expect(src).toMatch(
      /media_intelligence\.analyzer_refused[\s\S]*?return \{ ok: true, signalsEmitted: 0 \}/,
    );
  });

  it("throws ONLY on transient tracker_unavailable so BullMQ retries with backoff", () => {
    expect(src).toMatch(/throw new Error\(`run_tracker_unavailable/);
  });

  it("bounded job payload + bounded log/response shapes — no storage internals leak to caller", () => {
    // Phase 31.8 — the worker LEGITIMATELY queries
    // p.storage_bucket / p.storage_key in the extract_exif branch
    // (it has to, to fetch the bytes). The rule is "never EXPOSE
    // storage internals to API responses, log fields, or job
    // payload"  — not "never read them in worker SQL". So we
    // scrutinise the surfaces that leave the worker: the payload
    // destructure + the logger calls.
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    // 1. Payload destructure: { teamId, evidenceId, kind, runId,
    //    evidencePartId } — no storage fields permitted.
    const payloadDestructures =
      noComments.match(/const\s*\{[^}]*\}\s*=\s*job\.data/g) ?? [];
    for (const d of payloadDestructures) {
      for (const banned of [
        "storage_key",
        "storageKey",
        "storage_bucket",
        "storageBucket",
        "multipartUploadId",
        "signedUrl",
        "rawGps",
      ]) {
        expect(d, `payload destructure leaks ${banned}`).not.toContain(banned);
      }
    }

    // 2. Logger calls: log fields must never carry storage
    //    bucket / key / signed URL.
    const loggerCalls = noComments.match(/logger\.\w+\(\s*\{[^}]*\}/g) ?? [];
    for (const call of loggerCalls) {
      for (const banned of [
        "storage_key",
        "storageKey",
        "storage_bucket",
        "storageBucket",
        "multipartUploadId",
        "signedUrl",
        "signed_url",
        "rawGps",
        "raw_gps",
      ]) {
        expect(call, `logger call leaks ${banned}`).not.toContain(banned);
      }
    }

    // 3. Returned object shapes: every `return { ... }` from the
    //    processor must not include storage internals.
    const returns = noComments.match(/return\s*\{[^}]*\}/g) ?? [];
    for (const r of returns) {
      for (const banned of [
        "storage_key",
        "storageKey",
        "storage_bucket",
        "storageBucket",
        "multipartUploadId",
        "signedUrl",
        "rawGps",
      ]) {
        expect(r, `return shape leaks ${banned}`).not.toContain(banned);
      }
    }
  });
});

// =============================================================================
// PART 5 — Graph routes (Phase 32.5)
// =============================================================================

describe("Phase 32.5 — graph routes", () => {
  const src = readSource(
    "../../../services/api/src/routes/graph.routes.ts",
  );

  it("registers GET /v1/graph/cases/:caseId", () => {
    expect(src).toMatch(
      /app\.get\(\s*"\/v1\/graph\/cases\/:caseId"/,
    );
  });

  it("registers GET /v1/graph/search", () => {
    expect(src).toMatch(/app\.get\(\s*"\/v1\/graph\/search"/);
  });

  it("registers GET /v1/graph/timeline", () => {
    expect(src).toMatch(/app\.get\(\s*"\/v1\/graph\/timeline"/);
  });

  it("each new route is gated by authorizeOrFail with evidence.read + antiEnumeration", () => {
    // Cases route block.
    const casesBlock = src.match(
      /"\/v1\/graph\/cases\/:caseId"[\s\S]*?\n\s*\}\s*,?\s*\n\s*\)/,
    )?.[0];
    expect(casesBlock, "cases block found").toBeTruthy();
    expect(casesBlock!).toMatch(/authorizeOrFail/);
    expect(casesBlock!).toMatch(/permission:\s*"evidence\.read"/);
    expect(casesBlock!).toMatch(/antiEnumeration:\s*true/);

    const searchBlock = src.match(
      /"\/v1\/graph\/search"[\s\S]*?\n\s*\}\s*,?\s*\n\s*\)/,
    )?.[0];
    expect(searchBlock!).toMatch(/authorizeOrFail/);
    expect(searchBlock!).toMatch(/antiEnumeration:\s*true/);

    const timelineBlock = src.match(
      /"\/v1\/graph\/timeline"[\s\S]*?\n\s*\}\s*,?\s*\n\s*\)/,
    )?.[0];
    expect(timelineBlock!).toMatch(/authorizeOrFail/);
    expect(timelineBlock!).toMatch(/antiEnumeration:\s*true/);
  });

  it("each new route bumps its dedicated counter", () => {
    expect(src).toMatch(/bump\("graph_case_subgraph_loaded_total"\)/);
    expect(src).toMatch(/bump\("graph_search_executed_total"\)/);
    expect(src).toMatch(/bump\("graph_timeline_executed_total"\)/);
  });

  it("search depth + result counts are bounded (no unbounded query)", () => {
    // Bounded `limit` validator.
    expect(src).toMatch(/limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)/);
  });

  it("cases depth bounded by MAX_GRAPH_TRAVERSAL_DEPTH", () => {
    expect(src).toMatch(/MAX_GRAPH_TRAVERSAL_DEPTH/);
  });

  it("never returns storage internals from the projection", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storage_key",
      "storageKey",
      "storage_bucket",
      "storageBucket",
      "multipart_upload_id",
      "multipartUploadId",
      "signedUrl",
      "signed_url",
      "presignedUrl",
      "rawGps",
      "raw_gps",
      "privateReviewerNote",
      "legalNoteBody",
    ]) {
      expect(noComments, `graph.routes leaks ${banned}`).not.toContain(banned);
    }
  });
});

// =============================================================================
// PART 6 — runtime-readiness checkMediaIntelligence (extended)
// =============================================================================

describe("Phase 31.6 — runtime-readiness media intelligence check", () => {
  const src = readSource(
    "../../../services/api/src/runtime/runtime-readiness.ts",
  );

  it("imports setGauge from the metrics service", () => {
    expect(src).toMatch(
      /import\s*\{\s*setGauge\s*\}\s*from\s*"\.\.\/services\/ops\/metrics\.service\.js"/,
    );
  });

  it("checkMediaIntelligence sets all 5 new gauges", () => {
    const fn = src.match(
      /async function checkMediaIntelligence\([\s\S]*?\n\}\s*\n/,
    )?.[0];
    expect(fn, "checkMediaIntelligence function found").toBeTruthy();
    expect(fn!).toMatch(/setGauge\(\s*"media_intelligence_runs_pending"/);
    expect(fn!).toMatch(/setGauge\(\s*"media_intelligence_runs_processing"/);
    expect(fn!).toMatch(/setGauge\(\s*"media_intelligence_runs_failed"/);
    expect(fn!).toMatch(
      /setGauge\(\s*"media_intelligence_oldest_pending_age_seconds"/,
    );
    expect(fn!).toMatch(/setGauge\(\s*"media_intelligence_queue_depth"/);
  });

  it("never reports CRITICAL — advisory-only subsystem (HEALTHY/DEGRADED/UNKNOWN only)", () => {
    const fn = src.match(
      /async function checkMediaIntelligence\([\s\S]*?\n\}\s*\n/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).not.toMatch(/status:\s*"CRITICAL"/);
    expect(fn!).toMatch(/status:\s*"HEALTHY"/);
    expect(fn!).toMatch(/status:\s*"DEGRADED"/);
    expect(fn!).toMatch(/status:\s*"UNKNOWN"/);
  });

  it("DEGRADED branches: backlog_large + backlog_stale", () => {
    const fn = src.match(
      /async function checkMediaIntelligence\([\s\S]*?\n\}\s*\n/,
    )?.[0];
    expect(fn!).toMatch(/reasonCode:\s*[^\n]*"run_backlog_large"/);
    expect(fn!).toMatch(/reasonCode:\s*[^\n]*"run_backlog_stale"/);
  });
});

// =============================================================================
// PART 7 — apps/web hook + panel source contracts
// =============================================================================

describe("Phase 31.6 — apps/web hook + types source contracts", () => {
  const typesSrc = readSource(
    "../../../apps/web/lib/media-intelligence/types.ts",
  );
  const hookSrc = readSource(
    "../../../apps/web/lib/media-intelligence/useMediaIntelligence.ts",
  );

  it("types.ts exports bounded vocabularies that match server catalogs", () => {
    for (const t of [
      "EXIF_MISSING",
      "EXIF_TIMESTAMP_MISMATCH",
      "CLIENT_SERVER_TIME_GAP",
      "MIME_EXTENSION_MISMATCH",
      "CODEC_CONTAINER_OBSERVATION",
      "SCREENSHOT_LIKE_FILENAME",
      "DUPLICATE_HASH_MATCH",
      "OCR_AVAILABLE",
      "TRANSCRIPT_AVAILABLE",
    ]) {
      expect(typesSrc, `signal type ${t} missing`).toContain(`"${t}"`);
    }
  });

  it("severityLabel returns advisory wording, NEVER alarmist", () => {
    expect(typesSrc).toMatch(/return "Observation"/);
    expect(typesSrc).toMatch(/return "Review recommended"/);
    expect(typesSrc).toMatch(/return "Needs attention"/);
    // Forbidden alarmist wording in label outputs.
    const labelFn = typesSrc.match(
      /function severityLabel[\s\S]*?\n\}/,
    )?.[0];
    expect(labelFn).toBeTruthy();
    for (const banned of ["WARNING", "CRITICAL", "ALERT", "DANGER", "BLOCKED"]) {
      expect(labelFn!, `severityLabel uses ${banned}`).not.toMatch(
        new RegExp(`"\\s*${banned}`, "i"),
      );
    }
  });

  it("hook never throws — all error paths land in bounded state.error", () => {
    const noComments = hookSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // No bare `throw` statements in the hook (re-throws are an
    // anti-pattern for this API surface).
    expect(noComments).not.toMatch(/\bthrow\s+new\s+/);
    // Every catch lands in setState({ error: { code } }) shape.
    expect(hookSrc).toMatch(/error:\s*\{\s*code\s*\}/);
  });

  it("polling interval clamped to [2000, 60000] (DDOS-prevention)", () => {
    expect(hookSrc).toMatch(
      /Math\.max\(2_?000,\s*Math\.min\(60_?000/,
    );
  });

  it("runAsync POSTs with async:true (the orchestration opt-in)", () => {
    expect(hookSrc).toMatch(/async:\s*true/);
  });

  it("ack supports both ACKNOWLEDGED and DISMISSED (bounded vocabulary)", () => {
    expect(hookSrc).toMatch(
      /Extract<ClientStatus,\s*"ACKNOWLEDGED"\s*\|\s*"DISMISSED">/,
    );
  });

  it("hook returns a bounded result type (never raw Error objects)", () => {
    // The hook surfaces `{ ok: true, runId, queued }` or
    // `{ ok: false, reason: string }` — both bounded.
    expect(hookSrc).toMatch(/\{\s*ok:\s*false;\s*reason:\s*string\s*\}/);
  });
});

describe("Phase 31.6 — MediaIntelligencePanel source contract", () => {
  const panelSrc = readSource(
    "../../../apps/web/components/media-intelligence/MediaIntelligencePanel.tsx",
  );

  it("declared as a client component", () => {
    expect(panelSrc.trimStart()).toMatch(/^"use client"/);
  });

  it("uses the useMediaIntelligence hook (no direct fetch)", () => {
    expect(panelSrc).toMatch(/useMediaIntelligence/);
    const noComments = panelSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/\bfetch\(/);
    expect(noComments).not.toMatch(/apiFetch\(/);
  });

  it("renders advisory-only language (no truth-claims, no alarmist labels)", () => {
    const noComments = panelSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|verified as real|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(
        lit,
        `MediaIntelligencePanel uses forbidden truth-claim wording: ${lit}`,
      ).not.toMatch(forbidden);
    }
  });

  it("no storage internals or signed URLs", () => {
    const noComments = panelSrc
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
      "presignedUrl",
      "rawGps",
      "raw_gps",
    ]) {
      expect(noComments, `panel leaks ${banned}`).not.toContain(banned);
    }
  });

  it("offers Acknowledge + Dismiss actions for open signals", () => {
    expect(panelSrc).toMatch(/Acknowledge/);
    expect(panelSrc).toMatch(/Dismiss/);
  });

  it("offers a Run analyzer trigger (calls runAsync, never the sync path)", () => {
    expect(panelSrc).toMatch(/Run analyzer/);
    expect(panelSrc).toMatch(/runAsync/);
  });

  it("inline styles only — no CSS module dependency (drop-in safe)", () => {
    expect(panelSrc).not.toMatch(/import\s+.*\.module\.(css|scss)/);
  });
});

// =============================================================================
// PART 8 — Run tracker dismiss counter
// =============================================================================

describe("Phase 31.6 — run tracker dismiss counter", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/media-intelligence/run-tracker.service.ts",
  );

  it("dismissRun bumps media_intelligence_run_dismissed_total", () => {
    const fn = src.match(/export async function dismissRun[\s\S]*?\n\}/)?.[0];
    expect(fn, "dismissRun function found").toBeTruthy();
    expect(fn!).toMatch(/bump\("media_intelligence_run_dismissed_total"\)/);
  });

  it("dismissRun is idempotent (only transitions from non-terminal states)", () => {
    const fn = src.match(/export async function dismissRun[\s\S]*?\n\}/)?.[0];
    expect(fn!).toMatch(
      /"status" IN \('PENDING', 'FAILED', 'PROCESSING'\)/,
    );
  });
});
