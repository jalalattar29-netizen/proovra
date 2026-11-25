/**
 * REGRESSION — the read-only migration status check must run from the RELEASE IMAGE.
 *
 * Production (2026-11-25): before applying migration 20281124010000 the owner
 * ran `node scripts/drift-check.mjs` from the `proovra-api` image. It answered
 * `Command "prisma" not found` (ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL): the check
 * spawned `pnpm exec prisma`, the same defect safe-migrate.mjs had on
 * 2026-10-28. Even with the CLI found, the in-process hook in prisma.config.ts
 * refuses every `migrate` verb against a non-local host, so production had no
 * working way to read its migration state.
 *
 * Fixed: drift-check resolves the CLI through resolve-prisma-cli.mjs (shared
 * with safe-migrate) and, for a non-local host, requires the same two
 * acknowledgements as the migration wrapper. Targets here cannot be reached.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..");
const CHECK = resolve(API_ROOT, "scripts/drift-check.mjs");

const UNREACHABLE_LOCAL = "postgresql://proovra:disposable@127.0.0.1:59994/drift_probe_test";
// Classified REMOTE (`-pooler.`), but a `.localhost` name: nothing beyond this
// machine can be contacted (see safe-migrate-release-image-executor.test.ts).
const UNREACHABLE_REMOTE = "postgresql://probe:probe@proovra-probe-pooler.localhost:59995/neondb";

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    "DATABASE_URL",
    "DIRECT_URL",
    "DRIFT_CHECK_DATABASE_URL",
    "MIGRATE_ALLOW_REMOTE",
    "MIGRATE_BACKUP_ID",
    "SAFE_MIGRATE_WRAPPER_OK",
    "PRISMA_BYPASS_SAFETY",
  ]) {
    delete env[k];
  }
  return { ...env, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  const res = spawnSync(process.execPath, [CHECK, ...args], { cwd: API_ROOT, env, encoding: "utf8", timeout: 120_000 });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const PRISMA_RAN = /Loaded Prisma config|Prisma schema loaded|migrations found|P1001|Can't reach database server/i;
const NOT_FOUND = /Command "prisma" not found|ERR_PNPM|ENOENT/i;

describe("drift-check — runs from the release image layout", { timeout: 120_000 }, () => {
  it("runs the Prisma CLI with no package manager and no node_modules/.bin on PATH", () => {
    const { out } = run([], { ...baseEnv(), DATABASE_URL: UNREACHABLE_LOCAL, PATH: "" });
    expect(out).not.toMatch(NOT_FOUND);
    expect(out, `prisma did not execute:\n${out}`).toMatch(PRISMA_RAN);
  });

  it("a remote target without both acknowledgements stops before Prisma with the instruction", () => {
    const { status, out } = run([], { ...baseEnv(), DATABASE_URL: UNREACHABLE_REMOTE });
    expect(status).toBe(8);
    expect(out).toMatch(/MIGRATE_ALLOW_REMOTE=1 node scripts\/drift-check\.mjs --allow-remote/);
    expect(out).not.toMatch(PRISMA_RAN);
  });

  it("the flag alone is not enough", () => {
    const { status, out } = run(["--allow-remote"], { ...baseEnv(), DATABASE_URL: UNREACHABLE_REMOTE });
    expect(status).toBe(8);
    expect(out).not.toMatch(PRISMA_RAN);
  });

  it("an acknowledged remote check reaches Prisma: the hook accepts it", () => {
    const { out } = run(["--allow-remote"], {
      ...baseEnv(),
      DATABASE_URL: UNREACHABLE_REMOTE,
      MIGRATE_ALLOW_REMOTE: "1",
    });
    expect(out).not.toMatch(/\[prisma\.config\] REFUSED/);
    expect(out).not.toMatch(NOT_FOUND);
    expect(out, `prisma did not execute:\n${out}`).toMatch(PRISMA_RAN);
  });

  it("an explicit remote target is still refused (exit 3), acknowledgements or not", () => {
    const { status } = run([`--database-url=${UNREACHABLE_REMOTE}`, "--allow-remote"], {
      ...baseEnv(),
      MIGRATE_ALLOW_REMOTE: "1",
    });
    expect(status).toBe(3);
  });

  it("never spawns pnpm, never sets PRISMA_BYPASS_SAFETY, runs only `migrate status`", () => {
    const code = readFileSync(CHECK, "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/spawnSync\(\s*"pnpm"/);
    expect(code).not.toMatch(/PRISMA_BYPASS_SAFETY/);
    expect(code).not.toMatch(/process\.env\.SAFE_MIGRATE_WRAPPER_OK\s*=/);
    expect(code).toMatch(/\[prismaCli\.cliPath, "migrate", "status"\]/);
  });
});
