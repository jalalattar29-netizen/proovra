/**
 * PHASE CR0.5 — Recovery Readiness & State Dependency Closure guardrails.
 *
 * Extends the CR0 source-contract tests with diagnostic pins for the
 * findings produced during the CR0.5 dependency audit. The diagnostic
 * pins are intentional: they assert that the KNOWN BUGS still exist
 * (and therefore must be fixed in R1). When R1 fixes them, the test
 * must be updated as part of R1's deliverable — that's the forcing
 * function.
 *
 * The recovery baseline is at:
 *   docs/recovery/CR0_5_RECOVERY_READINESS.md
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { listAllFilesByRegex as listAllFiles } from "./_helpers/file-walker";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}
function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}
function readRepo(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
    "utf8",
  );
}

// =============================================================================
// PART 1 — CR0.5 readiness document exists + recovery roadmap locked
// =============================================================================

describe("Phase CR0.5 — readiness document + roadmap lock", () => {
  it("CR0.5 readiness document exists at the canonical path", () => {
    const path = fileURLToPath(
      new URL("../../../docs/recovery/CR0_5_RECOVERY_READINESS.md", import.meta.url),
    );
    const src = readFileSync(path, "utf8");
    expect(src.length).toBeGreaterThan(2000);
  });

  it("recovery roadmap order is locked in the doc — 23 phases CR0 → CR8", () => {
    const doc = readRepo("docs/recovery/CR0_5_RECOVERY_READINESS.md");
    const REQUIRED_PHASES = [
      "CR0", "CR0.5", "CR1", "CR1.5", "R1", "R1.5B", "R4",
      "CR6", "R2", "R5", "R6", "R3", "CR2", "CR5", "CR3",
      "CR4", "R7", "R8", "R9", "R9.5", "R10", "R11", "CR8",
    ];
    for (const phase of REQUIRED_PHASES) {
      expect(
        doc,
        `recovery roadmap missing phase "${phase}"`,
      ).toMatch(new RegExp(`\\*\\*${phase.replace(/\./g, "\\.")}\\*\\*`));
    }
  });

  it("CR0 baseline document still exists (CR0.5 extends, does not replace)", () => {
    const path = fileURLToPath(
      new URL("../../../docs/recovery/CR0_SYSTEM_FREEZE_BASELINE.md", import.meta.url),
    );
    const src = readFileSync(path, "utf8");
    expect(src.length).toBeGreaterThan(500);
  });
});

// =============================================================================
// PART 2 — useTeamWorkspaceGate live consumer pin
// =============================================================================

describe("Phase CR0.5 — useTeamWorkspaceGate live consumer count is pinned", () => {
  /**
   * Phase 38.18 said 4; CR0.5 verified only 2 production callsites
   * remain. This pins the narrower set. When R1 migrates CommandCenter,
   * this test will need to drop CommandCenter from the list — that's
   * the forcing function.
   */
  const PRODUCTION_CONSUMERS = [
    "components/command-center/CommandCenter.tsx",
    "app/(app)/operations/page.tsx",
  ];

  it("only the pinned production files import useTeamWorkspaceGate", () => {
    const root = fileURLToPath(new URL("../../../apps/web", import.meta.url));
    const all = listAllFiles(root, /\.tsx?$/);
    const offenders: string[] = [];
    const allowedSuffixes = new Set([
      ...PRODUCTION_CONSUMERS,
      // Canonical declaration + index re-export (per CR0):
      "lib/platform-context/useTeamWorkspaceGate.ts",
      "lib/platform-context/useTenantModel.ts",
      "lib/platform-context/index.ts",
    ]);
    for (const file of all) {
      const normalized = file.replace(/\\/g, "/");
      // Skip allowed
      let allowed = false;
      for (const suffix of allowedSuffixes) {
        if (normalized.endsWith(suffix)) {
          allowed = true;
          break;
        }
      }
      if (allowed) continue;
      const src = readFileSync(file, "utf8");
      if (/useTeamWorkspaceGate\b/.test(src)) {
        offenders.push(normalized.replace(/^.*apps\/web\//, ""));
      }
    }
    expect(
      offenders,
      `New code must NOT use useTeamWorkspaceGate. Migrate to useActiveSpaceId. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// =============================================================================
// PART 3 — KNOWN BUG DIAGNOSTIC PINS (force R1 to update tests when fixing)
// =============================================================================

describe("Phase CR0.5 — known bug diagnostic pins (R1 must update when fixing)", () => {
  /**
   * These tests assert the CURRENT broken state. When R1 fixes them,
   * the corresponding test must be updated. This is intentional: it
   * prevents R1 from silently regressing the test suite and forces
   * the fix to be reflected in the contract.
   *
   * IF YOU ARE READING THIS BECAUSE A TEST JUST BROKE:
   * congratulations, R1 fixed the bug. Update the pin to the inverse
   * assertion and mark it as a regression guard.
   */

  it("[FIXED IN R1] CommandCenter migrated off useTeamWorkspaceGate to canonical activeSpace", () => {
    const cc = readWeb("components/command-center/CommandCenter.tsx");
    // R1 fix landed: the dashboard now reads the canonical envelope
    // (Personal Space + Organization both valid). The matching R1
    // acceptance pin lives in phase-r1-product-state-recovery.test.ts.
    expect(cc).not.toMatch(/\buseTeamWorkspaceGate\s*\(/);
    expect(cc).toMatch(/\buseActiveSpace\s*\(/);
  });

  // (2026-07-20) The two "settings/persona save handler" diagnostic pins
  // were removed with the /settings/persona page (workspace-persona /
  // workflow-personalization deletion). There is no persona save flow.
});

// =============================================================================
// PART 4 — No new production seed/debug routes; acknowledged debt pinned
// =============================================================================

describe("Phase CR0.5 — production route registration debt pinned (CR1 will purge)", () => {
  it("server.ts opsSeedRoutes still acknowledged; webhookRoutes purged in CR1 Phase B", () => {
    const server = readApi("src/server.ts");
    expect(server).toMatch(/opsSeedRoutes/);
    // CR1 Phase B already removed the legacy webhookRoutes registration
    // and deleted `routes/webhook.routes.ts`. Pin the absence at code-
    // context only — explanatory comments may mention the symbol.
    expect(server).not.toMatch(/^import[^\n]*\bwebhookRoutes\b/m);
    expect(server).not.toMatch(/\bapp\.register\(webhookRoutes\)/);
  });

  it("the auditMiddleware HIGH-RISK hook was removed in CR1 Phase D", () => {
    // CR1 Phase D removed: the `addHook("onRequest", auditMiddleware)`
    // wiring at server.ts, the `middleware/audit.middleware.ts` file,
    // and the in-memory `services/audit.service.ts` tombstone. Canonical
    // audit writes via `appendPlatformAuditLog()` (hash-chained) remain
    // wired into each route. Pin the absence at code-context only —
    // explanatory deletion comments may mention the symbol.
    const server = readApi("src/server.ts");
    expect(
      server,
      "auditMiddleware import must not return.",
    ).not.toMatch(/^import[^\n]*\bauditMiddleware\b/m);
    expect(
      server,
      "auditMiddleware addHook wiring must not return.",
    ).not.toMatch(/\bapp\.addHook\([^)]*\bauditMiddleware\b/);
  });

  it("no new seed/debug route registration appears beyond the acknowledged debt", () => {
    const server = readApi("src/server.ts");
    const FORBIDDEN_NEW_SEED_PATTERNS = [
      /\bdevSeedRoutes\b/,
      /\bfixtureRoutes\b/,
      /\bdebugSeedRoutes\b/,
      /\btestOnlyRoutes\b/,
      /\binternalSeedRoutes\b/,
    ];
    for (const pattern of FORBIDDEN_NEW_SEED_PATTERNS) {
      expect(server).not.toMatch(pattern);
    }
  });
});

// =============================================================================
// PART 5 — Capture / finalization / custody files unchanged in CR0.5
// =============================================================================

describe("Phase CR0.5 — capture/finalization/custody guard (CR0.5 must not touch)", () => {
  /**
   * CR0.5 absolute rules forbid touching: capture, evidence-finalize,
   * custody, TSA/OTS. We pin coarse file-size tiers (±10%) of the
   * canonical files. A drift outside the band fires this test —
   * forcing the change to be acknowledged and justified.
   */
  const PINNED_FILES: ReadonlyArray<{ rel: string; expectedBytes: number; tolerance: number }> = [
    // ±10% around CR0.5 baseline bytes captured at the time of writing.
    {
      rel: "src/services/evidence-complete.service.ts",
      expectedBytes: 46824,
      tolerance: 0.1,
    },
    {
      rel: "src/services/custody-events.service.ts",
      expectedBytes: 5155,
      tolerance: 0.1,
    },
  ];

  for (const pin of PINNED_FILES) {
    it(`${pin.rel} is within ±${(pin.tolerance * 100).toFixed(0)}% of CR0.5 baseline (DO NOT REFACTOR in CR0.5)`, () => {
      const src = readApi(pin.rel);
      const bytes = Buffer.byteLength(src, "utf8");
      const min = Math.floor(pin.expectedBytes * (1 - pin.tolerance));
      const max = Math.ceil(pin.expectedBytes * (1 + pin.tolerance));
      expect(
        bytes,
        `${pin.rel} drifted from CR0.5 baseline of ${pin.expectedBytes} bytes (current: ${bytes}). If this is intentional, update the pin and justify in your phase report.`,
      ).toBeGreaterThanOrEqual(min);
      expect(bytes).toBeLessThanOrEqual(max);
    });
  }

  it("custody-events code is still duplicated between API and worker (CR1 will extract to shared package)", () => {
    // Both files must continue to exist with similar structure until
    // CR1 extracts to @proovra/shared/custody. When CR1 lands the
    // shared package, the worker copy goes away and this test inverts.
    const apiCopy = readApi("src/services/custody-events.service.ts");
    const workerCopy = readFileSync(
      fileURLToPath(
        new URL("../../worker/src/custody-events.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(apiCopy.length).toBeGreaterThan(1000);
    expect(workerCopy.length).toBeGreaterThan(1000);
    // Both should reference the canonical hash function (they will,
    // because they're literally the same logic).
    expect(apiCopy).toMatch(/buildCustodyEventHash|sequence/);
    expect(workerCopy).toMatch(/buildCustodyEventHash|sequence/);
  });
});

// =============================================================================
// PART 6 — No workflow/persona authorization gate introduced (defense-in-depth)
// =============================================================================

describe("Phase CR0.5 — no workflow/persona authorization gate introduced", () => {
  it("no page returns null based on workflow / persona checks (extends Phase 38.7 lock)", () => {
    const root = fileURLToPath(new URL("../../../apps/web/app", import.meta.url));
    const all = listAllFiles(root, /\.tsx$/);
    const offenders: string[] = [];
    const forbidden = [
      /if\s*\(\s*workflow\s*[!=]==\s*"[A-Z_]+"\s*\)\s*\{?\s*return\s+null/m,
      /if\s*\(\s*persona\s*[!=]==\s*"[A-Z_]+"\s*\)\s*\{?\s*return\s+null/m,
      /if\s*\(\s*primaryProfile\s*[!=]==\s*"[A-Z_]+"\s*\)\s*\{?\s*return\s+null/m,
      /if\s*\(\s*primaryWorkflow\s*[!=]==\s*"[A-Z_]+"\s*\)\s*\{?\s*return\s+null/m,
    ];
    for (const file of all) {
      const src = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(src)) {
          offenders.push(
            file.replace(/\\/g, "/").replace(/^.*apps\/web\//, ""),
          );
          break;
        }
      }
    }
    expect(
      offenders,
      `Workflow / persona must NEVER be used as a route gate. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// =============================================================================
// PART 7 — No new duplicate navigation source
// =============================================================================

describe("Phase CR0.5 — no new duplicate navigation source", () => {
  it("sidebar still consumes only ROUTE_REGISTRY + resolveRouteAccess + resolveNavigationExposure", () => {
    // (2026-07-20) The workflow/persona exposure resolver was replaced by
    // the neutral `resolveNavigationExposure` when the workspace-persona /
    // workflow-personalization feature was deleted.
    const sidebar = readWeb("components/app-shell-v2/AppSidebarV2.tsx");
    expect(sidebar).toMatch(/ROUTE_REGISTRY/);
    expect(sidebar).toMatch(/resolveRouteAccess/);
    expect(sidebar).toMatch(/resolveNavigationExposure/);
  });

  it("no new file exports a function whose name suggests an alternative navigation builder", () => {
    const root = fileURLToPath(
      new URL("../../../apps/web/components", import.meta.url),
    );
    const all = listAllFiles(root, /\.tsx?$/);
    const offenders: string[] = [];
    const FORBIDDEN_NAMES = [
      /export\s+function\s+buildSidebarItems\b/,
      /export\s+function\s+buildNavigationTree\b/,
      /export\s+function\s+resolveNavigation\b/,
      /export\s+function\s+buildAppNavigation\b/,
    ];
    const ALLOWED_SUFFIX = "AppSidebarV2.tsx"; // canonical
    for (const file of all) {
      if (file.endsWith(ALLOWED_SUFFIX)) continue;
      const src = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_NAMES) {
        if (pattern.test(src)) {
          offenders.push(file.replace(/\\/g, "/"));
        }
      }
    }
    expect(
      offenders,
      `Duplicate navigation builders are forbidden — extend ROUTE_REGISTRY + resolvers instead.\nOffenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
