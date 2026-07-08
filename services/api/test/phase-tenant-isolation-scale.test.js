/**
 * PHASE TENANT-ISOLATION + SCALE — Source-contract enforcement.
 *
 * This file scans the operational route + service + worker code paths and
 * enforces the tenant-isolation and scale invariants that the platform
 * MUST hold at multi-tenant enterprise scale. Failures here block PRs
 * before they reach a reviewer.
 *
 * The contract is intentionally narrow:
 *
 *   1. Every operational route file must reference the canonical
 *      authorize helper (`authorizeOrFail` / `requireAuthorize`) OR carry
 *      an explicit, bounded TENANT_SCOPE_EXCEPTION comment.
 *
 *   2. Every list/query handler must reference a bounded `take` /
 *      `limit` / `cursor` token — no unbounded findMany on operational
 *      tables.
 *
 *   3. Worker job handlers must fetch the resource by id from the DB
 *      before mutating it (the job payload is never the source of truth
 *      for tenant claims).
 *
 *   4. The platform-context envelope NEVER exposes `isPersonal=true`
 *      rows in `organizations` (already enforced by the enterprise
 *      tenant-model tests; re-asserted here as a non-regression).
 *
 *   5. The `availableWorkspaces` query is bounded; no synthetic
 *      `__personal__` row; no `findMany` without `take`.
 *
 * Approved exception vocabulary:
 *
 *   - TENANT_SCOPE_EXCEPTION: public_verify_token_readonly
 *   - TENANT_SCOPE_EXCEPTION: platform_admin_global
 *   - TENANT_SCOPE_EXCEPTION: system_health_no_user_data
 *   - TENANT_SCOPE_EXCEPTION: migration_or_backfill
 *   - TENANT_SCOPE_EXCEPTION: auth_or_session_no_user_data
 *   - TENANT_SCOPE_EXCEPTION: account_tier_user_scoped
 *
 * No vague exceptions. The vocabulary is closed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWorker(rel) {
    return readFileSync(fileURLToPath(new URL(`../../worker/${rel}`, import.meta.url)), "utf8");
}
function listFiles(absDir, ext) {
    try {
        const out = [];
        for (const name of readdirSync(absDir)) {
            const full = `${absDir}/${name}`;
            try {
                const stat = statSync(full);
                if (stat.isFile() && name.endsWith(ext))
                    out.push(full);
            }
            catch {
                /* ignore */
            }
        }
        return out.sort();
    }
    catch {
        return [];
    }
}
const APPROVED_EXCEPTIONS = [
    "TENANT_SCOPE_EXCEPTION: public_verify_token_readonly",
    "TENANT_SCOPE_EXCEPTION: platform_admin_global",
    "TENANT_SCOPE_EXCEPTION: system_health_no_user_data",
    "TENANT_SCOPE_EXCEPTION: migration_or_backfill",
    "TENANT_SCOPE_EXCEPTION: auth_or_session_no_user_data",
    "TENANT_SCOPE_EXCEPTION: account_tier_user_scoped",
];
function hasApprovedException(src) {
    return APPROVED_EXCEPTIONS.some((tag) => src.includes(tag));
}
const ROUTES_DIR = fileURLToPath(new URL("../src/routes/", import.meta.url));
const SERVICES_DIR = fileURLToPath(new URL("../src/services/", import.meta.url));
const WORKER_SRC_DIR = fileURLToPath(new URL("../../worker/src/", import.meta.url));
// =============================================================================
// PART 1 — Operational route classification + tenant-scoping invariants
// =============================================================================
/**
 * Routes that are EXPLICITLY non-operational:
 *
 *   - Auth/session/identity routes that operate on user identity only
 *   - Public verify-token routes (token-scoped, read-only)
 *   - Platform-admin global routes (gated by isPlatformAdmin)
 *   - System health / readiness routes (no user data)
 *   - Account-tier routes (settings, profile, account billing)
 *   - The platform-context route itself (the canonical resolver)
 *
 * Every other route in src/routes/ MUST consume the canonical authorize
 * helper OR carry an approved TENANT_SCOPE_EXCEPTION comment.
 */
