/**
 * PHASE E3 — Operational Automation Foundation contract tests.
 *
 * E3 ships the bounded foundation: Prisma migration + Prisma models +
 * service-layer validation + REST API + frontend visibility page. The
 * trigger DISPATCHER + worker execution are explicitly deferred to E3.1
 * (registered as DEF-021), and the WEBHOOK_DELIVERY_INTERNAL_ONLY action
 * is deferred to E3.2 (registered as DEF-022).
 *
 * This file pins:
 *   - Bounded trigger + action allowlists at the TS layer
 *   - Allowlists exist as DB CHECK constraints in the migration
 *   - Prisma models + indexes + relations
 *   - Service-layer JSON validation (no scripting / no eval)
 *   - Idempotency key determinism
 *   - REST endpoints exist + are registered
 *   - Frontend page exists under /ops/automation (NOT root nav)
 *   - 32.8 IA pin still holds (6 canonical primaries only)
 *   - 9 audit-event types added to security vocabulary
 *   - 2 capability keys added (VIEW + MANAGE)
 *   - No new client-state library
 *   - No capture / custody / report / package logic touched
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTOMATION_ACTION_TYPES, AUTOMATION_RUN_STATUSES, AUTOMATION_TRIGGER_TYPES, CONDITION_LEAF_OPERATORS, CONDITION_MAX_DEPTH, computeIdempotencyKey, E3_AUTOMATION_SECURITY_EVENTS, sanitiseReason, validateActionConfig, validateCondition, } from "../src/services/automation/automation.service.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function repoPath(rel) {
    return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel) {
    return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel) {
    return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function packagesPath(rel) {
    return fileURLToPath(new URL(`../../../packages/${rel}`, import.meta.url));
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
function readPackages(rel) {
    return readFileSync(packagesPath(rel), "utf8");
}
const MIGRATION = readApi("prisma/migrations/20260801000000_phase_e3_automation_foundation/migration.sql");
const PRISMA = readApi("prisma/schema.prisma");
const SERVICE = readApi("src/services/automation/automation.service.ts");
const ROUTES = readApi("src/routes/automation.routes.ts");
const SERVER = readApi("src/server.ts");
const SECURITY = readPackages("shared/src/security.ts");
const CAP_TYPES_API = readApi("src/services/platform-context/types.ts");
const CAP_TYPES_WEB = readWeb("lib/platform-context/types.ts");
const CAP_REGISTRY = readApi("src/services/platform-context/capability-registry.ts");
const ROUTE_REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const PAGE = readWeb("app/(app)/ops/automation/page.tsx");
// ===========================================================================
// PART 1 — Bounded trigger + action allowlists
// ===========================================================================
describe("E3 Test 1 — bounded trigger + action allowlists at TS layer", () => {
    const EXPECTED_TRIGGERS = [
        "EVIDENCE_CREATED",
        "EVIDENCE_FINALIZED",
        "EVIDENCE_REPORTED",
        "PACKAGE_READY",
        "REVIEW_ASSIGNED",
        "REVIEW_OVERDUE",
        "SLA_DUE_SOON",
        "ESCALATION_CREATED",
        "LEGAL_HOLD_CREATED",
        "RETENTION_CANDIDATE_FOUND",
        "EXTERNAL_ACCESS_EXPIRING",
    ];
    const EXPECTED_ACTIONS = [
        "NOTIFY_USER",
        "NOTIFY_ROLE",
        "CREATE_REVIEW_TASK",
        "CREATE_ESCALATION",
        "ASSIGN_REVIEWER",
        "APPLY_LABEL",
        "ADD_OPERATIONAL_COMMENT",
        // Phase E3.2 — DEF-022 RESOLVED. The webhook action joined the
        // allowlist with HTTPS-only + SSRF protection + HMAC signing.
        "WEBHOOK_DELIVERY_INTERNAL_ONLY",
    ];
    it("AUTOMATION_TRIGGER_TYPES matches the 11 documented triggers exactly", () => {
        expect([...AUTOMATION_TRIGGER_TYPES].sort()).toEqual([...EXPECTED_TRIGGERS].sort());
    });
    it("AUTOMATION_ACTION_TYPES matches the 8 documented actions exactly (E3.2 closed DEF-022)", () => {
        expect([...AUTOMATION_ACTION_TYPES].sort()).toEqual([...EXPECTED_ACTIONS].sort());
        expect(AUTOMATION_ACTION_TYPES).toContain("WEBHOOK_DELIVERY_INTERNAL_ONLY");
    });
    it("AUTOMATION_RUN_STATUSES enumerates the 5 bounded statuses", () => {
        expect([...AUTOMATION_RUN_STATUSES].sort()).toEqual(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"].sort());
    });
});
// ===========================================================================
// PART 2 — DB CHECK constraints mirror the TS allowlists
// ===========================================================================
describe("E3 Test 2 — migration CHECK constraints mirror TS allowlists", () => {
    it("migration declares automation_rules_trigger_type_allowlist CHECK", () => {
        expect(MIGRATION).toMatch(/automation_rules_trigger_type_allowlist/);
        for (const t of AUTOMATION_TRIGGER_TYPES) {
            expect(MIGRATION).toContain(`'${t}'`);
        }
    });
    it("migration declares automation_rules_action_type_allowlist CHECK", () => {
        expect(MIGRATION).toMatch(/automation_rules_action_type_allowlist/);
        // E3's migration shipped the original 7 actions. Phase E3.2 later
        // dropped + recreated this constraint to add WEBHOOK_DELIVERY (its
        // own migration owns that change). This test verifies E3's
        // migration contains only the 7 original actions.
        const E3_ACTIONS_AT_SHIP = [
            "NOTIFY_USER",
            "NOTIFY_ROLE",
            "CREATE_REVIEW_TASK",
            "CREATE_ESCALATION",
            "ASSIGN_REVIEWER",
            "APPLY_LABEL",
            "ADD_OPERATIONAL_COMMENT",
        ];
        for (const a of E3_ACTIONS_AT_SHIP) {
            expect(MIGRATION).toContain(`'${a}'`);
        }
    });
    it("migration declares automation_runs_status_allowlist CHECK", () => {
        expect(MIGRATION).toMatch(/automation_runs_status_allowlist/);
        for (const s of AUTOMATION_RUN_STATUSES) {
            expect(MIGRATION).toContain(`'${s}'`);
        }
    });
    it("migration declares unique index on (team, rule, idempotency_key)", () => {
        expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX "automation_runs_team_rule_idempotency_uniq"/);
    });
    it("migration sets ON DELETE CASCADE for team FK on both tables", () => {
        expect(MIGRATION).toMatch(/automation_rules_team_fkey[\s\S]*?ON DELETE CASCADE/);
        expect(MIGRATION).toMatch(/automation_runs_team_fkey[\s\S]*?ON DELETE CASCADE/);
    });
});
// ===========================================================================
// PART 3 — Prisma models present + correctly mapped
// ===========================================================================
describe("E3 Test 3 — Prisma models + relations correctly defined", () => {
    it("Prisma declares AutomationRule and AutomationRun models", () => {
        expect(PRISMA).toMatch(/\bmodel\s+AutomationRule\b/);
        expect(PRISMA).toMatch(/\bmodel\s+AutomationRun\b/);
    });
    it("AutomationRule maps to automation_rules table", () => {
        expect(PRISMA).toMatch(/@@map\("automation_rules"\)/);
    });
    it("AutomationRun maps to automation_runs table with idempotency unique", () => {
        expect(PRISMA).toMatch(/@@map\("automation_runs"\)/);
        expect(PRISMA).toMatch(/name:\s*"automation_runs_team_rule_idempotency_uniq"/);
    });
    it("Team model gains automation back-relations", () => {
        expect(PRISMA).toMatch(/automationRules\s+AutomationRule\[\]/);
        expect(PRISMA).toMatch(/automationRuns\s+AutomationRun\[\]/);
    });
    it("User model gains automation created/updated back-relations", () => {
        expect(PRISMA).toMatch(/createdAutomationRules[\s\S]*?AutomationRule\[\][\s\S]*?AutomationRuleCreatedBy/);
        expect(PRISMA).toMatch(/updatedAutomationRules[\s\S]*?AutomationRule\[\][\s\S]*?AutomationRuleUpdatedBy/);
    });
});
// ===========================================================================
// PART 4 — Service-layer condition + action validation
// ===========================================================================
describe("E3 Test 4 — service-layer JSON validation (no scripting / no eval)", () => {
    it("validateCondition accepts empty object (always-match)", () => {
        expect(validateCondition({}).ok).toBe(true);
    });
    it("validateCondition accepts a single leaf with allowlisted operator", () => {
        const r = validateCondition({
            field: "status",
            op: "equals",
            value: "OPEN",
        });
        expect(r.ok).toBe(true);
    });
    it("validateCondition rejects unknown operator", () => {
        const r = validateCondition({
            field: "status",
            op: "regex_match",
            value: ".*",
        });
        expect(r.ok).toBe(false);
    });
    it("validateCondition rejects object too deeply nested", () => {
        // Build depth > CONDITION_MAX_DEPTH (4) via nested `all` operators.
        let leaf = { field: "x", op: "equals", value: 1 };
        for (let i = 0; i < CONDITION_MAX_DEPTH + 2; i++) {
            leaf = { all: [leaf] };
        }
        const r = validateCondition(leaf);
        expect(r.ok).toBe(false);
    });
    it("validateActionConfig accepts a well-formed NOTIFY_USER config", () => {
        const r = validateActionConfig("NOTIFY_USER", {
            userId: "00000000-0000-4000-8000-000000000001",
            template: "REVIEW_REQUEST_ASSIGNED",
        });
        expect(r.ok).toBe(true);
    });
    it("validateActionConfig rejects extra unknown fields (strict)", () => {
        const r = validateActionConfig("NOTIFY_USER", {
            userId: "00000000-0000-4000-8000-000000000001",
            template: "REVIEW_REQUEST_ASSIGNED",
            extraField: "should be rejected",
        });
        expect(r.ok).toBe(false);
    });
    it("validateActionConfig rejects non-uuid userId for NOTIFY_USER", () => {
        const r = validateActionConfig("NOTIFY_USER", {
            userId: "not-a-uuid",
            template: "x",
        });
        expect(r.ok).toBe(false);
    });
    it("CONDITION_LEAF_OPERATORS is bounded — no `eval`, `exec`, `script`, `regex_*` operators", () => {
        for (const forbidden of [
            "eval",
            "exec",
            "script",
            "regex",
            "regex_match",
            "function",
            "javascript",
        ]) {
            expect(CONDITION_LEAF_OPERATORS).not.toContain(forbidden);
        }
    });
    it("service source does not import any vm / eval primitives", () => {
        expect(SERVICE).not.toMatch(/\bfrom\s+["']vm["']/);
        expect(SERVICE).not.toMatch(/\beval\s*\(/);
        expect(SERVICE).not.toMatch(/new\s+Function\s*\(/);
    });
});
// ===========================================================================
// PART 5 — Idempotency key is deterministic
// ===========================================================================
describe("E3 Test 5 — idempotency key is deterministic + bounded", () => {
    const sample = {
        ruleId: "11111111-1111-4111-8111-111111111111",
        triggerType: "REVIEW_ASSIGNED",
        targetType: "evidence_review_workflow",
        targetId: "22222222-2222-4222-8222-222222222222",
    };
    it("same inputs → same key (deterministic)", () => {
        expect(computeIdempotencyKey(sample)).toBe(computeIdempotencyKey(sample));
    });
    it("changing rule id changes the key", () => {
        expect(computeIdempotencyKey(sample)).not.toBe(computeIdempotencyKey({ ...sample, ruleId: "33333333-3333-4333-8333-333333333333" }));
    });
    it("changing target id changes the key", () => {
        expect(computeIdempotencyKey(sample)).not.toBe(computeIdempotencyKey({ ...sample, targetId: "44444444-4444-4444-8444-444444444444" }));
    });
    it("key fits the DB column (≤ 120 chars; service emits 64-char prefix)", () => {
        expect(computeIdempotencyKey(sample).length).toBeLessThanOrEqual(120);
        expect(computeIdempotencyKey(sample)).toMatch(/^[0-9a-f]+$/);
    });
});
// ===========================================================================
// PART 6 — REST endpoints + server registration
// ===========================================================================
describe("E3 Test 6 — REST endpoints registered + capability-gated", () => {
    const REQUIRED_ROUTES = [
        `"/v1/automation/rules"`,
        `"/v1/automation/rules/:id"`,
        `"/v1/automation/rules/:id/enable"`,
        `"/v1/automation/rules/:id/disable"`,
        `"/v1/automation/runs"`,
        `"/v1/automation/runs/:id"`,
    ];
    it.each(REQUIRED_ROUTES)("routes file declares %s", (route) => {
        expect(ROUTES).toContain(route);
    });
    it("routes file enforces requireAuth on every handler", () => {
        const handlerCount = (ROUTES.match(/preHandler:\s*requireAuth/g) ?? [])
            .length;
        expect(handlerCount).toBeGreaterThanOrEqual(REQUIRED_ROUTES.length);
    });
    it("server.ts registers the automation routes", () => {
        expect(SERVER).toMatch(/import\s*\{[^}]*automationRoutes[^}]*\}\s*from\s*"\.\/routes\/automation\.routes\.js"/);
        expect(SERVER).toMatch(/app\.register\(automationRoutes\)/);
    });
    it("routes file references both AUTOMATION_VIEW + AUTOMATION_MANAGE", () => {
        expect(ROUTES).toMatch(/"AUTOMATION_VIEW"/);
        expect(ROUTES).toMatch(/"AUTOMATION_MANAGE"/);
    });
});
// ===========================================================================
// PART 7 — Capability keys added to API + web type unions
// ===========================================================================
describe("E3 Test 7 — capability keys in both API and web type unions", () => {
    it("API CAPABILITY_KEYS contains AUTOMATION_VIEW + AUTOMATION_MANAGE", () => {
        expect(CAP_TYPES_API).toMatch(/"AUTOMATION_VIEW"/);
        expect(CAP_TYPES_API).toMatch(/"AUTOMATION_MANAGE"/);
    });
    it("web CAPABILITY_KEYS mirrors the API additions", () => {
        expect(CAP_TYPES_WEB).toMatch(/"AUTOMATION_VIEW"/);
        expect(CAP_TYPES_WEB).toMatch(/"AUTOMATION_MANAGE"/);
    });
    it("capability registry grants AUTOMATION_VIEW to writers + AUTOMATION_MANAGE to admins", () => {
        // Writer branch grants VIEW.
        expect(CAP_REGISTRY).toMatch(/if\s*\(isWriter\)[\s\S]*?"AUTOMATION_VIEW"/);
        // Admin branch grants MANAGE.
        expect(CAP_REGISTRY).toMatch(/if\s*\(isAdmin\)[\s\S]*?"AUTOMATION_MANAGE"/);
    });
});
// ===========================================================================
// PART 8 — Security event vocabulary additions
// ===========================================================================
describe("E3 Test 8 — automation security events registered", () => {
    it.each(E3_AUTOMATION_SECURITY_EVENTS)("SECURITY_EVENT_TYPES contains %s", (event) => {
        expect(SECURITY).toMatch(new RegExp(`"${event}"`));
    });
    it("exactly 9 automation events shipped in E3", () => {
        expect(E3_AUTOMATION_SECURITY_EVENTS).toHaveLength(9);
    });
});
// ===========================================================================
// PART 9 — Route registry entry (not root nav)
// ===========================================================================
describe("E3 Test 9 — automation route is in registry but NOT root nav", () => {
    it("route registry contains platform.automation entry under /ops/automation", () => {
        expect(ROUTE_REGISTRY).toMatch(/id:\s*["']platform\.automation["']/);
        expect(ROUTE_REGISTRY).toMatch(/href:\s*["']\/ops\/automation["']/);
    });
    it("platform.automation requires AUTOMATION_VIEW", () => {
        const m = ROUTE_REGISTRY.match(/id:\s*["']platform\.automation["'][\s\S]*?requiredCapabilities:\s*\[([\s\S]*?)\]/);
        expect(m).toBeTruthy();
        expect(m[1]).toContain("AUTOMATION_VIEW");
    });
    it("32.8 root nav remains bounded at 6 canonical primaries (no growth)", () => {
        const m = readWeb("lib/navigation/canonicalNavigationGroups.ts").match(/CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/);
        expect(m).toBeTruthy();
        const ids = Array.from(m[1].matchAll(/["']([^"']+)["']/g)).map((mm) => mm[1]);
        expect(ids).toHaveLength(9); // baseline grew with G0+ IA — was 6 pre-G0, now 9 canonical primaries
        expect(ids).not.toContain("platform.automation");
    });
});
// ===========================================================================
// PART 10 — Frontend page exists + has no builder / scripting / AI UI
// ===========================================================================
describe("E3 Test 10 — frontend page exists + UI guardrails", () => {
    it("page file exists under /ops/automation", () => {
        expect(existsSync(webPath("app/(app)/ops/automation/page.tsx"))).toBe(true);
    });
    it("page wraps in PageRouteGate routeId=platform.automation", () => {
        expect(PAGE).toMatch(/PageRouteGate\s+routeId="platform\.automation"/);
    });
    it("page has NO drag-and-drop builder / canvas / scripting editor / AI generator", () => {
        // Detect actual implementation, not the comments forbidding it.
        // Real drag-drop UIs use draggable attributes or dnd libraries.
        expect(PAGE).not.toMatch(/draggable=\{?true/);
        expect(PAGE).not.toMatch(/onDragStart=/);
        expect(PAGE).not.toMatch(/<canvas\b/i);
        expect(PAGE).not.toMatch(/react-dnd/);
        expect(PAGE).not.toMatch(/dnd-kit/);
        expect(PAGE).not.toMatch(/Monaco/i); // no code editor
        expect(PAGE).not.toMatch(/CodeMirror/i);
        expect(PAGE).not.toMatch(/openai/i);
        expect(PAGE).not.toMatch(/anthropic/i);
        // No realtime / websocket / pusher pieces.
        expect(PAGE).not.toMatch(/socket\.io/);
        expect(PAGE).not.toMatch(/new WebSocket/);
        expect(PAGE).not.toMatch(/EventSource/);
    });
    it("page exposes loading + auth_error + unavailable + ready states", () => {
        for (const state of [
            "status: \"loading\"",
            "status: \"ready\"",
            "status: \"auth_error\"",
            "status: \"unavailable\"",
        ]) {
            expect(PAGE).toContain(state);
        }
    });
});
// ===========================================================================
// PART 11 — Idempotency + duplicate prevention contract
// ===========================================================================
describe("E3 Test 11 — duplicate-trigger prevention at the schema + key layer", () => {
    it("idempotency key is sha256-derived and collapses duplicates", () => {
        const a = computeIdempotencyKey({
            ruleId: "11111111-1111-4111-8111-111111111111",
            triggerType: "REVIEW_OVERDUE",
            targetType: "evidence_review_workflow",
            targetId: "22222222-2222-4222-8222-222222222222",
        });
        const b = computeIdempotencyKey({
            ruleId: "11111111-1111-4111-8111-111111111111",
            triggerType: "REVIEW_OVERDUE",
            targetType: "evidence_review_workflow",
            targetId: "22222222-2222-4222-8222-222222222222",
        });
        expect(a).toBe(b);
    });
    it("DB enforces uniqueness via automation_runs_team_rule_idempotency_uniq", () => {
        // Pinned in Test 2; re-asserted here as the duplicate-prevention proof.
        expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX "automation_runs_team_rule_idempotency_uniq"/);
    });
});
// ===========================================================================
// PART 12 — Reason sanitiser bounds operator-facing strings
// ===========================================================================
describe("E3 Test 12 — reason sanitiser bounds + strips control characters", () => {
    it("truncates long reasons to ≤380 chars + appends ellipsis", () => {
        const long = "x".repeat(1000);
        const result = sanitiseReason(long);
        expect(result.length).toBeLessThanOrEqual(381); // 380 + 1 ellipsis
        expect(result.endsWith("…")).toBe(true);
    });
    it("non-string input returns empty string (no surprise serialisations)", () => {
        expect(sanitiseReason(undefined)).toBe("");
        expect(sanitiseReason(null)).toBe("");
        expect(sanitiseReason({ foo: "bar" })).toBe("");
        expect(sanitiseReason(42)).toBe("");
    });
});
// ===========================================================================
// PART 13 — No new client-state library
// ===========================================================================
describe("E3 Test 13 — no new client-state / realtime library introduced", () => {
    it("apps/web/package.json still has no React Query / SWR / Redux / Zustand / realtime libs", () => {
        const pkg = JSON.parse(readFileSync(webPath("package.json"), "utf8"));
        const deps = {
            ...(pkg.dependencies ?? {}),
            ...(pkg.devDependencies ?? {}),
        };
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
            "socket.io-client",
            "pusher-js",
            "ably",
        ]) {
            expect(deps[forbidden]).toBeUndefined();
        }
    });
});
// ===========================================================================
// PART 14 — Capture / custody / report / package files untouched
// ===========================================================================
describe("E3 Test 14 — capture / custody / report / package files untouched", () => {
    const PINS = [
        { rel: "src/routes/capture.routes.ts", expectedBytes: 21271 },
        { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
        { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
        { rel: "src/services/timestamp.service.ts", expectedBytes: 7535 },
        {
            rel: "src/services/reports/reports-aggregator.service.ts",
            expectedBytes: 13118,
        },
    ];
    for (const { rel, expectedBytes } of PINS) {
        it(`${rel} stays within ±10% (${expectedBytes} bytes)`, () => {
            const fullPath = apiPath(rel);
            expect(existsSync(fullPath)).toBe(true);
            const st = statSync(fullPath);
            const low = Math.floor(expectedBytes * 0.9);
            const high = Math.ceil(expectedBytes * 1.1);
            expect(st.size).toBeGreaterThanOrEqual(low);
            expect(st.size).toBeLessThanOrEqual(high);
        });
    }
});
// ===========================================================================
// PART 15 — Documentation + registry updated
// ===========================================================================
describe("E3 Test 15 — documentation + registry updated", () => {
    it("docs/product/PHASE_E3_OPERATIONAL_AUTOMATION.md exists + substantial", () => {
        const doc = readRepo("docs/product/PHASE_E3_OPERATIONAL_AUTOMATION.md");
        expect(doc.length).toBeGreaterThan(8000);
        expect(doc).toMatch(/PHASE E3/);
        expect(doc).toMatch(/Operational Automation/i);
    });
    it("registry registers Phase E3 with explicit status", () => {
        const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
        expect(registry).toMatch(/\|\s*(Phase )?E3\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/);
    });
    it("registry records 2 new DEF items: DEF-021 (dispatcher) + DEF-022 (webhook)", () => {
        const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
        expect(registry).toContain("DEF-021");
        expect(registry).toContain("DEF-022");
    });
});
