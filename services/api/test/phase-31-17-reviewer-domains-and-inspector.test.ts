/**
 * Phase 31.17 / 32.16 — 3 more graph domain reconcilers
 * (REVIEW_TASK, ESCALATION, INCIDENT) + Relationship Inspector UI.
 *
 * Layers covered:
 *
 *   1. Each new domain follows the established pattern:
 *      - team-anchored SELECT
 *      - bounded label using only safe enum tokens
 *      - idempotent upsertNode with WORKSPACE_INTERNAL visibility
 *      - typed edge with SYSTEM source + bounded confidence
 *      - stale-tombstone sweep with NOT EXISTS, team-anchored on
 *        both UPDATE and sub-select
 *      - try/catch isolation
 *   2. No reviewer-private text in any label:
 *      - REVIEW_TASK never reads pausedReason/rejectionReason/
 *        escalationReason
 *      - ESCALATION never reads resolutionNote/suppressionReason
 *      - INCIDENT never reads title or safeSummary in the label
 *   3. severityToConfidence helper added.
 *   4. Relationship Inspector UI:
 *      - client component
 *      - only the whitelisted endpoints called
 *      - consumes only the public projection shape (no internal
 *        timestamp / externalId fields)
 *      - bounded URL params (caseId, nodeId, edgeId)
 *      - no forbidden vocabulary
 *      - no storage internals
 *      - empty states with next-action guidance
 *      - safer canonical-custody language
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const RECONCILER_SRC = readSource(
  "../src/services/graph/graph-builder.service.ts",
);

// =============================================================================
// PART 1 — REVIEW_TASK domain
// =============================================================================

describe("Phase 31.17 — REVIEW_TASK graph domain", () => {
  it("section header present + ordered after EXPORT and before MEDIA_SIGNAL", () => {
    const idxExport = RECONCILER_SRC.indexOf("Phase 31.16 — EXPORT domain");
    const idxTask = RECONCILER_SRC.indexOf(
      "Phase 31.17 — REVIEW_TASK domain reconciliation",
    );
    const idxMedia = RECONCILER_SRC.indexOf(
      "// 2. Materialize MEDIA_SIGNAL",
    );
    expect(idxExport).toBeGreaterThan(0);
    expect(idxTask).toBeGreaterThan(idxExport);
    expect(idxMedia).toBeGreaterThan(idxTask);
  });

  it("SELECT JOIN'd evidence_review_workflows → evidence + team-anchored", () => {
    expect(RECONCILER_SRC).toMatch(
      /FROM "evidence_review_workflows" w[\s\S]*?JOIN "evidence" e ON e\."id" = w\."evidence_id"[\s\S]*?WHERE w\."team_id" = \$1[\s\S]*?AND e\."deleted_at" IS NULL/,
    );
  });

  it("upserts REVIEW_TASK node with WORKSPACE_INTERNAL visibility", () => {
    expect(RECONCILER_SRC).toMatch(
      /upsertNode\(\s*client,\s*teamId,\s*"REVIEW_TASK"[\s\S]*?"WORKSPACE_INTERNAL"/,
    );
  });

  it("emits REVIEWED_BY edge with SYSTEM source + HIGH confidence", () => {
    expect(RECONCILER_SRC).toMatch(
      /upsertEdge\([\s\S]*?"REVIEWED_BY"[\s\S]*?"SYSTEM"[\s\S]*?"HIGH"/,
    );
  });

  it("REVIEW_TASK label NEVER pulls reviewer-private text fields", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.17 — REVIEW_TASK domain reconciliation",
    );
    const idxEnd = RECONCILER_SRC.indexOf(
      "Phase 31.17 — ESCALATION domain reconciliation",
    );
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    // Strip comments so the documentation that NAMES the forbidden
    // columns (to enforce their absence) doesn't trip the check.
    const noComments = slice
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // The label SQL projection must only pull bounded enums.
    expect(slice).toMatch(
      /SELECT w\."id", w\."evidence_id", w\."status"::text AS "status"[\s\S]*?w\."priority"::text AS "priority"/,
    );
    // Must NOT pull free-text columns from code.
    expect(noComments).not.toContain("escalation_reason");
    expect(noComments).not.toContain("rejection_reason");
    expect(noComments).not.toContain("paused_reason");
    expect(noComments).not.toContain("resolution_note");
  });

  it("stale-sweep for REVIEW_TASK is team-anchored on both UPDATE and sub-select", () => {
    const block = RECONCILER_SRC.match(
      /UPDATE "investigation_graph_nodes" n[\s\S]*?n\."node_kind" = 'REVIEW_TASK'[\s\S]*?\)\s*\)/,
    )?.[0];
    expect(block, "REVIEW_TASK stale sweep block found").toBeTruthy();
    expect(block!).toMatch(/n\."team_id" = \$1/);
    expect(block!).toMatch(/w\."team_id" = \$1/);
  });
});

// =============================================================================
// PART 2 — ESCALATION domain
// =============================================================================

describe("Phase 31.17 — ESCALATION graph domain", () => {
  it("section header present", () => {
    expect(RECONCILER_SRC).toContain(
      "Phase 31.17 — ESCALATION domain reconciliation",
    );
  });

  it("SELECT on review_escalations is team-anchored", () => {
    expect(RECONCILER_SRC).toMatch(
      /FROM "review_escalations"\s+WHERE "team_id" = \$1/,
    );
  });

  it("upserts ESCALATION node with WORKSPACE_INTERNAL visibility", () => {
    expect(RECONCILER_SRC).toMatch(
      /upsertNode\(\s*client,\s*teamId,\s*"ESCALATION"[\s\S]*?"WORKSPACE_INTERNAL"/,
    );
  });

  it("emits ESCALATED_FROM edge with SYSTEM source + severityToConfidence", () => {
    expect(RECONCILER_SRC).toMatch(
      /upsertEdge\([\s\S]*?"ESCALATED_FROM"[\s\S]*?"SYSTEM"[\s\S]*?severityToConfidence/,
    );
  });

  it("ESCALATION label NEVER pulls operator-private text fields", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.17 — ESCALATION domain reconciliation",
    );
    const idxEnd = RECONCILER_SRC.indexOf(
      "Phase 31.17 — INCIDENT domain reconciliation",
    );
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    expect(slice).not.toContain("resolution_note");
    expect(slice).not.toContain("suppression_reason");
    expect(slice).not.toContain("safe_summary");
  });

  it("stale-sweep for ESCALATION is team-anchored on both UPDATE and sub-select", () => {
    const block = RECONCILER_SRC.match(
      /UPDATE "investigation_graph_nodes" n[\s\S]*?n\."node_kind" = 'ESCALATION'[\s\S]*?\)\s*\)/,
    )?.[0];
    expect(block, "ESCALATION stale sweep block found").toBeTruthy();
    expect(block!).toMatch(/n\."team_id" = \$1/);
    expect(block!).toMatch(/e\."team_id" = \$1/);
  });
});

// =============================================================================
// PART 3 — INCIDENT domain
// =============================================================================

describe("Phase 31.17 — INCIDENT graph domain", () => {
  it("section header present", () => {
    expect(RECONCILER_SRC).toContain(
      "Phase 31.17 — INCIDENT domain reconciliation",
    );
  });

  it("SELECT on operational_incidents is team-anchored", () => {
    expect(RECONCILER_SRC).toMatch(
      /FROM "operational_incidents"\s+WHERE "team_id" = \$1/,
    );
  });

  it("upserts INCIDENT node with WORKSPACE_INTERNAL visibility", () => {
    expect(RECONCILER_SRC).toMatch(
      /upsertNode\(\s*client,\s*teamId,\s*"INCIDENT"[\s\S]*?"WORKSPACE_INTERNAL"/,
    );
  });

  it("emits REFERENCES_SAME_INCIDENT edge only when related_evidence_id is present", () => {
    expect(RECONCILER_SRC).toMatch(
      /if \(inc\.related_evidence_id\)[\s\S]*?upsertEdge\([\s\S]*?"REFERENCES_SAME_INCIDENT"[\s\S]*?"SYSTEM"[\s\S]*?severityToConfidence/,
    );
  });

  it("INCIDENT label uses bounded category/severity/status enums — NEVER raw title or safe_summary", () => {
    const idx = RECONCILER_SRC.indexOf(
      "Phase 31.17 — INCIDENT domain reconciliation",
    );
    const idxEnd = RECONCILER_SRC.indexOf(
      "// 2. Materialize MEDIA_SIGNAL",
    );
    const slice = RECONCILER_SRC.slice(idx, idxEnd);
    // The SELECT projection must NOT pull title or safe_summary.
    expect(slice).toMatch(/SELECT "id", "related_evidence_id"/);
    expect(slice).not.toMatch(/SELECT[\s\S]*?"title"[\s\S]*?FROM "operational_incidents"/);
    expect(slice).not.toMatch(/SELECT[\s\S]*?"safe_summary"[\s\S]*?FROM "operational_incidents"/);
  });

  it("stale-sweep for INCIDENT is team-anchored on both UPDATE and sub-select", () => {
    const block = RECONCILER_SRC.match(
      /UPDATE "investigation_graph_nodes" n[\s\S]*?n\."node_kind" = 'INCIDENT'[\s\S]*?\)\s*\)/,
    )?.[0];
    expect(block, "INCIDENT stale sweep block found").toBeTruthy();
    expect(block!).toMatch(/n\."team_id" = \$1/);
    expect(block!).toMatch(/inc\."team_id" = \$1/);
  });
});

// =============================================================================
// PART 4 — severityToConfidence helper
// =============================================================================

describe("Phase 31.17 — severityToConfidence helper", () => {
  it("function defined + maps CRITICAL/HIGH → HIGH", () => {
    expect(RECONCILER_SRC).toMatch(
      /function severityToConfidence\([\s\S]*?CRITICAL[\s\S]*?HIGH[\s\S]*?HIGH/,
    );
  });

  it("maps WARNING/MEDIUM → MEDIUM", () => {
    expect(RECONCILER_SRC).toMatch(/"WARNING"\s*\|\|\s*s === "MEDIUM"[\s\S]*?return "MEDIUM"/);
  });

  it("falls back to LOW", () => {
    const fn = RECONCILER_SRC.match(
      /function severityToConfidence[\s\S]*?return "LOW";\s*\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/return "LOW";\s*\n\}/);
  });
});

// =============================================================================
// PART 5 — Cross-domain anti-leak invariants
// =============================================================================

describe("Phase 31.17 — anti-leak invariants on new domain steps", () => {
  it("no storage internals anywhere in the 3 new steps", () => {
    const idxStart = RECONCILER_SRC.indexOf(
      "Phase 31.17 — REVIEW_TASK domain reconciliation",
    );
    const idxEnd = RECONCILER_SRC.indexOf(
      "// 2. Materialize MEDIA_SIGNAL",
    );
    expect(idxStart).toBeGreaterThan(0);
    expect(idxEnd).toBeGreaterThan(idxStart);
    const slice = RECONCILER_SRC.slice(idxStart, idxEnd);
    const noComments = slice
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storage_bucket",
      "storageBucket",
      "storage_key",
      "storageKey",
      "signedUrl",
      "presignedUrl",
      "private_note",
      "privateNote",
      "legalNote",
      "raw_gps",
      "rawGps",
    ]) {
      expect(noComments, `domain steps leak ${banned}`).not.toContain(banned);
    }
  });

  it("no forbidden truth-claim vocabulary in any domain step literal", () => {
    const idxStart = RECONCILER_SRC.indexOf(
      "Phase 31.17 — REVIEW_TASK domain reconciliation",
    );
    const idxEnd = RECONCILER_SRC.indexOf(
      "// 2. Materialize MEDIA_SIGNAL",
    );
    const slice = RECONCILER_SRC.slice(idxStart, idxEnd);
    const literals = slice.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(lit, `forbidden wording: ${lit}`).not.toMatch(forbidden);
    }
  });

  it("each domain step is independently wrapped in try/catch", () => {
    const idxStart = RECONCILER_SRC.indexOf(
      "Phase 31.17 — REVIEW_TASK domain reconciliation",
    );
    // Phase 31.18 — the slice now ends BEFORE the EXTERNAL_REVIEW
    // anchor (added Phase 31.18) so the count stays scoped to the
    // three Phase 31.17 domains (REVIEW_TASK, ESCALATION, INCIDENT).
    const idxEnd = RECONCILER_SRC.indexOf(
      "Phase 31.18 — EXTERNAL_REVIEW domain reconciliation",
    );
    const slice = RECONCILER_SRC.slice(idxStart, idxEnd);
    const outerCatches =
      slice.match(/catch\s*\{[\s\S]*?best-effort; the rest of the reconcile continues/g) ?? [];
    expect(outerCatches.length).toBe(3);
  });
});

// =============================================================================
// PART 6 — Relationship Inspector UI source contract
// =============================================================================

describe("Phase 32.16 — Relationship Inspector UI", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/investigation/relationships/page.tsx",
  );

  it("declared as a client component", () => {
    expect(src.trimStart()).toMatch(/^"use client"/);
  });

  it("only calls whitelisted endpoints", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const apiFetchCalls =
      noComments.match(/apiFetch\(\s*[`"][^`"]+[`"]/g) ?? [];
    expect(apiFetchCalls.length).toBeGreaterThan(0);
    const allowed = ["/v1/users/me", "/v1/graph/cases"];
    for (const call of apiFetchCalls) {
      const path = call.match(/[`"]([^`"]+)[`"]/)?.[1] ?? "";
      const ok = allowed.some((p) => path.includes(p));
      expect(ok, `unexpected endpoint: ${path}`).toBe(true);
    }
  });

  it("consumes only the public projection shape (no internal timestamps / externalId)", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/\.createdAtUtc/);
    expect(noComments).not.toMatch(/\.updatedAtUtc/);
    expect(noComments).not.toMatch(/\.externalId/);
  });

  it("URL params bounded — caseId/nodeId/edgeId only", () => {
    expect(src).toMatch(/search\?.get\("caseId"\)/);
    expect(src).toMatch(/search\?.get\("nodeId"\)/);
    expect(src).toMatch(/search\?.get\("edgeId"\)/);
  });

  it("no forbidden truth-claim vocabulary in user-facing literals", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(lit, `inspector forbidden wording: ${lit}`).not.toMatch(
        forbidden,
      );
    }
  });

  it("no storage internals / signed URLs anywhere", () => {
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
      "multipartUploadId",
    ]) {
      expect(noComments, `inspector leaks ${banned}`).not.toContain(banned);
    }
  });

  it("bounded polling paused when tab hidden", () => {
    expect(src).toMatch(/setInterval\([\s\S]*?,\s*60_?000\s*\)/);
    expect(src).toMatch(/document\.hidden/);
  });

  it("empty state with next-action guidance present (no dead-end UI)", () => {
    const flat = src.replace(/\s+/g, " ");
    expect(flat).toMatch(/Select a relationship or node to inspect/);
  });

  it("safer canonical-custody language (no 'authenticity' even in negation)", () => {
    // JSX wraps text across lines; flatten whitespace before matching.
    const flat = src.replace(/\s+/g, " ");
    expect(flat).toMatch(/canonical custody record/);
    expect(src).not.toMatch(/authenticity or admissibility/);
  });

  it("edge inspector includes 'Why this relationship exists' framing for safe summary", () => {
    expect(src).toMatch(/Why this relationship exists/);
  });

  it("links back to Case Graph Explorer + node-detail navigation present", () => {
    expect(src).toMatch(/\/investigation\/cases\/\$\{encodeURIComponent\(caseId\)\}\/graph/);
    expect(src).toMatch(
      /\/investigation\/relationships\?caseId=\$\{encodeURIComponent\(caseId\)\}&nodeId=/,
    );
    expect(src).toMatch(
      /\/investigation\/relationships\?caseId=\$\{encodeURIComponent\(caseId\)\}&edgeId=/,
    );
  });
});
