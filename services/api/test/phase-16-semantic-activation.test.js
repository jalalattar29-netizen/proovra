/**
 * Phase 16 — Semantic Search Activation source-contract pin.
 *
 * Phase 15 shipped the SAFE / DISABLED skeleton: pgvector column,
 * EmbeddingProvider interface, /v1/search mode selector, hybrid
 * ranker shape — but the OpenAI provider was a stub that threw
 * `PROVIDER_NOT_IMPLEMENTED`, no chunk text ever left the process.
 *
 * Phase 16 ACTIVATES the engine WITHOUT compromising any Phase 15
 * guarantee:
 *   - Real OpenAI provider gated by the same four-flag combo
 *     (SEMANTIC_SEARCH_ENABLED + SEMANTIC_EMBEDDINGS_PROVIDER=openai +
 *     SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND + OPENAI_API_KEY).
 *   - Workspace-scoped backfill (admin) + status (workspace) endpoints
 *     extending the existing /v1/search route file (NO new route file).
 *   - Live-indexing `mi-embed` queue + worker processor populating
 *     the pgvector `embedding_vector` column outside the request path.
 *   - Hybrid search now uses pgvector cosine distance via Prisma
 *     `$queryRaw` (workspace id ALWAYS parameterised).
 *   - UI surfaces honest status, humanised fallback reasons, and a
 *     platform-admin-only dry-run backfill panel — no env-var names
 *     anywhere in the UI bundle.
 *
 * Constitutional guards carried forward from Phase 15:
 *   - NO Search v2, NO new search page, NO `/v1/semantic-search`
 *     route file, NO new top-level web route.
 *   - NO raw chunk text in logs.
 *   - Keyword search MUST work even if every semantic component is
 *     broken (provider failure → silent degrade to keyword + bounded
 *     `fallbackReason`; never throws out of /v1/search).
 *
 * Style: vitest source-contract (fs.readFileSync), matching
 * `test/phase-15-semantic-search.test.ts`. No DB, no server.
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
const EMBEDDING_PROVIDER_SRC = resolve(API_ROOT, "src/services/search/embedding-provider.ts");
const SEMANTIC_BACKFILL_SRC = resolve(API_ROOT, "src/services/search/semantic-backfill.service.ts");
const SEMANTIC_BUDGET_SRC = resolve(API_ROOT, "src/services/search/semantic-budget.service.ts");
const SEMANTIC_SERVICE_SRC = resolve(API_ROOT, "src/services/intelligence/semantic.service.ts");
const EVIDENCE_SEARCH_SRC = resolve(API_ROOT, "src/services/search/evidence-search.service.ts");
const SEARCH_ROUTES_SRC = resolve(API_ROOT, "src/routes/search.routes.ts");
const MI_EMBED_QUEUE_SRC = resolve(API_ROOT, "src/queue/mi-embed-queue.ts");
const WORKER_MI_EMBED_PROCESSOR_SRC = resolve(WORKER_ROOT, "src/mi-embed.processor.ts");
const WORKER_QUEUE_SRC = resolve(WORKER_ROOT, "src/queue.ts");
const API_ROUTES_DIR = resolve(API_ROOT, "src/routes");
const SEARCH_PAGE_SRC = resolve(WEB_ROOT, "app/(app)/search/page.tsx");
const MIGRATIONS_DIR = resolve(API_ROOT, "prisma/migrations");
const PHASE_16_MIGRATION_SQL = resolve(MIGRATIONS_DIR, "20270801000000_phase16_semantic_usage/migration.sql");
const PHASE_32_7_2_TEST_SRC = resolve(API_ROOT, "test/phase-32-7-2-security-event-mapping-drift.test.ts");
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
// =============================================================================
// GROUP 1 — PROVIDER (5 assertions)
// =============================================================================
describe("Phase 16 — OpenAI embedding provider gates + error vocabulary", () => {
    it("1. OpenAI provider class is gated on SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND + OPENAI_API_KEY before any network call", () => {
        const body = readUtf8(EMBEDDING_PROVIDER_SRC);
        // The real provider class exists.
        expect(body).toMatch(/class\s+OpenAIEmbeddingProvider\s+implements\s+EmbeddingProvider/);
        // It contains a `gate()` (or equivalent) that explicitly checks the
        // outbound flag against the literal "true" string AND the api key.
        expect(body).toMatch(/SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND[\s\S]{0,80}["']true["']/);
        expect(body).toMatch(/OPENAI_API_KEY/);
        // The gate throws OUTBOUND_NOT_ALLOWED when the outbound flag is
        // missing (the bounded refusal code surfaces to callers BEFORE the
        // SDK is even constructed).
        expect(body).toMatch(/OUTBOUND_NOT_ALLOWED/);
        // The lazy `import("openai")` call exists (proves we don't load
        // the SDK at module-eval time — only when the gate has passed).
        expect(body).toMatch(/import\(["']openai["']\)/);
        // AbortController + timeoutMs is wired (no naked hung connection).
        expect(body).toMatch(/AbortController/);
    });
    it("2. EmbeddingProviderError vocabulary includes OUTBOUND_NOT_ALLOWED, AUTH, RATE_LIMITED, UPSTREAM_5XX, TIMEOUT", () => {
        const body = readUtf8(EMBEDDING_PROVIDER_SRC);
        // The five bounded error codes must be present in the typed union
        // (callers degrade by code; loose strings would defeat that).
        for (const code of [
            "OUTBOUND_NOT_ALLOWED",
            "AUTH",
            "RATE_LIMITED",
            "UPSTREAM_5XX",
            "TIMEOUT",
        ]) {
            expect(body, `missing error code ${code}`).toMatch(new RegExp(`["']${code}["']`));
        }
        // And the EmbeddingProviderError class itself is exported so
        // callers can `instanceof`-check it.
        expect(body).toMatch(/export\s+class\s+EmbeddingProviderError/);
    });
    it("3. buildEmbeddingProviderFromEnv() factory returns Disabled when SEMANTIC_SEARCH_ENABLED !== 'true'", () => {
        const body = readUtf8(EMBEDDING_PROVIDER_SRC);
        expect(body).toMatch(/export\s+function\s+buildEmbeddingProviderFromEnv/);
        // The factory body must reference SEMANTIC_SEARCH_ENABLED + the
        // DisabledEmbeddingProvider as the fallback path.
        expect(body).toMatch(/SEMANTIC_SEARCH_ENABLED/);
        expect(body).toMatch(/DisabledEmbeddingProvider/);
        // The factory checks against the literal "true" so any other
        // value (undefined, "1", "yes") falls through to disabled.
        expect(body).toMatch(/SEMANTIC_SEARCH_ENABLED[\s\S]{0,40}["']true["']/);
    });
    it("4. Provider failure path in evidence-search.service.ts catches errors and sets a bounded fallbackReason", () => {
        const body = readUtf8(EVIDENCE_SEARCH_SRC);
        // The hybrid ranker call site MUST be wrapped in try/catch so a
        // provider throw can NEVER bubble out of /v1/search.
        expect(body).toMatch(/try\s*\{[\s\S]{0,400}rerankWithSemantic/);
        // Bounded fallback reasons are assigned (one of the documented
        // codes the frontend humanises). We accept the union of strings
        // since exact assignment order is implementation-specific.
        const fallbackReasons = [
            /PROVIDER_UNAVAILABLE/,
            /SEMANTIC_FEATURE_DISABLED/,
            /QUERY_TOO_SHORT/,
            /NO_SEMANTIC_RESULTS/,
        ];
        const matched = fallbackReasons.filter((re) => re.test(body)).length;
        expect(matched, "expected at least 3 bounded fallback reason strings in evidence-search.service.ts").toBeGreaterThanOrEqual(3);
        // And the catch branch downgrades modeUsed to KEYWORD so the
        // keyword pass result envelope is preserved.
        expect(body).toMatch(/modeUsed\s*=\s*["']KEYWORD["']/);
    });
    it("5. No raw chunk-text logging across provider + backfill + worker processor", () => {
        // Forbidden: any console.log/console.warn/console.error/logger.*
        // call that includes a property access of `.chunkText` or
        // `.chunk_text` (the raw text of an indexed chunk). The bounded
        // log helpers `logEmbeddingFailure` + structured logger calls
        // emit only ids + codes + counts — never the raw text.
        const provider = readUtf8(EMBEDDING_PROVIDER_SRC);
        const backfill = readUtf8(SEMANTIC_BACKFILL_SRC);
        const worker = readUtf8(WORKER_MI_EMBED_PROCESSOR_SRC);
        const forbidden = [
            /console\.(log|warn|error|info)\([^)]*\.chunkText/,
            /console\.(log|warn|error|info)\([^)]*\.chunk_text/,
            /logger\.(info|warn|error|debug|trace)\([^)]*\.chunkText/,
            /logger\.(info|warn|error|debug|trace)\([^)]*\.chunk_text/,
        ];
        for (const re of forbidden) {
            expect(provider, `raw chunk-text leak in embedding-provider.ts (${re})`).not.toMatch(re);
            expect(backfill, `raw chunk-text leak in semantic-backfill.service.ts (${re})`).not.toMatch(re);
            expect(worker, `raw chunk-text leak in mi-embed.processor.ts (${re})`).not.toMatch(re);
        }
    });
});
// =============================================================================
// GROUP 2 — BACKFILL + LIVE INDEXING (4 assertions)
// =============================================================================
describe("Phase 16 — Backfill service + live indexing", () => {
    it("6. semantic-backfill.service.ts exports runSemanticBackfill with workspaceId parameter", () => {
        expect(existsSync(SEMANTIC_BACKFILL_SRC)).toBe(true);
        const body = readUtf8(SEMANTIC_BACKFILL_SRC);
        expect(body).toMatch(/export\s+async\s+function\s+runSemanticBackfill/);
        // The input type carries workspaceId.
        expect(body).toMatch(/workspaceId\s*:\s*string/);
        // Bounded refusal when workspaceId is missing — the brief's
        // "workspace-scoped strictly" non-negotiable.
        expect(body).toMatch(/WORKSPACE_REQUIRED/);
    });
    it("7. Backfill uses Prisma.sql / $queryRaw with workspaceId parameterised — never string-interpolated into SQL", () => {
        const body = readUtf8(SEMANTIC_BACKFILL_SRC);
        // The raw SQL site exists (tagged template literal on $queryRaw).
        expect(body).toMatch(/\$queryRaw[\s\S]{0,400}team_id\s*=\s*\$\{[^}]*workspaceId[^}]*\}/);
        // Forbidden: classic string-concatenation of workspaceId into a
        // SQL fragment (`+` style, or `${...workspaceId}` inside a plain
        // string literal). We accept tagged-template interpolation
        // (Prisma's $queryRaw parameterises those for us).
        const forbidden = [
            /"[^"]*WHERE[^"]*team_id\s*=\s*'\s*\$\{?\s*\w*workspaceId/i,
            /'[^']*WHERE[^']*team_id\s*=\s*"\s*\$\{?\s*\w*workspaceId/i,
            /`SELECT[^`]*team_id\s*=\s*'\$\{workspaceId\}'/i,
        ];
        for (const re of forbidden) {
            expect(body, `forbidden string-interpolation of workspaceId into SQL (${re})`).not.toMatch(re);
        }
    });
    it("8. Live indexing — semantic.service.ts indexEvidenceText enqueues an mi-embed job", () => {
        const body = readUtf8(SEMANTIC_SERVICE_SRC);
        // The producer helper is imported.
        expect(body).toMatch(/enqueueEmbedChunks/);
        // And it's actually called from inside indexEvidenceText (not
        // merely imported). We anchor on the function name + the call.
        expect(body).toMatch(/indexEvidenceText[\s\S]{0,4000}enqueueEmbedChunks\s*\(/);
    });
    it("9. mi-embed worker processor exists with the EmbedSemanticChunks job handler", () => {
        expect(existsSync(WORKER_MI_EMBED_PROCESSOR_SRC)).toBe(true);
        const processor = readUtf8(WORKER_MI_EMBED_PROCESSOR_SRC);
        // The processor exports a handler that BullMQ invokes per job.
        expect(processor).toMatch(/export\s+async\s+function\s+processMiEmbedJob/);
        // The worker-side queue declaration includes the bounded job name.
        const queue = readUtf8(WORKER_QUEUE_SRC);
        expect(queue).toMatch(/miEmbedJobName\s*=\s*["']EmbedSemanticChunks["']/);
        expect(queue).toMatch(/miEmbedQueueName\s*=\s*["']mi-embed["']/);
    });
});
// =============================================================================
// GROUP 3 — HYBRID + ROUTES (3 assertions)
// =============================================================================
describe("Phase 16 — Hybrid pgvector ranker + admin routes", () => {
    it("10. POST /v1/search/semantic/backfill registered in search.routes.ts behind platform-admin gate", () => {
        const body = readUtf8(SEARCH_ROUTES_SRC);
        expect(body).toMatch(/["']\/v1\/search\/semantic\/backfill["']/);
        // The preHandler must include the platform-admin gate. We accept
        // the imported helper name `requirePlatformAdmin`.
        expect(body).toMatch(/["']\/v1\/search\/semantic\/backfill["'][\s\S]{0,400}requirePlatformAdmin/);
        // And the service runner is the one we shipped.
        expect(body).toMatch(/runSemanticBackfill\s*\(/);
    });
    it("11. GET /v1/search/semantic/status registered in search.routes.ts", () => {
        const body = readUtf8(SEARCH_ROUTES_SRC);
        expect(body).toMatch(/["']\/v1\/search\/semantic\/status["']/);
        // The handler should call the bounded summary helper so the
        // response is predictable + no raw chunk text leaks.
        expect(body).toMatch(/getSemanticUsageSummary\s*\(/);
    });
    it("12. evidence-search.service.ts hybrid mode references both keyword + cosine distance via the pgvector `<=>` operator", () => {
        const body = readUtf8(EVIDENCE_SEARCH_SRC);
        // HYBRID branch carried over from Phase 15.
        expect(body).toMatch(/HYBRID/);
        // pgvector cosine distance operator must appear inside a tagged
        // template literal passed to $queryRaw — the only way to reach
        // SQL-side nearest-neighbour math through Prisma 5 today.
        expect(body).toMatch(/\$queryRaw[\s\S]{0,800}embedding_vector\s*<=>/);
        // Workspace id MUST be parameterised (bound), not interpolated
        // into a raw SQL string. We assert the tagged-template form is
        // used near the team_id clause.
        expect(body).toMatch(/\$queryRaw[\s\S]{0,800}team_id\s*=\s*\$\{[^}]*teamId[^}]*\}/);
        // Keyword score reference preserved — hybrid blends the two.
        expect(body).toMatch(/keywordScore|KEYWORD_WEIGHT/);
    });
});
// =============================================================================
// GROUP 4 — UI (3 assertions)
// =============================================================================
describe("Phase 16 — /search page UI surfaces", () => {
    it("13. /search page wires apiFetch to /v1/search/semantic/status", () => {
        const body = readUtf8(SEARCH_PAGE_SRC);
        // The page hits the status endpoint to drive the chip.
        expect(body).toMatch(/\/v1\/search\/semantic\/status/);
        // And it uses the shared apiFetch helper (no bare fetch() to an
        // /v1 URL — that would bypass the auth header forwarder).
        expect(body).toMatch(/apiFetch\s*\([\s\S]{0,200}\/v1\/search\/semantic\/status/);
    });
    it("14. Admin-only backfill panel exists — references backfill + dryRun", () => {
        const body = readUtf8(SEARCH_PAGE_SRC);
        // The panel posts to the backfill endpoint with `dryRun: true`.
        expect(body).toMatch(/\/v1\/search\/semantic\/backfill/);
        expect(body).toMatch(/dryRun\s*:\s*true/);
        // The panel is gated on the platform-admin flag (the page reads
        // the canonical envelope; `isPlatformAdmin` is the boolean). We
        // accept either the helper name or the envelope property path.
        expect(body).toMatch(/isPlatformAdmin/);
    });
    it("15. Mode selector disable wording references humanised fallbackReason strings", () => {
        const body = readUtf8(SEARCH_PAGE_SRC);
        // The humaniser function exists.
        expect(body).toMatch(/humaniseFallbackReason/);
        // At least 4 of the 7 bounded humanised phrases ship in the page
        // (we leave room for copy iteration without weakening the
        // contract). These strings drive the title attribute on the
        // disabled Hybrid / Semantic radio buttons.
        const phrases = [
            /provider offline/i,
            /daily cap reached/i,
            /monthly budget reached/i,
            /outbound disabled/i,
            /feature not enabled/i,
            /query too short/i,
            /no semantic matches/i,
        ];
        const matched = phrases.filter((re) => re.test(body)).length;
        expect(matched, `expected >= 4 humanised fallback phrases in the /search page; matched ${matched}`).toBeGreaterThanOrEqual(4);
    });
});
// =============================================================================
// GROUP 5 — BOUNDED GUARDS (5 assertions)
// =============================================================================
describe("Phase 16 — bounded guards (no duplication, no leak, no Search v2)", () => {
    it("16. NO new search page — apps/web/app/(app)/**/search* matches only the existing /search/page.tsx", () => {
        const appDir = resolve(WEB_ROOT, "app");
        // Every page.tsx whose path segment contains "search" anywhere.
        const matches = walk(appDir, (name) => name === "page.tsx" || name === "page.ts" || name === "page.jsx").filter((p) => /[\\/]search[\\/]/i.test(p) || /[\\/]search-/i.test(p));
        // Only the canonical /search/page.tsx survives.
        const offenders = matches.filter((p) => !p.endsWith(resolve(WEB_ROOT, "app/(app)/search/page.tsx")) && !p.endsWith("app\\(app)\\search\\page.tsx") &&
            !p.endsWith("app/(app)/search/page.tsx"));
        expect(offenders, offenders.join("\n")).toEqual([]);
        // And the canonical file exists.
        expect(existsSync(SEARCH_PAGE_SRC)).toBe(true);
    });
    it("17. NO /semantic-search route — apps/web/app/(app)/**/semantic* returns empty", () => {
        const appDir = resolve(WEB_ROOT, "app");
        const offenders = walk(appDir, (name) => /^semantic/i.test(name) || /semantic-search/i.test(name));
        expect(offenders, offenders.join("\n")).toEqual([]);
    });
    it("18. NO new top-level /v1 semantic endpoint — no services/api/src/routes/semantic*.ts", () => {
        const offenders = readdirSync(API_ROUTES_DIR).filter((f) => /^semantic/i.test(f) && (f.endsWith(".ts") || f.endsWith(".tsx")));
        expect(offenders, offenders.join("\n")).toEqual([]);
        // And the canonical /v1/search route file is the one that gained
        // the new semantic admin endpoints.
        const searchRoutes = readUtf8(SEARCH_ROUTES_SRC);
        expect(searchRoutes).toMatch(/\/v1\/search\/semantic\/(backfill|status)/);
    });
    it("19. Phase 16 migration exists at 20270801000000_phase16_semantic_usage AND is allowlisted in 32.7.2 test", () => {
        // The migration file is present.
        expect(existsSync(PHASE_16_MIGRATION_SQL)).toBe(true);
        const migration = readUtf8(PHASE_16_MIGRATION_SQL);
        // Phase O additive pattern — must contain a DO $$ block and a
        // terminating semicolon, and reference the new table.
        expect(migration).toMatch(/DO\s+\$\$/);
        expect(migration).toMatch(/semantic_usage_daily/);
        // The cross-cutting migration-allowlist test must reference the
        // new migration name so the Phase O additive gate stays green.
        const allowlistTest = readUtf8(PHASE_32_7_2_TEST_SRC);
        expect(allowlistTest).toMatch(/["']20270801000000_phase16_semantic_usage["']/);
    });
    it("20. Policy doc updated — phase-15-semantic-policy.md size exceeds the conservative Phase-16 baseline", () => {
        expect(existsSync(PHASE_15_POLICY_DOC)).toBe(true);
        const body = readUtf8(PHASE_15_POLICY_DOC);
        // The Phase 15 original was ~5.5 KB. After the Phase 16 rewrite
        // the doc grew past 18 KB (audit: 18,294 bytes). We pin a
        // conservative floor (baseline minus 500 bytes) so:
        //   - any honest re-edit that nets >= -500 bytes still passes,
        //   - a regression that strips out a whole Phase 16 section
        //     (e.g. §0 Activation, §14 Backfill, §16 Debt) trips this.
        const POLICY_DOC_FLOOR_BYTES = 18_294 - 500;
        expect(body.length, `policy doc shrunk below Phase 16 floor: ${body.length} < ${POLICY_DOC_FLOOR_BYTES}`).toBeGreaterThan(POLICY_DOC_FLOOR_BYTES);
        // And the doc must mention the new Phase 16 surface — the
        // dedicated mi-embed queue and the workspace-day budget table —
        // so a future weakening that strips the activation context fails.
        expect(body).toMatch(/mi-embed/i);
        expect(body).toMatch(/semantic_usage_daily|budget|backfill/i);
    });
});
// Reference unused helpers to keep tree-shaking honest.
void SEMANTIC_BUDGET_SRC;
void MI_EMBED_QUEUE_SRC;
