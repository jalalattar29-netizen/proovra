/**
 * Phase 32.8 Foundation cleanup — drift-prevention tests.
 *
 * These tests fail the build if anyone reintroduces:
 *
 *   - direct `useActiveWorkspaceId` imports anywhere in apps/web
 *   - legacy `lib/navigation-config` or `lib/workspace-profile`
 *     imports in live shell / page code
 *   - direct `/v1/users/me` or `/v1/teams` calls for authority in
 *     app pages or shell components
 *   - local `user.platformRole === ...` derivations in app pages
 *   - inline `role === "OWNER"/"ADMIN"/"MEMBER"/"VIEWER"` UI-gating
 *     in pages that have access to the canonical context
 *   - legacy `WorkspaceGateState` props that lack the canonical
 *     `requiredCapability` field
 *
 * They also pin the /v1/teams response-shape backward-compat fix:
 * the route emits BOTH `teams` AND `items` so any legacy reader
 * works.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const WEB_ROOT = fileURLToPath(new URL("../../../apps/web", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".turbo", "build"]);
const SKIP_FILE_SUFFIXES = [".d.ts", ".tsbuildinfo"];

function walkTsFiles(rootAbs: string): string[] {
  const out: string[] = [];
  const stack = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir, { encoding: "utf8" }) as unknown as string[];
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      let isDir = false;
      let isFile = false;
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
      if (isDir) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(full);
        continue;
      }
      if (!isFile) continue;
      if (SKIP_FILE_SUFFIXES.some((s) => name.endsWith(s))) continue;
      if (!/\.(ts|tsx)$/.test(name)) continue;
      out.push(full);
    }
  }
  return out;
}

function listWebFiles(roots: string[]): string[] {
  const seen = new Set<string>();
  for (const r of roots) {
    const abs = join(WEB_ROOT, r);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isFile()) {
      seen.add(abs);
      continue;
    }
    for (const f of walkTsFiles(abs)) seen.add(f);
  }
  return [...seen];
}

const LIVE_APP_FILES = listWebFiles([
  "app",
  "components",
  "lib",
]).filter((f) => {
  const rel = relative(WEB_ROOT, f).replace(/\\/g, "/");
  // Exclude the legacy archive files that are intentionally retained
  // for older tests AND the canonical platform-context module.
  return (
    !rel.startsWith("lib/navigation-config.") &&
    !rel.startsWith("lib/workspace-profile.")
  );
});

// =============================================================================
// PART A — Legacy useActiveWorkspaceId hook is fully removed
// =============================================================================

describe("Phase 32.8 Foundation cleanup — useActiveWorkspaceId removal", () => {
  it("lib/useActiveWorkspaceId.ts is deleted (no longer on disk)", () => {
    const path = join(WEB_ROOT, "lib/useActiveWorkspaceId.ts");
    expect(existsSync(path)).toBe(false);
  });

  it("no live web file imports from the deleted legacy `lib/useActiveWorkspaceId` module", () => {
    // Phase 3 evolution: `useActiveWorkspaceId` is now the PHASE 3
    // CANONICAL hook for personal-aware workspace-id resolution, and
    // is exported from `lib/platform-context/useTeamWorkspaceGate.ts`
    // alongside `useTeamId` and `useWorkspaceId`. Importing it from
    // there (or from `lib/platform-context`) is correct and expected
    // for `/cases`, `/reports`, `/search`, `/capture`, etc.
    //
    // This test STILL guards against the original drift: importing
    // from the deleted standalone `lib/useActiveWorkspaceId(.ts)`
    // module. Anything pointing at the canonical platform-context
    // module passes.
    const offenders: string[] = [];
    for (const file of LIVE_APP_FILES) {
      const src = stripComments(readFileSync(file, "utf8"));
      const legacyImportRe =
        /from\s+['"][^'"]*\/lib\/useActiveWorkspaceId['"]/;
      if (legacyImportRe.test(src)) {
        offenders.push(relative(WEB_ROOT, file));
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("canonical useTeamWorkspaceGate is the replacement hook", () => {
    const src = readWeb("lib/platform-context/useTeamWorkspaceGate.ts");
    expect(src).toMatch(/export function useTeamWorkspaceGate/);
    expect(src).toMatch(/usePlatformContext/);
    // Non-fetching: must not import apiFetch.
    const live = stripComments(src);
    expect(live).not.toMatch(/apiFetch\(/);
    expect(live).not.toMatch(/\/v1\/users\/me/);
    expect(live).not.toMatch(/\/v1\/teams/);
  });
});

// =============================================================================
// PART B — Legacy nav/profile modules are isolated
// =============================================================================

describe("Phase 32.8 Foundation cleanup — legacy nav isolation", () => {
  it("lib/workspace-profile.ts carries a @deprecated marker", () => {
    const src = readWeb("lib/workspace-profile.ts");
    expect(src).toMatch(/@deprecated/);
  });

  it("lib/navigation-config.ts carries a @deprecated marker", () => {
    const src = readWeb("lib/navigation-config.ts");
    expect(src).toMatch(/@deprecated/);
  });

  it("no live shell file imports the legacy nav-config / workspace-profile modules", () => {
    const offenders: string[] = [];
    for (const file of LIVE_APP_FILES) {
      const src = stripComments(readFileSync(file, "utf8"));
      if (
        /from\s+['"][^'"]*\/navigation-config['"]/.test(src) ||
        /from\s+['"][^'"]*\/workspace-profile['"]/.test(src)
      ) {
        offenders.push(relative(WEB_ROOT, file));
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

// =============================================================================
// PART C — No direct /v1/users/me or /v1/teams calls for authority
// =============================================================================

describe("Phase 32.8 Foundation cleanup — no direct authority fetches", () => {
  it("no shell or page derives workspace authority from /v1/users/me", () => {
    // It is legitimate for pages to read user data (profile,
    // identity admin forms, etc.) from /v1/users/me. The forbidden
    // pattern is using it to RESOLVE WORKSPACE AUTHORITY —
    // specifically: reading `currentWorkspaceId` to scope a
    // team-scoped API call. The canonical envelope is the only
    // authority source for that decision.
    const offenders: string[] = [];
    for (const file of LIVE_APP_FILES) {
      const rel = relative(WEB_ROOT, file).replace(/\\/g, "/");
      const src = stripComments(readFileSync(file, "utf8"));
      // Forbidden: `apiFetch("/v1/users/me")` followed within a
      // small window by `currentWorkspaceId` access — that's the
      // historic authority-derivation pattern.
      if (
        /apiFetch\([^)]{0,200}\/v1\/users\/me[\s\S]{0,400}currentWorkspaceId/.test(
          src,
        )
      ) {
        offenders.push(rel);
      }
      // Forbidden: `apiFetch("/v1/users/me")` followed within a
      // small window by `platformRole` access — that's the historic
      // platform-admin derivation.
      if (
        /apiFetch\([^)]{0,200}\/v1\/users\/me[\s\S]{0,400}platformRole/.test(
          src,
        )
      ) {
        offenders.push(rel);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no app shell file calls /v1/teams directly for authority", () => {
    const shellGlob = listWebFiles(["components/app-shell-v2"]);
    const offenders: string[] = [];
    for (const file of shellGlob) {
      const src = stripComments(readFileSync(file, "utf8"));
      if (/apiFetch\(\s*['"`]\/v1\/teams/.test(src)) {
        offenders.push(relative(WEB_ROOT, file));
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

// =============================================================================
// PART D — /v1/platform/context is the sole authority source
// =============================================================================

describe("Phase 32.8 Foundation cleanup — canonical authority surface", () => {
  it("the canonical platform-context route is registered", () => {
    const server = readApi("src/server.ts");
    expect(server).toMatch(/platformContextRoutes/);
  });

  it("only the canonical provider hits /v1/platform/context", () => {
    const callers = new Set<string>();
    for (const file of LIVE_APP_FILES) {
      const src = stripComments(readFileSync(file, "utf8"));
      if (/['"`]\/v1\/platform\/context/.test(src)) {
        callers.add(relative(WEB_ROOT, file).replace(/\\/g, "/"));
      }
    }
    expect([...callers].sort()).toEqual([
      "lib/platform-context/PlatformContextProvider.tsx",
    ]);
  });
});

// =============================================================================
// PART E — /v1/teams response shape backward compatibility
// =============================================================================

describe("Phase 32.8 Foundation cleanup — /v1/teams contract drift fix", () => {
  const teamsRoutes = readApi("src/routes/teams.routes.ts");

  it("/v1/teams emits BOTH the canonical `teams` AND legacy `items` keys", () => {
    expect(teamsRoutes).toMatch(
      /reply\.code\(200\)\.send\(\{\s*teams:\s*items,\s*items[\s,}]/,
    );
  });

  it("the dual-key send is documented as a backward-compat fix", () => {
    // Comment near the dual-key send explains the regression history
    // (legacy frontend read `teams.items` against `{teams}` payload).
    expect(teamsRoutes).toMatch(
      /backward[\s-]compat|backward[\s-]compatible|legacy/i,
    );
  });
});

// =============================================================================
// PART F — ReviewerOps / Governance gates use canonical capabilities
// =============================================================================

describe("Phase 32.8 Foundation cleanup — reviewer/governance gate cleanup", () => {
  const SLA = readWeb("app/(app)/reviewer-ops/sla/page.tsx");
  const ESC = readWeb("app/(app)/reviewer-ops/escalations/page.tsx");
  const REV = readWeb("app/(app)/reviewer-ops/[reviewId]/page.tsx");
  const POLICY = readWeb("app/(app)/governance/policy/page.tsx");
  const GATE = readWeb("app/(app)/reviewer-ops/WorkspaceGateState.tsx");

  it("SLA page declares its required capability via the canonical route registry", () => {
    // Phase 38.11 — SLA page migrated from a local WorkspaceGateState
    // gate to <PageRouteGate routeId="review.sla">. The capability is
    // declared on the canonical ROUTE_REGISTRY entry.
    expect(SLA).toMatch(/PageRouteGate/);
    expect(SLA).toMatch(/routeId="review\.sla"/);
    const registry = readWeb("lib/navigation/routeRegistry.ts");
    expect(registry).toMatch(
      /id:\s*"review\.sla"[\s\S]*?SLA_VIEW/,
    );
  });

  it("Escalations page declares ESCALATIONS_VIEW capability — via the canonical route registry", () => {
    // Phase 38.10 — the escalations page no longer hands a
    // `requiredCapability` prop to a local gate. It now wraps in
    // <PageRouteGate routeId="review.escalations">, and the capability
    // is declared once on the canonical ROUTE_REGISTRY entry.
    expect(ESC).toMatch(/PageRouteGate/);
    expect(ESC).toMatch(/routeId="review\.escalations"/);
    const registry = readWeb("lib/navigation/routeRegistry.ts");
    expect(registry).toMatch(
      /id:\s*"review\.escalations"[\s\S]*?ESCALATIONS_VIEW/,
    );
  });

  it("Reviewer detail page declares REVIEWER_OPS_VIEW capability — via the canonical route registry", () => {
    // Phase 38.12 — the review workspace page migrated from a local
    // WorkspaceGateState gate to <PageRouteGate routeId="review.queue_detail">.
    expect(REV).toMatch(/PageRouteGate/);
    expect(REV).toMatch(/routeId="review\.queue_detail"/);
    const registry = readWeb("lib/navigation/routeRegistry.ts");
    expect(registry).toMatch(
      /id:\s*"review\.queue_detail"[\s\S]*?REVIEWER_OPS_VIEW/,
    );
  });

  it("Governance policy page declares GOVERNANCE_ACT capability — via the canonical route registry", () => {
    // Phase 38.11 — governance/policy migrated from a local
    // WorkspaceGateState gate to <PageRouteGate routeId="governance.policy">.
    expect(POLICY).toMatch(/PageRouteGate/);
    expect(POLICY).toMatch(/routeId="governance\.policy"/);
    const registry = readWeb("lib/navigation/routeRegistry.ts");
    expect(registry).toMatch(
      /id:\s*"governance\.policy"[\s\S]*?GOVERNANCE_ACT/,
    );
  });

  it("WorkspaceGateState consumes the canonical TeamWorkspaceGateState shape", () => {
    expect(GATE).toMatch(/TeamWorkspaceGateState/);
    expect(GATE).toMatch(/CapabilityDegradedPanel/);
    expect(GATE).toMatch(/requiredCapability/);
    // No legacy ActiveWorkspaceState import.
    const live = stripComments(GATE);
    expect(live).not.toMatch(/ActiveWorkspaceState/);
  });

  it("gate renders CapabilityDegradedPanel for personal-mode reason, not a plain text wall", () => {
    expect(GATE).toMatch(/reason === ['"]personal['"]/);
    // Personal-mode branch returns the CapabilityDegradedPanel.
    const personalBlockMatch = GATE.match(
      /reason === ['"]personal['"][\s\S]{0,1200}/,
    );
    expect(personalBlockMatch).not.toBeNull();
    expect(personalBlockMatch![0]).toMatch(/CapabilityDegradedPanel/);
  });
});

// =============================================================================
// PART G — Capability registry contains the newly-added bounded keys
// =============================================================================

describe("Phase 32.8 Foundation cleanup — capability registry extensions", () => {
  it("registry exposes fine-grained reviewer act capabilities", () => {
    const src = readApi("src/services/platform-context/types.ts");
    for (const key of [
      "REVIEW_ASSIGN",
      "REVIEW_REASSIGN",
      "REVIEW_ESCALATE",
      "LEGAL_HOLD_PLACE",
      "LEGAL_HOLD_RELEASE",
      "RETENTION_MANAGE",
      "EXPORT_GOVERNANCE_MANAGE",
    ]) {
      expect(src).toContain(`"${key}"`);
    }
  });

  it("frontend types mirror the new capability keys", () => {
    const src = readWeb("lib/platform-context/types.ts");
    for (const key of [
      "REVIEW_ASSIGN",
      "REVIEW_REASSIGN",
      "REVIEW_ESCALATE",
      "LEGAL_HOLD_PLACE",
      "LEGAL_HOLD_RELEASE",
      "RETENTION_MANAGE",
      "EXPORT_GOVERNANCE_MANAGE",
    ]) {
      expect(src).toContain(`"${key}"`);
    }
  });

  it("TEAM admin gets the fine-grained governance act capabilities", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "ADMIN",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(caps.LEGAL_HOLD_PLACE).toBe(true);
    expect(caps.LEGAL_HOLD_RELEASE).toBe(true);
    expect(caps.RETENTION_MANAGE).toBe(true);
    expect(caps.EXPORT_GOVERNANCE_MANAGE).toBe(true);
  });

  it("TEAM MEMBER gets review-act capabilities but NOT governance-admin", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "MEMBER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(caps.REVIEW_ASSIGN).toBe(true);
    expect(caps.REVIEW_REASSIGN).toBe(true);
    expect(caps.REVIEW_ESCALATE).toBe(true);
    expect(caps.LEGAL_HOLD_PLACE).toBe(false);
    expect(caps.RETENTION_MANAGE).toBe(false);
  });

  it("PERSONAL workspaces do not get any team-only act capabilities", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "PRO",
      isPlatformAdmin: false,
    });
    expect(caps.REVIEW_ASSIGN).toBe(false);
    expect(caps.REVIEW_ESCALATE).toBe(false);
    expect(caps.LEGAL_HOLD_PLACE).toBe(false);
    expect(caps.EXPORT_GOVERNANCE_MANAGE).toBe(false);
  });
});

// =============================================================================
// PART H — No inline role-string equality in pages with canonical context
// =============================================================================

describe("Phase 32.8 Foundation cleanup — capability-derived UI visibility", () => {
  // These component files are inside the (app) scope and have the
  // canonical context available. They MUST NOT compare role strings
  // for UI gating. Reading role for DISPLAY (e.g. printing a badge)
  // is allowed via interpolated JSX, but the equality test
  // `role === "OWNER" | "ADMIN" | "MEMBER" | "VIEWER"` is forbidden.
  const SHELL_AND_CORE_PAGES = [
    "components/governance-experience/GovernanceControlPlane.tsx",
    "components/workspace-admin/WorkspaceAdminPanel.tsx",
    "components/cases-experience/CasesIndex.tsx",
  ];

  for (const path of SHELL_AND_CORE_PAGES) {
    it(`${path} does not gate UI on role-string equality`, () => {
      const live = stripComments(readWeb(path));
      // Allow `role === undefined`-style narrow checks, but flag
      // equality against any of the bounded role strings.
      expect(live).not.toMatch(/role\s*===\s*['"]OWNER['"]/);
      expect(live).not.toMatch(/role\s*===\s*['"]ADMIN['"]/);
      expect(live).not.toMatch(/role\s*===\s*['"]MEMBER['"]/);
      expect(live).not.toMatch(/role\s*===\s*['"]VIEWER['"]/);
      // And no local platformRole derivation.
      expect(live).not.toMatch(/platformRole\s*===/);
    });
  }
});

// =============================================================================
// PART I — Teams nav + functionality remains reachable
// =============================================================================

describe("Phase 32.8 Foundation cleanup — Teams reachability preserved", () => {
  it("Teams nav item still gated on TEAM_VIEW", () => {
    const nav = readApi("src/services/platform-context/navigation-registry.ts");
    expect(nav).toMatch(/id:\s*['"]admin\.teams['"]/);
    expect(nav).toMatch(/requiresCapability:\s*['"]TEAM_VIEW['"]/);
  });

  it("backend Teams routes (list, invite, member, activity) all preserved", () => {
    const routes = readApi("src/routes/teams.routes.ts");
    for (const tag of [
      'app.get("/v1/teams"',
      'app.post("/v1/teams"',
      '"/v1/teams/:id/invites"',
      '"/v1/teams/:id/members/:memberId"',
      '"/v1/teams/:id/activity"',
    ]) {
      expect(routes).toContain(tag);
    }
  });
});
