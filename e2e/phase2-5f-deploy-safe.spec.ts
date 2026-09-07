/**
 * Phase 2.5F — deploy:safe orchestrator + env isolation regression tests.
 *
 * Covers:
 *   1. deploy:safe --dry-run with local DATABASE_URL passes preflight + typecheck (exit 14).
 *   2. deploy:safe --dry-run with remote DATABASE_URL fails at preflight (exit 13).
 *   3. The .env.audit-local.example file exists at repo root (fresh-clone safety).
 *   4. The orchestrator banner labels the mode + remote-flag explicitly.
 */
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = process.cwd();
const API_DIR = resolve(REPO_ROOT, "services/api");
const DEPLOY_SAFE = join(API_DIR, "scripts/deploy-safe.mjs");
const ENV_EXAMPLE = join(REPO_ROOT, ".env.audit-local.example");

/**
 * THE CHILD WAS ALLOWED LONGER THAN THE TEST THAT WAITS FOR IT.
 *
 * `spawnSync` was given 90s inside a test whose budget is the config's
 * 60s default. Those bounds are the wrong way round, and `spawnSync`
 * BLOCKS the event loop, so Playwright's timeout cannot fire while the
 * child runs: the only bound that can act is the inner one. When it did,
 * the child was killed and `result.status` came back `null`, which the
 * assertion reported as "expected exit 14; got null" — a message that
 * describes an exit code that never happened and says nothing about the
 * kill.
 *
 * Measured in CI: this passed on 63866b55 and was killed on 441581e1, two
 * commits whose only difference is four machine-generated audit artifacts.
 * Same code, one pass, one kill — the budget is simply too tight for a
 * `tsc` typecheck on a shared runner, which the original comment guessed
 * at "10-15s".
 *
 * So the test now gets a budget larger than the child's, the child gets
 * one big enough for a cold typecheck, and a kill reports itself as a
 * kill instead of as a wrong exit code.
 */
const CHILD_BUDGET_MS = 180_000;
const TEST_BUDGET_MS = 240_000;

type DeploySafeRun = {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
  detail: string;
};

function runDeploySafe(
  args: string[],
  env: Record<string, string | undefined>,
): DeploySafeRun {
  const result = spawnSync("node", [DEPLOY_SAFE, ...args], {
    encoding: "utf8",
    cwd: API_DIR,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) =>
            k !== "DATABASE_URL" &&
            k !== "PRELIGHT_SKIP_DRIFT" &&
            k !== "MIGRATE_ALLOW_REMOTE" &&
            k !== "MIGRATE_BACKUP_ID",
        ),
      ),
      ...env,
    },
    timeout: CHILD_BUDGET_MS,
  });
  // A child that never returned an exit code did not fail the check under
  // test — it was stopped. `signal` is set when spawnSync's own timeout
  // kills it; `error` covers a spawn that never started at all.
  const killed = result.status === null;
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    killed,
    detail: killed
      ? `child produced no exit code (signal=${result.signal ?? "none"}, ` +
        `error=${result.error ? String(result.error) : "none"}, ` +
        `budget=${CHILD_BUDGET_MS / 1000}s)`
      : "",
  };
}

/**
 * Assert the child RAN before asserting anything about what it said. A
 * killed child has empty-ish output, so every later expectation would fail
 * for a reason that has nothing to do with what it was checking.
 */
function expectCompleted(r: DeploySafeRun): void {
  expect(
    r.killed,
    `deploy:safe did not finish: ${r.detail}\nstderr:\n${r.stderr}`,
  ).toBe(false);
}

test.describe("Phase 2.5F — deploy:safe + env isolation @critical", () => {
  // Larger than CHILD_BUDGET_MS, so the child's own bound is the one that
  // acts and the outer one stays a genuine backstop.
  test.describe.configure({ timeout: TEST_BUDGET_MS });
  test(".env.audit-local.example ships safe defaults", async () => {
    expect(
      existsSync(ENV_EXAMPLE),
      `expected ${ENV_EXAMPLE} to exist; fresh-clone safety depends on it`,
    ).toBe(true);
    const content = (await import("node:fs")).readFileSync(
      ENV_EXAMPLE,
      "utf8",
    );
    // The example MUST default to localhost — anyone copying this
    // file gets a SAFE LOCAL config, never a production-like one.
    expect(content).toContain("DATABASE_URL=postgresql://");
    expect(content).toContain("localhost");
    // Must NOT contain any production-like host pattern.
    expect(content).not.toContain(".neon.tech");
    expect(content).not.toContain("amazonaws.com");
    expect(content).not.toContain("pooler.");
  });

  test("deploy:safe --dry-run with local URL passes (exit 14)", async () => {
    const r = runDeploySafe(["--dry-run"], {
      DATABASE_URL: "postgresql://x:y@localhost:5432/db",
      PRELIGHT_SKIP_DRIFT: "1",
    });
    expectCompleted(r);
    expect(
      r.code,
      `expected exit 14 (dry-run OK); got ${r.code}\nstderr:\n${r.stderr}`,
    ).toBe(14);
    expect(r.stderr).toContain("DRY-RUN OK");
    expect(r.stderr).toContain("preflight");
    expect(r.stderr).toContain("typecheck");
  });

  test("deploy:safe --dry-run with remote URL fails at preflight (exit 13)", async () => {
    const r = runDeploySafe(["--dry-run"], {
      DATABASE_URL:
        "postgresql://x:y@ep-fake.eu-central-1.aws.neon.tech:5432/db",
    });
    expectCompleted(r);
    expect(
      r.code,
      `expected exit 13 (orchestrator FAIL); got ${r.code}\nstderr:\n${r.stderr}`,
    ).toBe(13);
    expect(r.stderr).toContain("FAILED at stage");
    // The downstream preflight surfaces the host classification.
    expect(r.stderr).toContain("ep-fake.eu-central-1.aws.neon.tech");
  });

  test("orchestrator banner labels mode + remote flag", async () => {
    const r = runDeploySafe(["--dry-run"], {
      DATABASE_URL: "postgresql://x:y@localhost:5432/db",
      PRELIGHT_SKIP_DRIFT: "1",
    });
    expectCompleted(r);
    expect(r.stderr).toContain("deploy:safe orchestrator (Phase 2.5F)");
    expect(r.stderr).toContain("mode: DRY-RUN");
    expect(r.stderr).toContain("--allow-remote: no");
  });
});
