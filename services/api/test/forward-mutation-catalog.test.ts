/**
 * AUD-33 (2026-10-20) — THE FORWARD MUTATION SUITE IS CURRENT AND IN CI.
 *
 * The audit's mutation run was a scratchpad script; three guards it showed
 * unpinned (D, F, G) could have regressed again unnoticed. The catalog
 * (scripts/mutation/forward-evidence-mutations.json) holds one re-introduced
 * defect per forward-remediation guard, phases 1-12, and runs in CI
 * (unit mutants in ci.yml, integration mutants in forward-mutation.yml).
 *
 * This case keeps it honest on every push: every anchor still matches exactly
 * once (a moved guard fails here, not silently in a nightly), and the three
 * audit mutants are present.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const CATALOG = "scripts/mutation/forward-evidence-mutations.json";
type Mutant = { id: string; phase: string; file: string; find: string; tests: Array<{ cwd: string; args: string[]; integration?: boolean }> };
const catalog = JSON.parse(readFileSync(resolve(REPO, CATALOG), "utf8")) as Mutant[];

describe("AUD-33 forward mutation catalog", () => {
  it("every anchor matches exactly once (the runner's own --check-anchors)", () => {
    const r = spawnSync(process.execPath, [resolve(REPO, "scripts/mutation/run-mutations.mjs"), CATALOG, "--check-anchors"], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(r.status, r.stdout.slice(-2000) + r.stderr.slice(-2000)).toBe(0);
    expect(r.stdout).toContain(`"ANCHOR_OK":${catalog.length}`);
  });

  it("carries the audit's three unpinned guards and every remediation phase", () => {
    const ids = new Set(catalog.map((m) => m.id));
    for (const id of ["P12-D", "P12-F", "P12-G"]) expect(ids.has(id), id).toBe(true);
    const phases = new Set(catalog.map((m) => m.phase));
    for (let p = 1; p <= 13; p += 1) expect(phases.has(`P${p}`), `P${p}`).toBe(true);
    // Phase 13 (2026-10-20): AUD-37/52 and the open findings carry their mutants.
    for (const id of ["P13-37A", "P13-52A", "P13-29A", "P13-43A", "P13-44A", "P13-48A", "P13-49A", "P13-51A"]) expect(ids.has(id), id).toBe(true);
    expect(new Set(catalog.map((m) => m.id)).size).toBe(catalog.length);
  });

  it("names only test files that exist", () => {
    const missing: string[] = [];
    for (const m of catalog) {
      for (const t of m.tests) {
        for (const a of t.args) {
          if (/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(a) && !existsSync(resolve(REPO, t.cwd, a))) missing.push(`${m.id}: ${t.cwd}/${a}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("runs in CI: unit mutants with ci, integration mutants in their own workflow", () => {
    const ci = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/run-mutations\.mjs scripts\/mutation\/forward-evidence-mutations\.json --skip-integration/);
    const fm = readFileSync(resolve(REPO, ".github/workflows/forward-mutation.yml"), "utf8");
    expect(fm).toMatch(/run-mutations\.mjs scripts\/mutation\/forward-evidence-mutations\.json --integration-only/);
  });
});
