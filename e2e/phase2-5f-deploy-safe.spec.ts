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

function runDeploySafe(
  args: string[],
  env: Record<string, string | undefined>,
): { code: number | null; stdout: string; stderr: string } {
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
    // Force a longer-than-default test timeout for the typecheck stage;
    // tsc on a fresh build can take 10-15s.
    timeout: 90_000,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test.describe("Phase 2.5F — deploy:safe + env isolation @critical", () => {
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
    expect(r.stderr).toContain("deploy:safe orchestrator (Phase 2.5F)");
    expect(r.stderr).toContain("mode: DRY-RUN");
    expect(r.stderr).toContain("--allow-remote: no");
  });
});