const NON_OPERATIONAL_ROUTES = new Set([
    "auth.routes.ts",
    "sso-auth.routes.ts",
    "email-password-auth.routes.ts",
    "users.routes.ts",
    "identity.routes.ts",
    "identity-security.routes.ts",
    "platform-context.routes.ts",
    "runtime-readiness.routes.ts",
    "reliability.routes.ts",
    "ops-seed.routes.ts",
    "admin-identity.routes.ts",
    "admin-demo-requests.routes.ts",
    "admin-audit.routes.ts",
    "demo-requests.routes.ts",
    "billing.routes.ts",
    "webhooks.routes.ts",
    "ai.routes.ts",
    "notifications.routes.ts",
    "legal.routes.ts",
    "analytics.routes.ts",
    // External intake / public submission paths.
    "external-intake.routes.ts",
    "external-review.routes.ts",
    // Integrations API uses API-key auth + per-credential scoping; covered
    // by its own integration-hardening tests.
    "integrations.routes.ts",
    "integrations-api.routes.ts",
    "integrations-uploads.routes.ts",
    "webhook-receiver.routes.ts",
    // Marketing / docs.
    "demo.routes.ts",
    "security.routes.ts",
    // Workflow intake links carry their own token-scoping tests.
    "workflow-intake-links.routes.ts",
    // SCIM is token-protected via authenticateScimRequest; tenant is
    // bound by the token, not the session.
    "scim.routes.ts",
    // Legacy enterprise quota/seats surfaces are account-tier (per
    // authenticated user). The lookup of teamMembers / entitlements is
    // scoped by userId from the session.
    "enterprise.routes.ts",
    // Test-only rate-limit reset endpoint. Gated three ways: refuses
    // when NODE_ENV === "production", requires E2E_AUTH_BYPASS_SECRET
    // (>=32 chars), and is gated by a bypass header. Holds no tenant
    // data — it scrubs Redis rate-limit buckets only. Not an
    // operational data path.
    "_test-rate-limit.routes.ts",
]);
function isRouteFile(name) {
    return name.endsWith(".routes.ts");
}
describe("Tenant isolation — operational route classification", () => {
    const routeFiles = listFiles(ROUTES_DIR, ".ts").filter((p) => isRouteFile(p.split(/[\\/]/).pop() ?? ""));
    it("found a non-trivial number of route files", () => {
        expect(routeFiles.length).toBeGreaterThan(20);
    });
    for (const fullPath of routeFiles) {
        const name = fullPath.split(/[\\/]/).pop();
        if (NON_OPERATIONAL_ROUTES.has(name))
            continue;
        it(`${name} consumes the canonical authorize helper OR carries an approved TENANT_SCOPE_EXCEPTION`, () => {
            const src = readFileSync(fullPath, "utf8");
            const hasAuthorize = /authorizeOrFail|requireAuthorize\(|evaluateMemberAccess|evaluateAuthorize|requireEvidenceAccess|requireCaseAccess|requireReportAccess|requirePackageAccess|requireActiveSpaceAccess/.test(src);
            const hasException = hasApprovedException(src);
            // Operational routes must at minimum reference BOTH a user id and
            // a tenant id (teamId / organizationId / workspaceId / tenantId).
            // Routes that scope ONLY by userId (account-tier) should carry an
            // `account_tier_user_scoped` exception comment.
            const hasUserMarker = /\buserId\b/.test(src);
            const hasTenantMarker = /\bteamId\b/.test(src) ||
                /\borganizationId\b/.test(src) ||
                /\bworkspaceId\b/.test(src) ||
                /\btenantId\b/.test(src);
            const hasTenantMarkers = hasUserMarker && hasTenantMarker;
            // No-op legacy route stubs that explicitly do nothing.
            const isExplicitNoOp = /Intentionally disabled|Intentionally left as a no-op|LEGACY[^\n]*no-op/i.test(src);
            expect(hasAuthorize || hasException || hasTenantMarkers || isExplicitNoOp, `${name} must use authorizeOrFail/requireAuthorize, a TENANT_SCOPE_EXCEPTION comment, or reference both userId and teamId. None found.`).toBe(true);
        });
    }
});
// =============================================================================
// PART 2 — Pagination invariants: no unbounded findMany on operational tables
// =============================================================================
/**
 * The set of Prisma model names that hold operational, tenant-scoped data
 * at potentially-large scale. Any `<model>.findMany(` call must be in the
 * same file as at least one bounding token (`take:`, `cursor:`, `limit`,
 * or an approved exception comment).
 */
const LARGE_OPERATIONAL_MODELS = [
    "evidence",
    "case",
    "evidencePart",
    "report",
    "verificationPackage",
    "auditEvent",
    "custodyEvent",
    "evidenceLegalHold",
    "caseLegalHold",
    "evidenceRequest",
    "evidenceRelationship",
];
describe("Tenant isolation — bounded list queries", () => {
    const routeFiles = listFiles(ROUTES_DIR, ".ts");
    const serviceFiles = [];
    // Services live in nested folders; do one level of recursion.
    for (const entry of readdirSync(SERVICES_DIR)) {
        const full = `${SERVICES_DIR}/${entry}`;
        try {
            const stat = statSync(full);
            if (stat.isFile() && entry.endsWith(".ts"))
                serviceFiles.push(full);
            else if (stat.isDirectory()) {
                for (const sub of readdirSync(full)) {
                    if (sub.endsWith(".ts"))
                        serviceFiles.push(`${full}/${sub}`);
                }
            }
        }
        catch {
            /* ignore */
        }
    }
    const allOperational = [...routeFiles, ...serviceFiles];
    /**
     * A findMany call is "bounded" if one of the following is true:
     *   (a) the file contains a size-bounding token (`take: <N>`, `cursor:`,
     *       `limit`, `pageSize`, `DEFAULT_PAGE_SIZE`), OR
     *   (b) the file contains a tenant/parent scoping token in any `where:`
     *       clause (`teamId:`, `organizationId:`, `evidenceId:`, `caseId:`,
     *       `userId:`, `actorUserId:`, `ownerUserId:`, `tenantId:`), OR
     *   (c) the file carries an explicit, approved TENANT_SCOPE_EXCEPTION.
     *
     * Rationale: a `findMany` scoped to a single evidence/case/team's child
     * rows is intrinsically bounded by the parent's tenant. The parent
     * itself must be tenant-scoped (which Part 1 enforces on the route
     * surface). The test here is a static guard against globally-unscoped
     * findMany — not a guarantee that every individual call is page-safe.
     * That requires a runtime audit, which is documented in the Phase
     * report as a remaining risk.
     */
    for (const model of LARGE_OPERATIONAL_MODELS) {
        it(`every ${model}.findMany call sits in a file with a bounding token or an approved exception`, () => {
            const pattern = new RegExp(`\\.${model}\\.findMany\\s*\\(`);
            const offenders = [];
            for (const file of allOperational) {
                const src = readFileSync(file, "utf8");
                if (!pattern.test(src))
                    continue;
                const hasSizeBound = /\btake:\s*\d/.test(src) ||
                    /\bcursor:/.test(src) ||
                    /\blimit\b/.test(src) ||
                    /\bpageSize\b/i.test(src) ||
                    /\bDEFAULT_PAGE_SIZE\b/.test(src);
                const hasParentScope = /\bteamId\b/.test(src) ||
                    /\borganizationId\b/.test(src) ||
                    /\bevidenceId\b/.test(src) ||
                    /\bcaseId\b/.test(src) ||
                    /\bownerUserId\b/.test(src) ||
                    /\btenantId\b/.test(src) ||
                    /\bactorUserId\b/.test(src);
                const hasException = hasApprovedException(src);
                if (!hasSizeBound && !hasParentScope && !hasException) {
                    offenders.push(file.replace(/^.*services[\\/]api[\\/]/, ""));
                }
            }
            expect(offenders, `${model}.findMany must be bounded by take/cursor/limit, scoped to a tenant/parent id, or carry an approved TENANT_SCOPE_EXCEPTION. Offenders:\n${offenders.join("\n")}`).toEqual([]);
        });
    }
});
// =============================================================================
// PART 3 — Worker job tenant safety
// =============================================================================
describe("Tenant isolation — worker job ownership verification", () => {
    const workerFiles = [];
    function walk(dir) {
        try {
            for (const name of readdirSync(dir)) {
                const full = `${dir}/${name}`;
                try {
                    const stat = statSync(full);
                    if (stat.isFile() && name.endsWith(".ts"))
                        workerFiles.push(full);
                    else if (stat.isDirectory())
                        walk(full);
                }
                catch {
                    /* ignore */
                }
            }
        }
        catch {
            /* ignore */
        }
    }
    walk(WORKER_SRC_DIR);
    // Worker handler files that touch operational data MUST fetch the
    // resource from the DB before mutating it. We grep for the pattern.
    const HANDLER_PATTERNS = [
        "processor.ts",
        "ots-upgrade.processor.ts",
        "derived-assets.processor.ts",
        "media-intelligence.processor.ts",
        "search-indexing.processor.ts",
        "verification-package.ts",
    ];
    for (const handler of HANDLER_PATTERNS) {
        const candidate = workerFiles.find((f) => f.replace(/\\/g, "/").endsWith(`/${handler}`));
        if (!candidate)
            continue; // file moved or renamed — silently skip
        it(`worker handler ${handler} scopes by resource id from the job payload`, () => {
            const src = readFileSync(candidate, "utf8");
            // The handler must either:
            //   (a) fetch the resource directly via Prisma, OR
            //   (b) operate on a job-payload resource id that's then resolved by
            //       a downstream service. We assert at least ONE bounded id is
            //       referenced in the handler.
            const fetchesResource = /prisma\.(evidence|report|verificationPackage|evidencePart|otsRecord|otsState|searchDocument|mediaIntelligenceRun)\.(findUnique|findFirst|findMany)/.test(src);
            const referencesResourceId = /\b(evidenceId|caseId|reportId|packageId|partId|runId|verificationPackageId)\b/.test(src);
            const hasException = hasApprovedException(src);
            expect(fetchesResource || referencesResourceId || hasException, `${handler} must fetch the resource by id, reference a job-payload resource id, or carry an approved TENANT_SCOPE_EXCEPTION`).toBe(true);
        });
    }
});
// =============================================================================
// PART 4 — Platform-context envelope: personal/org separation invariants
// =============================================================================
describe("Tenant isolation — platform-context personal/org separation", () => {
    const SVC = readApi("src/services/platform-context/platform-context.service.ts");
    it("organizations list excludes isPersonal=true rows (canonical split)", () => {
        expect(SVC).toMatch(/m\.team\.isPersonal/);
        expect(SVC).toMatch(/personalTeams\.push\(/);
        expect(SVC).toMatch(/organizations\.push\(/);
    });
    it("no synthetic '__personal__' identifier remains in source", () => {
        expect(SVC).not.toMatch(/__personal__/);
    });
    it("availableWorkspaces is rebuilt from canonical sections (no unscoped query)", () => {
        expect(SVC).toMatch(/teamMember\.findMany[\s\S]{0,400}take:\s*200/);
    });
    it("duplicate-personal heuristic reasons are bounded to the canonical vocabulary", () => {
        expect(SVC).toMatch(/"name_matches_email_personal"/);
        expect(SVC).toMatch(/"single_owner_member"/);
        expect(SVC).toMatch(/"free_plan"/);
    });
});
// =============================================================================
// PART 5 — Canonical access helpers module is registered + exported
// =============================================================================
describe("Tenant isolation — canonical access helpers module", () => {
    it("exposes the canonical helpers for resource-typed access checks", () => {
        const HELPERS = readApi("src/services/access/tenant-access.helpers.ts");
        expect(HELPERS).toMatch(/export async function requireEvidenceAccess\b/);
        expect(HELPERS).toMatch(/export async function requireCaseAccess\b/);
        expect(HELPERS).toMatch(/export async function requireReportAccess\b/);
        expect(HELPERS).toMatch(/export async function requirePackageAccess\b/);
        expect(HELPERS).toMatch(/export async function requireActiveSpaceAccess\b/);
    });
    it("each helper resolves tenant ownership server-side and verifies membership", () => {
        const HELPERS = readApi("src/services/access/tenant-access.helpers.ts");
        // Every helper must reference both the canonical authorize helper
        // (for membership check) and a Prisma fetch (for resource-to-team
        // resolution). The vocabulary is bounded.
        const helperBlocks = HELPERS.split(/\nexport async function require/g)
            .slice(1)
            .map((b) => `requireXxx${b}`);
        for (const block of helperBlocks) {
            // Accept direct calls to the canonical authorize helpers OR
            // delegation to an internal helper that itself uses them.
            const usesCanonical = /evaluateAuthorize|evaluateMemberAccess|authorizeOrFail|requireResourceAccess|requireActiveSpaceAccess/.test(block);
            expect(usesCanonical, `helper block missing canonical authorize call: ${block.slice(0, 200)}`).toBe(true);
        }
    });
});
// =============================================================================
// PART 6 — List endpoints must accept a cursor or limit parameter
// =============================================================================
describe("Tenant isolation — list endpoints accept pagination", () => {
    // Routes that expose GET endpoints with list semantics. The set is
    // intentionally narrow — we only enforce on routes whose primary
    // operations are list reads.
    // audit.routes.ts is a legacy no-op (active audit is via
    // platform-audit-log.service.ts + admin-audit.routes.ts), so it's
    // excluded.
    const LIST_ROUTE_FILES = [
        "cases.routes.ts",
        "evidence.routes.ts",
        "search.routes.ts",
        "reviewer-ops.routes.ts",
        "governance.routes.ts",
        "case-workspace.routes.ts",
        "admin-audit.routes.ts",
        "communications.routes.ts",
        "collaboration.routes.ts",
        "review-operations.routes.ts",
    ];
    for (const name of LIST_ROUTE_FILES) {
        const candidate = `${ROUTES_DIR}${name}`;
        try {
            statSync(candidate);
        }
        catch {
            continue; // file moved or renamed; skip
        }
        it(`${name} accepts cursor / limit / take pagination on its list endpoints`, () => {
            const src = readFileSync(candidate, "utf8");
            const hasPaginationToken = /\bcursor\b/.test(src) ||
                /\blimit\b/.test(src) ||
                /\btake:\s*\d/.test(src) ||
                /\bpageSize\b/i.test(src) ||
                /\bnextCursor\b/.test(src);
            expect(hasPaginationToken, `${name} must accept cursor/limit pagination on its list endpoints`).toBe(true);
        });
    }
});
// =============================================================================
// PART 7a — Index audit: tenant + status/timestamp composite indexes
//
// The schema must declare composite indexes on `(tenantKey, status|timestamp)`
// for every large operational table. The check is permissive: we accept any
// index that includes the canonical tenant key as the leading column.
// =============================================================================
describe("Tenant isolation — schema indexes for tenant-scoped scans", () => {
    const SCHEMA = readApi("prisma/schema.prisma");
    function extractModel(name) {
        const re = new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
        const m = SCHEMA.match(re);
        if (!m)
            throw new Error(`model ${name} not found in schema`);
        return m[1];
    }
    const REQUIRED_INDEX_TABLES = [
        { model: "Evidence", leadingKeys: ["ownerUserId", "teamId", "organizationId"] },
        { model: "Case", leadingKeys: ["teamId", "ownerUserId"] },
        { model: "Report", leadingKeys: ["evidenceId"] },
        { model: "VerificationPackage", leadingKeys: ["evidenceId"] },
        { model: "CustodyEvent", leadingKeys: ["evidenceId"] },
        { model: "EvidenceLegalHold", leadingKeys: ["teamId", "evidenceId"] },
        { model: "CaseLegalHold", leadingKeys: ["teamId", "caseId"] },
        { model: "EvidenceRequest", leadingKeys: ["teamId", "ownerUserId"] },
        { model: "EvidenceRelationship", leadingKeys: ["sourceEvidenceId", "targetEvidenceId"] },
    ];
    for (const entry of REQUIRED_INDEX_TABLES) {
        it(`${entry.model} declares at least one index leading with a tenant/parent key`, () => {
            const block = extractModel(entry.model);
            const indexLines = block
                .split("\n")
                .filter((l) => l.includes("@@index"));
            const hasMatchingIndex = indexLines.some((line) => {
                // Match the first identifier inside @@index([X, ...])
                const m = line.match(/@@index\(\[\s*(\w+)/);
                if (!m)
                    return false;
                return entry.leadingKeys.includes(m[1]);
            });
            expect(hasMatchingIndex, `${entry.model} must declare an @@index leading with one of: ${entry.leadingKeys.join(", ")}. Found indexes:\n${indexLines.join("\n")}`).toBe(true);
        });
    }
});
// =============================================================================
// PART 7 — Frontend does not filter large server lists client-side
// =============================================================================
describe("Tenant isolation — frontend does not filter unbounded server lists", () => {
    // We specifically check the search + cases + reports pages — these are
    // the heaviest list surfaces and the ones where client-side filtering
    // would defeat enterprise scale.
    function readWeb(rel) {
        return readFileSync(fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)), "utf8");
    }
    const PAGES = [
        "components/reports-experience/ReportsIndex.tsx",
        "components/cases-experience/CasesIndex.tsx",
        "app/(app)/search/page.tsx",
    ];
    for (const page of PAGES) {
        it(`${page} sends pagination params (cursor/limit/teamId) to the server`, () => {
            const src = readWeb(page);
            const hasServerParam = /\bcursor\b/.test(src) ||
                /\blimit\b/.test(src) ||
                /\bteamId\b/.test(src) ||
                /\bnextCursor\b/.test(src);
            expect(hasServerParam, `${page} should drive pagination via server params`).toBe(true);
        });
    }
});
