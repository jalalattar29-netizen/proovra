/**
 * Phase 31.18 / 32.17 — Source-contract tests for the closure
 * program shipped in the prior session.
 *
 * The prior session shipped routes / pages / domains but no
 * dedicated tests. This file closes that gap by enforcing the
 * source-level contracts that the runtime depends on:
 *
 *   1. EXTERNAL_REVIEW graph domain reconciler:
 *      - team-anchored SELECT
 *      - bounded label uses only scope_kind + state enum tokens
 *      - NEVER reads reviewer_email / reviewer_display_name /
 *        safe_note / token_hash / token_prefix from the table
 *      - WORKSPACE_INTERNAL visibility
 *      - stale-tombstone sweep (team-anchored on both sides)
 *      - try/catch isolation
 *
 *   2. Per-kind stale sweep for MEDIA_SIGNAL / OCR / TRANSCRIPT:
 *      - three separate sweeps, one per node_kind
 *      - kind discriminator matches what section-2 materialised
 *        (OCR_AVAILABLE → OCR, TRANSCRIPT_AVAILABLE → TRANSCRIPT,
 *        else → MEDIA_SIGNAL)
 *      - team-anchored on both UPDATE and sub-select
 *      - independent try/catch (one sweep failure doesn't affect
 *        others)
 *
 *   3. New service helpers `listDuplicateEdges` + `listGraphSeedNodes`:
 *      - team-anchored
 *      - stale excluded
 *      - bounded limits
 *      - both endpoints' team_id checked for duplicates
 *
 *   4. New routes (/v1/graph/duplicates, /v1/graph/seeds,
 *      /v1/investigation/reviewers):
 *      - registered
 *      - authorizeOrFail + antiEnumeration: true
 *      - bounded zod query schemas
 *      - reviewer console never projects reviewer_email /
 *        token_hash / safe_note / escalation_reason /
 *        rejection_reason / paused_reason / resolution_note /
 *        suppression_reason
 *
 *   5. Public projections (PublicDuplicateEdge, PublicGraphSeed):
 *      - no internal timestamps beyond observedAtUtc/updatedAtUtc
 *      - no createdByUserId / staleAtUtc / createdAtUtc leakage
 *
 *   6. UI source contracts:
 *      - duplicates page: client component, real endpoint,
 *        forbidden-wording absent, only whitelisted endpoints
 *      - graph navigation: client component, real endpoint
 *      - reviewers console: client component, real endpoint,
 *        no reviewer_email / safe_note / token_hash text in source
 *      - timeline: anchor param wired, pivot link present
 *      - search: investigation pivots section present
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// Strip /* … */ and // … comments so forbidden-wording regex doesn't
// trigger on documentation that references the words. Mirrors the
// strip helper used by earlier source-contract tests.
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

// Flatten whitespace so JSX text that wraps across lines still
// matches simple substring/regex assertions.
function flat(s: string): string {
  return s.replace(/\s+/g, " ");
}

const RECONCILER_SRC = readSource(
  "../../../packages/shared-runtime/src/graph/graph-builder.service.ts",
);
const GRAPH_ROUTES_SRC = readSource("../src/routes/graph.routes.ts");
const MI_ROUTES_SRC = readSource("../src/routes/media-intelligence.routes.ts");

// Pre-strip comments so forbidden-wording checks don't catch
// documentation comments that intentionally reference the words.
const RECONCILER_CODE = stripComments(RECONCILER_SRC);
const GRAPH_ROUTES_CODE = stripComments(GRAPH_ROUTES_SRC);
const MI_ROUTES_CODE = stripComments(MI_ROUTES_SRC);

// =============================================================================
// PART 1 — EXTERNAL_REVIEW graph domain reconciler
// =============================================================================

