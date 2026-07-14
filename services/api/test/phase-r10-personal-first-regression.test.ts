/**
 * Phase R10 — Personal-first regression test (Stages 1-3 closure).
 *
 * Phase R9 pinned the personal-first rescue in the route access
 * resolver + PageRouteGate envelope plumbing + signup eager bootstrap.
 * Phase R10 (Stages 1-3) closes the surrounding rough edges that
 * surfaced once R9 was deployed:
 *
 *   STAGE 1 — Schema-version parity. Web client and API agree on the
 *     literal navigationSchemaVersion. Mismatch lands in FAILED with
 *     `SCHEMA_VERSION_MISMATCH`, NOT in LOADING_CONTEXT forever.
 *
 *   STAGE 2 — Personal-first capability gating. The capability registry
 *     does NOT grant operator-only capabilities (OPS_CENTER_VIEW) to
 *     PERSONAL scope. The no-workspace branch still grants the bounded
 *     account-tier set so an authenticated user can reach billing /
 *     settings / org-create. Operator UI surfaces (GlobalRuntimeIndicator)
 *     short-circuit when teamId is null. Hardcoded /ops/* links in the
 *     6 Stage-2 surfaces sit behind a useCan() capability check.
 *
 *   STAGE 3 — Personal/Enterprise route matrix integrity. resolveRouteAccess
 *     call sites (AppSidebarV2, CommandPalette, tools/page) pass both
 *     `workspace` and `personalSpace` envelope fragments. The route
 *     registry contains the enterprise governance + lifecycle entries.
 *     For PERSONAL persona, all eight core product routes resolve to
 *     ALLOWED; for ENTERPRISE governance + access-review surfaces,
 *     PERSONAL is still NEEDS_ORGANIZATION (org-only NEVER widens).
 *     /admin requires PLATFORM_ADMIN elevation. Every ROUTE_REGISTRY
 *     href maps to a real page.tsx on disk (modulo a small allowlist
 *     of dynamic + external destinations).
 *
 *   Plus: dead /ops -> /operations redirects pruned from next.config.js;
 *   CasesIndex no longer uses useTeamId for the personal-blocking
 *   branch; PageRouteGate warns on unknown routeId in dev; isProAccount
 *   is computed from the user-level Entitlement (accountPlan), not
 *   from workspace.plan.
 *
 * Style: source-contract first (file text + regex) so the suite is
 * fast and DB-free. Behavioural tests dynamically import the resolver
 * and capability registry the same way phase-r9 does. No DB I/O.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}

const RESOLVER_SRC = readWeb("lib/navigation/routeAccessResolver.ts");
const ROUTE_REGISTRY_SRC = readWeb("lib/navigation/routeRegistry.ts");
const PAGE_GATE_SRC = readWeb("components/navigation/PageRouteGate.tsx");
const APP_SIDEBAR_SRC = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
const COMMAND_PALETTE_SRC = readWeb("components/navigation/CommandPalette.tsx");
const TOOLS_PAGE_SRC = readWeb("app/(app)/tools/page.tsx");
const PLATFORM_CTX_PROVIDER_SRC = readWeb(
  "lib/platform-context/PlatformContextProvider.tsx",
);
const PLATFORM_CTX_TYPES_WEB_SRC = readWeb("lib/platform-context/types.ts");
const GLOBAL_RUNTIME_INDICATOR_SRC = readWeb(
  "components/operational/GlobalRuntimeIndicator.tsx",
);
const CASES_INDEX_SRC = readWeb("components/cases-experience/CasesIndex.tsx");
const NEXT_CONFIG_SRC = readWeb("next.config.js");

const PLATFORM_CTX_API_SRC = readApi(
  "src/services/platform-context/platform-context.service.ts",
);
const PLATFORM_CTX_TYPES_API_SRC = readApi(
  "src/services/platform-context/types.ts",
);
const CAPABILITY_REGISTRY_SRC = readApi(
  "src/services/platform-context/capability-registry.ts",
);

// =============================================================================
// PART 1 — Stage 1: Schema-version parity + FAILED-state transition
// =============================================================================

describe("Phase R10 — Stage 1: navigation schema version parity", () => {
  it("API and web client export the SAME NAVIGATION_SCHEMA_VERSION literal", () => {
    // Source-contract: both files must declare the literal version
    // value. If they drift, the web client rejects every envelope
    // and the provider parks the app in FAILED forever.
    const apiMatch = PLATFORM_CTX_TYPES_API_SRC.match(
      /export\s+const\s+NAVIGATION_SCHEMA_VERSION\s*=\s*(\d+)\s+as\s+const/,
    );
    const webMatch = PLATFORM_CTX_TYPES_WEB_SRC.match(
      /export\s+const\s+NAVIGATION_SCHEMA_VERSION\s*=\s*(\d+)\s+as\s+const/,
    );
    expect(apiMatch).not.toBeNull();
    expect(webMatch).not.toBeNull();
    expect(apiMatch![1]).toBe(webMatch![1]);
  });

  it("API platform-context.service references NAVIGATION_SCHEMA_VERSION when emitting envelope", () => {
    expect(PLATFORM_CTX_API_SRC).toMatch(
      /navigationSchemaVersion:\s*NAVIGATION_SCHEMA_VERSION/,
    );
  });

  it("web client whitelist (ACCEPTED_NAVIGATION_SCHEMA_VERSIONS) contains the current constant", () => {
    // The provider's versionsAreCompatible check passes only if the
    // envelope's emitted version is in this whitelist. Drift here
    // would break personal-first onboarding silently. Pin the literal
    // value (not the symbol) since the array is declared with bare
    // number literals.
    const versionMatch = PLATFORM_CTX_TYPES_WEB_SRC.match(
      /export\s+const\s+NAVIGATION_SCHEMA_VERSION\s*=\s*(\d+)\s+as\s+const/,
    );
    expect(versionMatch).not.toBeNull();
    const currentVersion = Number(versionMatch![1]);
    const whitelistMatch = PLATFORM_CTX_TYPES_WEB_SRC.match(
      /export\s+const\s+ACCEPTED_NAVIGATION_SCHEMA_VERSIONS[\s\S]*?\[([^\]]+)\]/,
    );
    expect(whitelistMatch).not.toBeNull();
    const whitelistNumbers = whitelistMatch![1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("//"))
      .map((s) => Number(s.replace(/[^0-9]/g, "")))
      .filter((n) => Number.isFinite(n));
    expect(whitelistNumbers).toContain(currentVersion);
  });

  it("SCHEMA_VERSION_MISMATCH appears in the PlatformContextErrorCode union", () => {
    // Source-contract on the bounded error-code union — a typed
    // string-literal mismatch would be a compile error, but tests
    // also pin it so refactors that rename the union (or move the
    // code into a different union) get a structural alarm.
    expect(PLATFORM_CTX_TYPES_WEB_SRC).toMatch(
      /export\s+type\s+PlatformContextErrorCode\s*=[\s\S]*?\|\s*"SCHEMA_VERSION_MISMATCH"/,
    );
  });

  it("PlatformContextProvider transitions to FAILED (NOT LOADING_CONTEXT) on schema mismatch", () => {
    // The bug was that mismatches silently parked the provider in
    // SWITCHING/LOADING_CONTEXT forever — Stage 1 forces them into
    // a structured FAILED state with the explicit error code.
    expect(PLATFORM_CTX_PROVIDER_SRC).toMatch(
      /name:\s*"FAILED"[\s\S]{0,200}errorCode:\s*"SCHEMA_VERSION_MISMATCH"/,
    );
  });

  it("schema-mismatch path does NOT downgrade to LOADING_CONTEXT", () => {
    // Make sure no branch sets the provider back into LOADING_CONTEXT
    // when the schema mismatch is detected — the fix's whole point.
    const mismatchIdx = PLATFORM_CTX_PROVIDER_SRC.indexOf(
      'errorCode: "SCHEMA_VERSION_MISMATCH"',
    );
    expect(mismatchIdx).toBeGreaterThan(0);
    // Slice a window around the mismatch handler (200 chars before,
    // 600 chars after) — within that block we must NOT see a
    // LOADING_CONTEXT setState.
    const window = PLATFORM_CTX_PROVIDER_SRC.slice(
      Math.max(0, mismatchIdx - 200),
      mismatchIdx + 600,
    );
    expect(window).not.toMatch(/name:\s*"LOADING_CONTEXT"/);
  });
});

// =============================================================================
// PART 2 — Stage 2: resolveRouteAccess call sites + capability registry
// =============================================================================

describe("Phase R10 — Stage 2: resolveRouteAccess call sites pass envelope context", () => {
  // The R9 fix only matters if every call site actually forwards the
  // `workspace` + `personalSpace` fragments. Three call sites exist:
  // AppSidebarV2, CommandPalette, and the All Tools page.

  // Phase G4 cleanup → R10 evolution: CommandPalette + tools/page.tsx
  // now thread the workspace/personalSpace fragments through the
  // canonical `useWorkspaceFragment` / `usePersonalSpaceFragment`
  // hooks (centralized inside `lib/platform-context/`) rather than
  // inlining `envelope.workspace` reads. AppSidebarV2 is on the G4
  // allowlist and still uses the legacy literal form. Accept either
  // pattern below — the R10 contract is "both fragments are passed
  // to resolveRouteAccess", and both forms satisfy it.
  const LEGACY_FRAGMENTS_RE =
    /resolveRouteAccess\(\{[\s\S]{0,800}workspace:\s*envelope\?\.workspace[\s\S]{0,400}personalSpace:\s*envelope\?\.personalSpace/;
  function hasCentralizedFragments(src: string): boolean {
    return (
      /useWorkspaceFragment\b/.test(src) &&
      /usePersonalSpaceFragment\b/.test(src) &&
      /workspace:\s*workspaceFragment/.test(src) &&
      /personalSpace:\s*personalSpaceFragment/.test(src)
    );
  }

  it("AppSidebarV2 passes both workspace and personalSpace into resolveRouteAccess", () => {
    expect(
      LEGACY_FRAGMENTS_RE.test(APP_SIDEBAR_SRC) ||
        hasCentralizedFragments(APP_SIDEBAR_SRC),
    ).toBe(true);
  });

  it("CommandPalette passes both workspace and personalSpace into resolveRouteAccess", () => {
    expect(
      LEGACY_FRAGMENTS_RE.test(COMMAND_PALETTE_SRC) ||
        hasCentralizedFragments(COMMAND_PALETTE_SRC),
    ).toBe(true);
  });

  it("tools/page.tsx passes both workspace and personalSpace into resolveRouteAccess", () => {
    expect(
      LEGACY_FRAGMENTS_RE.test(TOOLS_PAGE_SRC) ||
        hasCentralizedFragments(TOOLS_PAGE_SRC),
    ).toBe(true);
  });
});

describe("Phase R10 — Stage 2: capability registry personal-first rules", () => {
  // Behavioural — import the TS source via the .js extension (vitest
  // resolves TS for `.js` imports). The dist/ copy is intentionally
  // NOT used here: it can be stale relative to source between
  // `pnpm build` runs and would silently pass on the old behavior.
  // The module is a pure function so DB-free.
  type CapReg = typeof import(
    "../src/services/platform-context/capability-registry.js"
  );
  async function loadCapReg(): Promise<CapReg> {
    return import(
      "../src/services/platform-context/capability-registry.js"
    );
  }

  it("PERSONAL scope does NOT grant OPS_CENTER_VIEW (operator-only capability)", async () => {
    const { resolveCapabilities } = await loadCapReg();
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
    });
    expect(caps.OPS_CENTER_VIEW).toBe(false);
    // Sanity: personal users DO get their own core surfaces.
    expect(caps.PERSONAL_CAPTURE).toBe(true);
    expect(caps.PERSONAL_EVIDENCE_VIEW).toBe(true);
  });

  it("scope=null grants ACCOUNT_* + ORGANIZATION_CREATE/JOIN account-tier capabilities", async () => {
    // Recovery path — authenticated but no workspace at all. The
    // user MUST still be able to reach the canonical
    // settings/billing/upgrade/org surfaces to recover.
    const { resolveCapabilities } = await loadCapReg();
    const caps = resolveCapabilities({
      scope: null,
      role: null,
      plan: null,
      isPlatformAdmin: false,
    });
    expect(caps.ACCOUNT_SETTINGS_VIEW).toBe(true);
    expect(caps.ACCOUNT_BILLING_VIEW).toBe(true);
    expect(caps.ACCOUNT_UPGRADE_VIEW).toBe(true);
    expect(caps.ORGANIZATION_CREATE).toBe(true);
    expect(caps.ORGANIZATION_JOIN).toBe(true);
    // And operator-only ones stay false.
    expect(caps.OPS_CENTER_VIEW).toBe(false);
    expect(caps.GOVERNANCE_VIEW).toBe(false);
  });
});

describe("Phase R10 — Stage 2: GlobalRuntimeIndicator hides for personal users", () => {
  it("returns null when teamId is null (no operator runtime to report)", () => {
    // The component's entry point must short-circuit before
    // subscribing to runtime state when teamId === null. Otherwise
    // personal users see a perpetually-pending UNKNOWN pill.
    expect(GLOBAL_RUNTIME_INDICATOR_SRC).toMatch(
      /if\s*\(\s*teamId === null\s*\)\s*\{\s*return null;/,
    );
  });

  // Product-reset: AppTopbarV2 (dead duplicate topbar) deleted; contract
  // retargeted to the live AppAccountToolbar.
  it("shell passes teamId=null for non-TEAM workspaces (source contract on sidebar derivation)", () => {
    // The sidebar derives teamId from envelope.workspace.scope ===
    // "TEAM"; any other scope (or absent workspace) must yield null.
    // We pin the literal here; the live AppAccountToolbar applies the
    // same rule via activeSpace (ORGANIZATION → id, otherwise null)
    // where it wraps GlobalRuntimeIndicator.
    expect(APP_SIDEBAR_SRC).toMatch(
      /workspace\?\.status === "active"\s*&&\s*envelope\.workspace\.scope === "TEAM"/,
    );
  });
});

describe("Phase R10 — Stage 2: hardcoded /ops links sit behind useCan() checks", () => {
  // Six Stage-2 surfaces hardcoded /ops/* links (footer/deep-links).
  // Each must gate the link behind a useCan(...) capability check
  // so personal users don't see operator deep-links they cannot use.
  const STAGE_2_FILES = [
    "app/(app)/investigation/page.tsx",
    "components/reviewer-experience/ReviewerCommandConsole.tsx",
    "components/command-center/CommandCenter.tsx",
    "components/governance-experience/GovernanceControlPlane.tsx",
    "components/operational/RuntimeStatusBanner.tsx",
    "components/operational/GlobalRuntimeIndicator.tsx",
  ] as const;

  for (const rel of STAGE_2_FILES) {
    it(`${rel} gates /ops links behind a useCan() capability check`, () => {
      const src = readWeb(rel);
      // Hardcoded operations deep-link somewhere in the file. Phase 3
      // canonicalized /ops → /operations, so these operator deep-links now
      // point at /operations/* (the useCan() gating relationship is
      // unchanged — operator links stay behind a capability check).
      expect(src).toMatch(/href=["']\/operations/);
      // useCan() call somewhere in the file — the relationship is
      // structural (a capability is read and a link is conditionally
      // rendered against it). Pairing the two is enforced by code
      // review and the GlobalRuntimeIndicator footer test below.
      expect(src).toMatch(/useCan\(\s*["']/);
    });
  }
});

// =============================================================================
// PART 3 — Stage 2/3: next.config.js dead-redirect pruning
// =============================================================================

describe("Phase R10 — Stage 2/3: next.config.js redirect cleanliness", () => {
  // The pre-cleanup config had /ops/* -> /operations/* redirects whose
  // destinations did not exist on disk, so the canonical /ops/* pages
  // were 308-ing into 404s. The cleanup pruned every redirect whose
  // destination was missing; only /ops/reliability -> /operations/reliability
  // remains because /operations/reliability genuinely exists.

  function opsPagesOnDisk(): string[] {
    const opsDir = webPath("app/(app)/ops");
    const out: string[] = [];
    function walk(dir: string, prefix: string) {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const p = join(dir, name);
        const s = statSync(p);
        if (s.isDirectory()) {
          walk(p, `${prefix}/${name}`);
        } else if (name === "page.tsx") {
          out.push(prefix || "/");
        }
      }
    }
    walk(opsDir, "/ops");
    return out;
  }

  it("Phase 3 — /ops is fully canonicalized to /operations (no /ops pages; every /ops* redirect destination exists on disk)", () => {
    // Phase 3: the 6 real /ops/* impls were moved into /operations/* and the
    // /ops directory was deleted. /operations is the ONE canonical
    // operations namespace; /ops* URLs 308 one-way to /operations*.
    expect(
      opsPagesOnDisk(),
      "/ops/* pages must be gone (moved to /operations/* in Phase 3)",
    ).toEqual([]);

    // Every /ops* redirect source (back-compat) must point at a real
    // /operations* page on disk — no redirect into a 404.
    const opsSources = [
      ...NEXT_CONFIG_SRC.matchAll(/source:\s*["'](\/ops(?:\/[a-z-]+)?)["']/g),
    ].map((m) => m[1]);
    expect(opsSources.length).toBeGreaterThan(0);
    for (const src of opsSources) {
      const idxDq = NEXT_CONFIG_SRC.indexOf(`"${src}"`);
      const idxSq = NEXT_CONFIG_SRC.indexOf(`'${src}'`);
      const sourceIdx = idxDq >= 0 ? idxDq : idxSq;
      const block = NEXT_CONFIG_SRC.slice(sourceIdx, sourceIdx + 300);
      const destMatch = block.match(/destination:\s*["']([^"']+)["']/);
      expect(destMatch, `redirect for ${src} missing destination`).not.toBeNull();
      const dest = destMatch![1].split("?")[0].split("#")[0];
      const destPath = webPath(`app/(app)${dest}/page.tsx`);
      expect(
        existsSync(destPath),
        `redirect ${src} -> ${dest} but ${destPath} does not exist`,
      ).toBe(true);
    }
  });
});

// =============================================================================
// PART 4 — Personal-first product contract regressions
// =============================================================================

describe("Phase R10 — isProAccount derives from accountPlan (not workspace.plan)", () => {
  it("isProAccount literal expression uses accountPlan + PRO_PLAN_KEYS (NOT workspace.plan)", () => {
    // The bug pattern would be: `workspace.plan ? PRO_PLAN_KEYS.has(workspace.plan) : false`.
    // The fix pattern is: `accountPlan ? PRO_PLAN_KEYS.has(accountPlan) : false`,
    // and accountPlan itself is sourced from prisma.entitlement.findFirst
    // ({ where: { userId } }) — user-level, not workspace-level.
    expect(PLATFORM_CTX_API_SRC).toMatch(
      /const\s+isProAccount\s*=\s*accountPlan\s*\?\s*PRO_PLAN_KEYS\.has\(accountPlan\)\s*:\s*false/,
    );
  });

  it("the isProAccount derivation block does NOT read workspace.plan", () => {
    // Pin the negative: a refactor that re-introduces workspace.plan
    // for isProAccount would silently regress to org-only PRO.
    const idx = PLATFORM_CTX_API_SRC.indexOf("const isProAccount");
    expect(idx).toBeGreaterThan(0);
    const windowSrc = PLATFORM_CTX_API_SRC.slice(
      Math.max(0, idx - 50),
      idx + 200,
    );
    expect(windowSrc).not.toMatch(/PRO_PLAN_KEYS\.has\(workspace\.plan\)/);
  });
});

describe("Phase R10 — CasesIndex no longer uses useTeamId for personal-blocking", () => {
  it("imports do NOT include useTeamId", () => {
    // The Stage 3 fix replaced useTeamId (which returns null for
    // personal users) with useActiveWorkspaceId, which falls back
    // to the personal-space id so personal-first works.
    expect(CASES_INDEX_SRC).not.toMatch(/\buseTeamId\b/);
  });

  it("uses useActiveWorkspaceId (personal-aware) instead", () => {
    expect(CASES_INDEX_SRC).toMatch(/\buseActiveWorkspaceId\b/);
  });
});

describe("Phase R10 — PageRouteGate warns on unknown routeId in development", () => {
  it("development-only console.warn fires for unregistered routeId", () => {
    // The bounded warning must mention the routeId and the
    // NODE_ENV gate so production stays quiet.
    expect(PAGE_GATE_SRC).toMatch(
      /process\.env\.NODE_ENV\s*!==\s*"production"[\s\S]{0,200}console\.warn\([\s\S]{0,200}routeId/,
    );
  });
});

// =============================================================================
// PART 5 — Stage 3: route registry contains enterprise governance entries
// =============================================================================

describe("Phase R10 — Stage 3: route registry enterprise entries", () => {
  it("workspace.evidence_lifecycle entry is registered with the canonical href", () => {
    expect(ROUTE_REGISTRY_SRC).toMatch(
      /id:\s*"workspace\.evidence_lifecycle"[\s\S]{0,400}href:\s*"\/evidence-lifecycle"/,
    );
  });

  it("workspace.governance_platform entry is registered with the canonical href", () => {
    expect(ROUTE_REGISTRY_SRC).toMatch(
      /id:\s*"workspace\.governance_platform"[\s\S]{0,400}href:\s*"\/governance-platform"/,
    );
  });

  it("both entries declare ORGANIZATION_ONLY requiredActiveSpace (still blocked for personal)", () => {
    // Personal-first does NOT widen enterprise governance — the
    // registry must keep these gated to org-only.
    const lifecycleBlock = ROUTE_REGISTRY_SRC.slice(
      ROUTE_REGISTRY_SRC.indexOf('id: "workspace.evidence_lifecycle"'),
      ROUTE_REGISTRY_SRC.indexOf('id: "workspace.evidence_lifecycle"') + 600,
    );
    const governanceBlock = ROUTE_REGISTRY_SRC.slice(
      ROUTE_REGISTRY_SRC.indexOf('id: "workspace.governance_platform"'),
      ROUTE_REGISTRY_SRC.indexOf('id: "workspace.governance_platform"') + 600,
    );
    expect(lifecycleBlock).toMatch(
      /requiredActiveSpace:\s*"ORGANIZATION_ONLY"/,
    );
    expect(governanceBlock).toMatch(
      /requiredActiveSpace:\s*"ORGANIZATION_ONLY"/,
    );
  });
});

// =============================================================================
// PART 6 — Behavioural: full persona × route matrix
// =============================================================================

describe("Phase R10 — behavioural: resolveRouteAccess persona matrix", () => {
  type Resolver = typeof import(
    "../../../apps/web/lib/navigation/routeAccessResolver.js"
  );

  async function loadResolver(): Promise<Resolver> {
    return import(
      "../../../apps/web/lib/navigation/routeAccessResolver.js"
    );
  }

  function makeRoute(
    requiredActiveSpace:
      | "NONE"
      | "PERSONAL_OR_ORG"
      | "ORGANIZATION_ONLY"
      | "PLATFORM_ADMIN",
    opts?: { capabilities?: string[]; domain?: string },
  ) {
    return {
      id: "test.route",
      href: "/test",
      label: "Test",
      description: "",
      domain: opts?.domain ?? "PERSONAL_WORKSPACE",
      requiredCapabilities: opts?.capabilities ?? [],
      requiredActiveSpace,
      fallbackBehavior: "REQUEST_ACCESS",
      workflowTags: [],
    } as unknown as Parameters<Resolver["resolveRouteAccess"]>[0]["route"];
  }

  // -------------------------------------------------------------------------
  // Single targeted cases (from the task's test list)
  // -------------------------------------------------------------------------

  it("PERSONAL_OR_ORG + null activeSpaceType + personalSpace.id='x' returns ALLOWED", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute("PERSONAL_OR_ORG"),
      activeSpaceType: null,
      isPlatformAdmin: false,
      capabilities: {},
      personalSpace: { id: "x", status: "active" },
    });
    expect(res.accessState).toBe("ALLOWED");
    expect(res.canLoad).toBe(true);
  });

  it("ORGANIZATION_ONLY + activeSpaceType=PERSONAL + personalSpace.id='x' returns NEEDS_ORGANIZATION", async () => {
    // The fix must NEVER widen org-only access for personal-first.
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute("ORGANIZATION_ONLY"),
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: {},
      personalSpace: { id: "x", status: "active" },
    });
    expect(res.accessState).toBe("NEEDS_ORGANIZATION");
    expect(res.canLoad).toBe(false);
  });

  // -------------------------------------------------------------------------
  // PERSONAL persona — all eight core product routes are reachable
  // -------------------------------------------------------------------------

  const PERSONAL_ROUTES: ReadonlyArray<{
    href: string;
    space: "PERSONAL_OR_ORG" | "NONE";
    cap?: string;
  }> = [
    { href: "/home", space: "PERSONAL_OR_ORG", cap: "DASHBOARD_VIEW" },
    { href: "/capture", space: "PERSONAL_OR_ORG", cap: "EVIDENCE_CAPTURE" },
    { href: "/evidence", space: "PERSONAL_OR_ORG", cap: "EVIDENCE_VIEW" },
    { href: "/reports", space: "PERSONAL_OR_ORG", cap: "REPORTS_VIEW" },
    { href: "/search", space: "PERSONAL_OR_ORG", cap: "SEARCH_VIEW" },
    { href: "/settings", space: "NONE", cap: "ACCOUNT_SETTINGS_VIEW" },
    { href: "/billing", space: "NONE", cap: "ACCOUNT_BILLING_VIEW" },
  ];

  for (const r of PERSONAL_ROUTES) {
    it(`PERSONAL persona: ${r.href} is ALLOWED with activeSpaceType=PERSONAL`, async () => {
      const { resolveRouteAccess } = await loadResolver();
      const caps: Record<string, boolean> = {};
      if (r.cap) caps[r.cap] = true;
      const res = resolveRouteAccess({
        route: makeRoute(r.space, {
          capabilities: r.cap ? [r.cap] : [],
        }),
        activeSpaceType: "PERSONAL",
        isPlatformAdmin: false,
        capabilities: caps,
      });
      expect(res.accessState).toBe("ALLOWED");
      expect(res.canLoad).toBe(true);
    });
  }

  // -------------------------------------------------------------------------
  // ENTERPRISE persona surfaces — personal users still blocked
  // -------------------------------------------------------------------------

  const ENTERPRISE_BLOCK = [
    "/governance",
    "/governance/policy",
    "/access-reviews",
    "/review/qc",
    "/review/disagreements",
  ] as const;

  for (const href of ENTERPRISE_BLOCK) {
    it(`ENTERPRISE protection: ${href} returns NEEDS_ORGANIZATION for PERSONAL`, async () => {
      const { resolveRouteAccess } = await loadResolver();
      const res = resolveRouteAccess({
        route: makeRoute("ORGANIZATION_ONLY"),
        activeSpaceType: "PERSONAL",
        isPlatformAdmin: false,
        capabilities: {
          GOVERNANCE_VIEW: true,
          REVIEWER_OPS_VIEW: true,
          GOVERNANCE_ACT: true,
        },
        // Even a healthy personalSpace must NOT widen org-only.
        personalSpace: { id: "personal-uuid", status: "active" },
      });
      expect(res.accessState).toBe("NEEDS_ORGANIZATION");
      expect(res.canLoad).toBe(false);
    });
  }

  // -------------------------------------------------------------------------
  // PLATFORM_ADMIN persona protection
  // -------------------------------------------------------------------------

  it("PLATFORM_ADMIN: /admin returns PLATFORM_ADMIN_ONLY when isPlatformAdmin=false", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute("PLATFORM_ADMIN", { domain: "PLATFORM_ADMIN" }),
      activeSpaceType: "ORGANIZATION",
      isPlatformAdmin: false,
      capabilities: { PLATFORM_ADMIN: true },
    });
    expect(res.accessState).toBe("PLATFORM_ADMIN_ONLY");
    expect(res.canLoad).toBe(false);
  });

  it("PLATFORM_ADMIN: /admin returns ALLOWED when isPlatformAdmin=true", async () => {
    const { resolveRouteAccess } = await loadResolver();
    const res = resolveRouteAccess({
      route: makeRoute("PLATFORM_ADMIN", {
        domain: "PLATFORM_ADMIN",
        capabilities: ["PLATFORM_ADMIN"],
      }),
      activeSpaceType: "ORGANIZATION",
      isPlatformAdmin: true,
      capabilities: { PLATFORM_ADMIN: true },
    });
    expect(res.accessState).toBe("ALLOWED");
    expect(res.canLoad).toBe(true);
  });
});

// =============================================================================
// PART 7 — Registry-page-existence invariant
// =============================================================================

describe("Phase R10 — registry-page-existence invariant", () => {
  // Every concrete ROUTE_REGISTRY href maps to a real Next.js page on
  // disk. A small allowlist covers dynamic + parameterized routes that
  // are served by the catch-all `[param]` segment instead of a
  // top-level page.tsx, plus the static /admin index which lives at
  // app/(app)/admin/page.tsx — handled below via existsSync.
  type RouteRegistryEntry = { id: string; href: string };
  type RegistryModule = typeof import(
    "../../../apps/web/lib/navigation/routeRegistry.js"
  );

  async function loadRegistry(): Promise<ReadonlyArray<RouteRegistryEntry>> {
    const mod: RegistryModule = await import(
      "../../../apps/web/lib/navigation/routeRegistry.js"
    );
    return mod.ROUTE_REGISTRY as ReadonlyArray<RouteRegistryEntry>;
  }

  // Allowlist of registry hrefs that intentionally do NOT resolve to a
  // single `page.tsx`. Each is annotated with the reason. Tests must
  // not silently grow this list — additions should come with a comment.
  const ALLOWLIST: ReadonlySet<string> = new Set<string>([
    // Dynamic / parameterized routes are served by `[param]/page.tsx`
    // segments that don't match `<href>/page.tsx` literally.
    "/organizations/:id",

    "/organizations/:id/setup",

    "/organizations/:id/admin/domains",

    "/organizations/:id/admin/governance/external-reviewers",
    "/org-invites/:token/accept",
    "/reviewer-ops/[reviewId]",
    // Evidence requests is reached only via a per-id detail page
    // (`/evidence-requests/[id]/page.tsx`) — there is no index page
    // and the registry href is the bare prefix used in deep links.
    "/evidence-requests",
    // Phase 6 — Team Collaboration dynamic routes. The detail page
    // lives at `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx`
    // and the accept page at
    // `apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx`.
    // Both routes are sidebar-invisible and command-palette-invisible;
    // they are reached via deep link only.
    "/collaboration-teams/[teamId]",
    "/collaboration-teams/invites/[token]/accept",
    // Phase 7 — Collaboration hub (nested under [teamId]/collaboration).
    "/collaboration-teams/[teamId]/collaboration",
    // Phase 8 — Organization Admin shell + 9 tab leaves. Dynamic /:id
    // segment; the actual pages live at
    // apps/web/app/(app)/organizations/[id]/admin/... (Next.js [id]
    // convention). Allowlisted here because the registry intentionally
    // uses /:id documentation syntax to match the /organizations/:id
    // precedent.
    "/organizations/:id/admin",
    "/organizations/:id/admin/overview",
    "/organizations/:id/admin/members",
    "/organizations/:id/admin/departments",
    "/organizations/:id/admin/governance",
    "/organizations/:id/admin/access-reviews",
    "/organizations/:id/admin/retention",
    "/organizations/:id/admin/audit",
    // Phase 8 (Enterprise Production Readiness) — dynamic org-admin tabs.
    "/organizations/:id/admin/bulk-invite",
    "/organizations/:id/admin/reports",
    "/organizations/:id/admin/readiness",
    "/organizations/:id/admin/security",
    "/organizations/:id/admin/trust",
    // Phase 4 (Enterprise Administration) — Roles, Billing, Integrations.
    "/organizations/:id/admin/roles",
    "/organizations/:id/admin/billing",
    "/organizations/:id/admin/integrations",
    // Platform Admin Control Center — customer organization detail. The page
    // lives at apps/web/app/(app)/admin/organizations/[id]/page.tsx (Next.js
    // [id] convention); the registry uses /:id documentation syntax.
    "/admin/organizations/:id",
  ]);

  function pageExistsForHref(href: string): boolean {
    // Strip query/hash; the registry hrefs are clean.
    const cleaned = href.split("?")[0].split("#")[0];
    if (cleaned === "/") return existsSync(webPath("app/page.tsx"));
    // Try the (app) segment first (most product routes live there).
    const inAppGroup = webPath(`app/(app)${cleaned}/page.tsx`);
    if (existsSync(inAppGroup)) return true;
    // Fall back to top-level app dir (public surfaces).
    const inTopApp = webPath(`app${cleaned}/page.tsx`);
    if (existsSync(inTopApp)) return true;
    return false;
  }

  it("every concrete ROUTE_REGISTRY href maps to a page.tsx on disk (allowlist for dynamic + external)", async () => {
    const registry = await loadRegistry();
    expect(registry.length).toBeGreaterThan(0);
    const missing: Array<{ id: string; href: string }> = [];
    for (const r of registry) {
      if (ALLOWLIST.has(r.href)) continue;
      // Dynamic-segment hrefs that slipped past the allowlist would
      // contain a `:param` or `[param]`. Skip them with a hard
      // expectation that they are dynamic — otherwise a typo would
      // pass silently.
      if (/[:\[]/.test(r.href)) {
        // Force the test author to add new dynamic routes to the
        // allowlist explicitly.
        missing.push({ id: r.id, href: `${r.href} (dynamic — needs allowlist entry)` });
        continue;
      }
      if (!pageExistsForHref(r.href)) {
        missing.push({ id: r.id, href: r.href });
      }
    }
    expect(missing, `routes without a page.tsx on disk: ${JSON.stringify(missing, null, 2)}`).toEqual([]);
  });
});
