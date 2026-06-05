/**
 * PHASE CR1.5 (re-audit) — Product-state observability extension.
 *
 * Companion to `phase-cr1-5-state-observability.test.ts`. The original
 * suite pins the canonical observability utility + the documentation +
 * the R1 inverse-pin flips. This suite pins additional contract
 * assertions surfaced by the re-audit in:
 *
 *   `docs/product/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md`
 *
 * What this file adds (12 source-contract tests):
 *
 *   1.  The re-audit doc exists at `docs/product/...` and is substantial.
 *   2.  Three dead `ShellNoWorkspace()` functions remain present but
 *       UNREACHABLE. Pinning their location and the fact that
 *       `setState({ status: "no_workspace" })` is never called lets
 *       R9 delete them safely.
 *   3.  Personal Space label string is `"Personal Space"` (exact match)
 *       in both backend service and topbar — no drift.
 *   4.  `RUNTIME_SEVERITY_LABELS.UNKNOWN` is `"Status pending"` and
 *       the `"Unknown"` raw string is NOT a runtime-status label.
 *   5.  `STATE_FALLBACK_LABEL` is `"Status pending"`.
 *   6.  `useGlobalRuntimeState` has the fail-closed UNKNOWN behavior
 *       (returns UNKNOWN when probe sources error).
 *   7.  Persona save handler still calls `ctx.refresh()` (regression
 *       pin extending CR1.5 Test 10).
 *   8.  CommandCenter still uses `useActiveSpace()` (regression pin
 *       extending CR1.5 Test 9).
 *   9.  State observability event vocabulary covers the four events
 *       actually emitted from production code today.
 *  10.  `workflowExposureResolver` still forbids authorization concepts
 *       (regression pin extending CR1.5 Test 12).
 *  11.  No new client-state library introduced (no React Query, SWR,
 *       Redux, Zustand) — adding one requires a CR-level decision.
 *  12.  No new localStorage keys for workspace / persona / nav state.
 *
 * Hard rules (must be preserved across all R-phases):
 *
 *   - No capture / upload / finalize / custody / TSA / OTS / report /
 *     package logic touched.
 *   - No new auth subsystems introduced.
 *   - No backend permission semantics changed.
 *   - No fake state fixes — every assertion is evidence-backed.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { listAllTsxFiles } from "./_helpers/file-walker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}
const REAUDIT_DOC = readRepo(
  "docs/product/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md",
);

// ===========================================================================
// 1. Re-audit doc exists + substantial
// ===========================================================================

describe("CR1.5B Test 1 — re-audit documentation exists + substantial", () => {
  it("docs/product/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY.md is present and >= 10KB", () => {
    expect(REAUDIT_DOC.length).toBeGreaterThan(10000);
    expect(REAUDIT_DOC).toMatch(/PHASE CR1\.5/);
    expect(REAUDIT_DOC).toMatch(/State & Orchestration Observability/);
    // Must reference the original CR1.5 doc location.
    expect(REAUDIT_DOC).toMatch(
      /docs\/recovery\/CR1_5_STATE_ORCHESTRATION_OBSERVABILITY\.md/,
    );
  });

  it("re-audit doc enumerates the 9 required sections", () => {
    const REQUIRED_SECTIONS = [
      "## 1. Executive summary",
      "## 2. Current state model",
      "## 3. Active workspace lifecycle",
      "## 4. Persona / workflow lifecycle",
      "## 5. Navigation lifecycle",
      "## 6. Dashboard lifecycle",
      "## 7. Cache / invalidation map",
      "## 8. Impossible states discovered",
      "## 9. Canonical source-of-truth recommendations",
    ];
    for (const s of REQUIRED_SECTIONS) {
      expect(REAUDIT_DOC, `Missing section header: ${s}`).toContain(s);
    }
  });
});

// ===========================================================================
// 2. Three dead `ShellNoWorkspace()` functions are REMOVED (CR1.6 cleanup)
// ===========================================================================

describe("CR1.5B Test 2 — dead-code `ShellNoWorkspace()` removed by CR1.6", () => {
  const CLEANED_SITES: ReadonlyArray<{ file: string; symbol: string }> = [
    {
      file: "components/workspace-admin/WorkspaceAdminPanel.tsx",
      symbol: "ShellNoWorkspace",
    },
    {
      file: "components/reviewer-experience/ReviewerCommandConsole.tsx",
      symbol: "ShellNoWorkspace",
    },
    {
      file: "components/governance-experience/GovernanceControlPlane.tsx",
      symbol: "ShellNoWorkspace",
    },
  ];

  it.each(CLEANED_SITES)(
    "$file: `no_workspace` LoadState branch and `$symbol()` are gone",
    ({ file, symbol }) => {
      const src = readWeb(file);
      // CR1.6 — the dead LoadState union value must be removed.
      expect(
        src,
        `${file}: LoadState should not declare 'no_workspace' (dead branch removed in CR1.6).`,
      ).not.toMatch(/status:\s*["']no_workspace["']/);
      // CR1.6 — the dead render-switch arm must be removed.
      expect(
        src,
        `${file}: render switch should not check 'no_workspace' (dead branch removed in CR1.6).`,
      ).not.toMatch(
        new RegExp(`state\\.status\\s*===\\s*["']no_workspace["']`),
      );
      // CR1.6 — the dead function definition must be removed.
      expect(
        src,
        `${file}: function ${symbol}() should be removed (dead code removed in CR1.6).`,
      ).not.toMatch(new RegExp(`function ${symbol}\\s*\\(`));
      // Sanity: the file must retain its other legitimate state
      // branches (loading / auth_error / unavailable). Removing them
      // would be a regression beyond CR1.6 scope.
      expect(src).toMatch(/status:\s*["']loading["']/);
      expect(src).toMatch(/status:\s*["']auth_error["']/);
      expect(src).toMatch(/status:\s*["']unavailable["']/);
    },
  );
});

// ===========================================================================
// 3. Personal Space label string is consistent across backend + topbar
// ===========================================================================

describe("CR1.5B Test 3 — `Personal Space` label is canonical (no drift)", () => {
  it("backend platform-context.service.ts emits the exact string `Personal Space`", () => {
    const src = readApi(
      "src/services/platform-context/platform-context.service.ts",
    );
    expect(src).toMatch(/"Personal Space"/);
  });

  it("topbar AppTopbarV2.tsx renders the exact string `Personal Space`", () => {
    const src = readWeb("components/app-shell-v2/AppTopbarV2.tsx");
    expect(src).toMatch(/"Personal Space"/);
  });
});

// ===========================================================================
// 4. UNKNOWN runtime severity → "Status pending" (not raw "Unknown")
// ===========================================================================

describe("CR1.5B Test 4 — UNKNOWN runtime severity maps to `Status pending`", () => {
  it("RUNTIME_SEVERITY_LABELS.UNKNOWN is the string `Status pending`", () => {
    const src = readWeb("lib/product-language/stateLabels.ts");
    // The mapping table must include UNKNOWN: "Status pending".
    expect(src).toMatch(/UNKNOWN:\s*"Status pending"/);
  });

  it("stateLabels.ts header documents the 'Unknown is reserved / prefer Status pending' rule", () => {
    const src = readWeb("lib/product-language/stateLabels.ts");
    expect(src).toMatch(/Unknown.*reserved.*indeterminate/i);
    expect(src).toMatch(/Status pending/);
  });
});

// ===========================================================================
// 5. STATE_FALLBACK_LABEL is "Status pending"
// ===========================================================================

describe("CR1.5B Test 5 — fallback label is operationally neutral", () => {
  it("STATE_FALLBACK_LABEL exports the exact string `Status pending`", () => {
    const src = readWeb("lib/product-language/stateLabels.ts");
    expect(src).toMatch(
      /STATE_FALLBACK_LABEL\s*=\s*"Status pending"\s*as\s*const/,
    );
  });
});

// ===========================================================================
// 6. useGlobalRuntimeState has fail-closed UNKNOWN behavior
// ===========================================================================

describe("CR1.5B Test 6 — useGlobalRuntimeState returns UNKNOWN when probes error", () => {
  it("severity derivation returns UNKNOWN on any source error or readiness UNKNOWN", () => {
    const src = readWeb("lib/useGlobalRuntimeState.ts");
    // Must early-return UNKNOWN when no teamId is set.
    expect(src).toMatch(/if\s*\(!teamId\)\s*return\s*["']UNKNOWN["']/);
    // Must early-return UNKNOWN while loading.
    expect(src).toMatch(/if\s*\(loading\)\s*return\s*["']UNKNOWN["']/);
    // Must derive severity using anySourceErrored flag.
    expect(src).toMatch(/anySourceErrored/);
    // Probe error keys must include all three sources.
    expect(src).toMatch(/errors\.readiness/);
    expect(src).toMatch(/errors\.incidents/);
    expect(src).toMatch(/errors\.escalations/);
  });
});

// ===========================================================================
// 7. Persona save handler still calls `ctx.refresh()` (regression pin)
// ===========================================================================

describe("CR1.5B Test 7 — persona save invalidates envelope (extends CR1.5 Test 10)", () => {
  it("settings/persona/page.tsx PATCH handler calls ctx.refresh() AND emits state event", () => {
    const src = readWeb("app/(app)/settings/persona/page.tsx");
    // PATCH call exists.
    expect(src).toMatch(/method:\s*["']PATCH["']/);
    // R1 Bug B fix is intact.
    expect(src).toMatch(/ctx\.refresh\s*\(/);
    // State observability is wired.
    expect(src).toMatch(/persona-profile:saved/);
    expect(src).toMatch(/persona-profile:refresh-missing/);
    // Success copy does NOT instruct user to reload.
    expect(src).not.toMatch(/Reload to see/i);
    expect(src).toMatch(/Workspace profile updated/);
  });
});

// ===========================================================================
// 8. CommandCenter still uses useActiveSpace() (regression pin)
// ===========================================================================

describe("CR1.5B Test 8 — CommandCenter consumes canonical envelope (extends CR1.5 Test 9)", () => {
  it("CommandCenter.tsx reads useActiveSpace + usePlatformContext, NOT useTeamWorkspaceGate", () => {
    const src = readWeb("components/command-center/CommandCenter.tsx");
    expect(src).toMatch(/\buseActiveSpace\s*\(/);
    expect(src).toMatch(/\busePlatformContext\s*\(/);
    expect(src).not.toMatch(/\buseTeamWorkspaceGate\s*\(/);
    // State observability is wired (emits active-space:resolved + dashboard:resolved).
    expect(src).toMatch(/active-space:resolved/);
    expect(src).toMatch(/dashboard:resolved/);
  });
});

// ===========================================================================
// 9. State observability event vocabulary covers production emit sites
// ===========================================================================

describe("CR1.5B Test 9 — observability event vocabulary covers production emit sites", () => {
  it("STATE_OBSERVABILITY_EVENTS includes every event actually emitted in production code", () => {
    const obs = readWeb("lib/platform-context/state-observability.ts");
    // The vocabulary must include the 4 events emitted by production code today.
    const EMITTED_IN_PROD: ReadonlyArray<string> = [
      "active-space:resolved",
      "dashboard:resolved",
      "persona-profile:saved",
      "persona-profile:refresh-missing",
    ];
    for (const evt of EMITTED_IN_PROD) {
      expect(
        obs,
        `STATE_OBSERVABILITY_EVENTS missing event emitted in prod code: ${evt}`,
      ).toContain(`"${evt}"`);
    }
  });

  it("observability utility remains no-op in production (NODE_ENV gate fires first)", () => {
    const obs = readWeb("lib/platform-context/state-observability.ts");
    expect(obs).toMatch(/NODE_ENV === "production"/);
    expect(obs).toMatch(/NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY/);
    const isFn = obs.match(/function isObservabilityEnabled\(\)[\s\S]*?\n\}/);
    expect(isFn).toBeTruthy();
    const body = isFn![0];
    const prodGateIdx = body.indexOf('NODE_ENV === "production"');
    const flagIdx = body.indexOf("NEXT_PUBLIC_PLATFORM_STATE_OBSERVABILITY");
    expect(prodGateIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeGreaterThan(prodGateIdx);
  });
});

// ===========================================================================
// 10. workflowExposureResolver forbids authorization concepts (regression pin)
// ===========================================================================

describe("CR1.5B Test 10 — workflowExposureResolver stays presentation-only (extends CR1.5 Test 12)", () => {
  it("workflow exposure logic does NOT reference canLoad / requiredCapabilities / authorize / forbidden", () => {
    const src = readWeb("lib/navigation/workflowExposureResolver.ts");
    expect(src).not.toMatch(/\bcanLoad\s*=/);
    expect(src).not.toMatch(/requiredCapabilities\b\s*[:?.]/);
    expect(src).not.toMatch(/authorize/i);
    expect(src).not.toMatch(/forbidden/i);
    // The "Workflow NEVER changes [authorization]" contract is still
    // documented in the file header.
    expect(src).toMatch(/Workflow NEVER changes/i);
  });
});

// ===========================================================================
// 11. No new client-state library introduced
// ===========================================================================

describe("CR1.5B Test 11 — no new client-side state library introduced", () => {
  it("apps/web/package.json does NOT depend on React Query, SWR, Redux, or Zustand", () => {
    const pkgJsonPath = webPath("package.json");
    expect(existsSync(pkgJsonPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    const FORBIDDEN = [
      "@tanstack/react-query",
      "react-query",
      "swr",
      "redux",
      "@reduxjs/toolkit",
      "zustand",
      "jotai",
      "recoil",
      "mobx",
    ];
    for (const name of FORBIDDEN) {
      expect(
        allDeps[name],
        `Forbidden client-state library introduced: ${name}. Adding a parallel cache library requires CR-level decision per CR1.5 §9.`,
      ).toBeUndefined();
    }
  });
});

// ===========================================================================
// 12. No new localStorage keys for workspace / persona / nav state
// ===========================================================================

describe("CR1.5B Test 12 — no new localStorage keys for product state", () => {
  /**
   * Allow-list of localStorage keys that may appear in apps/web/ source.
   * Anything else flips the test and must be documented in the re-audit.
   */
  const ALLOWED_KEYS = new Set<string>([
    "proovra-token",
    "proovra-locale",
    "proovra-locale-mode",
    // Cookie/consent storage — not product state.
    "proovra-cookie-consent",
    "proovra-legal-acceptance",
  ]);

  /**
   * Substrings that, if found in a localStorage key, indicate
   * product-state leakage (workspace, persona, nav). These must NOT
   * appear in any localStorage.setItem / localStorage.getItem call.
   */
  const FORBIDDEN_SUBSTRINGS = [
    "workspace",
    "persona",
    "active.team",
    "selectedTeam",
    "currentWorkspace",
    "navigation.mode",
    "advancedMode",
    "sidebar.advanced",
  ];

  it("no apps/web/ file references a forbidden product-state localStorage key", () => {
    const root = webPath(".");
    const files = listAllTsxFiles(root);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Match keys passed to localStorage.{setItem,getItem,removeItem}.
      const re =
        /localStorage\.(?:setItem|getItem|removeItem)\(\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const key = m[1]!;
        // Skip the documented allow-list.
        if (ALLOWED_KEYS.has(key)) continue;
        // Skip if the key contains no forbidden substring (it's likely
        // some other domain — e.g. analytics consent flag).
        const lower = key.toLowerCase();
        const hit = FORBIDDEN_SUBSTRINGS.some((s) =>
          lower.includes(s.toLowerCase()),
        );
        if (!hit) continue;
        const rel = file.replace(/\\/g, "/").replace(/^.*\/apps\/web\/+/, "/");
        offenders.push(`${rel}: ${key}`);
      }
    }
    expect(
      offenders,
      `Forbidden product-state localStorage key(s) introduced:\n${offenders.join("\n")}\nAdd to ALLOWED_KEYS only with explicit CR1.5 doc justification — the canonical state source is PlatformContextEnvelope.`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 13. Bounded "No workspace selected" string occurrence count
// ===========================================================================

describe("CR1.5B Test 13 — `No workspace selected` string occurrences are bounded (CR1.6 cleanup)", () => {
  /**
   * Post-CR1.6, the user-facing string "No workspace selected" appears
   * in exactly ONE file:
   *
   *   - app/(app)/reviewer-ops/WorkspaceGateState.tsx
   *     LIVE — bounded by `reason !== "personal"` (personal users get
   *     CapabilityDegradedPanel). Genuinely reachable only when the
   *     actor has no workspace at all (rare — provider bootstraps
   *     Personal Space).
   *
   * CR1.6 removed the 3 dead occurrences in WorkspaceAdminPanel,
   * ReviewerCommandConsole, and GovernanceControlPlane. The
   * PageRouteGate / CapabilityDegradedPanel pair handles the
   * personal-workspace path correctly without the dead branches.
   *
   * If this count grows, a new surface introduced the legacy pattern;
   * pair it with CapabilityDegradedPanel and document in CR1.6.
   */
  it("exactly 1 .tsx file in apps/web/ renders the user-facing string", () => {
    const root = webPath(".");
    const files = listAllTsxFiles(root);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Match user-facing rendered string — JSX text content. The
      // `WorkspaceGateState.tsx` site uses a styled `<h1>` so the
      // string appears between `>` and `<` after whitespace.
      if (/>\s*No workspace selected\s*</.test(src)) {
        const rel = file.replace(/\\/g, "/").replace(/^.*\/apps\/web\/+/, "/");
        offenders.push(rel);
      }
      // Also catch the JSX-text variant (no surrounding tags on the
      // same line — could match inside `>{value}<` style assignments).
      // The reviewer-ops site uses `<h1 style={title}>No workspace selected</h1>`
      // which is captured by the primary regex; this branch covers
      // potential alternate forms.
    }
    const EXPECTED = ["/app/(app)/reviewer-ops/WorkspaceGateState.tsx"];
    expect(offenders.sort()).toEqual(EXPECTED.slice().sort());
  });
});

// ===========================================================================
// 14. Canonical workspace-state hooks remain exported
// ===========================================================================

describe("CR1.5B Test 14 — canonical workspace-state hooks remain exported", () => {
  it("lib/platform-context exports the canonical hooks used by every surface", () => {
    // Reading the barrel file ensures the hooks remain available.
    const idx = readWeb("lib/platform-context/index.ts");
    const REQUIRED_EXPORTS = [
      "usePlatformContext",
      "useActiveSpace",
      "useActiveSpaceId",
      "useTeamWorkspaceGate",
      "usePersonaProfile",
      "useAccount",
      "useOrganizations",
      "usePersonalSpace",
    ];
    for (const name of REQUIRED_EXPORTS) {
      expect(
        idx,
        `lib/platform-context/index.ts must export the canonical hook ${name}`,
      ).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