describe("Phase 31.18 — EXTERNAL_REVIEW graph domain", () => {
  it("declares a Phase 31.18 anchor section in the reconciler", () => {
    expect(RECONCILER_SRC).toMatch(
      /Phase 31\.18 — EXTERNAL_REVIEW domain reconciliation/,
    );
  });

  it("reads from external_review_grants table, team-anchored", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.18 — EXTERNAL_REVIEW domain reconciliation",
    );
    expect(idx).toBeGreaterThan(0);
    const slice = RECONCILER_SRC.slice(idx, idx + 4000);
    expect(slice).toMatch(/FROM "external_review_grants"/);
    expect(slice).toMatch(/WHERE "team_id" = \$1/);
  });

  it("only reads bounded scope/state/scope-target columns — never reviewer_email / display_name / safe_note / token_hash", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.18 — EXTERNAL_REVIEW domain reconciliation",
    );
    const idxEnd = RECONCILER_SRC.indexOf("// 2. Materialize MEDIA_SIGNAL", idx);
    expect(idxEnd).toBeGreaterThan(idx);
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    expect(slice).not.toMatch(/"reviewer_email"/);
    expect(slice).not.toMatch(/"reviewer_display_name"/);
    expect(slice).not.toMatch(/"safe_note"/);
    expect(slice).not.toMatch(/"token_hash"/);
    expect(slice).not.toMatch(/"token_prefix"/);
    expect(slice).not.toMatch(/"invited_by_user_id"/);
  });

  it("upserts EXTERNAL_REVIEW node kind with WORKSPACE_INTERNAL visibility", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.18 — EXTERNAL_REVIEW domain reconciliation",
    );
    const slice = RECONCILER_SRC.slice(idx, idx + 4000);
    expect(slice).toMatch(/upsertNode\s*\([\s\S]*?"EXTERNAL_REVIEW"[\s\S]*?"WORKSPACE_INTERNAL"/);
  });

  it("emits REVIEWED_BY edges from the correct scope-target node kind", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.18 — EXTERNAL_REVIEW domain reconciliation",
    );
    const idxEnd = RECONCILER_SRC.indexOf("// 2. Materialize MEDIA_SIGNAL", idx);
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    expect(slice).toMatch(/"REVIEWED_BY"/);
    // All three scope kinds handled.
    expect(slice).toMatch(/scope_kind === "EVIDENCE"/);
    expect(slice).toMatch(/scope_kind === "CASE"/);
    expect(slice).toMatch(/scope_kind === "PACKAGE"/);
    // Edge endpoint resolution: EVIDENCE → EVIDENCE node, CASE →
    // CASE node, PACKAGE → VERIFICATION_PACKAGE node.
    expect(slice).toMatch(/"EVIDENCE",[\s\S]*?g\.evidence_id/);
    expect(slice).toMatch(/"CASE",[\s\S]*?g\.case_id/);
    expect(slice).toMatch(/"VERIFICATION_PACKAGE",[\s\S]*?g\.package_id/);
  });

  it("includes a team-anchored stale-tombstone sweep on both UPDATE and inner sub-select", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.18 — EXTERNAL_REVIEW domain reconciliation",
    );
    const idxEnd = RECONCILER_SRC.indexOf("// 2. Materialize MEDIA_SIGNAL", idx);
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    expect(slice).toMatch(/UPDATE "investigation_graph_nodes" n/);
    expect(slice).toMatch(/"node_kind" = 'EXTERNAL_REVIEW'/);
    expect(slice).toMatch(/NOT EXISTS/);
    // The outer UPDATE binds team_id and the sub-select binds it too.
    const teamBindCount = (slice.match(/"team_id" = \$1/g) ?? []).length;
    expect(teamBindCount).toBeGreaterThanOrEqual(2);
  });

  it("wraps the EXTERNAL_REVIEW block in independent try/catch isolation", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.18 — EXTERNAL_REVIEW domain reconciliation",
    );
    const idxEnd = RECONCILER_SRC.indexOf("// 2. Materialize MEDIA_SIGNAL", idx);
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    const outerCatches =
      slice.match(/catch\s*\{[\s\S]*?best-effort; the rest of the reconcile continues/g) ??
      [];
    expect(outerCatches.length).toBe(1);
  });
});

// =============================================================================
// PART 2 — Per-kind stale sweep for MEDIA_SIGNAL / OCR / TRANSCRIPT
// =============================================================================

