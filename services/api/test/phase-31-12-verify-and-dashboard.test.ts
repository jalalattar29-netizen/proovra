/**
 * Phase 31.12 + 32.11 — Verify-page adoption + Investigation Overview dashboard.
 *
 * Source-contract + behavioural tests for the two surfaces shipped
 * this session:
 *
 *   * `services/api/src/services/media-intelligence/verify-projection.service.ts`
 *     — public-safe projection.
 *   * `services/api/src/routes/evidence.routes.ts` — public Verify
 *     route extension carrying the bounded advisory shape.
 *   * `services/api/src/routes/media-intelligence.routes.ts` — new
 *     /v1/investigation/overview workspace endpoint.
 *   * `apps/web/app/verify/[token]/page.tsx` — bounded advisory UI.
 *   * `apps/web/app/(app)/investigation/page.tsx` — investigation
 *     overview dashboard.
 *
 * Layers covered:
 *
 *   1. Public-safe projection: refuses without teamId/evidenceId,
 *      bounded result shape, count clamped, fixed disclaimer, never
 *      throws, DISMISSED filtered out, no leak fields in source.
 *   2. Verify route: pulls teamId, calls projection, attaches
 *      `mediaIntelligenceAdvisory` to response; legacy callers
 *      unaffected when no data.
 *   3. Verify UI: type widened OPTIONALLY, state setter wired,
 *      bounded section rendered with no per-signal detail.
 *   4. Investigation overview route: registered, auth-gated, returns
 *      bounded shape, never throws, severity-ordered, DISMISSED
 *      excluded from recent list.
 *   5. Dashboard UI: only safe endpoints called, no fake counters
 *      (— for missing metrics), no forbidden vocabulary, no
 *      storage internals, bounded polling.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  projectVerifyMediaIntelligence,
  VERIFY_MEDIA_INTELLIGENCE_DISCLAIMER,
} from "../src/services/media-intelligence/verify-projection.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Public-safe projection
// =============================================================================

describe("Phase 31.12 — verify projection: refusal at entry", () => {
  it("returns null when teamId is empty", async () => {
    const r = await projectVerifyMediaIntelligence({
      teamId: "",
      evidenceId: "00000000-0000-0000-0000-000000000001",
    });
    expect(r).toBeNull();
  });

  it("returns null when evidenceId is empty", async () => {
    const r = await projectVerifyMediaIntelligence({
      teamId: "00000000-0000-0000-0000-000000000001",
      evidenceId: "",
    });
    expect(r).toBeNull();
  });

  it("returns null on garbage UUIDs (Prisma may throw — projection swallows)", async () => {
    const r = await projectVerifyMediaIntelligence({
      teamId: "not-a-uuid",
      evidenceId: "also-not-a-uuid",
    });
    expect(r).toBeNull();
  });
});

describe("Phase 31.12 — verify projection: source contract", () => {
  const src = readSource(
    "../src/services/media-intelligence/verify-projection.service.ts",
  );

  it("DISMISSED signals filtered out at SQL", () => {
    expect(src).toMatch(/"status" IN \('PENDING','ACKNOWLEDGED'\)/);
    expect(src).not.toMatch(/"status" IN \([^)]*'DISMISSED'/);
  });

  it("team-anchored SQL (anti-enumeration)", () => {
    expect(src).toMatch(/WHERE "team_id" = \$1/);
  });

  it("count clamped to 99 (DoS / detail-leak prevention)", () => {
    expect(src).toMatch(/MAX_PUBLIC_COUNT\s*=\s*99/);
    expect(src).toMatch(/Math\.min\(Math\.max\(0,\s*Math\.floor\(raw\)\),\s*MAX_PUBLIC_COUNT\)/);
  });

  it("bounded result shape — ONLY hasObservations + observationCount + advisory", () => {
    const decl = src.match(
      /export type VerifyProjectionResult\s*=\s*\{[\s\S]*?\};/,
    )?.[0];
    expect(decl).toBeTruthy();
    const allowed = ["hasObservations", "observationCount", "advisory"];
    for (const k of allowed) {
      expect(decl, `result shape missing ${k}`).toContain(k);
    }
    // Reject per-signal detail keys that the workspace-internal
    // projection has but the public one MUST NOT.
    for (const banned of [
      "signals",
      "materialId",
      "severity",
      "confidence",
      "status",
      "safeSummary",
      "createdAtUtc",
    ]) {
      expect(decl!, `public projection leaks per-signal field ${banned}`).not.toMatch(
        new RegExp(`\\b${banned}\\b`),
      );
    }
  });

  it("never throws — try/catch returns null", () => {
    expect(src).toMatch(
      /try\s*\{[\s\S]*?\}\s*catch\s*\{[\s\S]*?return\s+null/,
    );
  });

  it("fixed disclaimer mentions advisory + canonical custody record + no forbidden vocabulary", () => {
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    expect(VERIFY_MEDIA_INTELLIGENCE_DISCLAIMER).toMatch(/advisory/i);
    expect(VERIFY_MEDIA_INTELLIGENCE_DISCLAIMER).toMatch(
      /canonical custody record/,
    );
    expect(VERIFY_MEDIA_INTELLIGENCE_DISCLAIMER).not.toMatch(forbidden);
  });

  it("no per-signal detail surfaces in SQL projection (SELECT only COUNT)", () => {
    // The SQL projects ONLY a count — never per-row fields.
    expect(src).toMatch(/SELECT COUNT\(\*\)::int AS "count"/);
    expect(src).not.toMatch(/SELECT[\s\S]*?safe_summary[\s\S]*?FROM "media_intelligence_signals"/);
    expect(src).not.toMatch(/SELECT[\s\S]*?signal_type[\s\S]*?FROM "media_intelligence_signals"/);
  });

  it("no storage internals / GPS / private notes anywhere in source", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageKey",
      "storage_key",
      "storageBucket",
      "storage_bucket",
      "multipartUploadId",
      "signedUrl",
      "presignedUrl",
      "rawGps",
      "raw_gps",
      "privateNote",
      "legalNote",
    ]) {
      expect(noComments, `verify projection leaks ${banned}`).not.toContain(
        banned,
      );
    }
  });

  it("no forbidden truth-claim vocabulary in source literals", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(lit, `projection uses forbidden wording: ${lit}`).not.toMatch(
        forbidden,
      );
    }
  });
});

// =============================================================================
// PART 2 — Verify route wiring
// =============================================================================

describe("Phase 31.12 — public verify route wiring", () => {
  const src = readSource("../src/routes/evidence.routes.ts");

  it("selects evidence.teamId for the projection (added to existing select)", () => {
    // Find the public verify select block and assert teamId is there.
    const start = src.indexOf('"/public/verify/:id"');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf(
      "Phase 14 — additive publication gate",
      start,
    );
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toMatch(/teamId:\s*true,/);
  });

  it("lazy-imports the verify projection service before sending", () => {
    expect(src).toMatch(
      /await import\(\s*"\.\.\/services\/media-intelligence\/verify-projection\.service\.js"/,
    );
  });

  it("response carries mediaIntelligenceAdvisory at top level", () => {
    // The variable is computed pre-send and attached as a key.
    expect(src).toMatch(
      /const mediaIntelligenceAdvisory = evidence\.teamId/,
    );
    // The return block includes the field.
    expect(src).toMatch(
      /return reply\.code\(200\)\.send\(\{[\s\S]*?mediaIntelligenceAdvisory,/,
    );
  });

  it("projection failure falls back to null without throwing", () => {
    // The async IIFE that calls the projection wraps everything in
    // try/catch and returns null on any failure.
    const block = src.match(
      /const mediaIntelligenceAdvisory[\s\S]*?:\s*null;/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/try\s*\{[\s\S]*?\}\s*catch\s*\{[\s\S]*?return\s+null/);
  });

  it("never invokes the projection when evidence.teamId is missing (anti-enumeration)", () => {
    const block = src.match(
      /const mediaIntelligenceAdvisory[\s\S]*?:\s*null;/,
    )?.[0];
    // Allow `evidence.teamId ? await (async ...)` OR `? (async ...)`
    expect(block!).toMatch(/evidence\.teamId[\s\S]*?\?\s*await\s*\(async/);
    expect(block!).toMatch(/:\s*null/);
  });
});

// =============================================================================
// PART 3 — Verify UI source contract
// =============================================================================

describe("Phase 31.12 — Verify page UI", () => {
  const src = readSource(
    "../../../apps/web/app/verify/[token]/page.tsx",
  );

  it("VerifyResponse widened OPTIONALLY with mediaIntelligenceAdvisory", () => {
    expect(src).toMatch(
      /mediaIntelligenceAdvisory\?:\s*\{[\s\S]*?hasObservations:\s*boolean[\s\S]*?observationCount:\s*number[\s\S]*?advisory:\s*string[\s\S]*?\}\s*\|\s*null/,
    );
  });

  it("state setter is wired into applyVerifyResponse", () => {
    expect(src).toMatch(
      /setMediaIntelligenceAdvisory\(data\.mediaIntelligenceAdvisory \?\? null\)/,
    );
  });

  it("Media Intelligence / Advisory Observations block is REMOVED from the verify page (product decision)", () => {
    // The low-value advisory block (bounded count + disclaimer for
    // workspace/correlation observations) was removed from the public
    // verify page. The API still returns `mediaIntelligenceAdvisory`
    // (type + setter retained above) but it is no longer rendered.
    expect(src).not.toContain('data-testid="verify-media-intelligence-advisory"');
    expect(src).not.toContain("Advisory observations available");
    expect(src).not.toContain("mediaIntelligenceAdvisory.observationCount");
    expect(src).not.toContain("mediaIntelligenceAdvisory.advisory");
  });
});

// =============================================================================
// PART 4 — Investigation overview API
// =============================================================================

describe("Phase 31.12 — /v1/investigation/overview route", () => {
  const src = readSource(
    "../src/routes/media-intelligence.routes.ts",
  );

  it("route registered + gated by authorizeOrFail + antiEnumeration", () => {
    const block = src.match(
      /"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/authorizeOrFail/);
    expect(block!).toMatch(/permission:\s*"evidence\.read"/);
    expect(block!).toMatch(/antiEnumeration:\s*true/);
  });

  it("DISMISSED excluded from recent list (operator dismissal intent)", () => {
    const block = src.match(
      /"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(
      /"status" IN \('PENDING','ACKNOWLEDGED'\)[\s\S]*?ORDER BY/,
    );
  });

  it("DISMISSED INCLUDED in totals (full workspace accounting)", () => {
    const block = src.match(
      /"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/FILTER \(WHERE "status" = 'DISMISSED'\)/);
  });

  it("bounded LIMITs (20 signals, 30 graph events)", () => {
    const block = src.match(
      /"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/LIMIT 20/);
    expect(block!).toMatch(/LIMIT 30/);
  });

  it("safe_summary truncated to 240 chars in projection", () => {
    const block = src.match(
      /"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/safe_summary\.slice\(0,\s*240\)/);
  });

  it("severity-ordered (ATTENTION first)", () => {
    const block = src.match(
      /"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(
      /WHEN 'ATTENTION' THEN 0[\s\S]*?WHEN 'REVIEW_RECOMMENDED' THEN 1/,
    );
  });

  it("each fetch wrapped in try/catch — never throws to caller", () => {
    const block = src.match(
      /"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    const catches = (block!.match(/\}\s*catch/g) ?? []).length;
    expect(catches).toBeGreaterThanOrEqual(3); // totals + recent + graph
  });

  it("graph stale-edge / stale-node exclusion", () => {
    const block = src.match(
      /"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    expect(block!).toMatch(/n\."stale_at_utc" IS NULL/);
    expect(block!).toMatch(/e\."stale_at_utc" IS NULL/);
  });

  it("team-anchored (anti-enumeration) on every SQL", () => {
    const block = src.match(
      /"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/,
    )?.[0];
    // Count team_id = $1 fragments — expect ≥ 3 (totals + recent +
    // node + edge stream).
    const matches = (block!.match(/team_id" = \$1/g) ?? []).length;
    expect(matches).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// PART 5 — Investigation dashboard UI source contract
// =============================================================================

describe("Phase 31.12 — /investigation dashboard page", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/investigation/page.tsx",
  );

  it("declared as a client component", () => {
    expect(src.trimStart()).toMatch(/^"use client"/);
  });

  it("only calls the whitelisted endpoints", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const apiFetchCalls =
      noComments.match(/apiFetch\(\s*[`"][^`"]+[`"]/g) ?? [];
    expect(apiFetchCalls.length).toBeGreaterThan(0);
    const allowed = [
      "/v1/users/me",
      "/v1/ops/metrics",
      "/v1/investigation/overview",
      // Phase 12 productization: the dashboard now surfaces a
      // Reviewer-activity + Indexing-progress summary by reading
      // the existing /v1/investigation/reviewers endpoint (no new
      // backend route). Pinned by
      // `phase-12-investigation-productization.test.ts`.
      "/v1/investigation/reviewers",
      // Wave 2 endpoint: Phase 6 added a workspace-wide
      // media-intelligence refresh button driven by handleRefresh().
      "/v1/investigation/media-intelligence/refresh",
      // Wave 2 endpoint: Phase 6 per-signal ack/dismiss handler
      // posts to the canonical media-intelligence signal action route.
      "/v1/media-intelligence/signals/",
      // Wave 2 endpoint: Phase 13 cross-evidence findings client
      // (apps/web/lib/api/intelligence.ts:getCrossEvidenceFindings)
      // is invoked from this page; the underlying apiFetch path is
      // /v1/intelligence/cross-evidence.
      "/v1/intelligence/cross-evidence",
    ];
    for (const call of apiFetchCalls) {
      const path = call.match(/[`"]([^`"]+)[`"]/)?.[1] ?? "";
      const ok = allowed.some((p) => path.includes(p));
      expect(ok, `unexpected endpoint: ${path}`).toBe(true);
    }
  });

  it("distinguishes missing metrics (— em-dash) from zero", () => {
    expect(src).toMatch(/value\s*==\s*null\s*\?\s*"—"/);
  });

  it("bounded polling — 60s + paused when tab hidden", () => {
    expect(src).toMatch(/setInterval\([\s\S]*?,\s*60_?000\s*\)/);
    expect(src).toMatch(/document\.hidden/);
  });

  it("no forbidden truth-claim vocabulary in any UI literal", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(lit, `dashboard uses forbidden wording: ${lit}`).not.toMatch(
        forbidden,
      );
    }
  });

  it("safer canonical-custody disclaimer (no 'authenticity' even in negation)", () => {
    const flat = src.replace(/\s+/g, " ");
    expect(flat).toMatch(/do not classify recorded material/);
    expect(flat).toMatch(/canonical custody record/);
    expect(src).not.toMatch(/authenticity or admissibility/);
  });

  it("severity / confidence / status labels mirror the panel (Observation / Review recommended / Needs attention)", () => {
    expect(src).toMatch(/return "Observation"/);
    expect(src).toMatch(/return "Review recommended"/);
    expect(src).toMatch(/return "Needs attention"/);
    expect(src).not.toMatch(/\bWARNING\b/);
    expect(src).not.toMatch(/\bCRITICAL\b/);
    expect(src).not.toMatch(/\bALERT\b/);
  });

  it("no storage internals / signed URLs / GPS leak", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageKey",
      "storage_key",
      "storageBucket",
      "storage_bucket",
      "multipartUploadId",
      "signedUrl",
      "signed_url",
      "presignedUrl",
      "rawGps",
      "raw_gps",
      "privateNote",
      "legalNote",
    ]) {
      expect(noComments, `dashboard leaks ${banned}`).not.toContain(banned);
    }
  });

  it("empty states present for both signal list AND graph activity list (with next-action guidance)", () => {
    // Wave 2 classifier swap: Phase 4 replaced inline empty-state
    // copy ("No analyses recorded yet" / "No graph activity yet") with
    // the canonical classifier-driven OperationalEmptyState primitive.
    // The requirement is preserved — both lists STILL render a bounded
    // empty state with a next-action affordance — but the prose now
    // lives in CLASSIFICATION_COPY (see assertion further below) and
    // the page only orchestrates the classifier resolution + the
    // nextAction object literal. The semantic intent ("empty states
    // present for both lists, with next-action guidance") is enforced
    // here by:
    //   1. The page MUST invoke classifyInvestigationEmptyState for
    //      BOTH the recent-signals list ("overview" domain) and the
    //      recent-graph-activity list ("graph" domain).
    //   2. The page MUST attach an OperationalEmptyState with a
    //      nextAction object literal carrying "Capture evidence" so
    //      the operator still sees a next-action hint.
    //   3. The page MUST render OperationalEmptyState (the canonical
    //      empty-state primitive) instead of inline JSX <p> fallbacks.
    const flat = src.replace(/\s+/g, " ");
    // (1) Both classifier invocations present, with correct domain
    //     hints (overview = signals list, graph = graph activity).
    //     Allow an optional trailing comma between the domain
    //     literal and the closing paren (Prettier may emit one).
    expect(flat).toMatch(
      /classifyInvestigationEmptyState\([\s\S]*?,\s*"overview"\s*,?\s*\)/,
    );
    expect(flat).toMatch(
      /classifyInvestigationEmptyState\([\s\S]*?,\s*"graph"\s*,?\s*\)/,
    );
    // (2) The page wires nextAction with "Capture evidence" so the
    //     operator still has next-action guidance.
    expect(flat).toMatch(
      /nextAction=\{\s*\{\s*label:\s*"Capture evidence"\s*,\s*href:\s*"\/capture"\s*\}\s*\}/,
    );
    // (3) The canonical empty-state primitive is mounted (not an
    //     inline <p> fallback) for both lists.
    const operationalEmptyStateMounts =
      (flat.match(/<OperationalEmptyState\b/g) ?? []).length;
    expect(operationalEmptyStateMounts).toBeGreaterThanOrEqual(2);
  });

  it("canonical empty-state copy lives in OperationalEmptyState (classifier-driven)", () => {
    // Wave 2 classifier swap: Phase 4 moved the per-list empty-state
    // prose ("No analyses recorded yet" / "No graph activity yet")
    // out of the dashboard page and into CLASSIFICATION_COPY on the
    // canonical OperationalEmptyState primitive. The canonical prose
    // is bounded — every Investigation surface MUST pick a code from
    // the 10-classification union, and the primitive renders the
    // matching kicker + title verbatim. This pin enforces that the
    // CLASSIFICATION_COPY map still defines the keys the classifier
    // resolves to for empty signal/graph lists (TRUE_EMPTY, the
    // catch-all when no error / no pending pipeline is detected) so
    // the operator still sees an empty-state explanation rather than
    // a dead surface.
    const operationalSrc = readSource(
      "../../../apps/web/components/operational/OperationalEmptyState.tsx",
    );
    // The CLASSIFICATION_COPY map MUST be exported.
    expect(operationalSrc).toMatch(
      /export const CLASSIFICATION_COPY\s*[:=]/,
    );
    // TRUE_EMPTY is the catch-all classification for empty data with
    // no pipeline activity (see classifier Rule 9). The map MUST
    // define a kicker + title for it so the page renders meaningful
    // empty-state prose instead of a blank surface.
    expect(operationalSrc).toMatch(
      /TRUE_EMPTY:\s*\{[\s\S]*?kicker:\s*"[^"]+"[\s\S]*?title:\s*"[^"]+"/,
    );
    // The PIPELINE_PENDING entry covers the case where graph
    // reconcile / media-intelligence work is queued — the equivalent
    // of the legacy "Graph reconcile runs…" hint.
    expect(operationalSrc).toMatch(
      /PIPELINE_PENDING:\s*\{[\s\S]*?kicker:\s*"[^"]+"[\s\S]*?title:\s*"[^"]+"/,
    );
  });

  it("pivots to existing surfaces (no dead-end dashboard)", () => {
    expect(src).toMatch(/href="\/operations\/media-graph"/);
    expect(src).toMatch(/href=\{`\/evidence\/\$\{encodeURIComponent\(s\.evidenceId\)\}`\}/);
  });
});
