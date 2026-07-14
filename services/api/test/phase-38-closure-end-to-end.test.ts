/**
 * PHASE 38-CLOSURE — End-to-end source-contract + behavioral tests.
 *
 * Covers:
 *   1. Persona mutation API (file-level + behavioral)
 *   2. Terminology layer (pure-function, all 7 personas)
 *   3. Persona empty-state library (pure-function, no hidden routes)
 *   4. Topbar persona chip + onboarding wizard wired
 *   5. Server registration of the new route
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const ROUTE = readApi("src/routes/workspace-persona.routes.ts");
const SERVER = readApi("src/server.ts");

const WEB_TERMS = readWeb("lib/platform-context/useTerminology.ts");
const WEB_EMPTY = readWeb("lib/platform-context/personaEmptyStates.ts");
const WEB_INDEX = readWeb("lib/platform-context/index.ts");
const WEB_WIZARD = readWeb("app/(app)/settings/persona/page.tsx");

// =============================================================================
// PART 1 — Persona mutation API source contract
// =============================================================================

describe("Phase 38-closure — persona mutation route", () => {
  it("declares both GET and PATCH endpoints on /v1/workspaces/:teamId/persona", () => {
    expect(ROUTE).toMatch(
      /app\.get\(\s*"\/v1\/workspaces\/:teamId\/persona"/,
    );
    expect(ROUTE).toMatch(
      /app\.patch\(\s*"\/v1\/workspaces\/:teamId\/persona"/,
    );
  });

  it("uses the canonical authorize helper (never local role check)", () => {
    expect(ROUTE).toMatch(/authorizeOrFail/);
    // No raw role comparisons or magic-string permission checks.
    expect(ROUTE).not.toMatch(/role\s*===\s*"OWNER"/);
    expect(ROUTE).not.toMatch(/role\s*===\s*"ADMIN"/);
    expect(ROUTE).not.toMatch(/MEMBER/);
  });

  it("read endpoint gates on identity.org_policy.read", () => {
    expect(ROUTE).toMatch(/permission:\s*"identity\.org_policy\.read"/);
  });

  it("update endpoint gates on identity.org_policy.manage", () => {
    expect(ROUTE).toMatch(/permission:\s*"identity\.org_policy\.manage"/);
  });

  it("uses Zod validation for body + params (bounded vocabularies)", () => {
    expect(ROUTE).toMatch(/UpdatePersonaSchema/);
    expect(ROUTE).toMatch(/z\.enum\(/);
    expect(ROUTE).toMatch(/WORKSPACE_PERSONA_PROFILES/);
    expect(ROUTE).toMatch(/OPERATIONAL_DENSITY_PREFERENCES/);
  });

  it("anti-enumeration: both endpoints pass antiEnumeration: true to authorize", () => {
    const calls = ROUTE.match(/authorizeOrFail\(req,\s*reply,\s*\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toMatch(/antiEnumeration:\s*true/);
    }
  });

  it("emits a bounded audit event (workspace.persona.updated)", () => {
    expect(ROUTE).toMatch(/appendPlatformAuditLog/);
    expect(ROUTE).toMatch(/action:\s*"workspace\.persona\.updated"/);
  });

  it("audit metadata is bounded — no secrets / large payloads", () => {
    // Sanity: metadata fields are the expected bounded names.
    expect(ROUTE).toMatch(/before:\s*\{[\s\S]*?primaryProfile/);
    expect(ROUTE).toMatch(/after:\s*\{[\s\S]*?primaryProfile/);
    expect(ROUTE).not.toMatch(/passwordHash/);
    expect(ROUTE).not.toMatch(/storageKey/);
  });

  it("upserts via the canonical Prisma table workspacePersonaProfile (no raw SQL)", () => {
    expect(ROUTE).toMatch(/prisma\.workspacePersonaProfile\.upsert/);
    expect(ROUTE).not.toMatch(/\$queryRaw|\$executeRaw/);
  });

  it("the route is registered in server.ts", () => {
    expect(SERVER).toMatch(/workspacePersonaRoutes/);
    expect(SERVER).toMatch(/app\.register\(workspacePersonaRoutes\)/);
  });
});

// =============================================================================
// PART 2 — Terminology layer (pure-function correctness)
// =============================================================================

describe("Phase 38-closure — terminology layer", () => {
  it("exports useTerminology + resolveTerminology + TerminologyKey", () => {
    expect(WEB_INDEX).toMatch(/useTerminology/);
    expect(WEB_INDEX).toMatch(/resolveTerminology/);
    expect(WEB_INDEX).toMatch(/TerminologyKey/);
  });

  it("LAWYER renames Case → Matter (canonical product example)", async () => {
    const { resolveTerminology } = await import(
      "../../../apps/web/lib/platform-context/useTerminology.js"
    );
    const t = resolveTerminology("LAWYER");
    expect(t.case).toBe("Matter");
    expect(t.casePlural).toBe("Matters");
    expect(t.timeline).toBe("Custody timeline");
  });

  it("INSURANCE renames Case → Claim and Queue → Claims queue", async () => {
    const { resolveTerminology } = await import(
      "../../../apps/web/lib/platform-context/useTerminology.js"
    );
    const t = resolveTerminology("INSURANCE");
    expect(t.case).toBe("Claim");
    expect(t.queue).toBe("Claims queue");
  });

  it("INDIVIDUAL preserves all canonical terms (no overrides)", async () => {
    const { resolveTerminology } = await import(
      "../../../apps/web/lib/platform-context/useTerminology.js"
    );
    const t = resolveTerminology("INDIVIDUAL");
    expect(t.case).toBe("Case");
    expect(t.evidence).toBe("Evidence");
    expect(t.report).toBe("Report");
  });

  it("every persona returns a complete terminology map (no missing keys)", async () => {
    const { resolveTerminology } = await import(
      "../../../apps/web/lib/platform-context/useTerminology.js"
    );
    const personas = [
      "INDIVIDUAL",
      "LAWYER",
      "INSURANCE",
      "INVESTIGATOR",
      "JOURNALIST",
      "ENTERPRISE_COMPLIANCE",
      "ADMIN_OPERATOR",
    ] as const;
    const requiredKeys = [
      "case",
      "casePlural",
      "evidence",
      "report",
      "timeline",
      "publicVerify",
      "review",
      "assignment",
      "dashboard",
      "queue",
      "incident",
    ];
    for (const persona of personas) {
      const t = resolveTerminology(persona);
      for (const k of requiredKeys) {
        expect(
          typeof (t as Record<string, unknown>)[k] === "string" &&
            (t as Record<string, string>)[k].length > 0,
          `${persona} must provide terminology[${k}]`,
        ).toBe(true);
      }
    }
  });

  it("terminology layer is UI-only — no Prisma / authorize / fetch calls", () => {
    expect(WEB_TERMS).not.toMatch(/prisma|apiFetch|fetch\(/);
    expect(WEB_TERMS).not.toMatch(/authorizeOrFail|requireAuth/);
  });
});

// =============================================================================
// PART 3 — Persona empty-state library
// =============================================================================

describe("Phase 38-closure — persona empty-state library", () => {
  it("exports resolvePersonaEmptyState + PersonaEmptyState + EmptyStateSurface", () => {
    expect(WEB_INDEX).toMatch(/resolvePersonaEmptyState/);
    expect(WEB_INDEX).toMatch(/EmptyStateSurface/);
    expect(WEB_INDEX).toMatch(/PersonaEmptyState/);
  });

  it("returns a complete shape for every surface (default + per-persona override)", async () => {
    const { resolvePersonaEmptyState } = await import(
      "../../../apps/web/lib/platform-context/personaEmptyStates.js"
    );
    const surfaces = [
      "cases",
      "reports",
      "evidence",
      "search",
      "reviewer-ops",
      "governance",
      "ops",
      "home",
    ] as const;
    const personas = [
      "INDIVIDUAL",
      "LAWYER",
      "INSURANCE",
      "INVESTIGATOR",
      "JOURNALIST",
      "ENTERPRISE_COMPLIANCE",
      "ADMIN_OPERATOR",
    ] as const;
    for (const persona of personas) {
      for (const surface of surfaces) {
        const state = resolvePersonaEmptyState({ persona, surface });
        expect(state.title.length).toBeGreaterThan(0);
        expect(state.body.length).toBeGreaterThan(0);
        expect(state.primaryCtaLabel.length).toBeGreaterThan(0);
        expect(state.primaryCtaHref).toMatch(/^\//);
      }
    }
  });

  it("LAWYER cases empty-state renames 'Case' → 'Matter'", async () => {
    const { resolvePersonaEmptyState } = await import(
      "../../../apps/web/lib/platform-context/personaEmptyStates.js"
    );
    const lawyer = resolvePersonaEmptyState({ persona: "LAWYER", surface: "cases" });
    expect(lawyer.title.toLowerCase()).toContain("matter");
  });

  it("empty states never hint at routes that aren't reachable (all hrefs start with /)", async () => {
    const { resolvePersonaEmptyState } = await import(
      "../../../apps/web/lib/platform-context/personaEmptyStates.js"
    );
    for (const persona of [
      "INDIVIDUAL",
      "LAWYER",
      "INSURANCE",
      "INVESTIGATOR",
      "JOURNALIST",
      "ENTERPRISE_COMPLIANCE",
      "ADMIN_OPERATOR",
    ] as const) {
      const surfaces = [
        "cases",
        "reports",
        "evidence",
        "search",
        "reviewer-ops",
        "governance",
        "ops",
        "home",
      ] as const;
      for (const surface of surfaces) {
        const state = resolvePersonaEmptyState({ persona, surface });
        expect(state.primaryCtaHref).toMatch(/^\//);
      }
    }
  });
});

// =============================================================================
// PART 4 — Onboarding wizard
// =============================================================================

describe("Phase 38-closure — onboarding", () => {
  it("onboarding wizard is a 4-step flow at /settings/persona", () => {
    expect(WEB_WIZARD).toMatch(/data-persona-wizard\b/);
    expect(WEB_WIZARD).toMatch(/data-persona-wizard-step-block="1"/);
    expect(WEB_WIZARD).toMatch(/data-persona-wizard-step-block="2"/);
    expect(WEB_WIZARD).toMatch(/data-persona-wizard-step-block="3"/);
    expect(WEB_WIZARD).toMatch(/data-persona-wizard-step-block="4"/);
  });

  it("onboarding wizard calls PATCH /v1/workspaces/:teamId/persona (no direct DB access)", () => {
    expect(WEB_WIZARD).toMatch(
      /apiFetch\(`\/v1\/workspaces\/\$\{encodeURIComponent\(workspaceId\)\}\/persona`/,
    );
    expect(WEB_WIZARD).toMatch(/method:\s*"PATCH"/);
  });

  it("onboarding wizard never creates a workspace (no POST /teams)", () => {
    expect(WEB_WIZARD).not.toMatch(/POST.*\/v1\/teams\b/);
    expect(WEB_WIZARD).not.toMatch(/createTeam|createWorkspace/);
  });

  it("onboarding wizard exposes save + draft + cancel-equivalent affordances", () => {
    expect(WEB_WIZARD).toMatch(/data-persona-wizard-save\b/);
    expect(WEB_WIZARD).toMatch(/data-persona-wizard-save-draft\b/);
    expect(WEB_WIZARD).toMatch(/data-persona-wizard-back\b/);
  });
});
