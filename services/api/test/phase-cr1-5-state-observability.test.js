/**
 * PHASE CR1.5 — State & Orchestration Observability guardrails.
 *
 * CR1.5 produces three deliverables:
 *   1. `docs/recovery/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md` —
 *      the canonical state contract + active-workspace trace +
 *      persona save-refresh trace + sidebar trace + dashboard trace +
 *      self-fetch cleanup plan + R1 execution brief.
 *   2. `apps/web/lib/platform-context/state-observability.ts` —
 *      dev/test-only state tracing utility, no-op in production.
 *   3. This test file — 15 source-contract assertions that pin the
 *      current truth-mapping and the known bugs.
 *
 * Tests #9, #10, #11 are INTENTIONAL INVERSE PINS — they assert that
 * the known bugs are STILL PRESENT. When R1 fixes them, those tests
 * MUST be flipped in the same PR. That is the forcing function so
 * R1's fix and CR1.5's observability ratchet stay in sync.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// =============================================================================
// Helpers
// =============================================================================
function repoPath(rel) {
    return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel) {
    return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel) {
    return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readRepo(rel) {
    return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel) {
    return readFileSync(webPath(rel), "utf8");
}
function readApi(rel) {
    return readFileSync(apiPath(rel), "utf8");
}
function listAllTsxFiles(dirAbs) {
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
                if (st.isFile() && /\.(ts|tsx)$/.test(name))
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
const DOC = readRepo("docs/recovery/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md");
const OBS = readWeb("lib/platform-context/state-observability.ts");
// =============================================================================
// PART 1 — Documentation exists and is non-trivial
// =============================================================================
describe("CR1.5 Test 1 — documentation exists + non-trivial", () => {
    it("docs/recovery/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md is present and substantial", () => {
        expect(DOC.length).toBeGreaterThan(8000);
        expect(DOC).toMatch(/PHASE CR1\.5/);
        expect(DOC).toMatch(/State & Orchestration Observability/);
    });
});
// =============================================================================
// PART 2 — Canonical state contract present with required state domains
// =============================================================================
describe("CR1.5 Test 2 — canonical state contract documented", () => {
    it("Section 1 has the canonical state contract table with required domains", () => {
        expect(DOC).toMatch(/## 1\. Canonical state contract/);
        const REQUIRED_DOMAINS = [
            "Authenticated user",
            "activeSpace",
            "Personal Space",
            "Team / Organization workspace",
            "Workspace profile",
            "Persona / workflow profile",
            "Onboarding completion",
            "Density preference",
            "Route access",
            "Workflow exposure",
            "Sidebar visibility",
            "Dashboard mode",
            "Capability / permission state",
            "Billing / plan gate state",
            "Governance availability",
            "Reviewer/ops availability",
        ];
        for (const d of REQUIRED_DOMAINS) {
            expect(DOC, `state-contract row missing: ${d}`).toContain(d);
        }
    });
    it("canonical-state contract names the platform envelope as the frontend source", () => {
        expect(DOC).toMatch(/PlatformContextEnvelope/);
        expect(DOC).toMatch(/GET \/v1\/platform\/context/);
        expect(DOC).toMatch(/PlatformContextProvider/);
    });
});
// =============================================================================
// PART 3 — Active-workspace readers/writers documented
// =============================================================================
describe("CR1.5 Test 3 — active-workspace trace documented", () => {
    it("Section 3 documents the canonical reader hooks + bug touchpoints", () => {
        expect(DOC).toMatch(/## 3\. Active workspace runtime trace/);
        expect(DOC).toMatch(/useActiveSpace/);
        expect(DOC).toMatch(/useActiveSpaceId/);
        expect(DOC).toMatch(/useTeamWorkspaceGate/);
        expect(DOC).toMatch(/AppTopbarV2\.tsx:113/);
        expect(DOC).toMatch(/CommandCenter\.tsx:70/);
    });
});
// =============================================================================
// PART 4 — Persona / workflow save-refresh chain documented
// =============================================================================
describe("CR1.5 Test 4 — persona save-refresh trace documented", () => {
    it("Section 4 documents the persona PATCH + refresh-missing chain", () => {
        expect(DOC).toMatch(/## 4\. Persona \/ workflow save-refresh trace/);
        expect(DOC).toMatch(/settings\/persona\/page\.tsx/);
        expect(DOC).toMatch(/PATCH \/v1\/workspaces/);
        expect(DOC).toMatch(/refresh\(\)/);
        expect(DOC).toMatch(/Reload to see/);
    });
});
// =============================================================================
// PART 5 — Sidebar dependency chain documented
// =============================================================================
describe("CR1.5 Test 5 — sidebar dependency chain documented", () => {
    it("Section 5 documents ROUTE_REGISTRY → resolveRouteAccess → resolveWorkflowExposure → AppSidebarV2", () => {
        expect(DOC).toMatch(/## 5\. Sidebar \/ route-exposure trace/);
        expect(DOC).toMatch(/ROUTE_REGISTRY/);
        expect(DOC).toMatch(/resolveRouteAccess/);
        expect(DOC).toMatch(/resolveWorkflowExposure/);
        expect(DOC).toMatch(/AppSidebarV2/);
    });
});
// =============================================================================
// PART 6 — Dashboard / CommandCenter dependency chain documented
// =============================================================================
describe("CR1.5 Test 6 — dashboard/CommandCenter chain documented", () => {
    it("Section 6 documents the frontend gate + backend service contract", () => {
        expect(DOC).toMatch(/## 6\. Dashboard \/ CommandCenter trace/);
        expect(DOC).toMatch(/CommandCenter\.tsx/);
        expect(DOC).toMatch(/command-center\.service\.ts/);
        expect(DOC).toMatch(/not_applicable/);
        expect(DOC).toMatch(/\/v1\/dashboard\/command-center/);
    });
});
// =============================================================================
// PART 7 — No new /v1/users/me self-fetcher without exemption
// =============================================================================
describe("CR1.5 Test 7 — bounded /v1/users/me self-fetcher allow-list", () => {
    /**
     * The exact allow-list of files that may self-fetch /v1/users/me.
     * Adding a new entry requires CR1.5 doc update + explicit
     * justification in the §7 cleanup plan. Migrating an entry to the
     * canonical envelope hook is the goal — R1 Phase 2 owns it.
     */
    const ALLOWED_SELF_FETCHERS = [
        {
            path: "app/providers.tsx",
            reason: "Bootstrap layer — runs before PlatformContextProvider mounts.",
        },
        {
            path: "app/(app)/settings/page.tsx",
            reason: "Profile PATCH mutation against the only /v1/users/me write endpoint. R1 Part 4 pairs it with ctx.refresh(); CR1.6 confirmed the refresh remains in place. Not a stale-read self-fetch.",
        },
        // CR1.6 Part 4 — `teams/[id]/page.tsx` migrated off the legacy
        // /v1/users/me self-fetch. Current user id now sourced from the
        // canonical platform envelope (`envelope.user.id`). The entry is
        // intentionally removed so any regression that re-adds the
        // self-fetch fails this test.
    ];
    it("only the documented files self-fetch /v1/users/me", () => {
        const root = webPath(".");
        const all = listAllTsxFiles(root);
        // Normalize allow-list to leading-slash form to match the
        // relative paths produced below.
        const allowedNormalized = new Set(ALLOWED_SELF_FETCHERS.map((e) => `/${e.path.replace(/\\/g, "/").replace(/^\/+/, "")}`));
        const offenders = [];
        for (const file of all) {
            const src = readFileSync(file, "utf8");
            // We only flag files that ACTUALLY call apiFetch("/v1/users/me"
            // or fetch("/v1/users/me" — comments and tests are ignored.
            const callsSelfMe = /\bapiFetch\(\s*["']\/v1\/users\/me["']/.test(src) ||
                /\bfetch\(\s*["']\/v1\/users\/me["']/.test(src);
            if (!callsSelfMe)
                continue;
            const normalized = file.replace(/\\/g, "/");
            const rel = normalized.replace(/^.*\/apps\/web\/+/, "/");
            if (!allowedNormalized.has(rel))
                offenders.push(rel);
        }
        expect(offenders, `Found new /v1/users/me self-fetchers outside the CR1.5 allow-list:\n${offenders.join("\n")}\nIf intentional, add to ALLOWED_SELF_FETCHERS with a reason + revisit phase.`).toEqual([]);
    });
    it("every allow-list entry carries a non-empty reason", () => {
        for (const entry of ALLOWED_SELF_FETCHERS) {
            expect(entry.reason.length, `${entry.path} reason`).toBeGreaterThan(8);
        }
    });
});
// =============================================================================
// PART 8 — No new useTeamWorkspaceGate callsite
// =============================================================================
describe("CR1.5 Test 8 — bounded useTeamWorkspaceGate callsite allow-list", () => {
    /**
     * `useTeamWorkspaceGate()` is the legacy team-only gate. R1 migrates
     * the dashboard callsite. The operator callsite may stay. This pin
     * stops new surfaces from re-introducing the same bug shape.
     *
     * Note: `useTeamId()` is a legacy alias also backed by the same
     * gate, with 28 surviving callsites. Those callsites are all
     * PageRouteGate-wrapped so personal users do not load the page and
     * the null-return is handled. CR1.5 does NOT pin `useTeamId`
     * because doing so without a same-PR migration plan would freeze
     * 28 pages mid-refactor. R1.5B / R2 own that migration.
     */
    const ALLOWED_GATE_CALLSITES = [
        // R1 (Bug A) migrated CommandCenter off `useTeamWorkspaceGate()`
        // to `useActiveSpace()` + `usePlatformContext()`. Removed from the
        // allow-list so a regression cannot quietly re-introduce the
        // legacy gate on the dashboard surface.
        {
            file: "app/(app)/ops/page.tsx",
            reason: "Operator-only surface; team-scope gating may be correct.",
            revisitPhase: "R8/R9",
        },
    ];
    it("only the documented files call useTeamWorkspaceGate()", () => {
        const root = webPath(".");
        const all = listAllTsxFiles(root);
        // Normalize allow-list to leading-slash form.
        const allowed = new Set(ALLOWED_GATE_CALLSITES.map((e) => `/${e.file.replace(/\\/g, "/").replace(/^\/+/, "")}`));
        const offenders = [];
        for (const file of all) {
            const src = readFileSync(file, "utf8");
            // Match real call sites only, not type-only or comment uses.
            if (!/\buseTeamWorkspaceGate\s*\(/.test(src))
                continue;
            const normalized = file.replace(/\\/g, "/");
            const rel = normalized.replace(/^.*\/apps\/web\/+/, "/");
            // The hook's own definition file isn't a callsite.
            if (rel.endsWith("/useTeamWorkspaceGate.ts"))
                continue;
            // The `lib/platform-context` index re-exports the hook and
            // mentions it in a documentation comment ("now call
            // useTeamWorkspaceGate() from ...") which trips a naive regex.
            // The re-exporter is not a real callsite.
            if (rel.endsWith("/lib/platform-context/index.ts"))
                continue;
            if (!allowed.has(rel))
                offenders.push(rel);
        }
        expect(offenders, `Found new useTeamWorkspaceGate() callsites outside the CR1.5 allow-list:\n${offenders.join("\n")}`).toEqual([]);
    });
});
// =============================================================================
// PART 9 — INVERSE PIN: CommandCenter team-only gate bug remains until R1
// =============================================================================
describe("CR1.5 Test 9 — [FIXED IN R1] CommandCenter no longer uses useTeamWorkspaceGate", () => {
    it("CommandCenter.tsx consumes the canonical useActiveSpace + usePlatformContext", () => {
        const src = readWeb("components/command-center/CommandCenter.tsx");
        // R1 Bug A — flipped. The CommandCenter must read active workspace
        // from the canonical envelope, not from the legacy team-only gate.
        expect(src).not.toMatch(/\buseTeamWorkspaceGate\s*\(/);
        expect(src).toMatch(/\buseActiveSpace\s*\(/);
        expect(src).toMatch(/\busePlatformContext\s*\(/);
    });
});
// =============================================================================
// PART 10 — INVERSE PIN: Persona save does NOT call refresh() (until R1)
// =============================================================================
describe("CR1.5 Test 10 — [FIXED IN R1] persona save refreshes the envelope", () => {
    it("settings/persona/page.tsx PATCH handler imports usePlatformContext and calls refresh()", () => {
        const src = readWeb("app/(app)/settings/persona/page.tsx");
        // Confirm the PATCH call still exists (we are talking about the
        // right file).
        expect(src).toMatch(/\/v1\/workspaces\/.+\/persona/);
        expect(src).toMatch(/method:\s*["']PATCH["']/);
        // R1 Bug B — flipped. The handler must now import the platform
        // context and refresh the envelope after a successful PATCH so
        // sidebar / dashboard / density / persona banner / help all
        // re-render without a manual page reload.
        expect(src).toMatch(/\busePlatformContext\b/);
        expect(src).toMatch(/ctx\.refresh\s*\(/);
    });
});
// =============================================================================
// PART 11 — INVERSE PIN: "Reload to see" copy remains until R1
// =============================================================================
describe("CR1.5 Test 11 — [FIXED IN R1] 'Reload to see' bug-marker copy removed", () => {
    it("settings/persona/page.tsx no longer ships the 'Reload to see' bug-marker copy", () => {
        const src = readWeb("app/(app)/settings/persona/page.tsx");
        // R1 removed the stale instruction. The success banner now says
        // navigation/recommendations have been refreshed (because they
        // actually have — see Test 10).
        expect(src).not.toMatch(/Reload to see/i);
        expect(src).toMatch(/Workspace profile updated/);
    });
});
// =============================================================================
// PART 12 — No workflow/persona authorization gates introduced
// =============================================================================
describe("CR1.5 Test 12 — workflow/persona stays presentation-only (no authorization)", () => {
    it("workflowExposureResolver does not reference canLoad, requiredCapabilities, or authorize", () => {
        const src = readWeb("lib/navigation/workflowExposureResolver.ts");
        // The exposure resolver is about ordering and bucketing only. It
        // must NEVER touch authorization concepts.
        expect(src).not.toMatch(/\bcanLoad\s*=/);
        expect(src).not.toMatch(/requiredCapabilities\b\s*[:?.]/);
        expect(src).not.toMatch(/authorize/i);
        expect(src).not.toMatch(/forbidden/i);
    });
    it("workflowExposureResolver header still documents the no-authorization contract", () => {
        const src = readWeb("lib/navigation/workflowExposureResolver.ts");
        // Lines 14-21 per CR1.5 §5 trace.
        expect(src).toMatch(/Workflow NEVER changes/i);
    });
});
// =============================================================================
// PART 13 — Observability utility is no-op in production + safe payload
// =============================================================================
describe("CR1.5 Test 13 — observability utility is production-safe", () => {
    it("emit() is gated behind both NODE_ENV !== 'production' and the explicit opt-in flag", () => {
        expect(OBS).toMatch(/process\.env\.NODE_ENV/);
        expect(OBS).toMatch(/NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY/);
        // The production gate must fire FIRST — i.e. the function must
        // early-return on NODE_ENV === "production" before checking the
        // public flag. We grep the relevant function body.
        const isFn = OBS.match(/function isObservabilityEnabled\(\)[\s\S]*?\n\}/);
        expect(isFn, "isObservabilityEnabled() function must exist").toBeTruthy();
        const body = isFn[0];
        const prodGateIdx = body.indexOf('NODE_ENV === "production"');
        const flagIdx = body.indexOf("NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY");
        expect(prodGateIdx).toBeGreaterThan(-1);
        expect(flagIdx).toBeGreaterThan(prodGateIdx);
    });
    it("SafePayload type forbids objects/arrays/blobs (only primitives + bounded strings)", () => {
        // The runtime sanitizer truncates strings to MAX_LABEL_LEN and
        // integer-coerces numbers (no float / no GPS precision).
        expect(OBS).toMatch(/const MAX_LABEL_LEN = 64/);
        expect(OBS).toMatch(/Math\.trunc/);
        // Compile-time contract: SafePayload values are bool|null|undef|
        // string|number — no object/array.
        expect(OBS).toMatch(/SafePayloadValue\s*=\s*\|\s*boolean[\s\S]*?\|\s*null[\s\S]*?\|\s*string[\s\S]*?\|\s*number/);
    });
    it("module exports a redactWorkspaceId helper", () => {
        expect(OBS).toMatch(/export function redactWorkspaceId/);
        expect(OBS).toMatch(/workspace_\$\{id\.slice\(0,\s*8\)\}/);
    });
    it("no production UI / no window-attached state / no broad logging beyond console.debug", () => {
        expect(OBS).not.toMatch(/\bwindow\./); // no window-attached state
        expect(OBS).not.toMatch(/\bdocument\./); // no DOM injection
        expect(OBS).not.toMatch(/\bconsole\.error\b/); // no error spam
        expect(OBS).not.toMatch(/\bconsole\.warn\b/);
        expect(OBS).not.toMatch(/\bconsole\.log\b/);
    });
    it("R1 wired the observability utility into the provider + persona save handler", () => {
        // R1 Part 7 — the dev-only utility now traces:
        //   - platform-envelope:loaded + :refreshed (provider)
        //   - persona-profile:saved + :refresh-missing (persona handler)
        //   - active-space:resolved + dashboard:resolved (CommandCenter)
        // Production behavior is unchanged (emit() is no-op in prod).
        const provider = readWeb("lib/platform-context/PlatformContextProvider.tsx");
        const persona = readWeb("app/(app)/settings/persona/page.tsx");
        const cc = readWeb("components/command-center/CommandCenter.tsx");
        expect(provider).toMatch(/state-observability/);
        expect(persona).toMatch(/state-observability/);
        expect(cc).toMatch(/state-observability/);
    });
});
// =============================================================================
// PART 14 — No capture upload/finalization files changed in CR1.5
// =============================================================================
describe("CR1.5 Test 14 — capture upload/finalization files unchanged", () => {
    // File-size pin within ±10% per the same CR0.5 pattern. CR1.5 does
    // not touch capture, so the sizes must hold.
    const PINS = [
        { rel: "src/routes/capture.routes.ts", expectedBytes: 21793 },
        { rel: "src/services/evidence-complete.service.ts", expectedBytes: 46824 },
    ];
    for (const { rel, expectedBytes } of PINS) {
        it(`${rel} is within ±10% of CR1.5 baseline (${expectedBytes} bytes)`, () => {
            const fullPath = apiPath(rel);
            expect(existsSync(fullPath), `${rel} must exist`).toBe(true);
            const st = statSync(fullPath);
            const low = Math.floor(expectedBytes * 0.9);
            const high = Math.ceil(expectedBytes * 1.1);
            expect(st.size, `${rel} size ${st.size} is outside ±10% window [${low}, ${high}]. CR1.5 must not touch capture/finalization.`).toBeGreaterThanOrEqual(low);
            expect(st.size).toBeLessThanOrEqual(high);
        });
    }
});
// =============================================================================
// PART 15 — No custody/TSA/OTS/report/package files changed in CR1.5
// =============================================================================
describe("CR1.5 Test 15 — custody / TSA / OTS / report / package files unchanged", () => {
    const PINS = [
        { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
        { rel: "src/services/timestamp.service.ts", expectedBytes: 12988 },
        {
            rel: "src/services/reports/reports-aggregator.service.ts",
            expectedBytes: 13118,
        },
    ];
    for (const { rel, expectedBytes } of PINS) {
        it(`${rel} is within ±10% of CR1.5 baseline (${expectedBytes} bytes)`, () => {
            const fullPath = apiPath(rel);
            expect(existsSync(fullPath), `${rel} must exist`).toBe(true);
            const st = statSync(fullPath);
            const low = Math.floor(expectedBytes * 0.9);
            const high = Math.ceil(expectedBytes * 1.1);
            expect(st.size, `${rel} size ${st.size} is outside ±10% window [${low}, ${high}]. CR1.5 must not touch custody / TSA / OTS / report / package.`).toBeGreaterThanOrEqual(low);
            expect(st.size).toBeLessThanOrEqual(high);
        });
    }
});
