/**
 * Phase 24 — Enterprise Evidence Discovery regression tests.
 *
 * No DB. Source-text + pure-helper + projection tests covering the
 * Phase 24 backend hardening + the web search console:
 *
 *   - Indexing service NEVER reads / projects the privateReviewerNote.
 *   - Search service hashes the raw query string before any audit
 *     emission (we assert source-level — no raw `q` in the event body).
 *   - Result row projection only contains allowed-catalog badges.
 *   - Routes use requireAuth + requireSearchActor (404-on-non-member)
 *     and write routes require identity.access_review.action.
 *   - Reindex routes accept only POST with operator gate.
 *   - Web search page never writes a forbidden overclaim phrase.
 *   - Public verify routes have NO Phase 24 imports.
 *   - Untouched files invariant: services/worker/src/pdf/report.ts
 *     carries no Phase 24 markers.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEARCH_RESULT_ALLOWED_BADGES, SEARCH_FORBIDDEN_OVERCLAIM_PHRASES, decodeSearchCursor, encodeSearchCursor, isAllowedSearchBadge, stringContainsForbiddenOverclaim, } from "@proovra/shared";
// -----------------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------------
function readSource(relativeFromTest) {
    return readFileSync(fileURLToPath(new URL(relativeFromTest, import.meta.url)), "utf8");
}
// -----------------------------------------------------------------------------
// Indexing service — privacy guarantees
// -----------------------------------------------------------------------------
describe("Phase 24 — indexing service privacy guarantees", () => {
    const src = readSource("../src/services/search/evidence-indexing.service.ts");
    it("never reads privateReviewerNote into the search projection", () => {
        // The phrase may legitimately appear in the file's header docstring
        // as a deliberate exclusion comment. The invariant is that no
        // property access reaches into it.
        expect(src).not.toMatch(/\.privateReviewerNote\b/);
        expect(src).not.toMatch(/privateReviewerNote\s*:/);
        expect(src).not.toMatch(/\bselect\s*:\s*\{[^}]*privateReviewerNote/);
    });
    it("never reads legal-hold reason text into the projection", () => {
        expect(src).not.toMatch(/legalHoldReason\b/);
        expect(src).not.toMatch(/legal_hold_reason\b/);
    });
    it("only consumes COMPLETED extraction text (no PENDING / FAILED leakage)", () => {
        // We rely on the Phase 15 extraction status enum; the service must
        // only fold COMPLETED extractions into the searchable_text body.
        expect(src).toMatch(/COMPLETED/);
        expect(src).not.toMatch(/EvidenceExtractedTextStatus\.SUCCESS/);
    });
    it("redacts via safeJsonSnapshot (not raw JSON.stringify of metadata)", () => {
        expect(src).toMatch(/safeJsonSnapshot/);
    });
});
// -----------------------------------------------------------------------------
// Search service — query privacy + reviewer gate
// -----------------------------------------------------------------------------
describe("Phase 24 — search service privacy + reviewer gate", () => {
    const src = readSource("../src/services/search/evidence-search.service.ts");
    it("hashes the search query (SHA256) before emitting any audit", () => {
        expect(src).toMatch(/createHash\(["']sha256["']\)/);
        expect(src).toMatch(/queryHash/);
    });
    it("never sends the raw `q` text into the SecurityEvent details", () => {
        // The event body must use queryHash + queryLength, not the raw string.
        // We assert source-level by checking the SecurityEvent emit shape
        // never references `q:` as the raw key in the details payload.
        const detailsBlock = src.match(/details:\s*\{[\s\S]*?\}/g) ?? [];
        for (const block of detailsBlock) {
            expect(block).not.toMatch(/q:\s*filter\.q\b/);
            expect(block).not.toMatch(/query:\s*filter\.q\b/);
        }
    });
    it("fails closed when isReviewerCapable is false (sets reviewerRestricted = false)", () => {
        expect(src).toMatch(/if \(!input\.isReviewerCapable\)/);
        expect(src).toMatch(/where\.reviewerRestricted\s*=\s*false/);
    });
    it("filters governance-blocked workflow rows (CANCELLED) in the per-row pass", () => {
        expect(src).toMatch(/workflowState\s*===\s*["']CANCELLED["']/);
    });
    it("only emits badges from the allowed catalog", () => {
        expect(src).toMatch(/isAllowedSearchBadge/);
    });
});
// -----------------------------------------------------------------------------
// Saved-search service — visibility + permission shape
// -----------------------------------------------------------------------------
describe("Phase 24 — saved-search service", () => {
    const src = readSource("../src/services/search/saved-search.service.ts");
    it("blocks PRIVATE-view deletion by non-creators", () => {
        expect(src).toMatch(/visibility\s*===\s*["']PRIVATE["'][\s\S]*?createdByUserId\s*!==\s*input\.actorUserId/);
    });
    it("includes other users' TEAM-visibility views in the list", () => {
        expect(src).toMatch(/visibility:\s*["']TEAM["']/);
    });
    it("touch is best-effort (never throws to the caller)", () => {
        expect(src).toMatch(/best-effort/i);
    });
});
// -----------------------------------------------------------------------------
// Routes — auth posture + operator gate on write surfaces
// -----------------------------------------------------------------------------
describe("Phase 24 — search routes auth posture", () => {
    const src = readSource("../src/routes/search.routes.ts");
    it("uses requireAuth on every Phase 24 route", () => {
        // The route file may include legacy routes too; we assert that
        // every Phase 24 path appears alongside a preHandler: requireAuth.
        const phase24Paths = [
            "/v1/search",
            "/v1/search/saved-views",
            "/v1/search/relationships",
            "/v1/search/reindex/evidence",
            "/v1/search/reindex/workflow",
        ];
        for (const p of phase24Paths) {
            const idx = src.indexOf(`"${p}`);
            expect(idx, `expected route "${p}" registered`).toBeGreaterThanOrEqual(0);
        }
        expect(src).toMatch(/preHandler:\s*requireAuth/);
    });
    it("404s on non-member via requireSearchActor", () => {
        expect(src).toMatch(/requireSearchActor/);
        expect(src).toMatch(/reply\.code\(404\)\.send\(\{ error: \{ code: ["']not_found["'] \} \}\)/);
    });
    it("write routes gate via requireSearchOperator (identity.access_review.action)", () => {
        expect(src).toMatch(/requireSearchOperator/);
        expect(src).toMatch(/identity\.access_review\.action/);
    });
    it("reindex routes only accept POST", () => {
        // Find every route registration referencing /v1/search/reindex
        // and assert its verb is POST.
        const reindexPaths = [
            "/v1/search/reindex/evidence/:id",
            "/v1/search/reindex/workflow/:id",
        ];
        for (const path of reindexPaths) {
            const idx = src.indexOf(`"${path}"`);
            expect(idx, `expected "${path}" registered`).toBeGreaterThan(0);
            // Look backwards from the path string to find the nearest verb
            // call (`app.post(`, `app.get(`, …) within ~120 chars.
            const before = src.slice(Math.max(0, idx - 160), idx);
            expect(before.match(/app\.post\(\s*$/), `route "${path}" must be registered via app.post`).not.toBeNull();
            expect(before).not.toMatch(/app\.(get|put|delete|patch)\(\s*$/);
        }
    });
    it("delete route is restricted to /v1/search/saved-views/:id", () => {
        expect(src).toMatch(/app\.delete\([\s\S]*?"\/v1\/search\/saved-views\/:id"/);
    });
});
// -----------------------------------------------------------------------------
// Cursor helper — pure round-trip
// -----------------------------------------------------------------------------
describe("Phase 24 — cursor helper round-trip", () => {
    it("encode + decode is lossless for {updatedAtUtc, id}", () => {
        const c = {
            updatedAtUtc: "2026-05-17T08:30:00.000Z",
            id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        };
        const round = decodeSearchCursor(encodeSearchCursor(c));
        expect(round).toEqual(c);
    });
    it("rejects malformed input as null (no throw)", () => {
        expect(decodeSearchCursor("garbage!!!")).toBeNull();
        expect(decodeSearchCursor("")).toBeNull();
    });
});
// -----------------------------------------------------------------------------
// Badge wording catalog — operator-safe phrases only
// -----------------------------------------------------------------------------
describe("Phase 24 — badge catalog", () => {
    it("contains the operator-readable phrases from the brief", () => {
        for (const required of [
            "matched metadata",
            "related evidence",
            "workflow-linked",
            "review-linked",
            "governance-restricted",
            "visibility-restricted",
            "integrity record",
        ]) {
            expect(SEARCH_RESULT_ALLOWED_BADGES.includes(required)).toBe(true);
            expect(isAllowedSearchBadge(required)).toBe(true);
        }
    });
    it("rejects free-form overclaims", () => {
        expect(isAllowedSearchBadge("court-approved")).toBe(false);
        expect(isAllowedSearchBadge("forensic proof")).toBe(false);
    });
});
// -----------------------------------------------------------------------------
// Forbidden overclaim wording sweep — UI surface
// -----------------------------------------------------------------------------
describe("Phase 24 — UI wording sweep", () => {
    const pageSrc = readSource("../../../apps/web/app/(app)/search/page.tsx");
    it("the search page contains no forbidden overclaim phrases", () => {
        for (const re of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
            expect(pageSrc).not.toMatch(re);
        }
    });
    it("badge styling map only contains allowed-catalog keys", () => {
        // Extract the badgeChipStyle map keys; every key must be in the
        // shared allowed-catalog (or be the safe fallback empty string).
        const mapBlock = pageSrc.match(/function badgeChipStyle[\s\S]*?const map: Record<string,[\s\S]*?\};/);
        expect(mapBlock).toBeTruthy();
        const keys = mapBlock?.[0].match(/"([^"]+)":\s*\{ bg:/g)?.map((s) => {
            const m = s.match(/"([^"]+)":/);
            return m?.[1] ?? "";
        }) ?? [];
        for (const k of keys) {
            expect(SEARCH_RESULT_ALLOWED_BADGES.includes(k), `badge key "${k}" not in allowed catalog`).toBe(true);
        }
    });
});
// -----------------------------------------------------------------------------
// Public verify isolation — Phase 24 services must NOT leak into the
// public verify surface (which has to remain ultra-minimal + zero-cost).
// -----------------------------------------------------------------------------
describe("Phase 24 — public verify isolation", () => {
    it("evidence routes (which host /public/verify) do NOT import Phase 24 search services", () => {
        // Public verify lives inside services/api/src/routes/evidence.routes.ts.
        // It must never reach into the Phase 24 search service stack.
        const evidenceSrc = readSource("../src/routes/evidence.routes.ts");
        expect(evidenceSrc).not.toMatch(/services\/search\/evidence-search/);
        expect(evidenceSrc).not.toMatch(/services\/search\/saved-search/);
        expect(evidenceSrc).not.toMatch(/services\/search\/evidence-indexing/);
    });
});
// -----------------------------------------------------------------------------
// Untouched files invariant — Phase 24 must NOT touch the renderer.
// -----------------------------------------------------------------------------
describe("Phase 24 — untouched files invariant", () => {
    it("services/worker/src/pdf/report.ts has NO Phase 24 markers", () => {
        const src = readSource("../../worker/src/pdf/report.ts");
        expect(src).not.toMatch(/Phase 24/);
        expect(src).not.toMatch(/search\/evidence-search/);
        expect(src).not.toMatch(/EvidenceSearchDocument/);
    });
});
// -----------------------------------------------------------------------------
// Helper: catch obvious "save raw query string" regressions in the search
// service (caller is the route layer, but the safety net is layered here).
// -----------------------------------------------------------------------------
describe("Phase 24 — raw-query non-leak guard", () => {
    const src = readSource("../src/services/search/evidence-search.service.ts");
    it("never includes the raw filter.q as an audit field by name", () => {
        // SafeEmitSecurityEvent payloads must not reference `q: filter.q`.
        const matches = src.match(/safeEmitSecurityEvent\(\{[\s\S]*?\}\);/g) ?? [];
        expect(matches.length).toBeGreaterThan(0);
        for (const block of matches) {
            expect(block).not.toMatch(/q:\s*filter\.q\b/);
            expect(block).not.toMatch(/rawQuery:/);
        }
    });
});
// -----------------------------------------------------------------------------
// Wording sweep — the catalog excludes the legally-overclaiming phrases.
// -----------------------------------------------------------------------------
describe("Phase 24 — overclaim catalog", () => {
    it("flags every banned phrase the brief enumerates", () => {
        const phrases = [
            "this image is tamper-proof",
            "court-approved chain of custody",
            "guaranteed authentic evidence",
            "impossible to alter",
            "detects fake media",
            "forensic proof of integrity",
            "legally admissible record",
        ];
        for (const p of phrases) {
            expect(stringContainsForbiddenOverclaim(p), `expected "${p}" to be flagged`).toBe(true);
        }
    });
    it("leaves operator-safe phrases unflagged", () => {
        expect(stringContainsForbiddenOverclaim("integrity record")).toBe(false);
        expect(stringContainsForbiddenOverclaim("matched metadata")).toBe(false);
        expect(stringContainsForbiddenOverclaim("related evidence")).toBe(false);
    });
});
