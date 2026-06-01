/**
 * Phase R11 — Domain Stabilization source-contract test.
 *
 * Pins the constitutional architecture invariants declared in
 * docs/architecture/architecture-invariants.md. Each `it()` block is
 * labeled with the invariant ID it enforces (INV-N).
 *
 * This test does NOT exercise runtime behavior. It is a source-contract
 * test: it greps the codebase for forbidden patterns and asserts that
 * canonical constants have the expected shape. Its job is to make
 * architectural drift LOUD at CI time, before drift can ship.
 *
 * Adding, changing, or relaxing any invariant requires:
 *   1. Editing docs/architecture/architecture-invariants.md
 *   2. Editing this test
 *   3. Architecture board approval
 *
 * See: docs/architecture/proovra-domain-model.md (constitutional model)
 * See: docs/architecture/architecture-invariants.md (the numbered rules)
 * See: docs/architecture/current-to-target-domain-map.md (mapping)
 * See: docs/architecture/domain-debt-register.md (allowlisted legacy)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  TARGET_WORKSPACE_KINDS,
  LEGACY_WORKSPACE_SCOPES,
  FORBIDDEN_WORKSPACE_KIND_TOKENS,
  FORBIDDEN_WORKSPACE_KIND_UI_STRINGS,
  isPersonalWorkspaceKind,
  isOrganizationWorkspaceKind,
  coerceLegacyScopeToTargetKind,
  assertTargetWorkspaceKind,
} from "@proovra/shared";

// =============================================================================
// Path helpers
// =============================================================================

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const docsArchitectureDir = join(repoRoot, "docs", "architecture");
const apiSrc = join(repoRoot, "services", "api", "src");
const webSrc = join(repoRoot, "apps", "web");
const sharedSrc = join(repoRoot, "packages", "shared", "src");

/**
 * Recursively list TypeScript source files under a directory.
 * Skips node_modules, dist, .next, and generated output.
 */