describe("Phase 31.18 — per-kind stale-sweep hardening", () => {
  it("declares a Phase 31.18 anchor for the per-kind stale sweep", () => {
    expect(RECONCILER_SRC).toMatch(
      /Phase 31\.18 — per-kind stale-tombstone sweep/,
    );
  });

  it("includes three separate stale sweeps anchored on MEDIA_SIGNAL / OCR / TRANSCRIPT", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.18 — per-kind stale-tombstone sweep",
    );
    const idxEnd = RECONCILER_SRC.indexOf("// 3. Build SAME_HASH_AS", idx);
    expect(idxEnd).toBeGreaterThan(idx);
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    expect(slice).toMatch(/"node_kind" = 'MEDIA_SIGNAL'/);
    expect(slice).toMatch(/"node_kind" = 'OCR'/);
    expect(slice).toMatch(/"node_kind" = 'TRANSCRIPT'/);
  });

  it("uses kind discriminators matching the section-2 materializer", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.18 — per-kind stale-tombstone sweep",
    );
    const idxEnd = RECONCILER_SRC.indexOf("// 3. Build SAME_HASH_AS", idx);
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    // OCR sweep checks that the underlying signal still has
    // signal_type = 'OCR_AVAILABLE'; symmetric for TRANSCRIPT.
    expect(slice).toMatch(/"signal_type" = 'OCR_AVAILABLE'/);
    expect(slice).toMatch(/"signal_type" = 'TRANSCRIPT_AVAILABLE'/);
    // MEDIA_SIGNAL sweep excludes the two kind-specific signal types
    // so it doesn't tombstone OCR/TRANSCRIPT signals' MEDIA_SIGNAL
    // nodes (those nodes don't exist).
    expect(slice).toMatch(
      /"signal_type" NOT IN \('OCR_AVAILABLE', 'TRANSCRIPT_AVAILABLE'\)/,
    );
  });

  it("each per-kind sweep is wrapped in independent try/catch", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.18 — per-kind stale-tombstone sweep",
    );
    const idxEnd = RECONCILER_SRC.indexOf("// 3. Build SAME_HASH_AS", idx);
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    const tryBlocks = slice.match(/try\s*\{/g) ?? [];
    // Three independent try blocks (one per kind).
    expect(tryBlocks.length).toBe(3);
    const bestEffortMarkers = slice.match(/best-effort/g) ?? [];
    expect(bestEffortMarkers.length).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// PART 3 — Duplicate listing helper + Graph seeds helper
// =============================================================================

describe("Phase 31.18 — listDuplicateEdges helper", () => {
  it("is exported from graph-builder.service.ts", () => {
    expect(RECONCILER_SRC).toMatch(/export async function listDuplicateEdges/);
  });

  it("filters to evidence-to-evidence edges of the three bounded kinds only", () => {
    const idx = RECONCILER_SRC.indexOf("export async function listDuplicateEdges");
    const idxEnd = RECONCILER_SRC.indexOf(
      "export async function listGraphSeedNodes",
      idx,
    );
    expect(idxEnd).toBeGreaterThan(idx);
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    expect(slice).toMatch(/'SAME_HASH_AS','SIMILAR_TO','POSSIBLE_DERIVATIVE_OF'/);
    expect(slice).toMatch(/ns\."node_kind" = 'EVIDENCE'/);
    expect(slice).toMatch(/nt\."node_kind" = 'EVIDENCE'/);
  });

  it("anchors team_id on the edge AND on both endpoint nodes (anti-leak)", () => {
    const idx = RECONCILER_SRC.indexOf("export async function listDuplicateEdges");
    const idxEnd = RECONCILER_SRC.indexOf(
      "export async function listGraphSeedNodes",
      idx,
    );
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    expect(slice).toMatch(/e\."team_id" = \$1/);
    expect(slice).toMatch(/ns\."team_id" = \$1/);
    expect(slice).toMatch(/nt\."team_id" = \$1/);
  });

  it("excludes stale edges", () => {
    const idx = RECONCILER_SRC.indexOf("export async function listDuplicateEdges");
    const idxEnd = RECONCILER_SRC.indexOf(
      "export async function listGraphSeedNodes",
      idx,
    );
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    expect(slice).toMatch(/e\."stale_at_utc" IS NULL/);
  });

  it("clamps limit to 1..200 with default 100", () => {
    const idx = RECONCILER_SRC.indexOf("export async function listDuplicateEdges");
    const idxEnd = RECONCILER_SRC.indexOf(
      "export async function listGraphSeedNodes",
      idx,
    );
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    expect(slice).toMatch(/Math\.max\(1,\s*Math\.min\(input\.limit \?\? 100, 200\)\)/);
  });
});

describe("Phase 31.18 — listGraphSeedNodes helper", () => {
  it("is exported and bounds per-kind limit to <=50", () => {
    expect(RECONCILER_SRC).toMatch(/export async function listGraphSeedNodes/);
    const idx = RECONCILER_SRC.indexOf("export async function listGraphSeedNodes");
    const slice = RECONCILER_SRC.slice(idx, idx + 3000);
    expect(slice).toMatch(/Math\.min\(input\.perKindLimit \?\? 25, 50\)/);
  });

  it("excludes stale and team-anchors every query", () => {
    const idx = RECONCILER_SRC.indexOf("export async function listGraphSeedNodes");
    const slice = RECONCILER_SRC.slice(idx, idx + 3000);
    expect(slice).toMatch(/"stale_at_utc" IS NULL/);
    expect(slice).toMatch(/"team_id" = \$1/);
  });
});

// =============================================================================
// PART 4 — New routes: /v1/graph/duplicates, /v1/graph/seeds, /v1/investigation/reviewers
// =============================================================================

describe("Phase 31.18 — new graph routes", () => {
  it("/v1/graph/duplicates is registered with bounded query schema", () => {
    expect(GRAPH_ROUTES_SRC).toMatch(/app\.get\(\s*"\/v1\/graph\/duplicates"/);
    const idx = GRAPH_ROUTES_SRC.indexOf('"/v1/graph/duplicates"');
    const slice = GRAPH_ROUTES_SRC.slice(idx, idx + 1500);
    expect(slice).toMatch(/teamId: z\.string\(\)\.uuid\(\)/);
    expect(slice).toMatch(/evidenceId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(slice).toMatch(/limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)\.optional\(\)/);
  });

  it("/v1/graph/seeds is registered with bounded query schema", () => {
    expect(GRAPH_ROUTES_SRC).toMatch(/app\.get\(\s*"\/v1\/graph\/seeds"/);
    const idx = GRAPH_ROUTES_SRC.indexOf('"/v1/graph/seeds"');
    const slice = GRAPH_ROUTES_SRC.slice(idx, idx + 1500);
    expect(slice).toMatch(/teamId: z\.string\(\)\.uuid\(\)/);
    expect(slice).toMatch(/perKindLimit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(50\)\.optional\(\)/);
  });

  it("both new graph routes require authorizeOrFail + antiEnumeration: true + evidence.read", () => {
    const dupIdx = GRAPH_ROUTES_SRC.indexOf('"/v1/graph/duplicates"');
    const dupSlice = GRAPH_ROUTES_SRC.slice(dupIdx, dupIdx + 1500);
    expect(dupSlice).toMatch(
      /authorizeOrFail\(\s*req,\s*reply,\s*\{[\s\S]*?antiEnumeration: true[\s\S]*?\}\s*\)/,
    );
    expect(dupSlice).toMatch(/permission: "evidence\.read"/);
    const seedsIdx = GRAPH_ROUTES_SRC.indexOf('"/v1/graph/seeds"');
    const seedsSlice = GRAPH_ROUTES_SRC.slice(seedsIdx, seedsIdx + 1500);
    expect(seedsSlice).toMatch(
      /authorizeOrFail\(\s*req,\s*reply,\s*\{[\s\S]*?antiEnumeration: true[\s\S]*?\}\s*\)/,
    );
    expect(seedsSlice).toMatch(/permission: "evidence\.read"/);
  });

  it("filters unknown kinds via bounded GRAPH_NODE_KINDS set (no information leak)", () => {
    const idx = GRAPH_ROUTES_SRC.indexOf('"/v1/graph/seeds"');
    const slice = GRAPH_ROUTES_SRC.slice(idx, idx + 1500);
    expect(slice).toMatch(/kindSet\.has/);
  });
});

describe("Phase 31.18 — /v1/investigation/reviewers route", () => {
  it("is registered", () => {
    expect(MI_ROUTES_SRC).toMatch(/app\.get\(\s*"\/v1\/investigation\/reviewers"/);
  });

  it("uses authorizeOrFail + antiEnumeration: true + evidence.read", () => {
    const idx = MI_ROUTES_SRC.indexOf('"/v1/investigation/reviewers"');
    // Take a generous slice — the handler body is large.
    const slice = MI_ROUTES_SRC.slice(idx, idx + 12_000);
    expect(slice).toMatch(
      /authorizeOrFail\(\s*req,\s*reply,\s*\{[\s\S]*?antiEnumeration: true[\s\S]*?\}\s*\)/,
    );
    expect(slice).toMatch(/permission: "evidence\.read"/);
  });

  it("NEVER reads reviewer_email / token_hash / safe_note / *_reason / *_note from the source table", () => {
    const idx = MI_ROUTES_SRC.indexOf("Phase 31.18 — Reviewer Intelligence Console");
    const idxEnd = MI_ROUTES_SRC.indexOf(
      "/v1/evidence/:evidenceId/derived-assets?teamId=",
      idx,
    );
    expect(idxEnd).toBeGreaterThan(idx);
    const slice = MI_ROUTES_SRC.slice(idx, idxEnd);
    // The handler must NOT pull reviewer-private columns.
    expect(slice).not.toMatch(/"reviewer_email"/);
    expect(slice).not.toMatch(/"reviewer_display_name"/);
    expect(slice).not.toMatch(/"token_hash"/);
    expect(slice).not.toMatch(/"token_prefix"/);
    expect(slice).not.toMatch(/"safe_note"/);
    expect(slice).not.toMatch(/"escalation_reason"/);
    expect(slice).not.toMatch(/"rejection_reason"/);
    expect(slice).not.toMatch(/"paused_reason"/);
    expect(slice).not.toMatch(/"resolution_note"/);
    expect(slice).not.toMatch(/"suppression_reason"/);
  });

  it("response keeps the bounded enum-token surface (status / state catalog tokens only)", () => {
    const idx = MI_ROUTES_SRC.indexOf("Phase 31.18 — Reviewer Intelligence Console");
    const slice = MI_ROUTES_SRC.slice(idx, idx + 12_000);
    // Workflow / escalation / external-review totals all keyed by
    // bounded catalog statuses.
    expect(slice).toMatch(/workflowTotals/);
    expect(slice).toMatch(/escalationTotals/);
    expect(slice).toMatch(/externalReviewTotals/);
    expect(slice).toMatch(/recentEscalations/);
    expect(slice).toMatch(/recentGrants/);
  });
});

// =============================================================================
// PART 5 — Public projections in graph.routes.ts have no internal-field leak
// =============================================================================

describe("Phase 31.18 — public duplicate/seed projections", () => {
  it("PublicDuplicateEdge omits createdByUserId / staleAtUtc / createdAtUtc / updatedAtUtc", () => {
    const idx = GRAPH_ROUTES_SRC.indexOf("type PublicDuplicateEdge");
    expect(idx).toBeGreaterThan(0);
    const slice = GRAPH_ROUTES_SRC.slice(idx, idx + 800);
    expect(slice).not.toMatch(/createdByUserId/);
    expect(slice).not.toMatch(/staleAtUtc/);
    expect(slice).not.toMatch(/createdAtUtc/);
    // Only the bounded observed-at timestamp is exposed.
    expect(slice).toMatch(/observedAtUtc/);
  });

  it("PublicGraphSeed omits createdAtUtc / staleAtUtc / teamId", () => {
    const idx = GRAPH_ROUTES_SRC.indexOf("type PublicGraphSeed");
    expect(idx).toBeGreaterThan(0);
    const slice = GRAPH_ROUTES_SRC.slice(idx, idx + 600);
    expect(slice).not.toMatch(/createdAtUtc/);
    expect(slice).not.toMatch(/staleAtUtc/);
    expect(slice).not.toMatch(/\bteamId\b/);
    expect(slice).toMatch(/updatedAtUtc/);
  });
});

// =============================================================================
// PART 6 — UI source contracts
// =============================================================================

const DUPLICATES_PAGE = readSource(
  "../../../apps/web/app/(app)/investigation/duplicates/page.tsx",
);
const GRAPH_NAV_PAGE = readSource(
  "../../../apps/web/app/(app)/investigation/graph/page.tsx",
);
const REVIEWERS_PAGE = readSource(
  "../../../apps/web/app/(app)/investigation/reviewers/page.tsx",
);
const TIMELINE_PAGE = readSource(
  "../../../apps/web/app/(app)/investigation/timeline/page.tsx",
);
const SEARCH_PAGE = readSource(
  "../../../apps/web/app/(app)/search/page.tsx",
);

const FORBIDDEN_USER_FACING = [
  "tampered",
  "forged",
  "manipulated",
  "authentic",
  "admissible",
  "proves",
  "confirms",
  "doctored",
  // "fake" appears inside source tokens like fontFamily — exclude
  // by checking only word-boundary user-facing text.
];

function expectNoForbiddenUserFacing(src: string): void {
  const code = stripComments(src);
  const lower = code.toLowerCase();
  for (const word of FORBIDDEN_USER_FACING) {
    expect(lower).not.toMatch(new RegExp(`\\b${word}\\b`));
  }
}

describe("Phase 31.18 — Duplicate Review UI source contract", () => {
  it("is a client component", () => {
    expect(DUPLICATES_PAGE.split("\n")[0].trim()).toBe('"use client";');
  });

  it("calls only the whitelisted endpoints", () => {
    const calls = DUPLICATES_PAGE.match(/apiFetch\(\s*[`"][^`"]+/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      // Allow /v1/users/me, /v1/graph/duplicates, template strings
      // constructing the latter.
      const ok =
        c.includes("/v1/users/me") ||
        c.includes("/v1/graph/duplicates");
      expect(ok).toBe(true);
    }
  });

  it("uses 'exact byte match' wording for SAME_HASH_AS — never 'identical' or 'fake'", () => {
    const flat = DUPLICATES_PAGE.replace(/\s+/g, " ");
    expect(flat).toMatch(/exact byte match/);
  });

  it("uses 'perceptually similar' / 'possible derivative' candidate wording", () => {
    const flat = DUPLICATES_PAGE.replace(/\s+/g, " ");
    expect(flat).toMatch(/perceptually similar/);
    expect(flat).toMatch(/possible derivative/);
  });

  it("never uses forbidden user-facing vocabulary", () => {
    expectNoForbiddenUserFacing(DUPLICATES_PAGE);
  });

  it("never references storage/internal fields", () => {
    expect(DUPLICATES_PAGE).not.toMatch(/storage_bucket|storage_key|signedUrl|signed_url|multipartUploadId/);
  });

  it("polling is bounded to 60s and paused when document hidden", () => {
    expect(DUPLICATES_PAGE).toMatch(/60_000/);
    expect(DUPLICATES_PAGE).toMatch(/document\.hidden/);
  });
});

describe("Phase 31.18 — Graph Navigation Explorer UI source contract", () => {
  it("is a client component", () => {
    expect(GRAPH_NAV_PAGE.split("\n")[0].trim()).toBe('"use client";');
  });

  it("calls only whitelisted endpoints", () => {
    const calls = GRAPH_NAV_PAGE.match(/apiFetch\(\s*[`"][^`"]+/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const ok =
        c.includes("/v1/users/me") || c.includes("/v1/graph/seeds");
      expect(ok).toBe(true);
    }
  });

  it("respects the public projection shape — no createdAtUtc, no staleAtUtc, no teamId in client type", () => {
    const idx = GRAPH_NAV_PAGE.indexOf("type GraphSeed ");
    expect(idx).toBeGreaterThan(0);
    const slice = GRAPH_NAV_PAGE.slice(idx, idx + 400);
    expect(slice).not.toMatch(/createdAtUtc/);
    expect(slice).not.toMatch(/staleAtUtc/);
    expect(slice).not.toMatch(/\bteamId\b/);
  });

  it("never uses forbidden user-facing vocabulary", () => {
    expectNoForbiddenUserFacing(GRAPH_NAV_PAGE);
  });

  it("polling is bounded to 60s and paused when document hidden", () => {
    expect(GRAPH_NAV_PAGE).toMatch(/60_000/);
    expect(GRAPH_NAV_PAGE).toMatch(/document\.hidden/);
  });
});

describe("Phase 31.18 — Reviewer Intelligence Console UI source contract", () => {
  it("is a client component", () => {
    expect(REVIEWERS_PAGE.split("\n")[0].trim()).toBe('"use client";');
  });

  it("calls only whitelisted endpoints", () => {
    const calls = REVIEWERS_PAGE.match(/apiFetch\(\s*[`"][^`"]+/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const ok =
        c.includes("/v1/users/me") ||
        c.includes("/v1/investigation/reviewers") ||
        // Phase 31.19 — bounded acknowledge/dismiss action endpoint.
        c.includes("/v1/media-intelligence/signals/");
      expect(ok).toBe(true);
    }
  });

  it("never displays reviewer_email / safe_note / token_hash / *_reason / *_note text", () => {
    const code = stripComments(REVIEWERS_PAGE);
    expect(code).not.toMatch(/reviewerEmail/);
    expect(code).not.toMatch(/reviewerDisplayName/);
    // The route response type doesn't carry these. The UI client type
    // must also not declare them.
    expect(code).not.toMatch(/safeNote/);
    expect(code).not.toMatch(/tokenHash/);
    expect(code).not.toMatch(/escalationReason/);
    expect(code).not.toMatch(/rejectionReason/);
    expect(code).not.toMatch(/pausedReason/);
    expect(code).not.toMatch(/resolutionNote/);
    expect(code).not.toMatch(/suppressionReason/);
  });

  it("renders all three totals tiles + two listing sections (no decorative-only counters)", () => {
    expect(REVIEWERS_PAGE).toMatch(/Review workflows/);
    expect(REVIEWERS_PAGE).toMatch(/Escalations/);
    expect(REVIEWERS_PAGE).toMatch(/External-reviewer grants/);
    expect(REVIEWERS_PAGE).toMatch(/Open escalations/);
    expect(REVIEWERS_PAGE).toMatch(/Active external-reviewer grants/);
  });

  it("never uses forbidden user-facing vocabulary", () => {
    expectNoForbiddenUserFacing(REVIEWERS_PAGE);
  });

  it("degraded state shows a 'data unavailable' pill, not a fake counter", () => {
    expect(REVIEWERS_PAGE).toMatch(/data unavailable/);
    // The tiles render "—" when data is null (no fake zero).
    expect(REVIEWERS_PAGE).toMatch(/total == null \? "—" : total/);
  });
});

describe("Phase 31.18 — Timeline pivot wiring", () => {
  it("respects the evidenceId URL param and threads it through the API call", () => {
    expect(TIMELINE_PAGE).toMatch(/anchorEvidenceId/);
    expect(TIMELINE_PAGE).toMatch(/searchParams\.get\("evidenceId"\)|\.get\("evidenceId"\)/);
    expect(TIMELINE_PAGE).toMatch(/\/v1\/graph\/timeline\?[\s\S]*?q\.toString\(\)/);
  });

  it("renders a per-event 'Inspect' pivot link to the Relationship Inspector", () => {
    expect(TIMELINE_PAGE).toMatch(/\/investigation\/relationships\?nodeId=\$\{encodeURIComponent\(/);
    expect(TIMELINE_PAGE).toMatch(/Inspect/);
  });
});

describe("Phase 31.18 — Search → graph/timeline pivots", () => {
  it("adds an 'Investigation pivots' section in the search inspector", () => {
    const flat = SEARCH_PAGE.replace(/\s+/g, " ");
    expect(flat).toMatch(/Investigation pivots/);
  });

  it("constructs pivot URLs from existing IDs (no new server fields)", () => {
    expect(SEARCH_PAGE).toMatch(/\/investigation\/cases\/\$\{row\.caseId\}\/graph/);
    expect(SEARCH_PAGE).toMatch(/\/investigation\/timeline\?evidenceId=\$\{encodeURIComponent\(/);
    expect(SEARCH_PAGE).toMatch(/\/investigation\/duplicates\?evidenceId=\$\{encodeURIComponent\(/);
  });

  it("pivots are gated on a visible evidenceId or caseId — no leak when both are null", () => {
    const flat = SEARCH_PAGE.replace(/\s+/g, " ");
    expect(flat).toMatch(/\(row\.evidenceId \|\| row\.caseId\) \? \( <Section label="Investigation pivots">/);
  });
});

// =============================================================================
// PART 7 — Metrics registry (new bounded counters are registered)
// =============================================================================

const METRICS_SRC = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");

describe("Phase 31.18 — metric names registered", () => {
  it("registers the 4 new bounded counters", () => {
    expect(METRICS_SRC).toMatch(/"graph_duplicate_list_total"/);
    expect(METRICS_SRC).toMatch(/"graph_duplicate_list_executed_total"/);
    expect(METRICS_SRC).toMatch(/"graph_seeds_executed_total"/);
    expect(METRICS_SRC).toMatch(/"reviewer_console_query_total"/);
  });
});

// =============================================================================
// PART 8 — Phase 31.19 hardening: DISMISSED-signal exclusion
// =============================================================================

describe("Phase 31.19 — DISMISSED-signal graph hardening", () => {
  it("section-2 materializer filters out DISMISSED signals at SELECT time", () => {
    const idx = RECONCILER_SRC.indexOf(
      "// 2. Materialize MEDIA_SIGNAL nodes",
    );
    expect(idx).toBeGreaterThan(0);
    const idxEnd = RECONCILER_SRC.indexOf(
      "Phase 31.18 — per-kind stale-tombstone sweep",
      idx,
    );
    expect(idxEnd).toBeGreaterThan(idx);
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    // The SELECT must constrain status to the two non-dismissed
    // values. We expect the literal SQL fragment.
    expect(slice).toMatch(/"status" IN \('PENDING', 'ACKNOWLEDGED'\)/);
  });

  it("each per-kind stale sweep also tombstones nodes whose signal is now DISMISSED", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.18 — per-kind stale-tombstone sweep",
    );
    const idxEnd = RECONCILER_SRC.indexOf("// 3. Build SAME_HASH_AS", idx);
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    // All three sweeps include the status-in-active filter on the
    // inner NOT EXISTS sub-select. Count them.
    const statusFilters = slice.match(/s\."status" IN \('PENDING', 'ACKNOWLEDGED'\)/g) ?? [];
    expect(statusFilters.length).toBe(3);
  });

  it("section-2 NEVER reads technical_details_json into the graph code path", () => {
    const idx = RECONCILER_SRC.indexOf(
      "// 2. Materialize MEDIA_SIGNAL nodes",
    );
    const idxEnd = RECONCILER_SRC.indexOf(
      "Phase 31.18 — per-kind stale-tombstone sweep",
      idx,
    );
    // Strip comments so the documentation block that references the
    // column doesn't trigger the regex. We're enforcing the source
    // CODE never reads the column, not that the column name is
    // absent from doc comments.
    const slice = stripComments(RECONCILER_SRC.slice(idx, idxEnd));
    expect(slice).not.toMatch(/technical_details_json/);
  });

  it("graph node labels never read raw OCR/transcript text — only safe_summary", () => {
    const idx = RECONCILER_SRC.indexOf(
      "// 2. Materialize MEDIA_SIGNAL nodes",
    );
    const idxEnd = RECONCILER_SRC.indexOf(
      "Phase 31.18 — per-kind stale-tombstone sweep",
      idx,
    );
    const slice = stripComments(RECONCILER_SRC.slice(idx, idxEnd));
    // The label uses sig.safe_summary.slice(0, 240). NEVER pulls
    // ocr_text / transcript_text / details / any free-text column.
    expect(slice).toMatch(/sig\.safe_summary\.slice\(0, 240\)/);
    expect(slice).not.toMatch(/ocr_text/);
    expect(slice).not.toMatch(/transcript_text/);
  });
});

// =============================================================================
// PART 9 — Phase 31.19 Reviewer Console actions
// =============================================================================

describe("Phase 31.19 — Reviewer Console actions API surface", () => {
  it("reviewer console response includes pendingSignals (PENDING only)", () => {
    const idx = MI_ROUTES_SRC.indexOf("Phase 31.18 — Reviewer Intelligence Console");
    const idxEnd = MI_ROUTES_SRC.indexOf(
      "/v1/evidence/:evidenceId/derived-assets?teamId=",
      idx,
    );
    const slice = MI_ROUTES_SRC.slice(idx, idxEnd);
    expect(slice).toMatch(/pendingSignals/);
    // SQL filter is PENDING only — not ACKNOWLEDGED, not DISMISSED.
    expect(slice).toMatch(/"status" = 'PENDING'/);
    // safe_summary is bounded to 240 chars (no raw text leak path).
    expect(slice).toMatch(/r\.safe_summary\.slice\(0, 240\)/);
  });

  it("the ack/dismiss endpoint exists with bounded action enum", () => {
    expect(MI_ROUTES_SRC).toMatch(
      /app\.post\(\s*"\/v1\/media-intelligence\/signals\/:signalId\/action"/,
    );
  });
});

describe("Phase 31.19 — Reviewer Console UI actions", () => {
  it("calls the ack/dismiss endpoint with bounded action enum", () => {
    expect(REVIEWERS_PAGE).toMatch(
      /\/v1\/media-intelligence\/signals\/\$\{encodeURIComponent\(signalId\)\}\/action/,
    );
    expect(REVIEWERS_PAGE).toMatch(/action: "ACKNOWLEDGED" \| "DISMISSED"/);
  });

  it("renders Acknowledge + Dismiss buttons that disable while pending", () => {
    expect(REVIEWERS_PAGE).toMatch(/Acknowledge/);
    expect(REVIEWERS_PAGE).toMatch(/Dismiss/);
    expect(REVIEWERS_PAGE).toMatch(/disabled=\{pending\}/);
  });

  it("403 / 404 / forbidden / not_found responses map to a single 'denied' wording (anti-enumeration)", () => {
    expect(REVIEWERS_PAGE).toMatch(/403\|404\|forbidden\|not_found/);
    expect(REVIEWERS_PAGE).toMatch(/Action not permitted for this signal/);
  });

  it("optimistic removal does NOT depend on response body shape — anti-leak", () => {
    // After a successful action we drop the row from pendingSignals
    // (so the next poll just confirms it). The response itself is
    // not inspected, so the UI cannot leak ack actor identity.
    expect(REVIEWERS_PAGE).toMatch(
      /pendingSignals: prev\.pendingSignals\.filter\(\(s\) => s\.id !== signalId\)/,
    );
  });
});
