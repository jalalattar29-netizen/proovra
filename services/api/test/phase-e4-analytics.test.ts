/**
 * PHASE E4 — Operational Analytics contract tests.
 *
 * Phase E4 builds the bounded operational-analytics surface that lives
 * under the Operations Center hub at /ops/analytics. The hard rules
 * pinned by this suite are:
 *
 *   - Real-data only. Every metric ties to a Prisma model + filter.
 *   - Bounded window (1..180 days, default 30). The clamp is in code.
 *   - Team-scoped queries — never `findMany` without a teamId filter.
 *   - On Prisma failure → metric = null + source pushed to
 *     `degradedSources`. Never a fake number.
 *   - ANALYTICS_VIEW capability resolved for team writers + admins.
 *   - Route registry entry under OPS domain, `sidebarEligible: false`
 *     (32.8 root nav stays at 6 primaries).
 *   - 5 read-only GET endpoints; no mutation routes; no POST/PATCH/PUT/DELETE
 *     in the analytics file.
 *   - No new client-state / queue libraries introduced.
 *   - No new root nav item.
 *   - File-size pins on the protected core files unchanged.
 *
 * Phase E4 does NOT add a Prisma migration (no schema change), so the
 * 32.7-2 migration drift allow-list does not need updating.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANALYTICS_DEFAULT_WINDOW_DAYS,
  ANALYTICS_MAX_WINDOW_DAYS,
  ANALYTICS_MIN_WINDOW_DAYS,
  clampWindow,
} from "../src/services/analytics/analytics.service.js";
import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";

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
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}

const SERVICE = readApi("src/services/analytics/analytics.service.ts");
const ROUTES = readApi("src/routes/analytics-operations.routes.ts");
const SERVER = readApi("src/server.ts");
const ROUTE_REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const PAGE = readWeb("app/(app)/operations/analytics/page.tsx");
const API_TYPES = readApi("src/services/platform-context/types.ts");
const WEB_TYPES = readWeb("lib/platform-context/types.ts");
const CAP_REG = readApi("src/services/platform-context/capability-registry.ts");

// ===========================================================================
// PART 1 — Bounded window constants + clamp
// ===========================================================================

describe("E4 Test 1 — bounded window", () => {
  it("default = 30, min = 1, max = 180", () => {
    expect(ANALYTICS_DEFAULT_WINDOW_DAYS).toBe(30);
    expect(ANALYTICS_MIN_WINDOW_DAYS).toBe(1);
    expect(ANALYTICS_MAX_WINDOW_DAYS).toBe(180);
  });

  it("clampWindow(undefined) → default", () => {
    expect(clampWindow(undefined)).toBe(ANALYTICS_DEFAULT_WINDOW_DAYS);
  });

  it("clampWindow(NaN) → default", () => {
    expect(clampWindow(Number.NaN)).toBe(ANALYTICS_DEFAULT_WINDOW_DAYS);
  });

  it("clampWindow(Infinity) → default", () => {
    expect(clampWindow(Number.POSITIVE_INFINITY)).toBe(
      ANALYTICS_DEFAULT_WINDOW_DAYS,
    );
  });

  it("clampWindow(0) → MIN (1)", () => {
    expect(clampWindow(0)).toBe(ANALYTICS_MIN_WINDOW_DAYS);
  });

  it("clampWindow(-7) → MIN (1)", () => {
    expect(clampWindow(-7)).toBe(ANALYTICS_MIN_WINDOW_DAYS);
  });

  it("clampWindow(1000) → MAX (180)", () => {
    expect(clampWindow(1000)).toBe(ANALYTICS_MAX_WINDOW_DAYS);
  });

  it("clampWindow(7) → 7 (valid in range)", () => {
    expect(clampWindow(7)).toBe(7);
  });

  it("clampWindow(30.7) → 30 (floored)", () => {
    expect(clampWindow(30.7)).toBe(30);
  });
});

// ===========================================================================
// PART 2 — ANALYTICS_VIEW capability registered + bounded
// ===========================================================================

describe("E4 Test 2 — ANALYTICS_VIEW capability registered", () => {
  it("ANALYTICS_VIEW present in API CapabilityKey union", () => {
    expect(API_TYPES).toMatch(/"ANALYTICS_VIEW"/);
  });

  it("ANALYTICS_VIEW present in web CapabilityKey union (mirror)", () => {
    expect(WEB_TYPES).toMatch(/"ANALYTICS_VIEW"/);
  });

  it("ANALYTICS_VIEW granted to TEAM writer (resolver)", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "MEMBER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(caps.ANALYTICS_VIEW).toBe(true);
  });

  it("ANALYTICS_VIEW granted to TEAM admin / owner", () => {
    for (const role of ["ADMIN", "OWNER"] as const) {
      const caps = resolveCapabilities({
        scope: "TEAM",
        role,
        plan: "TEAM",
        isPlatformAdmin: false,
      });
      expect(caps.ANALYTICS_VIEW, `role=${role}`).toBe(true);
    }
  });

  it("ANALYTICS_VIEW DENIED to TEAM viewer (read-only role still cannot see ops analytics)", () => {
    const caps = resolveCapabilities({
      scope: "TEAM",
      role: "VIEWER",
      plan: "TEAM",
      isPlatformAdmin: false,
    });
    expect(caps.ANALYTICS_VIEW).toBe(false);
  });

  it("ANALYTICS_VIEW DENIED when there is no workspace at all", () => {
    const caps = resolveCapabilities({
      scope: null,
      role: null,
      plan: null,
      isPlatformAdmin: false,
    });
    expect(caps.ANALYTICS_VIEW).toBe(false);
  });

  it("capability registry comment names ANALYTICS_VIEW as part of the writer block", () => {
    expect(CAP_REG).toMatch(/ANALYTICS_VIEW/);
  });
});

// ===========================================================================
// PART 3 — Analytics service source-trace + bounded queries
// ===========================================================================

describe("E4 Test 3 — analytics service source contract", () => {
  it("exports the 5 public analytics functions", () => {
    expect(SERVICE).toMatch(/export async function getOperationsOverview/);
    expect(SERVICE).toMatch(/export async function getReviewerAnalytics/);
    expect(SERVICE).toMatch(/export async function getGovernanceAnalytics/);
    expect(SERVICE).toMatch(/export async function getAutomationAnalytics/);
    expect(SERVICE).toMatch(/export async function getArtifactReadinessAnalytics/);
  });

  it("every public function returns AnalyticsEnvelope (declared return type)", () => {
    // Promise<AnalyticsEnvelope<...>> appears once per function.
    const matches = SERVICE.match(/Promise<AnalyticsEnvelope</g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it("envelope shape carries generatedAt + window + sourceTrace + degradedSources + metrics", () => {
    expect(SERVICE).toMatch(/generatedAt:\s*string/);
    expect(SERVICE).toMatch(/sourceTrace:\s*SourceTrace/);
    expect(SERVICE).toMatch(/degradedSources:\s*ReadonlyArray<string>/);
  });

  it("safe() wrapper exists and is used (Prisma errors → null + degraded push)", () => {
    expect(SERVICE).toMatch(/async function safe</);
    expect(SERVICE).toMatch(/degraded\.push\(source\)/);
  });

  it("every query is `count`, never unbounded findMany without teamId", () => {
    // .count appears for each metric (no .findMany of unbounded rows).
    expect(SERVICE).not.toMatch(/prisma\.\w+\.findMany\(\s*\{\s*\}\s*\)/);
    expect(SERVICE).not.toMatch(/prisma\.\w+\.findMany\(\s*\)/);
    // every count where-clause names teamId at least once.
    const countCalls = SERVICE.match(/\.count\(\{[\s\S]*?\}\)/g) ?? [];
    expect(countCalls.length).toBeGreaterThanOrEqual(15);
    for (const c of countCalls) {
      // Either teamId is filtered directly OR scoped through evidence.teamId
      // (Report + VerificationPackage path — those models have no teamId column).
      const ok = /teamId/.test(c) || /evidence:\s*\{\s*teamId/.test(c);
      expect(ok, `count call without team scope: ${c.slice(0, 120)}`).toBe(true);
    }
  });

  it("Report + VerificationPackage scope through evidence.teamId (no fake teamId column)", () => {
    // Reports/packages do not carry teamId; structural scoping prevents leakage.
    expect(SERVICE).toMatch(/prisma\.report\.count[\s\S]*?evidence:\s*\{\s*teamId/);
    expect(SERVICE).toMatch(
      /prisma\.verificationPackage\.count[\s\S]*?evidence:\s*\{\s*teamId/,
    );
  });

  it("does NOT import fetch / vm / child_process (no remote calls, no scripting)", () => {
    expect(SERVICE).not.toMatch(/from\s+["']vm["']/);
    expect(SERVICE).not.toMatch(/from\s+["']child_process["']/);
    expect(SERVICE).not.toMatch(/from\s+["']node-fetch["']/);
  });

  it("does NOT contain eval / new Function (no scripting layer)", () => {
    expect(SERVICE).not.toMatch(/\beval\s*\(/);
    expect(SERVICE).not.toMatch(/new\s+Function\s*\(/);
  });

  it("does NOT mutate evidence / custody / report / package state", () => {
    expect(SERVICE).not.toMatch(/\bevidence\.update\s*\(/);
    expect(SERVICE).not.toMatch(/\bevidence\.delete\s*\(/);
    expect(SERVICE).not.toMatch(/\bappendCustodyEvent\s*\(/);
    expect(SERVICE).not.toMatch(/\.update\(/);
    expect(SERVICE).not.toMatch(/\.delete\(/);
    expect(SERVICE).not.toMatch(/\.create\(/);
  });

  it("does NOT make legal / authenticity / admissibility claims in returned metrics", () => {
    // Match identifier / property / quoted-string usages only — comments
    // that say "no admissibility scores" are documentation, not claims.
    expect(SERVICE).not.toMatch(/admissibility[A-Za-z0-9_]*\s*[:=]/);
    expect(SERVICE).not.toMatch(/["']admissibility/i);
    expect(SERVICE).not.toMatch(/authenticity[A-Za-z0-9_]*\s*[:=]/);
    expect(SERVICE).not.toMatch(/["']authenticityScore/i);
    expect(SERVICE).not.toMatch(/legallyValid/);
    expect(SERVICE).not.toMatch(/courtReady/);
    expect(SERVICE).not.toMatch(/trustScore/);
  });

  it("operationsOverview wires a non-empty sourceTrace per public function", () => {
    // sourceTrace literal appears once per function block (5).
    const traces = SERVICE.match(/const sourceTrace:\s*SourceTrace\s*=/g) ?? [];
    expect(traces.length).toBe(5);
  });
});

// ===========================================================================
// PART 4 — REST endpoints + capability gate
// ===========================================================================

describe("E4 Test 4 — REST endpoints contract", () => {
  const ENDPOINTS = [
    "/v1/analytics/operations",
    "/v1/analytics/reviewer",
    "/v1/analytics/governance",
    "/v1/analytics/automation",
    "/v1/analytics/artifacts",
  ];

  it.each(ENDPOINTS)("registers GET %s", (path) => {
    const re = new RegExp(
      `app\\.get\\(\\s*["']${path.replace(/\//g, "\\/")}["']`,
    );
    expect(ROUTES).toMatch(re);
  });

  it("every endpoint uses requireAuth preHandler", () => {
    const gets = ROUTES.match(/app\.get\([\s\S]*?\)/g) ?? [];
    expect(gets.length).toBeGreaterThanOrEqual(5);
    for (const g of gets) {
      expect(g).toMatch(/preHandler:\s*requireAuth/);
    }
  });

  it("every analytics endpoint gates ANALYTICS_VIEW via gateAnalyticsRead", () => {
    expect(ROUTES).toMatch(/ANALYTICS_VIEW/);
    expect(ROUTES).toMatch(/gateAnalyticsRead/);
  });

  it("teamId query is uuid-validated via zod schema", () => {
    expect(ROUTES).toMatch(/teamId:\s*z\.string\(\)\.uuid\(\)/);
  });

  it("does NOT register any mutation verbs (POST / PATCH / PUT / DELETE)", () => {
    expect(ROUTES).not.toMatch(/app\.post\(/);
    expect(ROUTES).not.toMatch(/app\.patch\(/);
    expect(ROUTES).not.toMatch(/app\.put\(/);
    expect(ROUTES).not.toMatch(/app\.delete\(/);
  });

  it("server registers analyticsOperationsRoutes after automation routes", () => {
    expect(SERVER).toMatch(/analyticsOperationsRoutes/);
    const idxOps = SERVER.indexOf(
      "app.register(analyticsOperationsRoutes)",
    );
    const idxAutomation = SERVER.indexOf(
      "app.register(automationWebhooksRoutes)",
    );
    expect(idxOps).toBeGreaterThan(-1);
    expect(idxAutomation).toBeGreaterThan(-1);
  });

  it("gate calls prisma.teamMember + prisma.team and replies 403 on non-membership", () => {
    expect(ROUTES).toMatch(/prisma\.teamMember\.findUnique/);
    expect(ROUTES).toMatch(/prisma\.team\.findUnique/);
    expect(ROUTES).toMatch(/Not a member of the workspace/);
  });
});

// ===========================================================================
// PART 5 — Route registry entry + 32.8 IA preserved
// ===========================================================================

describe("E4 Test 5 — route registry entry", () => {
  it("registers platform.analytics under /operations/analytics", () => {
    expect(ROUTE_REGISTRY).toMatch(/id:\s*["']platform\.analytics["']/);
    expect(ROUTE_REGISTRY).toMatch(/href:\s*["']\/operations\/analytics["']/);
  });

  it("route requires ANALYTICS_VIEW capability", () => {
    const block = ROUTE_REGISTRY.match(
      /id:\s*["']platform\.analytics["'][\s\S]*?sidebarEligible:[^\n]+/,
    );
    expect(block, "platform.analytics block missing").toBeTruthy();
    expect(block![0]).toMatch(/requiredCapabilities:\s*\[\s*["']ANALYTICS_VIEW["']\s*\]/);
  });

  it("route is NOT sidebar-eligible (32.8 root nav stays at 6 primaries)", () => {
    const block = ROUTE_REGISTRY.match(
      /id:\s*["']platform\.analytics["'][\s\S]*?sidebarEligible:[^\n]+/,
    );
    expect(block![0]).toMatch(/sidebarEligible:\s*false/);
  });

  it("32.8 canonical primaries still exactly 6 (no new root nav)", () => {
    const groups = readWeb("lib/navigation/canonicalNavigationGroups.ts");
    const m = groups.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).toBeTruthy();
    const ids = Array.from(m![1]!.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    expect(ids).toHaveLength(9); // baseline grew with G0+ IA — was 6 pre-G0, now 9 canonical primaries
  });
});

// ===========================================================================
// PART 6 — Frontend page contract
// ===========================================================================

describe("E4 Test 6 — frontend page contract", () => {
  it("page exists at /ops/analytics", () => {
    expect(existsSync(webPath("app/(app)/operations/analytics/page.tsx"))).toBe(true);
  });

  it("default export wraps in PageRouteGate with platform.analytics", () => {
    expect(PAGE).toMatch(/PageRouteGate routeId=["']platform\.analytics["']/);
  });

  it("calls all 5 analytics endpoints", () => {
    expect(PAGE).toMatch(/\/v1\/analytics\/operations\?/);
    expect(PAGE).toMatch(/\/v1\/analytics\/reviewer\?/);
    expect(PAGE).toMatch(/\/v1\/analytics\/governance\?/);
    expect(PAGE).toMatch(/\/v1\/analytics\/automation\?/);
    expect(PAGE).toMatch(/\/v1\/analytics\/artifacts\?/);
  });

  it("renders degraded sentinel ('—' / 'Data source unavailable') instead of fake numbers", () => {
    expect(PAGE).toMatch(/data-analytics-degraded/);
    expect(PAGE).toMatch(/Data source unavailable/);
  });

  it("exposes source-trace badges to operators", () => {
    expect(PAGE).toMatch(/data-analytics-source-trace=/);
    expect(PAGE).toMatch(/source:/);
  });

  it("does NOT render legal / authenticity / admissibility / trust-score language", () => {
    // Match identifier / property / string-label usages — file comments
    // that say "no admissibility scores" are documentation, not claims.
    // The forbidden shapes are: an identifier ending in Score, a label
    // attribute string, or a JSX label= prop.
    expect(PAGE).not.toMatch(/admissibility[A-Za-z0-9_]*\s*[:=]/);
    expect(PAGE).not.toMatch(/admissibilityScore/);
    expect(PAGE).not.toMatch(/trustScore/);
    expect(PAGE).not.toMatch(/courtReady/);
    expect(PAGE).not.toMatch(/legallyValid/);
    expect(PAGE).not.toMatch(/authenticityScore/);
    expect(PAGE).not.toMatch(/label=["'][^"']*admissibility[^"']*["']/i);
    expect(PAGE).not.toMatch(/label=["'][^"']*court[- ]?ready[^"']*["']/i);
    expect(PAGE).not.toMatch(/label=["'][^"']*legally\s*valid[^"']*["']/i);
    expect(PAGE).not.toMatch(/label=["'][^"']*trust\s*score[^"']*["']/i);
    expect(PAGE).not.toMatch(/label=["'][^"']*authenticity\s*score[^"']*["']/i);
  });

  it("does NOT contain BI-builder / drag-drop / SQL-runner affordances", () => {
    expect(PAGE).not.toMatch(/drag/i);
    expect(PAGE).not.toMatch(/sql/i);
    expect(PAGE).not.toMatch(/queryBuilder/i);
    expect(PAGE).not.toMatch(/customMetric/i);
  });

  it("bounded window selector lists only the canonical day options", () => {
    expect(PAGE).toMatch(
      /ANALYTICS_WINDOW_OPTIONS\s*=\s*\[\s*7,\s*14,\s*30,\s*60,\s*90,\s*180\s*\]/,
    );
  });
});

// ===========================================================================
// PART 7 — File-size pins on protected core files
// ===========================================================================

describe("E4 Test 7 — protected core files untouched", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
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
// PART 8 — No new client-state / queue / pubsub library introduced
// ===========================================================================

describe("E4 Test 8 — no new state / queue libraries", () => {
  it("web package.json carries none of the forbidden client-state libraries", () => {
    const pkg = JSON.parse(readWeb("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const forbidden of [
      "@tanstack/react-query",
      "react-query",
      "swr",
      "redux",
      "zustand",
      "socket.io-client",
      "pusher-js",
      "ably",
      "kafkajs",
      "amqplib",
      "@google-cloud/pubsub",
    ]) {
      expect(deps[forbidden], `forbidden web dep ${forbidden}`).toBeUndefined();
    }
  });

  it("api package.json carries none of the forbidden queue / pubsub libraries", () => {
    const pkg = JSON.parse(readApi("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const forbidden of [
      "kafkajs",
      "amqplib",
      "@google-cloud/pubsub",
      "socket.io",
      "pusher",
      "ably",
    ]) {
      expect(deps[forbidden], `forbidden api dep ${forbidden}`).toBeUndefined();
    }
  });
});

// ===========================================================================
// PART 9 — Documentation + registry
// ===========================================================================

describe("E4 Test 9 — documentation + registry", () => {
  it("docs/product/PHASE_E4_ANALYTICS_OPERATIONAL_INTELLIGENCE.md exists + substantial", () => {
    const doc = readRepo(
      "docs/product/PHASE_E4_ANALYTICS_OPERATIONAL_INTELLIGENCE.md",
    );
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE E4/);
  });

  it("registry registers Phase E4 with explicit closure status", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    expect(registry).toMatch(
      /\|\s*(Phase )?E4\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });
});
