/**
 * Phase 31.16 / 32.15 — 3 new graph domain reconcilers
 * (REPORT, VERIFICATION_PACKAGE, EXPORT) + Case Graph Explorer UI.
 *
 * Layers covered:
 *
 *   1. Each new domain creates nodes + edges following the CASE
 *      reference pattern.
 *   2. Each domain has a stale-tombstone sweep with the team-
 *      anchored NOT EXISTS clause.
 *   3. Each domain is wrapped in try/catch so a single domain
 *      failure doesn't block the rest of reconcileTeamGraph.
 *   4. Each domain SQL is team-anchored.
 *   5. Case Graph Explorer UI: real-data only, no fake counters,
 *      whitelisted endpoints, no storage internals, no forbidden
 *      vocabulary, bounded polling, filter controls present.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
const RECONCILER_SRC = readSource("../../../packages/shared-runtime/src/graph/graph-builder.service.ts");
// =============================================================================
// PART 1 — REPORT domain reconciler
// =============================================================================
describe("Phase 31.16 — REPORT graph domain", () => {
    it("section header present + ordered between CASE and MEDIA_SIGNAL", () => {
        const idxCase = RECONCILER_SRC.indexOf("Phase 31.15 — CASE domain");
        const idxReport = RECONCILER_SRC.indexOf("Phase 31.16 — REPORT domain");
        const idxMedia = RECONCILER_SRC.indexOf("// 2. Materialize MEDIA_SIGNAL");
        expect(idxCase).toBeGreaterThan(0);
        expect(idxReport).toBeGreaterThan(idxCase);
        expect(idxMedia).toBeGreaterThan(idxReport);
    });
    it("SELECT JOINs reports → evidence + team-anchored", () => {
        expect(RECONCILER_SRC).toMatch(/FROM "reports" r[\s\S]*?JOIN "evidence" e ON e\."id" = r\."evidence_id"[\s\S]*?WHERE e\."team_id" = \$1[\s\S]*?AND e\."deleted_at" IS NULL/);
    });
    it("external_id format is evidence-scoped + version-pinned", () => {
        expect(RECONCILER_SRC).toMatch(/const externalId = `\$\{r\.evidence_id\}:v\$\{r\.version\}`/);
    });
    it("upserts REPORT node with WORKSPACE_INTERNAL visibility", () => {
        expect(RECONCILER_SRC).toMatch(/upsertNode\(\s*client,\s*teamId,\s*"REPORT"[\s\S]*?"WORKSPACE_INTERNAL"/);
    });
    it("emits GENERATED_REPORT edge with SYSTEM source + HIGH confidence", () => {
        expect(RECONCILER_SRC).toMatch(/upsertEdge\([\s\S]*?"GENERATED_REPORT"[\s\S]*?"SYSTEM"[\s\S]*?"HIGH"/);
    });
    it("stale-sweep for REPORT nodes is team-anchored on both UPDATE and sub-select", () => {
        const block = RECONCILER_SRC.match(/UPDATE "investigation_graph_nodes" n[\s\S]*?n\."node_kind" = 'REPORT'[\s\S]*?\)\s*\)/)?.[0];
        expect(block, "REPORT stale sweep block found").toBeTruthy();
        expect(block).toMatch(/n\."team_id" = \$1/);
        expect(block).toMatch(/e\."team_id" = \$1/);
    });
    it("entire REPORT step wrapped in try/catch (best-effort)", () => {
        const idx = RECONCILER_SRC.indexOf("Phase 31.16 — REPORT domain");
        const block = RECONCILER_SRC.slice(idx, idx + 4000);
        expect(block).toMatch(/try\s*\{[\s\S]*?\}\s*catch\s*\{[\s\S]*?best-effort/);
    });
});
// =============================================================================
// PART 2 — VERIFICATION_PACKAGE domain reconciler
// =============================================================================
describe("Phase 31.16 — VERIFICATION_PACKAGE graph domain", () => {
    it("section header present", () => {
        expect(RECONCILER_SRC).toContain("Phase 31.16 — VERIFICATION_PACKAGE domain reconciliation");
    });
    it("SELECT JOINs verification_packages → evidence + team-anchored", () => {
        expect(RECONCILER_SRC).toMatch(/FROM "verification_packages" vp[\s\S]*?JOIN "evidence" e ON e\."id" = vp\."evidence_id"[\s\S]*?WHERE e\."team_id" = \$1[\s\S]*?AND e\."deleted_at" IS NULL/);
    });
    it("upserts VERIFICATION_PACKAGE node with WORKSPACE_INTERNAL visibility", () => {
        expect(RECONCILER_SRC).toMatch(/upsertNode\(\s*client,\s*teamId,\s*"VERIFICATION_PACKAGE"[\s\S]*?"WORKSPACE_INTERNAL"/);
    });
    it("emits GENERATED_PACKAGE edge with SYSTEM source + HIGH confidence", () => {
        expect(RECONCILER_SRC).toMatch(/upsertEdge\([\s\S]*?"GENERATED_PACKAGE"[\s\S]*?"SYSTEM"[\s\S]*?"HIGH"/);
    });
    it("stale-sweep for VERIFICATION_PACKAGE nodes is team-anchored", () => {
        const block = RECONCILER_SRC.match(/UPDATE "investigation_graph_nodes" n[\s\S]*?n\."node_kind" = 'VERIFICATION_PACKAGE'[\s\S]*?\)\s*\)/)?.[0];
        expect(block, "VERIFICATION_PACKAGE stale sweep block found").toBeTruthy();
        expect(block).toMatch(/n\."team_id" = \$1/);
        expect(block).toMatch(/e\."team_id" = \$1/);
    });
});
// =============================================================================
// PART 3 — EXPORT domain reconciler
// =============================================================================
describe("Phase 31.16 — EXPORT graph domain", () => {
    it("section header present", () => {
        expect(RECONCILER_SRC).toContain("Phase 31.16 — EXPORT domain reconciliation");
    });
    it("SELECT against governance_export_snapshots is team-anchored", () => {
        expect(RECONCILER_SRC).toMatch(/FROM "governance_export_snapshots"\s+WHERE "team_id" = \$1/);
    });
    it("upserts EXPORT node with WORKSPACE_INTERNAL visibility", () => {
        expect(RECONCILER_SRC).toMatch(/upsertNode\(\s*client,\s*teamId,\s*"EXPORT"[\s\S]*?"WORKSPACE_INTERNAL"/);
    });
    it("emits EXPORTED_AS edge with SYSTEM source + HIGH confidence, only when evidence_id is present", () => {
        expect(RECONCILER_SRC).toMatch(/if \(x\.evidence_id\)[\s\S]*?upsertEdge\([\s\S]*?"EXPORTED_AS"[\s\S]*?"SYSTEM"[\s\S]*?"HIGH"/);
    });
    it("EXPORT stale-sweep is team-anchored on UPDATE + sub-select", () => {
        const block = RECONCILER_SRC.match(/UPDATE "investigation_graph_nodes" n[\s\S]*?n\."node_kind" = 'EXPORT'[\s\S]*?\)\s*\)/)?.[0];
        expect(block, "EXPORT stale sweep block found").toBeTruthy();
        expect(block).toMatch(/n\."team_id" = \$1/);
        expect(block).toMatch(/x\."team_id" = \$1/);
    });
    it("EXPORT node label NEVER includes snapshot_payload (which can carry operator-private fields)", () => {
        const exportBlock = RECONCILER_SRC.match(/Phase 31\.16 — EXPORT domain reconciliation[\s\S]*?\}\s*catch\s*\{[\s\S]*?best-effort/)?.[0];
        expect(exportBlock).toBeTruthy();
        expect(exportBlock).not.toContain("snapshot_payload");
    });
});
// =============================================================================
// PART 4 — Cross-domain anti-leak invariants
// =============================================================================
describe("Phase 31.16 — anti-leak invariants on new domain steps", () => {
    it("no storage internals / signed URLs / private notes referenced anywhere in the 3 new steps", () => {
        const idxStart = RECONCILER_SRC.indexOf("Phase 31.16 — REPORT domain reconciliation");
        const idxEnd = RECONCILER_SRC.indexOf("// 2. Materialize MEDIA_SIGNAL");
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
            "signed_url",
            "presignedUrl",
            "private_note",
            "privateNote",
            "legalNote",
            "legalNoteBody",
            "raw_gps",
            "rawGps",
        ]) {
            expect(noComments, `domain steps leak ${banned}`).not.toContain(banned);
        }
    });
    it("no forbidden truth-claim vocabulary in any domain step literal", () => {
        const idxStart = RECONCILER_SRC.indexOf("Phase 31.16 — REPORT domain reconciliation");
        const idxEnd = RECONCILER_SRC.indexOf("// 2. Materialize MEDIA_SIGNAL");
        const slice = RECONCILER_SRC.slice(idxStart, idxEnd);
        const literals = slice.match(/"[^"\n]+"/g) ?? [];
        const forbidden = /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
        for (const lit of literals) {
            expect(lit, `forbidden wording: ${lit}`).not.toMatch(forbidden);
        }
    });
    it("each Phase 31.16 domain step is independently wrapped in try/catch (one failure cannot stop the others)", () => {
        // Phase 31.17 added more domains after Phase 31.16, so scope
        // the slice to just the Phase 31.16 range (REPORT through
        // EXPORT) before counting outer catches.
        const idxStart = RECONCILER_SRC.indexOf("Phase 31.16 — REPORT domain reconciliation");
        const idxEnd = RECONCILER_SRC.indexOf("Phase 31.17 — REVIEW_TASK domain reconciliation");
        expect(idxStart).toBeGreaterThan(0);
        expect(idxEnd).toBeGreaterThan(idxStart);
        const slice = RECONCILER_SRC.slice(idxStart, idxEnd);
        // Three outer catches expected — one per Phase 31.16 domain.
        const outerCatches = slice.match(/catch\s*\{[\s\S]*?best-effort; the rest of the reconcile continues/g) ?? [];
        expect(outerCatches.length).toBe(3);
    });
});
// =============================================================================
// PART 5 — Case Graph Explorer UI
// =============================================================================
describe("Phase 32.15 — Case Graph Explorer UI", () => {
    const src = readSource("../../../apps/web/app/(app)/investigation/cases/[caseId]/graph/page.tsx");
    it("declared as a client component", () => {
        expect(src.trimStart()).toMatch(/^"use client"/);
    });
    it("only calls whitelisted endpoints", () => {
        const noComments = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        const apiFetchCalls = noComments.match(/apiFetch\(\s*[`"][^`"]+[`"]/g) ?? [];
        expect(apiFetchCalls.length).toBeGreaterThan(0);
        const allowed = ["/v1/users/me", "/v1/graph/cases"];
        for (const call of apiFetchCalls) {
            const path = call.match(/[`"]([^`"]+)[`"]/)?.[1] ?? "";
            const ok = allowed.some((p) => path.includes(p));
            expect(ok, `unexpected endpoint: ${path}`).toBe(true);
        }
    });
    it("consumes only the public projection shape (no internal timestamp / externalId fields)", () => {
        // The shape on the wire is { id, nodeKind, safeLabel,
        // visibilityScope }. The UI MUST NOT reference fields that
        // aren't projected — those would be undefined at runtime.
        const noComments = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        expect(noComments).not.toMatch(/n\.createdAtUtc/);
        expect(noComments).not.toMatch(/n\.updatedAtUtc/);
        expect(noComments).not.toMatch(/n\.externalId/);
        expect(noComments).not.toMatch(/e\.createdAtUtc/);
    });
    it("filter UI for node kind + edge type present", () => {
        expect(src).toMatch(/Node kind/);
        expect(src).toMatch(/Edge type/);
        expect(src).toMatch(/BELONGS_TO_CASE/);
        expect(src).toMatch(/GENERATED_REPORT/);
        expect(src).toMatch(/GENERATED_PACKAGE/);
        expect(src).toMatch(/EXPORTED_AS/);
    });
    it("no forbidden truth-claim vocabulary", () => {
        const noComments = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        const literals = noComments.match(/"[^"\n]+"/g) ?? [];
        const forbidden = /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
        for (const lit of literals) {
            expect(lit, `forbidden wording: ${lit}`).not.toMatch(forbidden);
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
            expect(noComments, `UI leaks ${banned}`).not.toContain(banned);
        }
    });
    it("bounded polling — paused when tab hidden", () => {
        expect(src).toMatch(/setInterval\([\s\S]*?,\s*60_?000\s*\)/);
        expect(src).toMatch(/document\.hidden/);
    });
    it("empty states with next-action guidance present (no dead-end UI)", () => {
        const flat = src.replace(/\s+/g, " ");
        expect(flat).toMatch(/No nodes recorded[\s\S]*?graph reconciler/);
        expect(flat).toMatch(/No relationships recorded[\s\S]*?graph reconciler/);
    });
    it("safer canonical-custody language in the page subtitle", () => {
        expect(src).toMatch(/canonical custody record/);
        expect(src).not.toMatch(/authenticity or admissibility/);
    });
    it("truncated subgraph notice (no hidden-count leak)", () => {
        expect(src).toMatch(/Showing a bounded subgraph/);
    });
});
