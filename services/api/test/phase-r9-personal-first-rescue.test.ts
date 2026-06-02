/**
 * Phase R9 — Personal-first rescue regression test.
 *
 * Pins the fix for the production regression where personal-workspace
 * users were seeing "Workspace setup required" on every core product
 * route despite having valid `Team` + `TeamMember` rows in the DB.
 *
 * Root cause (read-only investigation report):
 *   `routeAccessResolver` consulted ONLY `activeSpace.type`. If the
 *   backend envelope returned a partial projection where `activeSpace`
 *   was missing/empty (degraded section, schema downgrade, synthetic
 *   fallback), every `PERSONAL_OR_ORG`-gated route returned
 *   `NEEDS_PERSONAL_OR_ORG`. Personal-first product contract was
 *   violated because no fallback inspection of `envelope.personalSpace`
 *   or `envelope.workspace` existed.
 *
 * Fix (this file's contract):
 *   1. routeAccessResolver accepts optional `workspace` + `personalSpace`
 *      fragments and grants PERSONAL_OR_ORG access when either is healthy.
 *   2. PageRouteGate passes those fragments from the envelope.
 *   3. ORGANIZATION_ONLY routes are UNCHANGED — fallback never widens
 *      org-only access. Personal-only users still get NEEDS_ORGANIZATION
 *      on governance / access-review / cross-org / reviewer-ops surfaces.
 *   4. buildPlatformContext refuses to emit `type: "ORGANIZATION"` with
 *      an empty id — falls back to PERSONAL when no real workspace id
 *      is available, so personal users always have a usable activeSpace.
 *   5. Signup handlers (registerWithEmailPassword + upsertUserWithEmailLink)
 *      eagerly call ensurePersonalWorkspace and set currentWorkspaceId,
 *      so new users can use the core product on first request without
 *      depending on /v1/platform/context succeeding first.
 *   6. Entitlement projection remains user-level — PRO works for personal
 *      users without any team billing_status filter.
 *
 * Test style: mix of source-contract (file-text assertions) + behavioral
 * (pure-function imports). No DB I/O. Matches the convention used by
 * phase-emergency-recovery-bootstrap.test.ts.
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

const RESOLVER_SRC = readWeb("lib/navigation/routeAccessResolver.ts");
const PAGE_GATE_SRC = readWeb("components/navigation/PageRouteGate.tsx");
const PLATFORM_CTX_SRC = readApi(
  "src/services/platform-context/platform-context.service.ts",
);
const EMAIL_AUTH_SRC = readApi("src/services/email-password-auth.service.ts");
const AUTH_SRC = readApi("src/services/auth.service.ts");

// =============================================================================
// PART 1 — Source contract: resolver accepts the new fields + fallback exists
// =============================================================================

describe("Phase R9 — routeAccessResolver source contract", () => {
  it("RouteAccessInput exposes optional `workspace` and `personalSpace`", () => {
    expect(RESOLVER_SRC).toMatch(/workspace\?\s*:/);
    expect(RESOLVER_SRC).toMatch(/personalSpace\?\s*:/);
  });

  it("declares the hasUsablePersonalOrOrgEvidence rescue helper", () => {
    expect(RESOLVER_SRC).toMatch(/function\s+hasUsablePersonalOrOrgEvidence/);
  });

  it("PERSONAL_OR_ORG branch consults the rescue helper before refusing", () => {
    // The new branch must call the helper and only fall to
    // NEEDS_PERSONAL_OR_ORG when the helper returns false.
    expect(RESOLVER_SRC).toMatch(
      /requiredActiveSpace === "PERSONAL_OR_ORG"[\s\S]*?hasUsablePersonalOrOrgEvidence/,
    );
  });

  it("ORGANIZATION_ONLY branch does NOT call the personal/workspace rescue", () => {
    // Find the ORG_ONLY block boundaries and assert the helper isn't
    // invoked inside it. Otherwise the rescue would silently widen
    // governance access to personal-only users.
    const orgBlockStart = RESOLVER_SRC.indexOf(
      'requiredActiveSpace === "ORGANIZATION_ONLY"',
    );
    const orgBlockEnd = RESOLVER_SRC.indexOf(
      'requiredActiveSpace === "PERSONAL_OR_ORG"',
    );
    expect(orgBlockStart).toBeGreaterThan(0);
    expect(orgBlockEnd).toBeGreaterThan(orgBlockStart);
    const orgOnlySection = RESOLVER_SRC.slice(orgBlockStart, orgBlockEnd);
    expect(orgOnlySection).not.toMatch(/hasUsablePersonalOrOrgEvidence/);
    // And the only branch that allows org-only is still
    // `activeSpaceType !== "ORGANIZATION"`.
    expect(orgOnlySection).toMatch(/activeSpaceType !== "ORGANIZATION"/);
  });
});

// =============================================================================
// PART 2 — Behavioral: pure function fallback
// =============================================================================

describe("Phase R9 — resolveRouteAccess behavioral fallback", () => {
  type Resolver = typeof import(
    "../../../apps/web/lib/navigation/routeAccessResolver.js"
  );

  async function loadResolver(): Promise<Resolver> {
    return import(
      "../../../apps/web/lib/navigation/routeAccessResolver.js"
    );
  }

  // Minimal RouteDefinition shape — only the fields resolver reads.
  function makeRoute(opts: {
    requiredActiveSpace:
      | "NONE"
      | "PERSONAL_OR_ORG"
      | "ORGANIZATION_ONLY"
      | "PLATFORM_ADMIN";
  }) {
    return {
      id: "test.route",
      href: "/test",
      label: "Test",
      description: "",
      domain: "WORKSPACE",
      requiredCapabilities: [],
      requiredActiveSpace: opts.requiredActiveSpace,
      fallbackBehavior: "REQUEST_ACCESS",
      workflowTags: [],
      // Some fields that downstream code may read but resolver ignores.
    } as unknown as Parameters<Resolver["resolveRouteAccess"]>[0]["route"];
  }

  it("PERSONAL_OR_ORG: ALLOWED when activeSpaceType is PERSONAL", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute({ requiredActiveSpace: "PERSONAL_OR_ORG" }),
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: {},
    });
    expect(res.accessState).toBe("ALLOWED");
    expect(res.canLoad).toBe(true);
  });

  it("PERSONAL_OR_ORG: ALLOWED via personalSpace.id fallback even when activeSpaceType is null", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute({ requiredActiveSpace: "PERSONAL_OR_ORG" }),
      activeSpaceType: null,
      isPlatformAdmin: false,
      capabilities: {},
      personalSpace: { id: "personal-uuid-123", status: "active" },
    });
    expect(res.accessState).toBe("ALLOWED");
    expect(res.canLoad).toBe(true);
  });

  it("PERSONAL_OR_ORG: ALLOWED via workspace.id fallback even when activeSpaceType is null", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute({ requiredActiveSpace: "PERSONAL_OR_ORG" }),
      activeSpaceType: null,
      isPlatformAdmin: false,
      capabilities: {},
      workspace: { id: "team-uuid-456", status: "active" },
    });
    expect(res.accessState).toBe("ALLOWED");
    expect(res.canLoad).toBe(true);
  });

  it("PERSONAL_OR_ORG: still DENIED when both workspace and personalSpace are empty", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute({ requiredActiveSpace: "PERSONAL_OR_ORG" }),
      activeSpaceType: null,
      isPlatformAdmin: false,
      capabilities: {},
      workspace: { id: null, status: "no-workspace" },
      personalSpace: { id: null, status: "degraded" },
    });
    expect(res.accessState).toBe("NEEDS_PERSONAL_OR_ORG");
    expect(res.canLoad).toBe(false);
  });

  it("PERSONAL_OR_ORG: DENIED when workspace.status='no-workspace' and personalSpace absent", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute({ requiredActiveSpace: "PERSONAL_OR_ORG" }),
      activeSpaceType: null,
      isPlatformAdmin: false,
      capabilities: {},
      workspace: { id: "team-id", status: "no-workspace" },
      personalSpace: null,
    });
    expect(res.accessState).toBe("NEEDS_PERSONAL_OR_ORG");
  });

  it("PERSONAL_OR_ORG: ALLOWED via personalSpace even when workspace is degraded", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute({ requiredActiveSpace: "PERSONAL_OR_ORG" }),
      activeSpaceType: null,
      isPlatformAdmin: false,
      capabilities: {},
      workspace: { id: null, status: "no-workspace" },
      personalSpace: { id: "personal-uuid-789", status: "active" },
    });
    expect(res.accessState).toBe("ALLOWED");
  });

  it("ORGANIZATION_ONLY: BLOCKS personal-only envelope (rescue MUST NOT widen org-only)", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute({ requiredActiveSpace: "ORGANIZATION_ONLY" }),
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: {},
      // Even with a healthy personalSpace, ORG_ONLY must NOT pass.
      personalSpace: { id: "personal-uuid", status: "active" },
      workspace: { id: "personal-team", status: "active" },
    });
    expect(res.accessState).toBe("NEEDS_ORGANIZATION");
    expect(res.canLoad).toBe(false);
  });

  it("ORGANIZATION_ONLY: BLOCKS null activeSpace even with healthy personalSpace", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute({ requiredActiveSpace: "ORGANIZATION_ONLY" }),
      activeSpaceType: null,
      isPlatformAdmin: false,
      capabilities: {},
      personalSpace: { id: "personal-uuid", status: "active" },
    });
    expect(res.accessState).toBe("NEEDS_ORGANIZATION");
  });

  it("ORGANIZATION_ONLY: ALLOWED only when activeSpaceType is ORGANIZATION", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute({ requiredActiveSpace: "ORGANIZATION_ONLY" }),
      activeSpaceType: "ORGANIZATION",
      isPlatformAdmin: false,
      capabilities: {},
    });
    expect(res.accessState).toBe("ALLOWED");
  });

  it("backwards-compatible: omitting workspace/personalSpace still works for happy path", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute({ requiredActiveSpace: "PERSONAL_OR_ORG" }),
      activeSpaceType: "ORGANIZATION",
      isPlatformAdmin: false,
      capabilities: {},
      // workspace/personalSpace deliberately omitted — pre-rescue call sites
    });
    expect(res.accessState).toBe("ALLOWED");
  });
});

// =============================================================================
// PART 3 — PageRouteGate threads envelope context into the resolver
// =============================================================================

describe("Phase R9 — PageRouteGate envelope plumbing", () => {
  // Phase G4 cleanup → Phase R9 evolution: PageRouteGate now reads
  // workspace + personalSpace through the canonical
  // `useWorkspaceFragment()` / `usePersonalSpaceFragment()` hooks
  // (centralized inside `lib/platform-context/`), instead of inlining
  // `envelope.workspace.id` reads at the call site. Either pattern
  // preserves the R9 contract — the resolver still receives the
  // fragments — but the centralized form also satisfies Phase G4's
  // "no direct envelope.workspace.* reads outside platform-context"
  // rule. Accept either form here.
  const HAS_FRAGMENT_HOOK =
    /useWorkspaceFragment\b/.test(PAGE_GATE_SRC) &&
    /workspace:\s*workspaceFragment/.test(PAGE_GATE_SRC);
  const HAS_PERSONAL_HOOK =
    /usePersonalSpaceFragment\b/.test(PAGE_GATE_SRC) &&
    /personalSpace:\s*personalSpaceFragment/.test(PAGE_GATE_SRC);

  it("passes workspace fragment from envelope into resolveRouteAccess", () => {
    const legacy =
      /workspace:\s*envelope\?\.workspace[\s\S]*?id:\s*envelope\.workspace\.id/.test(
        PAGE_GATE_SRC,
      );
    expect(legacy || HAS_FRAGMENT_HOOK).toBe(true);
  });

  it("passes personalSpace fragment from envelope into resolveRouteAccess", () => {
    const legacy =
      /personalSpace:\s*envelope\?\.personalSpace[\s\S]*?id:\s*envelope\.personalSpace\.id/.test(
        PAGE_GATE_SRC,
      );
    expect(legacy || HAS_PERSONAL_HOOK).toBe(true);
  });

  it("still passes activeSpaceType (primary signal — fallback is additive)", () => {
    expect(PAGE_GATE_SRC).toMatch(
      /activeSpaceType[\s\S]{0,200}envelope\?\.activeSpace\?\.type/,
    );
  });
});

// =============================================================================
// PART 4 — Backend: activeSpace derivation refuses to emit empty-id ORG
// =============================================================================

describe("Phase R9 — buildPlatformContext activeSpace derivation", () => {
  it("emits type=ORGANIZATION only when workspace.scope='TEAM' AND workspace.id is non-empty", () => {
    // The derivation matches: scope === "TEAM" AND workspace.id non-empty
    expect(PLATFORM_CTX_SRC).toMatch(
      /workspace\.scope === "TEAM" && workspaceIdNonEmpty/,
    );
    expect(PLATFORM_CTX_SRC).toMatch(
      /workspaceIdNonEmpty[\s\S]*?typeof workspace\.id === "string" && workspace\.id\.length > 0/,
    );
  });

  it("falls back to type=PERSONAL when workspace.id is empty or scope is not TEAM", () => {
    // The else branch picks the personal id when available.
    expect(PLATFORM_CTX_SRC).toMatch(
      /personalId[\s\S]*?workspaceIdNonEmpty[\s\S]*?personalSpace\.id/,
    );
    expect(PLATFORM_CTX_SRC).toMatch(/type:\s*"PERSONAL"[\s\S]*?id:\s*personalId/);
  });

  it("never emits ORGANIZATION with empty-string id (regression: was `id: workspace.id ?? \"\"`)", () => {
    // Confirm the empty-string fallback assignment is gone.
    expect(PLATFORM_CTX_SRC).not.toMatch(/type:\s*"ORGANIZATION"[\s\S]{0,200}id:\s*workspace\.id\s*\?\?\s*""/);
  });
});

// =============================================================================
// PART 5 — Entitlement projection remains user-level (PRO without org)
// =============================================================================

describe("Phase R9 — entitlement projection is user-level (PRO without org)", () => {
  it("entitlement.findFirst is user-scoped (userId required; active:true added by the production billing-mismatch fix)", () => {
    // R9 originally asserted `where: { userId: userRow.id }` ONLY — the
    // intent was "do not gate on team.billingStatus / billingPlan" (the
    // bug it was preventing was an org-tier filter creeping into a
    // personal-tier lookup). Both call sites now additionally carry
    // `active: true` to mirror the authoritative billing guard in
    // `services/api/src/services/collaboration-team/billing-guards.ts`.
    // The R9 intent is preserved (no team-billing filter — see next
    // assertion); the extra `active: true` is the production fix and
    // is pinned by `production-billing-parity.test.ts`.
    const matches = PLATFORM_CTX_SRC.match(
      /entitlement\.findFirst\(\{\s*where:\s*\{\s*userId:\s*userRow\.id,\s*active:\s*true\s*\}/g,
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("entitlement projection does NOT filter on team.billingStatus or team.billingPlan", () => {
    // Find the entitlement.findFirst blocks and assert no billing
    // filter leaked into their where clauses.
    const re = /entitlement\.findFirst\(\{[\s\S]*?\}\)/g;
    const blocks = PLATFORM_CTX_SRC.match(re) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/billingStatus/);
      expect(block).not.toMatch(/billingPlan/);
      expect(block).not.toMatch(/billing_status/);
      expect(block).not.toMatch(/team:\s*\{/);
    }
  });
});

// =============================================================================
// PART 6 — Signup handlers eagerly bootstrap personal workspace
// =============================================================================

describe("Phase R9 — signup eager bootstrap", () => {
  it("email-password registerWithEmailPassword imports ensurePersonalWorkspace", () => {
    expect(EMAIL_AUTH_SRC).toMatch(
      /import\s*\{\s*ensurePersonalWorkspace\s*\}\s*from\s*["'].*workspace-bootstrap\.service\.js["']/,
    );
  });

  it("registerWithEmailPassword calls ensurePersonalWorkspace AFTER creating the user and BEFORE returning", () => {
    // Slice the source from `export async function registerWithEmailPassword`
    // to the next top-level `export async function` so we only assert on
    // the function body, not the whole file.
    const fnStart = EMAIL_AUTH_SRC.indexOf(
      "export async function registerWithEmailPassword",
    );
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const nextExport = EMAIL_AUTH_SRC.indexOf(
      "export async function loginWithEmailPassword",
      fnStart + 1,
    );
    expect(nextExport).toBeGreaterThan(fnStart);
    const body = EMAIL_AUTH_SRC.slice(fnStart, nextExport);

    const upsertIdx = body.indexOf("prisma.user.upsert");
    const bootstrapIdx = body.indexOf(
      "ensurePersonalWorkspace({ userId: user.id })",
    );
    // Last `return user;` inside the function body.
    const returnIdx = body.lastIndexOf("return user;");

    expect(upsertIdx).toBeGreaterThan(0);
    expect(bootstrapIdx).toBeGreaterThan(upsertIdx);
    expect(returnIdx).toBeGreaterThan(bootstrapIdx);
  });

  it("registerWithEmailPassword sets currentWorkspaceId only when NULL (no clobber)", () => {
    expect(EMAIL_AUTH_SRC).toMatch(
      /if\s*\(\s*!user\.currentWorkspaceId\s*&&\s*personal\.teamId\s*\)/,
    );
    expect(EMAIL_AUTH_SRC).toMatch(
      /prisma\.user\.update\([\s\S]*?data:\s*\{\s*currentWorkspaceId:\s*personal\.teamId\s*\}/,
    );
  });

  it("registerWithEmailPassword bootstrap failure is non-fatal (try/catch)", () => {
    // Bootstrap is wrapped so signup itself never errors out on
    // workspace-creation failure (platform-context has a lazy fallback).
    expect(EMAIL_AUTH_SRC).toMatch(
      /try\s*\{[\s\S]*?ensurePersonalWorkspace[\s\S]*?\}\s*catch/,
    );
  });

  it("auth.service upsertUserWithEmailLink imports ensurePersonalWorkspace", () => {
    expect(AUTH_SRC).toMatch(
      /import\s*\{\s*ensurePersonalWorkspace\s*\}\s*from\s*["'].*workspace-bootstrap\.service\.js["']/,
    );
  });

  it("upsertUserWithEmailLink calls ensurePersonalWorkspace AFTER user upsert", () => {
    const userCreateIdx = AUTH_SRC.indexOf("user = await prisma.user.create");
    const bootstrapIdx = AUTH_SRC.indexOf(
      "ensurePersonalWorkspace({ userId: user.id })",
    );
    expect(userCreateIdx).toBeGreaterThan(0);
    expect(bootstrapIdx).toBeGreaterThan(userCreateIdx);
  });

  it("upsertUserWithEmailLink sets currentWorkspaceId only when NULL (no guest-conversion clobber)", () => {
    expect(AUTH_SRC).toMatch(
      /if\s*\(\s*!user\.currentWorkspaceId\s*&&\s*personal\.teamId\s*\)/,
    );
  });

  it("upsertUserWithEmailLink bootstrap failure is non-fatal (try/catch wraps the bootstrap)", () => {
    expect(AUTH_SRC).toMatch(
      /try\s*\{[\s\S]*?ensurePersonalWorkspace[\s\S]*?\}\s*catch/,
    );
  });
});

// =============================================================================
// PART 7 — Product-contract regression guards
// =============================================================================

describe("Phase R9 — product contract", () => {
  it("no-organizations is NEVER treated as no-workspace in the resolver", () => {
    // Search the resolver for any reference to `organizations.length` or
    // similar — the only space signals must be activeSpaceType, workspace,
    // personalSpace. (No regression toward org-first.)
    expect(RESOLVER_SRC).not.toMatch(/organizations\.length\s*===\s*0/);
    expect(RESOLVER_SRC).not.toMatch(
      /organizations\.length\s*<\s*1[\s\S]*?NEEDS/,
    );
  });

  it("PERSONAL_OR_ORG and ORGANIZATION_ONLY remain the only two workspace-gated tiers", () => {
    // No accidental "PERSONAL_ONLY" / "ORG_OPTIONAL" introduced.
    expect(RESOLVER_SRC).not.toMatch(/PERSONAL_ONLY/);
    expect(RESOLVER_SRC).not.toMatch(/ORG_OPTIONAL/);
  });
});
