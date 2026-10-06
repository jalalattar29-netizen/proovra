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

/**
 * A vitest glob as a matcher over API-root-relative POSIX paths. Only `**`
 * and `*` are supported; anything else throws, so the matcher is extended
 * rather than silently wrong.
 */
function globToRegExp(glob: string): RegExp {
  if (/[?{}[\]!]/.test(glob)) throw new Error(`unsupported glob syntax: ${glob}`);
  let re = "";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("/**", i) && i + 3 === glob.length) {
      re += "(?:/.*)?";
      i += 3;
    } else if (glob[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else {
      re += /[.+^$()|\\]/.test(glob[i]) ? `\\${glob[i]}` : glob[i];
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** The project's real `include` / `exclude` arrays, read from its config. */
function projectGlobs(source: string): { include: RegExp[]; exclude: RegExp[] } {
  const arr = (key: string): string[] => {
    const m = source.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  };
  const include = arr("include").map(globToRegExp);
  expect(include.length, "a project config declares no include globs").toBeGreaterThan(0);
  return { include, exclude: arr("exclude").map(globToRegExp) };
}

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
    // Evaluated against the configs' REAL include/exclude globs, so an extra
    // exclude that drops a suite, or an include that claims a file twice,
    // fails here rather than shrinking the run unnoticed.
    const unit = projectGlobs(config("vitest.config.ts"));
    const integration = projectGlobs(config("vitest.integration.config.ts"));
    const claims = (p: { include: RegExp[]; exclude: RegExp[] }, f: string) =>
      p.include.some((g) => g.test(f)) && !p.exclude.some((g) => g.test(f));
    const unitOnDisk = testFilesOnDisk.filter((f) => claims(unit, f));
    const integrationOnDisk = testFilesOnDisk.filter((f) => claims(integration, f));
    // Both halves non-empty: an empty integration half would mean the database
    // suites had been dropped rather than moved.
    expect(integrationOnDisk.length).toBeGreaterThan(0);
    expect(unitOnDisk.length).toBeGreaterThan(0);
    expect(integrationOnDisk.every((f) => f.endsWith(INTEGRATION_SUFFIX))).toBe(true);
    const unclaimed = testFilesOnDisk.filter((f) => !claims(unit, f) && !claims(integration, f));
    expect(unclaimed, `test files no project runs:\n${unclaimed.join("\n")}`).toEqual([]);
    const both = unitOnDisk.filter((f) => claims(integration, f));
    expect(both, `test files both projects run:\n${both.join("\n")}`).toEqual([]);
  });

  it("no committed generated test twins (GeneratedTestTwins = 0)", () => {
    const twins = filesUnderTest.filter((p) => /\.test\.(js|jsx|mjs|cjs)$/.test(p));
    expect(twins.sort(), `generated test twins:\n${twins.join("\n")}`).toEqual([]);
  });
});
