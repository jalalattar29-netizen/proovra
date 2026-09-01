/**
 * Phase 31.7 + 32.6 — Timeline extension + ops UI source contracts.
 *
 * Source-level invariants for:
 *   * Extended TimelineEvent union (lifecycle / MI runs / MI signals).
 *   * /v1/graph/timeline route accepts the new evidenceId param.
 *   * SQL projection unions the new streams ONLY when evidenceId is
 *     provided (so a global query never scans the lifecycle table).
 *   * Stream WHERE clauses are team-anchored (anti-enumeration).
 *   * No storage internals / GPS / private-note leakage in the
 *     timeline projection.
 *   * The new /ops/media-graph page is a client component that:
 *     - consumes only /v1/ops/metrics (no new server route);
 *     - distinguishes missing-metric ("—") from zero (operator clarity);
 *     - polls bounded (≤30s) + pauses when tab hidden;
 *     - has no forbidden vocabulary in user-facing literals;
 *     - has no fake/hardcoded counts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Timeline service contract
// =============================================================================

describe("Phase 31.7 — buildInvestigationTimeline", () => {
  const src = readSource(
    "../../../packages/shared-runtime/src/graph/graph-builder.service.ts",
  );

  it("TimelineEventKind union includes lifecycle + MI run + MI signal kinds", () => {
    const decl = src.match(
      /export type TimelineEventKind\s*=[\s\S]*?;/,
    )?.[0];
    expect(decl, "TimelineEventKind found").toBeTruthy();
    for (const k of [
      "NODE_CREATED",
      "EDGE_CREATED",
      "EDGE_REMOVED",
      "LIFECYCLE_EVENT",
      "MEDIA_RUN_STARTED",
      "MEDIA_RUN_COMPLETED",
      "MEDIA_RUN_FAILED",
      "MEDIA_SIGNAL_CREATED",
      "MEDIA_SIGNAL_ACKNOWLEDGED",
    ]) {
      expect(decl!, `TimelineEventKind missing ${k}`).toContain(`"${k}"`);
    }
  });

  it("TimelineQueryInput accepts evidenceId param", () => {
    const decl = src.match(/export type TimelineQueryInput\s*=[\s\S]*?\};/)?.[0];
    expect(decl, "TimelineQueryInput found").toBeTruthy();
    expect(decl!).toMatch(/evidenceId\?:\s*string\s*\|\s*null/);
  });

  it("each evidence-keyed stream binds team_id first (anti-enumeration)", () => {
    expect(src).toMatch(/lifecycleWhere:\s*string\[\]\s*=\s*\[\s*`le\."team_id" = \$1`/);
    expect(src).toMatch(/runsWhere:\s*string\[\]\s*=\s*\[\s*`r\."team_id" = \$1`/);
    expect(src).toMatch(/signalsWhere:\s*string\[\]\s*=\s*\[\s*`s\."team_id" = \$1`/);
  });

  it("evidence-keyed stream UNIONs are only appended when evidenceId is provided", () => {
    // The SQL template uses `input.evidenceId ? ... : ""` to gate
    // the extra streams. This avoids a full lifecycle scan for
    // queries that don't filter to an evidence.
    expect(src).toMatch(
      /const evidenceStreams\s*=\s*input\.evidenceId[\s\S]*?:\s*""/,
    );
  });

  it("each evidence-keyed stream filters by evidence_id when the param is set", () => {
    expect(src).toMatch(/lifecycleWhere\.push\(`le\."evidence_id" = \$/);
    expect(src).toMatch(/runsWhere\.push\(`r\."evidence_id" = \$/);
    expect(src).toMatch(/signalsWhere\.push\(`s\."evidence_id" = \$/);
  });

  it("never throws — every catch path returns a bounded result", () => {
    // Phase Repair (Problem 13) — the catch now returns the new
    // discriminated-union failure variant (`ok:false,
    // classification:"QUERY_FAILED"`) instead of disguising the
    // failure as `ok:true, events:[]`. Either shape proves the
    // function never throws; the distinction is what the route + UI
    // then do with the result.
    const fn = src.match(
      /export async function buildInvestigationTimeline\([\s\S]*?\n\}\s*\n/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(
      /catch\s*\(err\)\s*\{[\s\S]*?return\s*\{\s*ok:\s*false,\s*classification:\s*"QUERY_FAILED"/,
    );
  });

  it("summary field is bounded to 240 chars in the projection", () => {
    expect(src).toMatch(/summary:\s*r\.summary\.slice\(0,\s*240\)/);
  });

  it("no storage internals / signed URLs / raw GPS leak through the projection", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storage_key",
      "storageKey",
      "storage_bucket",
      "storageBucket",
      "signed_url",
      "signedUrl",
      "presignedUrl",
      "raw_gps",
      "rawGps",
      "private_note",
      "privateNote",
      "legalNoteBody",
    ]) {
      expect(noComments, `graph-builder leaks ${banned}`).not.toContain(banned);
    }
  });
});

// =============================================================================
// PART 2 — /v1/graph/timeline route
// =============================================================================

describe("Phase 31.7 — /v1/graph/timeline route", () => {
  const src = readSource("../src/routes/graph.routes.ts");

  it("accepts the new evidenceId param", () => {
    const block = src.match(
      /"\/v1\/graph\/timeline"[\s\S]*?\n\s*\}\s*,?\s*\n\s*\)/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/evidenceId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
  });

  it("threads evidenceId through to the timeline service", () => {
    expect(src).toMatch(/evidenceId:\s*q\.evidenceId\s*\?\?\s*null/);
  });

  it("preserves authorizeOrFail + antiEnumeration on the timeline route", () => {
    const block = src.match(
      /"\/v1\/graph\/timeline"[\s\S]*?\n\s*\}\s*,?\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/authorizeOrFail/);
    expect(block!).toMatch(/permission:\s*"evidence\.read"/);
    expect(block!).toMatch(/antiEnumeration:\s*true/);
  });
});

// =============================================================================
// PART 3 — /ops/media-graph page source contract
// =============================================================================

describe("Phase 31.7 + 32.6 — /ops/media-graph page", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/admin/platform/media-graph/page.tsx",
  );

  it("declared a client component", () => {
    expect(src.trimStart()).toMatch(/^"use client"/);
  });

  it("reads only from a whitelisted set of endpoints", () => {
    // Phase 31.9 — operator actions added two POST endpoints +
    // /v1/users/me for workspace id. Every call must match the
    // whitelist; no other endpoints permitted.
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const apiFetchCalls = noComments.match(/apiFetch\(\s*[`"][^`"]+[`"]/g) ?? [];
    expect(apiFetchCalls.length).toBeGreaterThan(0);
    const allowedPrefixes = [
      // ADM-013 PHASE 1 — the metric read moved from "/v1/ops/metrics" to the
      // canonical platform namespace. Both spellings answer the same
      // process-global registry behind the same requirePlatformAdmin gate;
      // this page is registered PLATFORM_ADMIN, so nothing about its audience
      // changed. What changed is that the URL now says which scope it is.
      //
      // The OLD path is not left in the list as a permitted alternative: two
      // acceptable spellings for one payload is how a page drifts back onto
      // the compatibility path and takes the next reader with it.
      "/v1/admin/platform/metrics",
      "/v1/users/me",
      "/v1/ops/media-intelligence/runs/",
      "/v1/ops/media-intelligence/dlq/replay",
    ];
    for (const call of apiFetchCalls) {
      const path = call.match(/[`"]([^`"]+)[`"]/)?.[1] ?? "";
      const matched = allowedPrefixes.some((p) => path.includes(p));
      expect(
        matched,
        `unexpected endpoint called from /ops/media-graph: ${path}`,
      ).toBe(true);
    }
  });

  it("renders the new Phase 31.6 counters", () => {
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
      expect(src, `tile missing for ${m}`).toContain(`"${m}"`);
    }
  });

  it("renders the new Phase 31.6 gauges", () => {
    for (const m of [
      "media_intelligence_runs_pending",
      "media_intelligence_runs_processing",
      "media_intelligence_runs_failed",
      "media_intelligence_oldest_pending_age_seconds",
      "media_intelligence_queue_depth",
    ]) {
      expect(src, `gauge tile missing for ${m}`).toContain(`"${m}"`);
    }
  });

  it("renders the Phase 32.5 graph query counters", () => {
    for (const m of [
      "graph_case_subgraph_loaded_total",
      "graph_search_executed_total",
      "graph_timeline_executed_total",
    ]) {
      expect(src, `graph tile missing for ${m}`).toContain(`"${m}"`);
    }
  });

  it("distinguishes missing metrics (em-dash) from zero", () => {
    // The TileGrid checks presence then emits "—" when absent.
    // Operators must be able to tell "no traffic" (0) from
    // "instrument missing" (—).
    expect(src).toMatch(/value\s*==\s*null\s*\?\s*"—"/);
  });

  it("polling is bounded (≤ 30s) and pauses when tab is hidden", () => {
    expect(src).toMatch(/setInterval\([\s\S]*?,\s*30_?000\s*\)/);
    expect(src).toMatch(/document\.hidden/);
  });

  it("no forbidden truth-claim vocabulary in user-facing literals", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(
        lit,
        `ops page uses forbidden wording: ${lit}`,
      ).not.toMatch(forbidden);
    }
  });

  it("no storage internals / signed URLs / GPS leakage", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageKey",
      "storage_key",
      "storageBucket",
      "storage_bucket",
      "signedUrl",
      "signed_url",
      "presignedUrl",
      "rawGps",
      "raw_gps",
    ]) {
      expect(noComments, `ops page leaks ${banned}`).not.toContain(banned);
    }
  });

  it("advisory disclaimer present (numbers are operational telemetry, not classifications)", () => {
    // Phase 31.9 — wording tightened to avoid the literal forbidden
    // words even in negation. JSX wraps the disclaimer across lines
    // so flatten whitespace before matching the phrase.
    const flat = src.replace(/\s+/g, " ");
    expect(flat).toMatch(/advisory operational telemetry/);
    expect(flat).toMatch(/do not classify the recorded material/);
    expect(flat).toMatch(/canonical custody record/);
  });
});
