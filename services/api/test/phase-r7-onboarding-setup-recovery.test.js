/**
 * PHASE R7 — Onboarding & Setup Recovery guardrails.
 *
 * R7 codifies the bounded per-mode onboarding step sequences as
 * pure data + a single resolver. Existing surfaces (PersonaSetupBanner,
 * CommandCenter onboarding hint, dashboard quick actions) continue
 * to consume their existing helpers; R7 establishes the canonical
 * sequence vocabulary so future surface wiring is single-sourced.
 *
 * Hard contract pinned here:
 *
 *   1. Onboarding state uses ONE canonical source — the
 *      envelope's `personaProfile.onboardingCompleted` flag.
 *   2. Per-mode step sequences are bounded (3–5 steps).
 *   3. Every step `href` references an existing route.
 *   4. Resolver is pure (no fetches, no auth predicates).
 *   5. R1 refresh behavior preserved (persona save calls
 *      ctx.refresh — the "Reload to see" copy stays gone).
 *   6. Empty-state copy uses R4 vocabulary, no marketing fluff.
 *   7. No duplicate onboarding system / no parallel state store.
 *   8. Capture / custody / TSA / report files unchanged.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function repoPath(rel) {
    return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel) {
    return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function readRepo(rel) {
    return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel) {
    return readFileSync(webPath(rel), "utf8");
}
const TYPES = readWeb("lib/onboarding/types.ts");
const STEPS = readWeb("lib/onboarding/onboardingSteps.ts");
const RESOLVER = readWeb("lib/onboarding/resolveOnboardingState.ts");
const INDEX = readWeb("lib/onboarding/index.ts");
const PERSONA_PAGE = readWeb("app/(app)/settings/persona/page.tsx");
const COMMAND_CENTER = readWeb("components/command-center/CommandCenter.tsx");
const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
// =============================================================================
// PART 1 — Onboarding uses one canonical state source
// =============================================================================
describe("R7 Part 1 — single canonical onboarding state source", () => {
    it("resolver consumes onboardingCompleted only (no parallel state)", () => {
        expect(RESOLVER).toMatch(/onboardingCompleted/);
        // The resolver must NOT introduce new state primitives like a
        // separate setup-progress counter; it works off the existing flag.
        expect(RESOLVER).not.toMatch(/\bsetupStep\b/);
        expect(RESOLVER).not.toMatch(/\bsetupProgress\b/);
        expect(RESOLVER).not.toMatch(/\bonboardingState\b/);
    });
    it("resolver is pure (no fetches, no I/O, no auth predicates)", () => {
        expect(RESOLVER).not.toMatch(/\bfetch\(/);
        expect(RESOLVER).not.toMatch(/\bapiFetch\(/);
        expect(RESOLVER).not.toMatch(/^\s*await\s/m);
        expect(RESOLVER).not.toMatch(/\bauthorize\s*\(/);
        expect(RESOLVER).not.toMatch(/\.requiredCapabilities\b/);
    });
});
// =============================================================================
// PART 2 — Personal onboarding sequence is simple + action-oriented
// =============================================================================
describe("R7 Part 2 — personal onboarding sequence", () => {
    it("PERSONAL sequence leads with capture (first-action)", () => {
        expect(STEPS).toMatch(/PERSONAL:\s*\[[\s\S]*?personal\.capture-first-evidence[\s\S]*?"\/capture"/);
        expect(STEPS).toMatch(/Create your first evidence record/);
    });
    it("PERSONAL sequence is bounded (3-5 steps) + uses operational vocabulary", () => {
        const block = STEPS.match(/PERSONAL:\s*\[([\s\S]*?)\],\s*ORGANIZATION:/);
        expect(block).toBeTruthy();
        const ids = (block[1].match(/\bid:\s*"personal\./g) ?? []).length;
        expect(ids).toBeGreaterThanOrEqual(3);
        expect(ids).toBeLessThanOrEqual(5);
        // R4 vocabulary — evidence / reports / collaboration / intake.
        expect(block[1]).toMatch(/Review your recent evidence/);
        expect(block[1]).toMatch(/Generate or view a report/);
    });
});
// =============================================================================
// PART 3 — Organization onboarding sequence is operational + team-aware
// =============================================================================
describe("R7 Part 3 — organization onboarding sequence", () => {
    it("ORGANIZATION sequence leads with workspace profile + invite collaborators", () => {
        const block = STEPS.match(/ORGANIZATION:\s*\[([\s\S]*?)\],\s*REVIEW_OPS:/);
        expect(block).toBeTruthy();
        expect(block[1]).toMatch(/Configure your workspace profile/);
        expect(block[1]).toMatch(/Invite collaborators/);
    });
    it("ORGANIZATION sequence includes intake + queues + governance setup", () => {
        const block = STEPS.match(/ORGANIZATION:\s*\[([\s\S]*?)\],\s*REVIEW_OPS:/);
        expect(block).toBeTruthy();
        expect(block[1]).toMatch(/Configure intake operations/);
        expect(block[1]).toMatch(/Review queues and escalations/);
        expect(block[1]).toMatch(/Configure governance and retention/);
    });
    it("ORGANIZATION sequence is bounded (3-5 steps)", () => {
        const block = STEPS.match(/ORGANIZATION:\s*\[([\s\S]*?)\],\s*REVIEW_OPS:/);
        const ids = (block[1].match(/\bid:\s*"org\./g) ?? []).length;
        expect(ids).toBeGreaterThanOrEqual(3);
        expect(ids).toBeLessThanOrEqual(5);
    });
});
// =============================================================================
// PART 4 — Hub-aware onboarding (REVIEW_OPS + GOVERNANCE sequences)
// =============================================================================
describe("R7 Part 4 — hub-aware onboarding sequences", () => {
    it("REVIEW_OPS sequence uses R6 reviewer-hub vocabulary (queue / escalations / SLA)", () => {
        expect(STEPS).toMatch(/Open the reviewer queue/);
        expect(STEPS).toMatch(/Triage escalations/);
        expect(STEPS).toMatch(/Check SLA/);
    });
    it("GOVERNANCE sequence uses R6 governance-hub vocabulary (retention / lifecycle / policy)", () => {
        expect(STEPS).toMatch(/Review retention posture/);
        expect(STEPS).toMatch(/Open lifecycle reviews/);
        expect(STEPS).toMatch(/Configure governance policy/);
    });
    it("REVIEW_OPS + GOVERNANCE sequences are bounded (3-5 each)", () => {
        // Simpler approach: count step ids by their prefix across the
        // whole file. Each step id starts with the mode prefix.
        const cases = [
            ["REVIEW_OPS", "reviewer."],
            ["GOVERNANCE", "governance."],
        ];
        for (const [mode, prefix] of cases) {
            const escapedPrefix = prefix.replace(".", "\\.");
            const count = (STEPS.match(new RegExp(`\\bid:\\s*"${escapedPrefix}`, "g")) ?? []).length;
            expect(count, `${mode} step count must be ≥ 3`).toBeGreaterThanOrEqual(3);
            expect(count, `${mode} step count must be ≤ 5`).toBeLessThanOrEqual(5);
        }
    });
});
// =============================================================================
// PART 5 — Every step href is a registered route (no invented destinations)
// =============================================================================
describe("R7 Part 5 — every step href references an existing route", () => {
    it("each onboarding step href matches a registry href entry", () => {
        const hrefs = Array.from(STEPS.matchAll(/href:\s*"([^"]+)"/g)).map((m) => m[1]);
        expect(hrefs.length).toBeGreaterThanOrEqual(15);
        // Phase B0 introduced canonical operator vocabulary
        // ("Workspaces" / "/organizations"), but legacy `/teams` URL
        // is preserved as a backward-compat alias and is declared in
        // `lib/navigation-config.ts`. Treat declared-but-not-in-
        // routeRegistry aliases as valid for the onboarding step
        // contract — the test only protects against invented routes.
        const ALIAS_HREFS = new Set([
            "/teams", // alias for /organizations, declared in navigation-config
        ]);
        for (const href of hrefs) {
            if (ALIAS_HREFS.has(href))
                continue;
            expect(REGISTRY.includes(`href: "${href}"`), `onboarding href ${href} must be a registered route`).toBe(true);
        }
    });
});
// =============================================================================
// PART 6 — R1 refresh behavior preserved (workflow setup outcome)
// =============================================================================
describe("R7 Part 6 — R1 persona-refresh behavior preserved", () => {
    it("persona save handler still calls ctx.refresh() after PATCH", () => {
        expect(PERSONA_PAGE).toMatch(/\busePlatformContext\b/);
        expect(PERSONA_PAGE).toMatch(/ctx\.refresh\s*\(/);
    });
    it("the stale 'Reload to see' copy stays removed (R1 contract)", () => {
        expect(PERSONA_PAGE).not.toMatch(/Reload to see/i);
        expect(PERSONA_PAGE).toMatch(/Workspace profile updated/);
    });
    it("dashboard onboarding hint still consumes the canonical helper", () => {
        expect(COMMAND_CENTER).toMatch(/resolveDashboardOnboarding/);
        expect(COMMAND_CENTER).toMatch(/onboardingHint\s*\?/);
    });
});
// =============================================================================
// PART 7 — Empty-state copy uses R4 vocabulary
// =============================================================================
describe("R7 Part 7 — onboarding copy uses R4 vocabulary, no fluff", () => {
    it("steps use operational terms (capture/evidence/report/queue/retention/lifecycle)", () => {
        expect(STEPS).toMatch(/Create your first evidence record/);
        expect(STEPS).toMatch(/Review your recent evidence/);
        expect(STEPS).toMatch(/Configure intake operations/);
        expect(STEPS).toMatch(/Open lifecycle reviews/);
        expect(STEPS).toMatch(/Review retention posture/);
    });
    it("no marketing / dramatic / debug phrases in step labels", () => {
        const FORBIDDEN = [
            /\brevolutionary\b/i,
            /\bnext[-\s]gen\b/i,
            /\bbest[-\s]in[-\s]class\b/i,
            /\bAI[-\s]powered\b/i,
            /\bworld[-\s]class\b/i,
            /\bcatastrophic\b/i,
            /\boops!?\b/i,
            /\bobject\s+not\s+found\b/i,
        ];
        for (const p of FORBIDDEN) {
            expect(STEPS, `onboarding steps contain forbidden ${p}`).not.toMatch(p);
        }
    });
    it("no raw 'Unknown' / 'No workspace selected' regression copy", () => {
        expect(STEPS).not.toMatch(/No workspace selected/i);
        expect(STEPS).not.toMatch(/>\s*Unknown\s*</);
    });
});
// =============================================================================
// PART 8 — No duplicate onboarding system
// =============================================================================
describe("R7 Part 8 — no duplicate onboarding system / parallel state store", () => {
    it("no separate OnboardingProvider / OnboardingContext component file", () => {
        const root = webPath("components");
        function listAllFiles(dirAbs) {
            const out = [];
            const stack = [dirAbs];
            while (stack.length > 0) {
                const dir = stack.pop();
                let entries;
                try {
                    entries = readdirSync(dir);
                }
                catch {
                    continue;
                }
                for (const name of entries) {
                    const full = `${dir}/${name}`;
                    try {
                        const st = statSync(full);
                        if (st.isFile() && /\.tsx?$/.test(name))
                            out.push(full);
                        else if (st.isDirectory())
                            stack.push(full);
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
            return out;
        }
        const all = listAllFiles(root);
        const FORBIDDEN_NAMES = [
            "OnboardingProvider.tsx",
            "OnboardingContext.tsx",
            "OnboardingStateProvider.tsx",
            "SetupWizard.tsx",
            "SetupProvider.tsx",
            "OnboardingPortal.tsx",
        ];
        for (const file of all) {
            const name = file.split(/[\\/]/).pop();
            expect(FORBIDDEN_NAMES.includes(name), `R7 forbids parallel onboarding state components — found ${name}`).toBe(false);
        }
    });
    it("the existing PersonaSetupBanner remains the single setup-banner component", () => {
        const path = webPath("components/app-shell-v2/PersonaSetupBanner.tsx");
        expect(statSync(path).isFile()).toBe(true);
    });
    it("the existing PersonaWizardPage remains the single setup wizard", () => {
        const path = webPath("app/(app)/settings/persona/page.tsx");
        expect(statSync(path).isFile()).toBe(true);
    });
});
// =============================================================================
// PART 9 — No new permission logic in onboarding
// =============================================================================
describe("R7 Part 9 — no permission logic in onboarding", () => {
    it("resolver does not consult capabilities", () => {
        expect(RESOLVER).not.toMatch(/\.capabilities\b/);
        expect(RESOLVER).not.toMatch(/capabilities:/);
    });
    it("steps file does not consult capabilities", () => {
        expect(STEPS).not.toMatch(/\.capabilities\b/);
        expect(STEPS).not.toMatch(/\bauthorize\s*\(/);
    });
    it("onboarding package barrel does not re-export auth primitives", () => {
        expect(INDEX).not.toMatch(/authorize/i);
        expect(INDEX).not.toMatch(/Capability/i);
    });
});
// =============================================================================
// PART 10 — Documentation present + substantial
// =============================================================================
describe("R7 Part 10 — R7 documentation present", () => {
    const doc = readRepo("docs/recovery/R7_ONBOARDING_SETUP_RECOVERY.md");
    it("R7 doc exists and covers the required sections", () => {
        expect(doc.length).toBeGreaterThan(6000);
        expect(doc).toMatch(/PHASE R7/);
        // The doc may title the personal section either as "Personal
        // onboarding" or "Personal Space onboarding"; both are valid.
        expect(doc).toMatch(/Personal[^.\n]{0,20}onboarding/i);
        expect(doc).toMatch(/Organization onboarding/i);
        expect(doc).toMatch(/Hub-aware/i);
        expect(doc).toMatch(/Remaining risks/);
    });
});
// =============================================================================
// PART 11 — Capture / custody / TSA / report / package unchanged
// =============================================================================
describe("R7 Part 11 — canonical capture/custody/TSA/report files unchanged", () => {
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
        it(`${rel} is within ±10% of the CR1.5 baseline`, () => {
            const fullPath = fileURLToPath(new URL(`../${rel}`, import.meta.url));
            const st = statSync(fullPath);
            const low = Math.floor(expectedBytes * 0.9);
            const high = Math.ceil(expectedBytes * 1.1);
            expect(st.size, `${rel} size ${st.size} drifted out of window [${low}, ${high}]`).toBeGreaterThanOrEqual(low);
            expect(st.size).toBeLessThanOrEqual(high);
        });
    }
});
