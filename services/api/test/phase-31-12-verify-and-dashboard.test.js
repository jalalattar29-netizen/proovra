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
import { projectVerifyMediaIntelligence, VERIFY_MEDIA_INTELLIGENCE_DISCLAIMER, } from "../src/services/media-intelligence/verify-projection.service.js";
function readSource(rel) {
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
    const src = readSource("../src/services/media-intelligence/verify-projection.service.ts");
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
        const decl = src.match(/export type VerifyProjectionResult\s*=\s*\{[\s\S]*?\};/)?.[0];
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
            expect(decl, `public projection leaks per-signal field ${banned}`).not.toMatch(new RegExp(`\\b${banned}\\b`));
        }
    });
    it("never throws — try/catch returns null", () => {
        expect(src).toMatch(/try\s*\{[\s\S]*?\}\s*catch\s*\{[\s\S]*?return\s+null/);
    });
    it("fixed disclaimer mentions advisory + canonical custody record + no forbidden vocabulary", () => {
        const forbidden = /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
        expect(VERIFY_MEDIA_INTELLIGENCE_DISCLAIMER).toMatch(/advisory/i);
        expect(VERIFY_MEDIA_INTELLIGENCE_DISCLAIMER).toMatch(/canonical custody record/);
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
            expect(noComments, `verify projection leaks ${banned}`).not.toContain(banned);
        }
    });
    it("no forbidden truth-claim vocabulary in source literals", () => {
        const noComments = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        const literals = noComments.match(/"[^"\n]+"/g) ?? [];
        const forbidden = /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
        for (const lit of literals) {
            expect(lit, `projection uses forbidden wording: ${lit}`).not.toMatch(forbidden);
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
        const end = src.indexOf("Phase 14 — additive publication gate", start);
        expect(end).toBeGreaterThan(start);
        const block = src.slice(start, end);
        expect(block).toMatch(/teamId:\s*true,/);
    });
    it("lazy-imports the verify projection service before sending", () => {
        expect(src).toMatch(/await import\(\s*"\.\.\/services\/media-intelligence\/verify-projection\.service\.js"/);
    });
    it("response carries mediaIntelligenceAdvisory at top level", () => {
        // The variable is computed pre-send and attached as a key.
        expect(src).toMatch(/const mediaIntelligenceAdvisory = evidence\.teamId/);
        // The return block includes the field.
        expect(src).toMatch(/return reply\.code\(200\)\.send\(\{[\s\S]*?mediaIntelligenceAdvisory,/);
    });
    it("projection failure falls back to null without throwing", () => {
        // The async IIFE that calls the projection wraps everything in
        // try/catch and returns null on any failure.
        const block = src.match(/const mediaIntelligenceAdvisory[\s\S]*?:\s*null;/)?.[0];
        expect(block).toBeTruthy();
        expect(block).toMatch(/try\s*\{[\s\S]*?\}\s*catch\s*\{[\s\S]*?return\s+null/);
    });
    it("never invokes the projection when evidence.teamId is missing (anti-enumeration)", () => {
        const block = src.match(/const mediaIntelligenceAdvisory[\s\S]*?:\s*null;/)?.[0];
        // Allow `evidence.teamId ? await (async ...)` OR `? (async ...)`
        expect(block).toMatch(/evidence\.teamId[\s\S]*?\?\s*await\s*\(async/);
        expect(block).toMatch(/:\s*null/);
    });
});
// =============================================================================
// PART 3 — Verify UI source contract
// =============================================================================
describe("Phase 31.12 — Verify page UI", () => {
    const src = readSource("../../../apps/web/app/verify/[token]/page.tsx");
    it("VerifyResponse widened OPTIONALLY with mediaIntelligenceAdvisory", () => {
        expect(src).toMatch(/mediaIntelligenceAdvisory\?:\s*\{[\s\S]*?hasObservations:\s*boolean[\s\S]*?observationCount:\s*number[\s\S]*?advisory:\s*string[\s\S]*?\}\s*\|\s*null/);
    });
    it("state setter is wired into applyVerifyResponse", () => {
        expect(src).toMatch(/setMediaIntelligenceAdvisory\(data\.mediaIntelligenceAdvisory \?\? null\)/);
    });
    it("section renders ONLY when hasObservations is true", () => {
        expect(src).toMatch(/mediaIntelligenceAdvisory && mediaIntelligenceAdvisory\.hasObservations/);
    });
    it("section displays bounded count + advisory disclaimer text — never per-signal detail", () => {
        const start = src.indexOf("verify-media-intelligence-advisory");
        expect(start).toBeGreaterThan(0);
        const end = src.indexOf(") : null}", start);
        expect(end).toBeGreaterThan(start);
        const block = src.slice(start, end);
        expect(block).toContain("mediaIntelligenceAdvisory.observationCount");
        expect(block).toContain("mediaIntelligenceAdvisory.advisory");
        // No per-signal detail keys should appear in the rendered block.
        for (const banned of [
            "safeSummary",
            "signalType",
            "materialId",
            "severity",
            "confidence",
            "createdAtUtc",
        ]) {
            expect(block, `verify UI block surfaces per-signal field ${banned}`).not.toContain(banned);
        }
    });
    it("section uses safe wording — no forbidden vocabulary in the new JSX block", () => {
        const start = src.indexOf("verify-media-intelligence-advisory");
        const end = src.indexOf(") : null}", start);
        const block = src.slice(start, end);
        const forbidden = /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
        expect(block).not.toMatch(forbidden);
    });
});
// =============================================================================
// PART 4 — Investigation overview API
// =============================================================================
describe("Phase 31.12 — /v1/investigation/overview route", () => {
    const src = readSource("../src/routes/media-intelligence.routes.ts");
    it("route registered + gated by authorizeOrFail + antiEnumeration", () => {
        const block = src.match(/"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/)?.[0];
        expect(block).toBeTruthy();
        expect(block).toMatch(/authorizeOrFail/);
        expect(block).toMatch(/permission:\s*"evidence\.read"/);
        expect(block).toMatch(/antiEnumeration:\s*true/);
    });
    it("DISMISSED excluded from recent list (operator dismissal intent)", () => {
        const block = src.match(/"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/)?.[0];
        expect(block).toMatch(/"status" IN \('PENDING','ACKNOWLEDGED'\)[\s\S]*?ORDER BY/);
    });
    it("DISMISSED INCLUDED in totals (full workspace accounting)", () => {
        const block = src.match(/"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/)?.[0];
        expect(block).toMatch(/FILTER \(WHERE "status" = 'DISMISSED'\)/);
    });
    it("bounded LIMITs (20 signals, 30 graph events)", () => {
        const block = src.match(/"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/)?.[0];
        expect(block).toMatch(/LIMIT 20/);
        expect(block).toMatch(/LIMIT 30/);
    });
    it("safe_summary truncated to 240 chars in projection", () => {
        const block = src.match(/"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/)?.[0];
        expect(block).toMatch(/safe_summary\.slice\(0,\s*240\)/);
    });
    it("severity-ordered (ATTENTION first)", () => {
        const block = src.match(/"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/)?.[0];
        expect(block).toMatch(/WHEN 'ATTENTION' THEN 0[\s\S]*?WHEN 'REVIEW_RECOMMENDED' THEN 1/);
    });
    it("each fetch wrapped in try/catch — never throws to caller", () => {
        const block = src.match(/"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/)?.[0];
        const catches = (block.match(/\}\s*catch/g) ?? []).length;
        expect(catches).toBeGreaterThanOrEqual(3); // totals + recent + graph
    });
    it("graph stale-edge / stale-node exclusion", () => {
        const block = src.match(/"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/)?.[0];
        expect(block).toMatch(/n\."stale_at_utc" IS NULL/);
        expect(block).toMatch(/e\."stale_at_utc" IS NULL/);
    });
    it("team-anchored (anti-enumeration) on every SQL", () => {
        const block = src.match(/"\/v1\/investigation\/overview"[\s\S]*?\n\s*\}\s*,\s*\n\s*\)/)?.[0];
        // Count team_id = $1 fragments — expect ≥ 3 (totals + recent +
        // node + edge stream).
        const matches = (block.match(/team_id" = \$1/g) ?? []).length;
        expect(matches).toBeGreaterThanOrEqual(3);
    });
});
// =============================================================================
// PART 5 — Investigation dashboard UI source contract
// =============================================================================
describe("Phase 31.12 — /investigation dashboard page", () => {
    const src = readSource("../../../apps/web/app/(app)/investigation/page.tsx");
    it("declared as a client component", () => {
        expect(src.trimStart()).toMatch(/^"use client"/);
    });
    it("only calls the whitelisted endpoints", () => {
        const noComments = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        const apiFetchCalls = noComments.match(/apiFetch\(\s*[`"][^`"]+[`"]/g) ?? [];
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
        const forbidden = /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
        for (const lit of literals) {
            expect(lit, `dashboard uses forbidden wording: ${lit}`).not.toMatch(forbidden);
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
        // Investigation-suite audit evolution: the previous copy ("No open
        // advisory observations…Run the analyzer") was rewritten to
        // operator-readable empty states with CTA links. The original
        // requirement is preserved — both lists still render a bounded
        // empty state with a next-action hint — but the exact wording now
        // surfaces "No analyses recorded yet" + Capture/Cases CTAs (signal
        // list) and "No graph activity yet" + same CTAs (graph list). The
        // canonical pin lives in `investigation-suite-audit.test.ts`.
        const flat = src.replace(/\s+/g, " ");
        expect(flat).toMatch(/No (?:open advisory observations|analyses recorded)[\s\S]*?(?:Run the[\s\S]*?analyzer|Capture)/);
        expect(flat).toMatch(/No graph (?:activity|yet)[\s\S]*?(?:Graph reconcile runs|Capture)/);
    });
    it("pivots to existing surfaces (no dead-end dashboard)", () => {
        expect(src).toMatch(/href="\/ops\/media-graph"/);
        expect(src).toMatch(/href=\{`\/evidence\/\$\{encodeURIComponent\(s\.evidenceId\)\}`\}/);
    });
});