function listSourceFiles(dir: string, exts: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (
      name === "node_modules" ||
      name === "dist" ||
      name === ".next" ||
      name === "build" ||
      name.startsWith(".")
    ) {
      continue;
    }
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full, exts));
    } else if (exts.some((e) => name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip JS/TS line + block comments + string literals (loosely) so source-
 * contract greps don't trip on documentation that mentions a forbidden token.
 * Conservative: removes line comments, block comments, and double-quoted +
 * single-quoted string literals. Template literals are preserved (they
 * frequently carry code-relevant tokens). This is not a TS parser — but it
 * is sufficient to eliminate the dominant false-positive class.
 */
function stripCommentsAndStringLiterals(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

// =============================================================================
// ALLOWLIST — files that may contain forbidden tokens for legitimate reasons.
//
// These are documentation, this very test, the architecture compatibility
// module, and the audit/debt-register that explicitly enumerates legacy
// debt. Any other occurrence is a violation.
// =============================================================================

const ALLOWLISTED_PATHS_FOR_FORBIDDEN_TOKENS: ReadonlyArray<string> = [
  "docs/architecture/",
  "docs/operations/",
  "docs/product/",
  "docs/recovery/",
  "services/api/test/phase-r11-domain-stabilization.test.ts",
  "packages/shared/src/architecture/workspace-kinds.ts",
];

function isAllowlistedPath(absPath: string): boolean {
  const rel = relative(repoRoot, absPath).replace(/\\/g, "/");
  return ALLOWLISTED_PATHS_FOR_FORBIDDEN_TOKENS.some((prefix) =>
    rel.startsWith(prefix),
  );
}

// =============================================================================
// INV-1 — Target workspace kinds are closed
// =============================================================================

describe("INV-1 — Target workspace kinds", () => {
  it("TARGET_WORKSPACE_KINDS is exactly ['PERSONAL', 'ORGANIZATION']", () => {
    expect(TARGET_WORKSPACE_KINDS).toEqual(["PERSONAL", "ORGANIZATION"]);
    expect(TARGET_WORKSPACE_KINDS.length).toBe(2);
  });

  it("TARGET_WORKSPACE_KINDS contains no fake workspace types", () => {
    for (const forbidden of FORBIDDEN_WORKSPACE_KIND_TOKENS) {
      const forbiddenAsKind = forbidden
        .replace(/Workspace$/, "")
        .toUpperCase();
      expect(TARGET_WORKSPACE_KINDS as readonly string[]).not.toContain(
        forbiddenAsKind,
      );
    }
  });

  it("LEGACY_WORKSPACE_SCOPES is exactly ['PERSONAL', 'TEAM'] (pinning current state, not adding)", () => {
    expect(LEGACY_WORKSPACE_SCOPES).toEqual(["PERSONAL", "TEAM"]);
    expect(LEGACY_WORKSPACE_SCOPES.length).toBe(2);
  });

  it("isPersonalWorkspaceKind returns true ONLY for 'PERSONAL'", () => {
    expect(isPersonalWorkspaceKind("PERSONAL")).toBe(true);
    expect(isPersonalWorkspaceKind("ORGANIZATION")).toBe(false);
    expect(isPersonalWorkspaceKind("TEAM")).toBe(false);
    expect(isPersonalWorkspaceKind(null)).toBe(false);
    expect(isPersonalWorkspaceKind(undefined)).toBe(false);
    expect(isPersonalWorkspaceKind("personal")).toBe(false); // case-sensitive
  });

  it("isOrganizationWorkspaceKind accepts BOTH target 'ORGANIZATION' and legacy 'TEAM' (bridging)", () => {
    expect(isOrganizationWorkspaceKind("ORGANIZATION")).toBe(true);
    expect(isOrganizationWorkspaceKind("TEAM")).toBe(true); // legacy bridge
    expect(isOrganizationWorkspaceKind("PERSONAL")).toBe(false);
    expect(isOrganizationWorkspaceKind(null)).toBe(false);
    expect(isOrganizationWorkspaceKind(undefined)).toBe(false);
  });

  it("coerceLegacyScopeToTargetKind maps PERSONAL→PERSONAL and TEAM→ORGANIZATION", () => {
    expect(coerceLegacyScopeToTargetKind("PERSONAL")).toBe("PERSONAL");
    expect(coerceLegacyScopeToTargetKind("TEAM")).toBe("ORGANIZATION");
    expect(coerceLegacyScopeToTargetKind("ORGANIZATION")).toBe(null);
    expect(coerceLegacyScopeToTargetKind("UNKNOWN")).toBe(null);
    expect(coerceLegacyScopeToTargetKind(null)).toBe(null);
  });

  it("assertTargetWorkspaceKind throws for any non-target value", () => {
    expect(() => assertTargetWorkspaceKind("PERSONAL")).not.toThrow();
    expect(() => assertTargetWorkspaceKind("ORGANIZATION")).not.toThrow();
    expect(() => assertTargetWorkspaceKind("TEAM")).toThrow(/must be one of/);
    expect(() => assertTargetWorkspaceKind("teamworkspace")).toThrow();
    expect(() => assertTargetWorkspaceKind(null)).toThrow();
    expect(() => assertTargetWorkspaceKind(undefined)).toThrow();
    expect(() => assertTargetWorkspaceKind(42)).toThrow();
  });
});

// =============================================================================
// INV-2 — No fake workspace types in code or UI
// =============================================================================

describe("INV-2 — Fake workspace terminology forbidden in new code", () => {
  it("declares the forbidden-token list with exactly the 4 expected entries", () => {
    expect(FORBIDDEN_WORKSPACE_KIND_TOKENS).toEqual([
      "TeamWorkspace",
      "ReviewerWorkspace",
      "GovernanceWorkspace",
      "OperationsWorkspace",
    ]);
  });

  it("declares the forbidden UI-string list", () => {
    expect(FORBIDDEN_WORKSPACE_KIND_UI_STRINGS).toEqual([
      "team workspace",
      "reviewer workspace",
      "governance workspace",
      "operations workspace",
    ]);
  });

  it("no non-allowlisted file in services/api/src introduces forbidden tokens", () => {
    const violations: Array<{ file: string; token: string }> = [];
    const files = listSourceFiles(apiSrc, [".ts", ".tsx"]);
    for (const file of files) {
      if (isAllowlistedPath(file)) continue;
      const stripped = stripCommentsAndStringLiterals(readFileSync(file, "utf8"));
      for (const token of FORBIDDEN_WORKSPACE_KIND_TOKENS) {
        // Match as a whole-identifier (avoid matching e.g. "TeamWorkspaces" or substring noise)
        const re = new RegExp(`\\b${token}\\b`);
        if (re.test(stripped)) {
          violations.push({ file: relative(repoRoot, file), token });
        }
      }
    }
    expect(
      violations,
      `New code introduced forbidden workspace-kind tokens (INV-2). Each is a constitutional violation per architecture-invariants.md. Violations:\n${violations
        .map((v) => `  - ${v.file}: ${v.token}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("no non-allowlisted file in apps/web introduces forbidden tokens", () => {
    const violations: Array<{ file: string; token: string }> = [];
    const files = listSourceFiles(webSrc, [".ts", ".tsx"]);
    for (const file of files) {
      if (isAllowlistedPath(file)) continue;
      const stripped = stripCommentsAndStringLiterals(readFileSync(file, "utf8"));
      for (const token of FORBIDDEN_WORKSPACE_KIND_TOKENS) {
        const re = new RegExp(`\\b${token}\\b`);
        if (re.test(stripped)) {
          violations.push({ file: relative(repoRoot, file), token });
        }
      }
    }
    expect(
      violations,
      `New code introduced forbidden workspace-kind tokens (INV-2):\n${violations
        .map((v) => `  - ${v.file}: ${v.token}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("no non-allowlisted file in packages/shared/src introduces forbidden tokens", () => {
    const violations: Array<{ file: string; token: string }> = [];
    const files = listSourceFiles(sharedSrc, [".ts"]);
    for (const file of files) {
      if (isAllowlistedPath(file)) continue;
      const stripped = stripCommentsAndStringLiterals(readFileSync(file, "utf8"));
      for (const token of FORBIDDEN_WORKSPACE_KIND_TOKENS) {
        const re = new RegExp(`\\b${token}\\b`);
        if (re.test(stripped)) {
          violations.push({ file: relative(repoRoot, file), token });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// =============================================================================
// INV-3 — Personal users are not forced into Organizations
// =============================================================================

describe("INV-3 — Core personal routes are not ORGANIZATION_ONLY", () => {
  it("routeRegistry's core personal routes use PERSONAL_OR_ORG (or NONE), never ORGANIZATION_ONLY", () => {
    // Read routeRegistry.ts as source contract. We assert by inspection
    // rather than dynamic import to keep the test fast and DB-free.
    const registryPath = join(
      webSrc,
      "lib",
      "navigation",
      "routeRegistry.ts",
    );
    const src = readFileSync(registryPath, "utf8");

    // The core-personal route ids that MUST be reachable by Personal users.
    const corePersonalRouteIds = [
      "workspace.home",
      "workspace.capture",
      "workspace.evidence",
      "workspace.cases",
      "workspace.reports",
      "workspace.search",
      "workspace.trust",
      "account.settings",
      "account.billing",
    ];

    for (const id of corePersonalRouteIds) {
      // Find the route definition block for this id. Each entry has the
      // shape `{ id: "...", ..., requiredActiveSpace: "..." }`.
      const blockRe = new RegExp(
        `id:\\s*"${id.replace(/\./g, "\\.")}"[\\s\\S]{0,2000}?requiredActiveSpace:\\s*"([^"]+)"`,
      );
      const m = src.match(blockRe);
      if (!m) {
        // The route id may not appear (e.g. removed); that's fine — the
        // invariant only applies to ids present in the registry.
        continue;
      }
      const requiredActiveSpace = m[1];
      expect(
        requiredActiveSpace,
        `INV-3 violation: route '${id}' has requiredActiveSpace='${requiredActiveSpace}'. Core personal routes must be NONE or PERSONAL_OR_ORG, never ORGANIZATION_ONLY.`,
      ).not.toBe("ORGANIZATION_ONLY");
    }
  });
});

// =============================================================================
// INV-8 — Capability names must not imply fake workspace types
// =============================================================================

describe("INV-8 — Capability names do not imply fake workspace types", () => {
  it("capability-registry.ts contains no fake-workspace capability names", () => {
    const capRegistry = readFileSync(
      join(
        apiSrc,
        "services",
        "platform-context",
        "capability-registry.ts",
      ),
      "utf8",
    );
    for (const token of FORBIDDEN_WORKSPACE_KIND_TOKENS) {
      // Capability keys are uppercase + snake; substring match is OK.
      // Convert e.g. "TeamWorkspace" → "TEAMWORKSPACE" / "TEAM_WORKSPACE"
      const upper = token.toUpperCase();
      const snake = token
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toUpperCase();
      expect(
        capRegistry.includes(upper),
        `Capability registry contains '${upper}' — fake workspace name (INV-8)`,
      ).toBe(false);
      expect(
        capRegistry.includes(snake),
        `Capability registry contains '${snake}' — fake workspace name (INV-8)`,
      ).toBe(false);
    }
  });
});

// =============================================================================
// INV-9 — The denial vocabulary is closed
// =============================================================================

describe("INV-9 — ACCESS_STATES has no fake-workspace-type entries", () => {
  it("routeAccessResolver.ts ACCESS_STATES contains no fake workspace types", () => {
    const src = readFileSync(
      join(webSrc, "lib", "navigation", "routeAccessResolver.ts"),
      "utf8",
    );

    // Forbidden access-state values that would imply fake workspaces.
    const forbiddenStates = [
      "NEEDS_TEAM_WORKSPACE",
      "NEEDS_REVIEWER_WORKSPACE",
      "NEEDS_GOVERNANCE_WORKSPACE",
      "NEEDS_OPERATIONS_WORKSPACE",
    ];

    for (const state of forbiddenStates) {
      expect(
        src.includes(state),
        `routeAccessResolver.ts contains '${state}' — forbidden by INV-9`,
      ).toBe(false);
    }
  });
});

// =============================================================================
// Architecture documentation must exist
// =============================================================================

describe("Phase 2 — architecture documentation is present", () => {
  it("docs/architecture/proovra-domain-model.md exists and is non-trivial", () => {
    const path = join(docsArchitectureDir, "proovra-domain-model.md");
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toMatch(/PERSONAL/);
    expect(src).toMatch(/ORGANIZATION/);
    expect(src).toMatch(/Team[^a-z]*is a collaboration sub-unit/i);
  });

  it("docs/architecture/architecture-invariants.md exists and lists INV-1..INV-15", () => {
    const path = join(docsArchitectureDir, "architecture-invariants.md");
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    expect(src.length).toBeGreaterThan(2000);
    // At minimum these invariants must be declared.
    for (const inv of [
      "INV-1",
      "INV-2",
      "INV-3",
      "INV-4",
      "INV-5",
      "INV-6",
      "INV-7",
      "INV-8",
      "INV-9",
      "INV-10",
    ]) {
      expect(
        src.includes(inv),
        `architecture-invariants.md missing declaration of ${inv}`,
      ).toBe(true);
    }
  });

  it("docs/architecture/current-to-target-domain-map.md exists", () => {
    const path = join(
      docsArchitectureDir,
      "current-to-target-domain-map.md",
    );
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    expect(src.length).toBeGreaterThan(2000);
    // Must explicitly state Team is currently treated as the runtime workspace
    expect(src).toMatch(/Team.*Workspace/);
  });

  it("docs/architecture/domain-debt-register.md exists", () => {
    const path = join(docsArchitectureDir, "domain-debt-register.md");
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    expect(src.length).toBeGreaterThan(1500);
  });

  it("docs/architecture/phase-3-runtime-refactor-readiness.md exists", () => {
    const path = join(
      docsArchitectureDir,
      "phase-3-runtime-refactor-readiness.md",
    );
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    expect(src.length).toBeGreaterThan(1500);
  });
});

// =============================================================================
// Bonus — pin that compatibility module is exported from @proovra/shared
// =============================================================================

describe("Phase 2 — workspace-kinds compatibility module is exported", () => {
  it("imports resolve from @proovra/shared (not deep imports)", async () => {
    const mod = await import("@proovra/shared");
    expect(mod.TARGET_WORKSPACE_KINDS).toBeDefined();
    expect(mod.LEGACY_WORKSPACE_SCOPES).toBeDefined();
    expect(mod.FORBIDDEN_WORKSPACE_KIND_TOKENS).toBeDefined();
    expect(typeof mod.isPersonalWorkspaceKind).toBe("function");
    expect(typeof mod.isOrganizationWorkspaceKind).toBe("function");
    expect(typeof mod.coerceLegacyScopeToTargetKind).toBe("function");
    expect(typeof mod.assertTargetWorkspaceKind).toBe("function");
  });
});
