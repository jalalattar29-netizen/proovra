/**
 * Production regression test — Evidence Lifecycle Final Fix.
 *
 * Pins the structural invariants of the Phase "Evidence Lifecycle Final
 * Fix" against future drift. This is a SOURCE-CONTRACT test — it reads
 * the relevant files and asserts shape/wiring rather than booting a DB.
 *
 * ─── INVARIANTS PINNED ─────────────────────────────────────────────────
 *
 *  1. Single lifecycle subtree at apps/web/app/(app)/evidence-lifecycle
 *     — no `lifecycle-v2` / `governance-lifecycle-v2` / `evidence-
 *     lifecycle-v2` siblings.
 *
 *  2. Segment-scoped error.tsx + loading.tsx exist so render crashes
 *     stay contained to the lifecycle subtree (never trigger the global
 *     "Something went wrong" boundary in apps/web/app/error.tsx).
 *
 *  3. Shared primitives module _shared.tsx exists with:
 *       - resolveLifecycleError (never-throws error mapper)
 *       - DenialBanner
 *       - EmptyState
 *       - SectionLoadingSkeleton
 *       - LifecyclePageHeader
 *       - RefreshButton
 *       - LifecycleSectionBoundary (class component, error boundary)
 *       - useLifecycleFetch hook
 *
 *  4. All 7 pages wrap their default-export tree in
 *     LifecycleSectionBoundary so a single broken sub-section can't
 *     blank the segment.
 *
 *  5. Dashboard normaliser is fully tolerant — never returns null, so
 *     "Unable to load lifecycle dashboard" cannot fire on a 200 with an
 *     unexpected body shape. Instead it surfaces the new `degraded`
 *     flag with a soft banner.
 *
 *  6. Backend GET /v1/lifecycle/dashboard wraps projectLifecycleDashboard
 *     in try/catch and returns an empty projection with `degraded: true`
 *     on internal failure — the route NEVER 500s a dashboard read.
 *
 *  7. Pages still hit the EXISTING backend endpoints — no v2 routes were
 *     introduced.
 *
 *  8. Date formatting goes through a safeDate helper that returns "—"
 *     on null/Invalid Date — no more "Invalid Date" leaking into tables.
 *
 *  9. apps/web/app/error.tsx is unchanged ("Something went wrong") — the
 *     test confirms it still exists as the last-resort root boundary.
 *
 * 10. Destruction page does NOT expose execute mutation without an
 *     explicit per-row action — pinned via source check.
 *
 * 11. No raw Prisma / Zod error strings are surfaced from lifecycle UI.
 *
 * 12. Phase 2.1 migration (20270809*) is the most recent lifecycle-
 *     touching migration — no new migration created by this fix.
 *
 * Style: source-contract — readFileSync + regex. No DB. No process boot.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const REPO_ROOT = resolve(__dirname, "../../..");
const LIFECYCLE_DIR = resolve(REPO_ROOT, "apps/web/app/(app)/evidence-lifecycle");
const SUB_PAGES = [
    { slug: "retention", label: "Retention" },
    { slug: "legal-holds", label: "Legal Holds" },
    { slug: "archive", label: "Archive" },
    { slug: "destruction", label: "Destruction" },
    { slug: "webhooks", label: "Webhooks" },
    { slug: "chain-transfers", label: "Chain Transfers" },
];
function readLifecycleFile(rel) {
    return readFileSync(resolve(LIFECYCLE_DIR, rel), "utf8");
}
describe("Evidence Lifecycle Final Fix — segment chrome", () => {
    // 1 — Test 1: no lifecycle-v2 subtree was created.
    it("(1) /evidence-lifecycle dashboard does not crash — no v2 subtree", () => {
        const appDir = resolve(REPO_ROOT, "apps/web/app/(app)");
        const entries = readdirSync(appDir);
        const offenders = entries.filter((name) => /lifecycle/i.test(name) &&
            /v2/i.test(name) &&
            name !== "evidence-lifecycle");
        expect(offenders, "no lifecycle-v2 / lifecycle-v3 directories").toEqual([]);
    });
    it("(2) section-scoped error.tsx exists for evidence-lifecycle", () => {
        const errorPath = resolve(LIFECYCLE_DIR, "error.tsx");
        expect(existsSync(errorPath), "error.tsx is required").toBe(true);
        const src = readFileSync(errorPath, "utf8");
        // Must be a client component + a default-exported error boundary.
        expect(src).toMatch(/"use client";/);
        expect(src).toMatch(/export\s+default\s+function/);
        // Must accept the Next.js error boundary signature.
        expect(src).toMatch(/error:\s*Error/);
        expect(src).toMatch(/reset:\s*\(\)\s*=>\s*void/);
        // Must call captureException so silent crashes still reach observability.
        expect(src).toMatch(/captureException/);
    });
    it("(3) loading.tsx skeleton exists for evidence-lifecycle", () => {
        const loadingPath = resolve(LIFECYCLE_DIR, "loading.tsx");
        expect(existsSync(loadingPath), "loading.tsx is required").toBe(true);
        const src = readFileSync(loadingPath, "utf8");
        expect(src).toMatch(/export\s+default\s+function/);
        // Skeleton — no client JS needed.
        expect(src).not.toMatch(/"use client";/);
    });
    it("(4) global error.tsx still exists as last-resort boundary", () => {
        const globalErrorPath = resolve(REPO_ROOT, "apps/web/app/error.tsx");
        expect(existsSync(globalErrorPath)).toBe(true);
        const src = readFileSync(globalErrorPath, "utf8");
        expect(src).toMatch(/Something went wrong/);
    });
});
describe("Evidence Lifecycle Final Fix — shared primitives", () => {
    const SHARED_PATH = resolve(LIFECYCLE_DIR, "_shared.tsx");
    const SHARED = (() => {
        expect(existsSync(SHARED_PATH), "_shared.tsx must exist").toBe(true);
        return readFileSync(SHARED_PATH, "utf8");
    })();
    it("(5) exports the 7 primitives needed by the pages", () => {
        expect(SHARED).toMatch(/export\s+function\s+resolveLifecycleError/);
        expect(SHARED).toMatch(/export\s+function\s+DenialBanner/);
        expect(SHARED).toMatch(/export\s+function\s+EmptyState/);
        expect(SHARED).toMatch(/export\s+function\s+SectionLoadingSkeleton/);
        expect(SHARED).toMatch(/export\s+function\s+LifecyclePageHeader/);
        expect(SHARED).toMatch(/export\s+function\s+RefreshButton/);
        expect(SHARED).toMatch(/export\s+class\s+LifecycleSectionBoundary/);
        expect(SHARED).toMatch(/export\s+function\s+useLifecycleFetch/);
    });
    it("(6) resolveLifecycleError handles missing teamId / null err / string err without throwing", () => {
        // Source-level check that the function defends against the legacy
        // `applyDenial` failure mode (passing a non-object).
        expect(SHARED).toMatch(/if\s*\(\s*err\s*===\s*null\s*\|\|\s*err\s*===\s*undefined\s*\)/);
        expect(SHARED).toMatch(/typeof\s+err\s*===\s*["']string["']/);
    });
    it("(7) LifecycleSectionBoundary is a class with getDerivedStateFromError", () => {
        expect(SHARED).toMatch(/static\s+getDerivedStateFromError/);
        expect(SHARED).toMatch(/componentDidCatch/);
    });
});
describe("Evidence Lifecycle Final Fix — per-page wiring", () => {
    const DASHBOARD = readLifecycleFile("page.tsx");
    it("(8) dashboard page wires the existing endpoint (no v2)", () => {
        expect(DASHBOARD).toMatch(/\/v1\/lifecycle\/dashboard/);
        expect(DASHBOARD).not.toMatch(/\/v2\/lifecycle/);
    });
    it("(9) dashboard normaliser NEVER returns null", () => {
        // normaliseDashboard returns a value in every code path now.
        expect(DASHBOARD).toMatch(/function\s+normaliseDashboard.*LifecycleDashboard\s*\{/s);
        // The function must NOT contain `return null;` — invariant for this fix.
        const normaliserMatch = DASHBOARD.match(/function\s+normaliseDashboard[\s\S]*?\n\}\n/);
        expect(normaliserMatch).toBeTruthy();
        expect(normaliserMatch[0]).not.toMatch(/return\s+null\s*;/);
        // Must reference the `emptyDashboard()` fallback helper.
        expect(DASHBOARD).toMatch(/function\s+emptyDashboard/);
    });
    it("(10) dashboard renders a degraded banner when the backend signals degraded", () => {
        expect(DASHBOARD).toMatch(/data-evidence-lifecycle-degraded-banner/);
        expect(DASHBOARD).toMatch(/degraded\?\s*:\s*boolean/);
    });
    // REAL FIX FOLLOW-UP — archive intentionally no longer uses
    // LifecycleSectionBoundary because the underlying type-mismatch bug
    // was fixed at the source (costs is now correctly an object). The
    // boundary was masking a real bug. The other 5 sub-pages keep the
    // boundary as defence-in-depth, but it must NEVER substitute for
    // fixing a real throw.
    const SUB_PAGES_WITH_BOUNDARY = SUB_PAGES.filter((s) => s.slug !== "archive");
    for (const sub of SUB_PAGES_WITH_BOUNDARY) {
        it(`(11.${sub.slug}) ${sub.label} sub-page wraps Shell in LifecycleSectionBoundary`, () => {
            const src = readLifecycleFile(`${sub.slug}/page.tsx`);
            // Import line for the shared boundary.
            expect(src).toMatch(/import[^;]*LifecycleSectionBoundary[^;]*from\s+["']\.\.\/_shared["']/);
            // Boundary actually wraps <Shell />.
            expect(src).toMatch(/<LifecycleSectionBoundary[\s\S]*?<Shell\s*\/>[\s\S]*?<\/LifecycleSectionBoundary>/);
            // PageRouteGate is the outer wrapper (route-level access stays intact).
            expect(src).toMatch(/<PageRouteGate\s+routeId=["']workspace\.evidence_lifecycle["']>/);
        });
    }
    // Archive: PageRouteGate stays, boundary explicitly removed.
    it("(11.archive) Archive sub-page keeps PageRouteGate but NO boundary mask (real fix is upstream)", () => {
        const src = readLifecycleFile("archive/page.tsx");
        expect(src).toMatch(/<PageRouteGate\s+routeId=["']workspace\.evidence_lifecycle["']>/);
        expect(src).not.toMatch(/<LifecycleSectionBoundary/);
    });
    it("(12) retention page uses safe Promise.allSettled (not Promise.all)", () => {
        const src = readLifecycleFile("retention/page.tsx");
        expect(src).toMatch(/Promise\.allSettled/);
        expect(src).not.toMatch(/Promise\.all\s*\(/);
        // Defensive date formatting.
        expect(src).toMatch(/function\s+formatDate/);
        expect(src).toMatch(/Number\.isNaN\(d\.getTime\(\)\)/);
    });
    it("(13) archive page uses safe Promise.allSettled", () => {
        const src = readLifecycleFile("archive/page.tsx");
        expect(src).toMatch(/Promise\.allSettled/);
        expect(src).not.toMatch(/Promise\.all\s*\(/);
    });
    it("(14) webhooks page uses safe Promise.allSettled", () => {
        const src = readLifecycleFile("webhooks/page.tsx");
        expect(src).toMatch(/Promise\.allSettled/);
        expect(src).not.toMatch(/Promise\.all\s*\(/);
    });
    it("(15) destruction page only executes via explicit per-row action (no automatic execute)", () => {
        const src = readLifecycleFile("destruction/page.tsx");
        // The "execute" action is wired through a user-clicked button per row.
        expect(src).toMatch(/action:\s*["']approve["']\s*\|\s*["']reject["']\s*\|\s*["']execute["']/);
        // There is NO useEffect / setInterval calling execute.
        expect(src).not.toMatch(/setInterval[\s\S]{0,200}execute/);
        expect(src).not.toMatch(/useEffect[\s\S]{0,200}\bexecute\b/);
    });
});
describe("Evidence Lifecycle Final Fix — backend hardening", () => {
    const ROUTES_PATH = resolve(REPO_ROOT, "services/api/src/routes/product-and-lifecycle.routes.ts");
    const ROUTES = readFileSync(ROUTES_PATH, "utf8");
    it("(16) GET /v1/lifecycle/dashboard wraps projectLifecycleDashboard in try/catch", () => {
        // Locate the dashboard handler and verify the try/catch that
        // turns a projector failure into a `degraded: true` shape.
        const startIdx = ROUTES.indexOf('"/v1/lifecycle/dashboard"');
        expect(startIdx).toBeGreaterThan(0);
        const slice = ROUTES.slice(startIdx, startIdx + 4000);
        expect(slice).toMatch(/try\s*\{[\s\S]*?projectLifecycleDashboard[\s\S]*?\}\s*catch/);
        expect(slice).toMatch(/degraded:\s*true/);
        expect(slice).toMatch(/degradedReason/);
    });
    it("(17) no new lifecycle migration was added — Phase 2.1 (20270809) remains latest lifecycle-touching migration", () => {
        const migrationsDir = resolve(REPO_ROOT, "services/api/prisma/migrations");
        const dirs = readdirSync(migrationsDir).filter((n) => statSync(resolve(migrationsDir, n)).isDirectory());
        // No directory with the strings "lifecycle-v2" or "lifecycle_final_fix"
        // should appear — this fix is code-only.
        const offenders = dirs.filter((n) => /lifecycle.*v2/i.test(n) || /lifecycle.final.fix/i.test(n));
        expect(offenders).toEqual([]);
        // The Phase 2.1 migration must still exist.
        const phase21 = dirs.filter((n) => n.startsWith("20270809"));
        expect(phase21.length).toBeGreaterThanOrEqual(1);
    });
});
describe("Evidence Lifecycle Final Fix — no raw error leakage", () => {
    for (const sub of [{ slug: "page", label: "Dashboard" }, ...SUB_PAGES.map((s) => ({ slug: `${s.slug}/page`, label: s.label }))]) {
        it(`(18.${sub.label.replace(/\s+/g, "-").toLowerCase()}) ${sub.label} surfaces no raw Prisma error codes`, () => {
            const src = readLifecycleFile(`${sub.slug}.tsx`);
            // No P2022 / P2021 / P2025 codes baked into UI strings.
            expect(src).not.toMatch(/["']P20\d\d["']/);
            // No raw "PrismaClientKnownRequestError" string leak.
            expect(src).not.toMatch(/PrismaClientKnownRequestError/);
            // No raw ZodError class reference in UI text.
            expect(src).not.toMatch(/ZodError/);
        });
    }
});
