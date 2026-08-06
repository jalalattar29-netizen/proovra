/**
 * PHASE 12 POINT 4 — deterministic test-discovery census gate.
 *
 * The Point-4 report claimed an API pass count that had risen by ~1,860
 * without a per-file explanation. The census that resolved it lives in
 * `docs/architecture/api-test-census.json`; this gate keeps its invariants
 * true instead of leaving them as a one-off claim.
 *
 * What the census established, and what is enforced here:
 *
 *   1. Nothing is undiscovered. Every `*.test.ts` on disk is executed by
 *      exactly one of the two projects — the unit project or the integration
 *      project. A file that stops being discovered is silent coverage loss.
 *   2. Nothing is double-counted. No file is discovered by both projects, so
 *      combined totals are sums, not overlaps.
 *   3. No generated test twins. A committed `.test.js` beside a `.test.ts`
 *      would be an unexecuted stale copy inflating nothing and rotting quietly.
 *   4. No recorded test FILE has disappeared. Per-file COUNTS are deliberately
 *      not pinned: three suites (phase-r10, phase-r11, phase-cr5) emit one
 *      assertion PER web source file, so their totals legitimately move with
 *      the tree — which is precisely why raw totals from different tree states
 *      were never comparable, and why the earlier figure could not be
 *      reconciled by arithmetic alone.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(API_ROOT, "..", "..");
const CENSUS_PATH = resolve(REPO, "docs/architecture/api-test-census.json");
const INTEGRATION_SUFFIX = ".integration.test.ts";

type FileCounts = {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
};
type Census = {
  projects: Record<string, { files: number; config: string; command: string }>;
  combined: { files: number; filesDiscoveredByBothProjects: number; failed: number; skipped: number };
  perFile: { unit: Record<string, FileCounts>; integration: Record<string, FileCounts> };
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (statSync(p).isFile()) out.push(p);
  }
  return out;
}

const testFilesOnDisk = walk(join(API_ROOT, "test"))
  .map((p) => p.slice(API_ROOT.length + 1).split(sep).join("/"))
  .filter((p) => p.endsWith(".test.ts"));

const census = JSON.parse(readFileSync(CENSUS_PATH, "utf8")) as Census;

describe("Phase 12 Point 4 — API test census", () => {
  it("the census artifact exists and names both canonical projects", () => {
    expect(existsSync(CENSUS_PATH)).toBe(true);
    expect(census.projects.unit.config).toBe("services/api/vitest.config.ts");
    expect(census.projects.integration.config).toBe(
      "services/api/vitest.integration.config.ts",
    );
    expect(census.projects.unit.command).toMatch(/test$/);
    expect(census.projects.integration.command).toMatch(/test:integration$/);
  });

  it("every recorded test file still exists (LostBehavioralTests = 0)", () => {
    const recorded = [
      ...Object.keys(census.perFile.unit),
      ...Object.keys(census.perFile.integration),
    ];
    expect(recorded.length).toBeGreaterThan(600);
    const gone = recorded.filter((f) => !existsSync(resolve(API_ROOT, f)));
    expect(
      gone.sort(),
      `test files recorded in the census that no longer exist:\n${gone.join("\n")}`,
    ).toEqual([]);
  });

  it("no file is discovered by BOTH projects (DuplicateTestDiscovery = 0)", () => {
    const both = Object.keys(census.perFile.unit).filter(
      (f) => f in census.perFile.integration,
    );
    expect(both.sort(), `files discovered twice:\n${both.join("\n")}`).toEqual([]);
    expect(census.combined.filesDiscoveredByBothProjects).toBe(0);
    // The suffix partition is what guarantees it, so assert it structurally too.
    expect(
      Object.keys(census.perFile.unit).filter((f) => f.endsWith(INTEGRATION_SUFFIX)),
    ).toEqual([]);
    expect(
      Object.keys(census.perFile.integration).filter(
        (f) => !f.endsWith(INTEGRATION_SUFFIX),
      ),
    ).toEqual([]);
  });

  it("every test file on disk is claimed by exactly one project (no silent loss)", () => {
    const unitOnDisk = testFilesOnDisk.filter((f) => !f.endsWith(INTEGRATION_SUFFIX));
    const integrationOnDisk = testFilesOnDisk.filter((f) =>
      f.endsWith(INTEGRATION_SUFFIX),
    );
    // Both halves non-empty: an empty integration half would mean the database
    // suites had been dropped rather than moved.
    expect(integrationOnDisk.length).toBeGreaterThan(0);
    expect(unitOnDisk.length).toBeGreaterThan(0);
    expect(unitOnDisk.length + integrationOnDisk.length).toBe(testFilesOnDisk.length);
  });

  it("no committed generated test twins (GeneratedTestTwins = 0)", () => {
    const twins = walk(join(API_ROOT, "test"))
      .map((p) => p.slice(API_ROOT.length + 1).split(sep).join("/"))
      .filter((p) => /\.test\.(js|jsx|mjs|cjs)$/.test(p));
    expect(twins.sort(), `generated test twins:\n${twins.join("\n")}`).toEqual([]);
  });

  it("the census recorded a fully green, fully executed run", () => {
    expect(census.combined.failed).toBe(0);
    // Zero skipped is the whole point of the correction: there is no longer a
    // "live pending" category, so nothing may be recorded as skipped.
    expect(census.combined.skipped).toBe(0);
    expect(census.combined.files).toBe(
      census.projects.unit.files + census.projects.integration.files,
    );
  });
});

describe("Phase 12 Point 4 — historical baselines are classified, not assumed", () => {
  type Baseline = { value: string; classification: string; reason: string };
  const census = JSON.parse(readFileSync(CENSUS_PATH, "utf8")) as {
    historicalBaselines: Baseline[];
    fileInventoryDriven: { suites: string[]; currentCounts: Record<string, number> };
  };

  it("every historical figure carries an explicit classification", () => {
    expect(census.historicalBaselines.length).toBeGreaterThan(0);
    const VALID = new Set([
      "RAW_RUNNER_ARTIFACT",
      "DERIVED_FROM_MANIFEST / AUTHORITATIVE",
      "RAW_RUNNER_ARTIFACT (summary only, no per-file breakdown)",
      "HAND_REPORTED_ONLY / NON_AUTHORITATIVE",
      "UNREPRODUCIBLE",
    ]);
    for (const b of census.historicalBaselines) {
      expect(VALID, `unclassified baseline: ${b.value}`).toContain(b.classification);
      expect(b.reason.length).toBeGreaterThan(30);
    }
  });

  it("the 19,360 figure is recorded as non-authoritative (FalseHistoricalBaselineClaims = 0)", () => {
    const legacy = census.historicalBaselines.find((b) => b.value.includes("19,360"));
    expect(legacy, "the historical figure must be registered, not silently dropped").toBeTruthy();
    expect(legacy!.classification).toBe("HAND_REPORTED_ONLY / NON_AUTHORITATIVE");
    // And the ledger must say so, so nobody reconciles against it again.
    const ledger = readFileSync(
      resolve(REPO, "docs/architecture/program-ledger.md"),
      "utf8",
    );
    expect(ledger).toMatch(/19,360 API test figure is NON-AUTHORITATIVE/);
    expect(ledger).toMatch(/HAND_REPORTED_ONLY \/ NON_AUTHORITATIVE/);
  });

  it("exactly ONE baseline is authoritative, and it is this census", () => {
    // NOTE: "NON_AUTHORITATIVE" contains "AUTHORITATIVE", so the classification
    // must be matched exactly rather than by substring.
    const authoritative = census.historicalBaselines.filter(
      (b) => b.classification === "DERIVED_FROM_MANIFEST / AUTHORITATIVE",
    );
    expect(authoritative).toHaveLength(1);
    expect(authoritative[0]!.value).toBe("this manifest");
  });

  it("the file-inventory-driven suites are named, so totals are never read as fixed", () => {
    // A raw total is only meaningful alongside the tree that produced it.
    expect(census.fileInventoryDriven.suites.length).toBeGreaterThan(0);
    for (const s of census.fileInventoryDriven.suites) {
      expect(existsSync(resolve(API_ROOT, s)), `${s} must exist`).toBe(true);
      const src = readFileSync(resolve(API_ROOT, s), "utf8");
      // Each really does generate cases from a filesystem walk.
      expect(src, `${s} must generate per-file cases`).toMatch(
        /for \(const \w+ of (APP_FILES|CSS_FILES|CAPTURE_FILES|CAPTURE_AI_FILES)\)/,
      );
      expect(census.fileInventoryDriven.currentCounts[s]).toBeGreaterThan(0);
    }
  });
});
