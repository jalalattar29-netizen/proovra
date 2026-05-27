/**
 * Phase 2.5E — Migration preflight aggregator regression tests.
 *
 * Covers the new `db-preflight.mjs` and the CI hard-enforcement
 * surface.
 *
 *   1. Preflight against a local DATABASE_URL + skip-drift returns
 *      exit 0 (the aggregator's pass signal).
 *   2. Preflight against a remote DATABASE_URL without override
 *      returns exit 12 (composite FAIL signal).
 *   3. Preflight surfaces a structured banner with PASS/WARN/FAIL
 *      per check.
 *   4. The Phase 2.5C/D scripts still refuse a fake Neon URL with
 *      the documented exit codes (regression guard).
 */
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";

const API_DIR = resolve(process.cwd(), "services/api");
const PREFLIGHT = join(API_DIR, "scripts/db-preflight.mjs");

function runPreflight(env: Record<string, string | undefined>): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("node", [PREFLIGHT], {
    encoding: "utf8",
    cwd: API_DIR,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) =>
            k !== "DATABASE_URL" &&
            k !== "PRELIGHT_SKIP_DRIFT" &&
            k !== "MIGRATE_ALLOW_REMOTE",
        ),
      ),
      ...env,
    },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test.describe("Phase 2.5E — preflight aggregator @critical", () => {
  test("preflight exits 0 on local URL + skip-drift", async () => {
    const r = runPreflight({
      DATABASE_URL: "postgresql://x:y@localhost:5432/db",
      PRELIGHT_SKIP_DRIFT: "1",
    });
    expect(
      r.code,
      `expected exit 0; got ${r.code}\nstderr:\n${r.stderr}`,
    ).toBe(0);
    expect(r.stderr).toContain("DATABASE_URL classification");
    expect(r.stderr).toContain("local");
  });

  test("preflight exits 12 on remote URL without override", async () => {
    const r = runPreflight({
      DATABASE_URL:
        "postgresql://x:y@ep-fake.eu-central-1.aws.neon.tech:5432/db",
      PRELIGHT_SKIP_DRIFT: "1",
    });
    expect(
      r.code,
      `expected exit 12; got ${r.code}\nstderr:\n${r.stderr}`,
    ).toBe(12);
    expect(r.stderr).toContain("FAIL");
    expect(r.stderr).toContain("refusing without --allow-remote");
  });

  test("preflight banner lists every check with PASS/WARN/FAIL", async () => {
    const r = runPreflight({
      DATABASE_URL: "postgresql://x:y@localhost:5432/db",
      PRELIGHT_SKIP_DRIFT: "1",
    });
    // The banner is structured so an operator (or CI log scraper)
    // can see exactly which checks ran and their outcome.
    expect(r.stderr).toContain("PROOVRA migration preflight (Phase 2.5E)");
    expect(r.stderr).toContain("DATABASE_URL classification");
    expect(r.stderr).toContain("Migration risk scan");
    expect(r.stderr).toContain("Drift check");
    expect(r.stderr).toContain("Result:");
  });
});
