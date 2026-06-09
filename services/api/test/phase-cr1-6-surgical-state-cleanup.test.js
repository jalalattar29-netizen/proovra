/**
 * PHASE CR1.6 — Surgical state cleanup contract tests.
 *
 * Pins the cleanups landed by CR1.6 (post-CR1.5 surgical phase):
 *
 *   - Dead `no_workspace` LoadState branches removed from
 *     WorkspaceAdminPanel, ReviewerCommandConsole, GovernanceControlPlane.
 *     (See CR1.5B Test 2 — flipped to assert REMOVED.)
 *   - `teams/[id]/page.tsx` migrated off the legacy /v1/users/me
 *     self-fetch onto the canonical envelope `user.id`.
 *   - `settings/page.tsx` still pairs PATCH with `ctx.refresh()`
 *     (R1 Part 4 carry-forward) and the page only calls /v1/users/me
 *     with PATCH (mutation, not a stale-read self-fetch).
 *   - `PlatformContextProvider` ships an opt-in focus-triggered
 *     refresh helper, feature-gated and 60 s throttled.
 *
 * Hard rules preserved:
 *   - No new feature flags beyond NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED.
 *   - No new product surfaces. No new routes.
 *   - No backend permission semantics changed.
 *   - No capture / upload / finalize / custody / TSA / OTS / report /
 *     package logic touched. (File-size pin below.)
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function webPath(rel) {
    return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function repoPath(rel) {
    return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function apiPath(rel) {
    return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readWeb(rel) {
    return readFileSync(webPath(rel), "utf8");
}
function readRepo(rel) {
    return readFileSync(repoPath(rel), "utf8");
}
const PROVIDER = readWeb("lib/platform-context/PlatformContextProvider.tsx");
const TEAMS_DETAIL = readWeb("app/(app)/teams/[id]/page.tsx");
const SETTINGS = readWeb("app/(app)/settings/page.tsx");
const WORKSPACE_ADMIN = readWeb("components/workspace-admin/WorkspaceAdminPanel.tsx");
const REVIEWER_CC = readWeb("components/reviewer-experience/ReviewerCommandConsole.tsx");
const GOV_CP = readWeb("components/governance-experience/GovernanceControlPlane.tsx");
// =============================================================================
// PART 1 — CR1.6 documentation exists + substantial
// =============================================================================
describe("CR1.6 Test 1 — documentation exists and is non-trivial", () => {
    it("docs/product/CR1_6_SURGICAL_STATE_CLEANUP.md is present and substantial", () => {
        const doc = readRepo("docs/product/CR1_6_SURGICAL_STATE_CLEANUP.md");
        expect(doc.length).toBeGreaterThan(6000);
        expect(doc).toMatch(/PHASE CR1\.6/);
        expect(doc).toMatch(/Surgical State Cleanup/i);
        // Must cross-reference CR1.5 follow-up sections.
        expect(doc).toMatch(/CR1\.5/);
    });
    it("docs/product/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md carries a CR1.6 follow-up section", () => {
        const doc = readRepo("docs/product/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md");
        expect(doc).toMatch(/CR1\.6/);
        expect(doc).toMatch(/follow-up/i);
    });
});
// =============================================================================
// PART 2 — Dead `no_workspace` branches verified removed
// =============================================================================
describe("CR1.6 Test 2 — dead `no_workspace` branches and `ShellNoWorkspace` are removed", () => {
    const FILES = [
        { name: "WorkspaceAdminPanel", src: WORKSPACE_ADMIN },
        { name: "ReviewerCommandConsole", src: REVIEWER_CC },
        { name: "GovernanceControlPlane", src: GOV_CP },
    ];
    it.each(FILES)("$name has no `no_workspace` LoadState branch", ({ src }) => {
        expect(src).not.toMatch(/status:\s*["']no_workspace["']/);
        expect(src).not.toMatch(/state\.status\s*===\s*["']no_workspace["']/);
        expect(src).not.toMatch(/function ShellNoWorkspace\s*\(/);
        // CR1.6 paper trail — each file references the cleanup in a
        // comment so future readers know why the branch is missing.
        expect(src).toMatch(/CR1\.6/);
    });
});
// =============================================================================
// PART 3 — `teams/[id]/page.tsx` no longer self-fetches /v1/users/me
// =============================================================================
describe("CR1.6 Test 3 — teams detail page reads current user id from envelope", () => {
    it("teams/[id]/page.tsx does not call /v1/users/me", () => {
        expect(TEAMS_DETAIL).not.toMatch(/\bapiFetch\(\s*["']\/v1\/users\/me["']/);
        expect(TEAMS_DETAIL).not.toMatch(/\bfetch\(\s*["']\/v1\/users\/me["']/);
    });
    it("teams/[id]/page.tsx reads currentUserId from the platform envelope", () => {
        expect(TEAMS_DETAIL).toMatch(/usePlatformContext\s*\(/);
        // The canonical pattern: `platformCtx.envelope?.user?.id ?? ""`.
        expect(TEAMS_DETAIL).toMatch(/envelope\??\.user\??\.id/);
        // CR1.6 paper trail.
        expect(TEAMS_DETAIL).toMatch(/CR1\.6/);
    });
    it("teams/[id]/page.tsx removed the now-unused MeResponse type", () => {
        // The legacy type local to this file is gone (replaced by the
        // envelope user shape). Pinning its absence prevents regressions
        // that re-introduce the self-fetch alongside the type.
        expect(TEAMS_DETAIL).not.toMatch(/^type MeResponse =/m);
    });
});
// =============================================================================
// PART 4 — `settings/page.tsx` still refreshes envelope after PATCH
// =============================================================================
describe("CR1.6 Test 4 — settings page refresh wiring (R1 Part 4 carry-forward)", () => {
    it("settings/page.tsx PATCH handler calls platformCtx.refresh()", () => {
        // PATCH call still exists (mutation endpoint).
        expect(SETTINGS).toMatch(/apiFetch\(\s*["']\/v1\/users\/me["']\s*,\s*\{\s*[\s\S]*?method:\s*["']PATCH["']/);
        // R1 Part 4 fix is intact — pair PATCH with envelope refresh.
        expect(SETTINGS).toMatch(/platformCtx\.refresh\s*\(/);
    });
    it("settings/page.tsx only calls /v1/users/me with PATCH (no stale-read GET)", () => {
        // Find every apiFetch("/v1/users/me", ...) call in the file and
        // ensure each is followed by a `method: "PATCH"` in the same
        // options object. This is a contract check that "self-fetch GET"
        // patterns do not creep back in alongside the legitimate
        // mutation.
        const callRegex = /apiFetch\(\s*["']\/v1\/users\/me["'](?:\s*,\s*(\{[\s\S]*?\}))?\s*\)/g;
        let m;
        let calls = 0;
        let patchOnly = 0;
        while ((m = callRegex.exec(SETTINGS)) !== null) {
            calls += 1;
            const opts = m[1] ?? "";
            if (/method:\s*["']PATCH["']/.test(opts))
                patchOnly += 1;
        }
        expect(calls).toBeGreaterThan(0);
        expect(patchOnly, `settings/page.tsx: all ${calls} /v1/users/me calls must be PATCH (found ${patchOnly} PATCH). A GET self-fetch would duplicate envelope.user state.`).toBe(calls);
    });
});
// =============================================================================
// PART 5 — Focus-triggered envelope refresh helper (opt-in, throttled)
// =============================================================================
describe("CR1.6 Test 5 — focus-refresh helper is feature-gated and safe", () => {
    it("PlatformContextProvider declares MIN_REFRESH_INTERVAL_MS = 60_000", () => {
        expect(PROVIDER).toMatch(/MIN_REFRESH_INTERVAL_MS\s*=\s*60_000/);
    });
    it("focus-refresh is gated by NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED", () => {
        expect(PROVIDER).toMatch(/NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED/);
        // Helper checks for === "true" so any other value (including
        // "1", true boolean, undefined) yields false.
        expect(PROVIDER).toMatch(/NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED\s*===\s*["']true["']/);
    });
    it("focus-refresh effect is SSR-safe (guards on typeof window/document)", () => {
        expect(PROVIDER).toMatch(/typeof window === "undefined"/);
        expect(PROVIDER).toMatch(/typeof document === "undefined"/);
    });
    it("focus-refresh subscribes to focus AND visibilitychange and cleans up", () => {
        expect(PROVIDER).toMatch(/window\.addEventListener\(\s*["']focus["']/);
        expect(PROVIDER).toMatch(/document\.addEventListener\(\s*["']visibilitychange["']/);
        expect(PROVIDER).toMatch(/window\.removeEventListener\(\s*["']focus["']/);
        expect(PROVIDER).toMatch(/document\.removeEventListener\(\s*["']visibilitychange["']/);
    });
    it("focus-refresh has a concurrency guard and throttle window", () => {
        expect(PROVIDER).toMatch(/focusRefreshInflightRef/);
        expect(PROVIDER).toMatch(/lastRefreshAtRef/);
        // The throttle compares against MIN_REFRESH_INTERVAL_MS.
        expect(PROVIDER).toMatch(/MIN_REFRESH_INTERVAL_MS/);
    });
    it("focus-refresh only fires while state.name === READY", () => {
        // Refresh in other states (LOADING_CONTEXT, SWITCHING, FAILED,
        // IDLE) is wasteful or racy — the guard must early-return.
        expect(PROVIDER).toMatch(/state\.name\s*!==\s*["']READY["']/);
    });
    it("focus-refresh visibility check requires the document to become visible", () => {
        expect(PROVIDER).toMatch(/document\.visibilityState\s*!==\s*["']visible["']/);
    });
    it("focus-refresh helper does NOT use a state library or add a global subscriber outside React", () => {
        // No new React Query / SWR / Redux / Zustand introduction.
        const pkgPath = webPath("package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        for (const forbidden of [
            "@tanstack/react-query",
            "react-query",
            "swr",
            "redux",
            "@reduxjs/toolkit",
            "zustand",
            "jotai",
            "recoil",
            "mobx",
        ]) {
            expect(deps[forbidden], `CR1.6 must not add ${forbidden}. The platform envelope remains canonical.`).toBeUndefined();
        }
    });
});
// =============================================================================
// PART 6 — Canonical contracts preserved (regression pins)
// =============================================================================
describe("CR1.6 Test 6 — canonical contracts preserved", () => {
    it("CommandCenter still uses useActiveSpace() (R1 Bug A regression pin)", () => {
        const cc = readWeb("components/command-center/CommandCenter.tsx");
        expect(cc).toMatch(/\buseActiveSpace\s*\(/);
        expect(cc).toMatch(/\busePlatformContext\s*\(/);
        expect(cc).not.toMatch(/\buseTeamWorkspaceGate\s*\(/);
    });
    it("Persona save still calls ctx.refresh() (R1 Bug B regression pin)", () => {
        const persona = readWeb("app/(app)/settings/persona/page.tsx");
        expect(persona).toMatch(/method:\s*["']PATCH["']/);
        expect(persona).toMatch(/ctx\.refresh\s*\(/);
        expect(persona).not.toMatch(/Reload to see/i);
    });
    it("PageRouteGate component remains the canonical access gate", () => {
        // The component must still exist and the canonical surfaces wrap
        // their pages with it. We assert it is present (file exists)
        // rather than counting consumers (a separate test owns drift
        // detection).
        const gatePath = webPath("components/navigation/PageRouteGate.tsx");
        expect(existsSync(gatePath)).toBe(true);
    });
    it("PlatformContextEnvelope remains the canonical frontend state shape", () => {
        const types = readWeb("lib/platform-context/types.ts");
        expect(types).toMatch(/PlatformContextEnvelope/);
    });
    it("RUNTIME_SEVERITY_LABELS.UNKNOWN is still 'Status pending'", () => {
        const labels = readWeb("lib/product-language/stateLabels.ts");
        expect(labels).toMatch(/UNKNOWN:\s*"Status pending"/);
    });
});
// =============================================================================
// PART 7 — Touch-no-capture invariant
// =============================================================================
describe("CR1.6 Test 7 — capture / custody / report / package files untouched", () => {
    const PINS = [
        { rel: "src/routes/capture.routes.ts", expectedBytes: 21793 },
        { rel: "src/services/evidence-complete.service.ts", expectedBytes: 46824 },
        { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
        { rel: "src/services/timestamp.service.ts", expectedBytes: 12988 },
        {
            rel: "src/services/reports/reports-aggregator.service.ts",
            expectedBytes: 13118,
        },
    ];
    for (const { rel, expectedBytes } of PINS) {
        it(`${rel} stays within ±10% of CR1.6 baseline (${expectedBytes} bytes)`, () => {
            const fullPath = apiPath(rel);
            expect(existsSync(fullPath), `${rel} must exist`).toBe(true);
            const st = statSync(fullPath);
            const low = Math.floor(expectedBytes * 0.9);
            const high = Math.ceil(expectedBytes * 1.1);
            expect(st.size, `${rel} size ${st.size} outside ±10% window [${low}, ${high}]. CR1.6 must not touch capture / custody / TSA / OTS / report / package.`).toBeGreaterThanOrEqual(low);
            expect(st.size).toBeLessThanOrEqual(high);
        });
    }
});
