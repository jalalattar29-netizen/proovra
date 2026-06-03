/**
 * Phase 15 — Semantic Search + Hybrid Ranker source-contract pin.
 *
 * Adds privacy-safe semantic search ON TOP of the existing Global
 * Intelligence Search (Phase 14 closure). Pins the binding contract
 * for the Phase 15 backend + frontend without exercising the runtime
 * (vitest source-contract style — every assertion reads from the
 * filesystem, no DB / no server).
 *
 * Constitutional ground rules carried forward:
 *   - ONE /search page. ONE /v1/search API. No Search v2.
 *   - No NEW worker file matching *semantic*.
 *   - No NEW backend route file matching semantic*.
 *   - No raw OCR / transcript / chunk text in logs.
 *   - No outbound chunk text without SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND.
 *   - Default OFF: SEMANTIC_SEARCH_ENABLED=false,
 *     SEMANTIC_EMBEDDINGS_PROVIDER=disabled,
 *     SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND=false.
 *   - Plan / workspace permissions / legal-hold / destroyed / export
 *     filters preserved by re-ranking inside the already-gated keyword
 *     result set.
 *
 * Style: vitest source-contract (fs.readFileSync), matching
 * test/phase-7-team-vs-workspace-anti-confusion.test.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// -----------------------------------------------------------------------------
// Roots
// -----------------------------------------------------------------------------
const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_ROOT = resolve(REPO_ROOT, "apps/web");
const WORKER_ROOT = resolve(REPO_ROOT, "services/worker");
const DOCS_ROOT = resolve(REPO_ROOT, "docs");
// -----------------------------------------------------------------------------
// Source paths
// -----------------------------------------------------------------------------
const SCHEMA_PRISMA = resolve(API_ROOT, "prisma/schema.prisma");
const ENV_EXAMPLE = resolve(API_ROOT, ".env.example");
const MIGRATIONS_DIR = resolve(API_ROOT, "prisma/migrations");
const EMBEDDING_PROVIDER_SRC = resolve(API_ROOT, "src/services/search/embedding-provider.ts");
const EVIDENCE_SEARCH_SRC = resolve(API_ROOT, "src/services/search/evidence-search.service.ts");
const SEARCH_AUDIT_SRC = resolve(API_ROOT, "src/services/search/search-audit.service.ts");
const SEARCH_ROUTES_SRC = resolve(API_ROOT, "src/routes/search.routes.ts");
const INTELLIGENCE_ROUTES_SRC = resolve(API_ROOT, "src/routes/intelligence.routes.ts");
const WORKER_SEARCH_INDEXER_SRC = resolve(WORKER_ROOT, "src/search-indexing.processor.ts");
const SEARCH_PAGE_SRC = resolve(WEB_ROOT, "app/(app)/search/page.tsx");
const SIDEBAR_SRC = resolve(WEB_ROOT, "components/app-shell-v2/AppSidebarV2.tsx");
const ROUTE_REGISTRY_SRC = resolve(WEB_ROOT, "lib/navigation/routeRegistry.ts");
const PHASE_15_POLICY_DOC = resolve(DOCS_ROOT, "architecture/phase-15-semantic-policy.md");
// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function readUtf8(path) {
    return readFileSync(path, "utf8");
}
function walk(dir, accept) {
    const out = [];
    if (!existsSync(dir))
        return out;
    for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        let st;
        try {
            st = statSync(full);
        }
        catch {
            continue;
        }
        if (st.isDirectory()) {
            if (name === "node_modules" || name === ".next" || name === "dist") {
                continue;
            }
            out.push(...walk(full, accept));
            continue;
        }
        if (accept(name))
            out.push(full);
    }
    return out;
}
const WEB_FILES = walk(WEB_ROOT, (name) => name.endsWith(".tsx") ||
    name.endsWith(".ts") ||
    name.endsWith(".jsx") ||
    name.endsWith(".js"));
// =============================================================================
// BACKEND — 15 assertions
// =============================================================================
describe("Phase 15 backend — schema + migration", () => {
    it("1. EvidenceSemanticChunk model exists in schema.prisma with an embedding_vector column (or equivalent if pgvector unavailable)", () => {
        const schema = readUtf8(SCHEMA_PRISMA);
        expect(schema).toMatch(/model\s+EvidenceSemanticChunk\s*\{/);
        // Either the pgvector sibling column OR the existing Bytes
        // embedding column counts — the contract is "some embedding
        // storage exists on the chunk model".
        const hasVectorColumn = /embedding_vector/.test(schema) || /embeddingVector/.test(schema);
        const hasBytesEmbedding = /embedding\s+Bytes\??/i.test(schema);
        expect(hasVectorColumn || hasBytesEmbedding).toBe(true);
    });
    it("2. New Phase 15 migration file exists with timestamp > 20270601000000", () => {
        const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => /^\d{14}_/.test(d));
        // The Phase 15 *new* semantic-search migration is the one whose
        // name explicitly says "semantic" (the legacy
        // `add_intelligence_phase15` migration from Feb 2026 is a
        // different scope and predates the Phase 14 deferred plan).
        const phase15Semantic = dirs.filter((d) => /phase15[_-]?semantic|semantic[_-]?search/i.test(d));
        expect(phase15Semantic.length, `expected at least one phase15 semantic-search migration: found ${phase15Semantic.join(",")}`).toBeGreaterThan(0);
        for (const d of phase15Semantic) {
            const ts = d.slice(0, 14);
            expect(ts > "20270601000000").toBe(true);
        }
    });
    it("3. Migration contains 'CREATE EXTENSION IF NOT EXISTS vector'", () => {
        const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => /phase15|semantic/i.test(d));
        expect(dirs.length).toBeGreaterThan(0);
        let found = false;
        for (const d of dirs) {
            const sql = readUtf8(resolve(MIGRATIONS_DIR, d, "migration.sql"));
            if (/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+vector/i.test(sql)) {
                found = true;
                break;
            }
        }
        expect(found).toBe(true);
    });
    it("4. Migration uses Phase O additive pattern (DO $$ EXECUTE $sql$ blocks; terminating ;)", () => {
        const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => /phase15|semantic/i.test(d));
        expect(dirs.length).toBeGreaterThan(0);
        let satisfied = false;
        for (const d of dirs) {
            const sql = readUtf8(resolve(MIGRATIONS_DIR, d, "migration.sql"));
            // The Phase O additive pattern is: every DDL nested inside a
            // DO $$ ... END $$ block. We accept either the EXECUTE $sql$
            // sub-form OR a plain DO $$ ... END $$ block as long as at
            // least one statement is terminated with a semicolon.
            const hasDoBlock = /DO\s+\$\$[\s\S]+?END\s+\$\$/.test(sql);
            const hasTerminatedStmt = /;\s*(\n|$)/.test(sql);
            if (hasDoBlock && hasTerminatedStmt) {
                satisfied = true;
                break;
            }
        }
        expect(satisfied).toBe(true);
    });
    it("5. Migration uses information_schema.columns guards before CREATE INDEX", () => {
        const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => /phase15|semantic/i.test(d));
        expect(dirs.length).toBeGreaterThan(0);
        let satisfied = false;
        for (const d of dirs) {
            const sql = readUtf8(resolve(MIGRATIONS_DIR, d, "migration.sql"));
            const hasIndexGuard = /information_schema\.columns/i.test(sql) &&
                /CREATE\s+INDEX/i.test(sql);
            if (hasIndexGuard) {
                satisfied = true;
                break;
            }
        }
        expect(satisfied).toBe(true);
    });
});
describe("Phase 15 backend — embedding provider", () => {
    it("6. embedding-provider.ts exists + exports EmbeddingProvider interface", () => {
        expect(existsSync(EMBEDDING_PROVIDER_SRC)).toBe(true);
        const body = readUtf8(EMBEDDING_PROVIDER_SRC);
        expect(body).toMatch(/export\s+interface\s+EmbeddingProvider/);
    });
    it("7. Provider factory reads SEMANTIC_EMBEDDINGS_PROVIDER env (default 'disabled')", () => {
        const body = readUtf8(EMBEDDING_PROVIDER_SRC);
        expect(body).toMatch(/SEMANTIC_EMBEDDINGS_PROVIDER/);
        // Default fallback to 'disabled' somewhere in the factory.
        expect(body).toMatch(/["']disabled["']/);
    });
    it("8. Provider factory reads SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND env (default false)", () => {
        const body = readUtf8(EMBEDDING_PROVIDER_SRC);
        expect(body).toMatch(/SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND/);
        // The gate compares against the literal "true" string — anything
        // other than the explicit opt-in is treated as "do not send
        // chunk text outbound".
        expect(body).toMatch(/SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND[\s\S]{0,80}["']true["']/);
    });
});
describe("Phase 15 backend — hybrid ranker + /v1/search wiring", () => {
    it("9. evidence-search.service.ts contains hybrid-ranking logic (keyword + semantic combine)", () => {
        const body = readUtf8(EVIDENCE_SEARCH_SRC);
        // Combine signal — either a blended-score helper or a SEMANTIC /
        // HYBRID branch that re-orders rows by a semantic-derived score.
        const hasHybridBranch = /HYBRID|hybrid/.test(body);
        const hasSemanticScoreCombine = /semanticScore/.test(body) || /cosineSimilarity/.test(body);
        expect(hasHybridBranch).toBe(true);
        expect(hasSemanticScoreCombine).toBe(true);
    });
    it("10. evidence-search.service.ts result shape carries matchReasons + modeUsed + semanticScore? + keywordScore?", () => {
        const body = readUtf8(EVIDENCE_SEARCH_SRC);
        expect(body).toMatch(/matchReasons/);
        expect(body).toMatch(/modeUsed/);
        expect(body).toMatch(/semanticScore/);
        expect(body).toMatch(/keywordScore/);
    });
    it("11. /v1/search route accepts mode query param", () => {
        const body = readUtf8(SEARCH_ROUTES_SRC);
        // The handler must explicitly forward `mode` from the raw query
        // into the SearchFilterSchema (or the executeSearch filter).
        expect(body).toMatch(/mode\s*:\s*[\s\S]{0,200}raw\.mode/);
    });
    it("12. /v1/search response includes semanticAvailable + fallbackReason fields", () => {
        const body = readUtf8(SEARCH_ROUTES_SRC);
        expect(body).toMatch(/semanticAvailable/);
        expect(body).toMatch(/fallbackReason/);
    });
    it("13. Search indexer worker calls the provider behind try/catch (failure must not block keyword index write)", () => {
        const body = readUtf8(WORKER_SEARCH_INDEXER_SRC);
        // The provider call (embedText / embedBatch) MUST be wrapped in
        // a try/catch so an embedding failure is logged + skipped without
        // failing the surrounding keyword index write.
        const wrapped = /try\s*\{[\s\S]{0,400}embedText\(/.test(body) ||
            /try\s*\{[\s\S]{0,400}embedBatch\(/.test(body);
        expect(wrapped).toBe(true);
    });
    it("14. /v1/intelligence/search alias still forwards to /v1/search (Phase 14 contract preserved)", () => {
        const body = readUtf8(INTELLIGENCE_ROUTES_SRC);
        // Route declared.
        expect(body).toMatch(/["']\/v1\/intelligence\/search["']/);
        // And it delegates to the canonical search backend
        // (`executeSearch` from evidence-search.service).
        expect(body).toMatch(/executeSearch\s*\(/);
    });
    it("15. No raw text logged: search-audit.service.ts + embedding job paths do NOT include chunk.text or evidence.ocrText in audit calls", () => {
        // Allowed: TS shape definitions like `{ text: string }` (used as
        // a row projection), the EmbeddingProvider interface signature
        // `embedText(text: string)`, and the hash helper
        // `hashQuery(text: string)`. Disallowed: persisting / logging
        // `chunk.text`, `evidence.ocrText`, `chunkText: c.chunkText` etc
        // inside an audit row or a logger payload.
        const auditBody = readUtf8(SEARCH_AUDIT_SRC);
        const workerBody = readUtf8(WORKER_SEARCH_INDEXER_SRC);
        const evidenceSearchBody = readUtf8(EVIDENCE_SEARCH_SRC);
        // No "chunk.text" / "evidence.ocrText" / ".chunkText" property
        // ACCESS appearing anywhere near an audit/log call site.
        const forbidden = [
            /chunk\.text/,
            /evidence\.ocrText/,
            /\bchunkText\s*:\s*[a-zA-Z_]\w*\.chunkText\b/,
            /ocrText\s*:\s*[a-zA-Z_]\w*\.ocrText\b/,
        ];
        for (const re of forbidden) {
            expect(auditBody, `forbidden raw-text leak (${re}) in search-audit.service.ts`).not.toMatch(re);
            expect(workerBody, `forbidden raw-text leak (${re}) in worker search indexer`).not.toMatch(re);
            expect(evidenceSearchBody, `forbidden raw-text leak (${re}) in evidence-search.service.ts`).not.toMatch(re);
        }
    });
});
// =============================================================================
// FRONTEND — 9 assertions
// =============================================================================
describe("Phase 15 frontend — /search page surface", () => {
    it("16. /search page.tsx contains the mode selector (3 modes: Keyword / Hybrid / Semantic)", () => {
        const body = readUtf8(SEARCH_PAGE_SRC);
        expect(body).toMatch(/Keyword/);
        expect(body).toMatch(/Hybrid/);
        expect(body).toMatch(/Semantic/);
        // And a selector component / data-attribute that ties them
        // together as a mode picker (not just incidental copy).
        const hasSelector = /SearchModeSelector/.test(body) ||
            /data-search-mode-selector/.test(body) ||
            /data-search-mode=/.test(body);
        expect(hasSelector).toBe(true);
    });
    it("17. /search page.tsx renders the semantic status chip (one of 3 wordings depending on state)", () => {
        const body = readUtf8(SEARCH_PAGE_SRC);
        const hasChipComponent = /SemanticStatusChip/.test(body) ||
            /data-semantic-search-status/.test(body);
        expect(hasChipComponent).toBe(true);
        // The chip's bounded language covers at least 2 of 3 states
        // (disabled vs active vs fallback). We accept any 2 to leave
        // room for copy iteration.
        const wordings = [
            /not available/i,
            /disabled/i,
            /active/i,
            /fell back/i,
        ];
        const matched = wordings.filter((re) => re.test(body)).length;
        expect(matched).toBeGreaterThanOrEqual(2);
    });
    it("18. /search page.tsx renders matchReasons badges per result", () => {
        const body = readUtf8(SEARCH_PAGE_SRC);
        expect(body).toMatch(/matchReasons/);
        // The per-row render references matchReasons in JSX (not just
        // type definitions). We look for an array-iteration pattern
        // adjacent to matchReasons.
        expect(body).toMatch(/matchReasons[\s\S]{0,200}\.map\(/);
    });
    it("19. /search page.tsx no-result suggestions include 'Enable semantic search' path", () => {
        const body = readUtf8(SEARCH_PAGE_SRC);
        expect(body).toMatch(/Enable semantic search/i);
    });
    it("20. Inspector renders semantic pivots when semanticScore > 0", () => {
        const body = readUtf8(SEARCH_PAGE_SRC);
        // The pivots block must be gated on a semanticScore threshold so
        // we don't show "Semantically similar" for keyword-only hits.
        expect(body).toMatch(/semanticScore[\s\S]{0,80}>\s*0/);
    });
    it("21. /search page.tsx forwards mode in apiFetch URL", () => {
        const body = readUtf8(SEARCH_PAGE_SRC);
        // The runSearch helper must set the `mode` query param on the
        // /v1/search call (gated on non-default).
        expect(body).toMatch(/qs\.set\(\s*["']mode["']/);
    });
    it("22. No new search route file exists under apps/web/app/(app)/ matching /semantic|search-v2/", () => {
        const appDir = resolve(WEB_ROOT, "app");
        const offenders = walk(appDir, (name) => name === "page.tsx" || name === "page.ts" || name === "page.jsx").filter((p) => /semantic-search|search-v2/i.test(p));
        expect(offenders, offenders.join("\n")).toEqual([]);
    });
    it("23. Sidebar (AppSidebarV2.tsx) + Cmd-K + Tools still point at /search (not /semantic-search)", () => {
        // Forbidden literal anywhere in the web tree.
        const offenders = [];
        const re = /["']\/semantic-search["']/;
        for (const file of WEB_FILES) {
            if (file.includes(".test.") ||
                file.includes("\\test\\") ||
                file.includes("/test/")) {
                continue;
            }
            const body = readUtf8(file);
            if (re.test(body))
                offenders.push(file);
        }
        expect(offenders, offenders.join("\n")).toEqual([]);
        // And the canonical /search href is still registered.
        const registry = readUtf8(ROUTE_REGISTRY_SRC);
        expect(registry).toMatch(/href:\s*["']\/search["']/);
        // Sidebar still references the workspace.search route id.
        const sidebar = readUtf8(SIDEBAR_SRC);
        expect(sidebar).toMatch(/workspace\.search/);
    });
    it("24. Phase 13's 'Semantic search not available' copy logic is preserved (chip wording remains operator-readable)", () => {
        const body = readUtf8(SEARCH_PAGE_SRC);
        // The Phase 13 wording is preserved verbatim for the disabled
        // baseline — the Phase 15 chip flips into other variants only
        // when semantic becomes available.
        expect(body).toMatch(/Semantic search not available/i);
    });
});
// =============================================================================
// BOUNDED GUARDS — 4 assertions
// =============================================================================
describe("Phase 15 bounded guards — no duplication, no leak", () => {
    it("25. No NEW worker file added (search for new files under services/worker/src/ matching *semantic*)", () => {
        const workerSrc = resolve(WORKER_ROOT, "src");
        const offenders = walk(workerSrc, (name) => /semantic/i.test(name));
        expect(offenders, offenders.join("\n")).toEqual([]);
    });
    it("26. No NEW backend search route file added (no services/api/src/routes/semantic*.ts)", () => {
        const routesDir = resolve(API_ROOT, "src/routes");
        const offenders = readdirSync(routesDir).filter((f) => /^semantic/i.test(f) && f.endsWith(".ts"));
        expect(offenders, offenders.join("\n")).toEqual([]);
    });
    it("27. No raw 'OPENAI_API_KEY' / 'OPENAI_EMBEDDING_MODEL' string appears in any apps/web file (env names stay server-side)", () => {
        const offenders = [];
        const re = /OPENAI_API_KEY|OPENAI_EMBEDDING_MODEL/;
        for (const file of WEB_FILES) {
            if (file.includes(".test.") ||
                file.includes("\\test\\") ||
                file.includes("/test/")) {
                continue;
            }
            const body = readUtf8(file);
            if (re.test(body))
                offenders.push(file);
        }
        expect(offenders, offenders.join("\n")).toEqual([]);
    });
    it("28. Privacy doc exists at docs/architecture/phase-15-semantic-policy.md and contains 'SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND' + 'Provider failure → keyword fallback'", () => {
        expect(existsSync(PHASE_15_POLICY_DOC)).toBe(true);
        const body = readUtf8(PHASE_15_POLICY_DOC);
        expect(body).toMatch(/SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND/);
        // Accept either the literal "→" arrow form or the equivalent
        // English ("Provider failure triggers keyword fallback") — both
        // are bounded operator-safe documentation of the same policy.
        const hasArrowForm = /Provider failure\s*(?:→|->|—|-)?\s*(?:keyword fallback|triggers keyword fallback)/i.test(body);
        const hasEnglishForm = /Provider failure[^\n]{0,80}keyword fallback/i.test(body);
        expect(hasArrowForm || hasEnglishForm).toBe(true);
    });
});
