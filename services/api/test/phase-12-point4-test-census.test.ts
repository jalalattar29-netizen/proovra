/**
 * API test-discovery invariants, measured live from disk and the two vitest
 * project configs.
 *
 *   1. Nothing is undiscovered. Every `*.test.ts` on disk is executed by
 *      exactly one of the two projects — the unit project or the integration
 *      project. A file that stops being discovered is silent coverage loss.
 *   2. Nothing is double-counted. No file is discovered by both projects, so
 *      combined totals are sums, not overlaps.
 *   3. No generated test twins. A committed `.test.js` beside a `.test.ts`
 *      would be an unexecuted stale copy inflating nothing and rotting quietly.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATION_SUFFIX = ".integration.test.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (statSync(p).isFile()) out.push(p);
  }
  return out;
}

const filesUnderTest = walk(join(API_ROOT, "test")).map((p) =>
  p.slice(API_ROOT.length + 1).split(sep).join("/"),
);
const testFilesOnDisk = filesUnderTest.filter((p) => p.endsWith(".test.ts"));

const config = (name: string) => readFileSync(resolve(API_ROOT, name), "utf8");

describe("API test discovery", () => {
  it("the two projects partition test files by the integration suffix", () => {
    // The configs ARE the discovery rule; assert the rule rather than a
    // recorded snapshot of what it once discovered.
    const unit = config("vitest.config.ts");
    const integration = config("vitest.integration.config.ts");
    expect(unit).toMatch(/include:\s*\["test\/\*\*\/\*\.test\.ts"\]/);
    expect(unit).toMatch(/exclude:\s*\[[^\]]*"test\/\*\*\/\*\.integration\.test\.ts"/);
    expect(integration).toMatch(/include:\s*\["test\/\*\*\/\*\.integration\.test\.ts"\]/);
  });

  it("every test file on disk is claimed by exactly one project (no silent loss, no double count)", () => {
    const unitOnDisk = testFilesOnDisk.filter((f) => !f.endsWith(INTEGRATION_SUFFIX));
    const integrationOnDisk = testFilesOnDisk.filter((f) => f.endsWith(INTEGRATION_SUFFIX));
    // Both halves non-empty: an empty integration half would mean the database
    // suites had been dropped rather than moved.
    expect(integrationOnDisk.length).toBeGreaterThan(0);
    expect(unitOnDisk.length).toBeGreaterThan(0);
    const both = unitOnDisk.filter((f) => integrationOnDisk.includes(f));
    expect(both).toEqual([]);
    expect(unitOnDisk.length + integrationOnDisk.length).toBe(testFilesOnDisk.length);
  });

  it("no committed generated test twins (GeneratedTestTwins = 0)", () => {
    const twins = filesUnderTest.filter((p) => /\.test\.(js|jsx|mjs|cjs)$/.test(p));
    expect(twins.sort(), `generated test twins:\n${twins.join("\n")}`).toEqual([]);
  });
});
