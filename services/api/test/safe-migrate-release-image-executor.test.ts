/**
 * REGRESSION — the canonical migration path must run from the RELEASE IMAGE.
 *
 * Production incident (2026-10-28). `safe-migrate.mjs deploy --allow-remote`,
 * run as the runbook documents from the `proovra-api` image, failed three ways:
 *
 *   1. `Command "prisma" not found` (ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL). The
 *      wrapper spawned `pnpm exec prisma` from services/api; the image installs
 *      with `--node-linker=hoisted`, so the CLI is in /app/node_modules/.bin,
 *      which neither services/api nor the image PATH carried.
 *   2. With that worked around, the in-process hook in prisma.config.ts would
 *      have refused (`missing_flag_--allow-remote`): the wrapper consumes
 *      `--allow-remote` and never handed the acknowledgement on.
 *   3. The first `pnpm` in the container made Corepack download pnpm.
 *
 * These cases run the real wrapper and the real Prisma CLI with `status`
 * (read-only) against targets that cannot be reached, so they need no
 * database: the proof is how far each run gets, and which layer refuses.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const WRAPPER = resolve(API_ROOT, "scripts/safe-migrate.mjs");

const UNREACHABLE_LOCAL = "postgresql://proovra:disposable@127.0.0.1:59992/image_executor_probe_test";
// Classified REMOTE by the shared host policy (remote patterns are checked
// first, and `-pooler.` is one), yet a `.localhost` name (RFC 6761) — so the
// test bootstrap, which NODE_OPTIONS preloads into every spawned child and
// which replaces any non-loopback DATABASE_URL, keeps it, and nothing beyond
// this machine can be contacted.
const UNREACHABLE_REMOTE = "postgresql://probe:probe@proovra-probe-pooler.localhost:59993/neondb";

/** The ambient environment minus every key that could change a decision here. */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    "DATABASE_URL",
    "DIRECT_URL",
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
  const res = spawnSync(process.execPath, args, { cwd: API_ROOT, env, encoding: "utf8", timeout: 120_000 });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Prisma itself executed: it loaded its config/schema or tried the database. */
const PRISMA_RAN = /Loaded Prisma config|Prisma schema loaded|migrations found|P1001|Can't reach database server/i;

const SPAWN_CASE_TIMEOUT_MS = 120_000;

describe("safe-migrate — runs from the release image layout", { timeout: SPAWN_CASE_TIMEOUT_MS }, () => {
  it("runs the lockfile-pinned Prisma CLI with no package manager and no node_modules/.bin on PATH", () => {
    // The release image: no `pnpm` it can use offline, no .bin on PATH. An
    // empty PATH is the strictest form of both.
    const { out } = run([WRAPPER, "status"], { ...baseEnv(), DATABASE_URL: UNREACHABLE_LOCAL, PATH: "" });

    expect(out).not.toMatch(/Command "prisma" not found|ERR_PNPM|ENOENT|could not be started/i);
    const pinned = JSON.parse(
      readFileSync(createRequire(resolve(API_ROOT, "package.json")).resolve("prisma/package.json"), "utf8"),
    ).version as string;
    expect(out).toContain(`[safe-migrate] prisma CLI: ${pinned}`);
    expect(out, `prisma did not execute:\n${out}`).toMatch(PRISMA_RAN);
  });

  it("an APPROVED remote run reaches Prisma — the in-process hook accepts the wrapper's hand-off", () => {
    const { out } = run([WRAPPER, "status", "--allow-remote"], {
      ...baseEnv(),
      DATABASE_URL: UNREACHABLE_REMOTE,
      MIGRATE_ALLOW_REMOTE: "1",
      MIGRATE_BACKUP_ID: "TEST_PROBE_BACKUP",
    });

    expect(out).toMatch(/classification: REMOTE/);
    expect(out).toMatch(/EXPLICIT REMOTE MIGRATION OVERRIDE/);
    // The defect: the hook refused every wrapper-approved remote migration.
    expect(out).not.toMatch(/\[prisma\.config\] REFUSED|missing_flag_--allow-remote/);
    expect(out, `prisma did not execute:\n${out}`).toMatch(PRISMA_RAN);
  });

  it("the wrapper still refuses a remote run without the backup acknowledgement, before Prisma", () => {
    const { status, out } = run([WRAPPER, "status", "--allow-remote"], {
      ...baseEnv(),
      DATABASE_URL: UNREACHABLE_REMOTE,
      MIGRATE_ALLOW_REMOTE: "1",
    });
    expect(status).toBe(11);
    expect(out).not.toMatch(PRISMA_RAN);
  });

  it("the hand-off stands in for the flag ONLY — the hook still requires MIGRATE_ALLOW_REMOTE=1", () => {
    // Prisma invoked directly with the hand-off variable but without the env
    // acknowledgement: the hook must still refuse a remote host.
    const cli = resolve(
      dirname(createRequire(resolve(API_ROOT, "package.json")).resolve("prisma/package.json")),
      "build/index.js",
    );
    const { status, out } = run([cli, "migrate", "status"], {
      ...baseEnv(),
      DATABASE_URL: UNREACHABLE_REMOTE,
      SAFE_MIGRATE_WRAPPER_OK: "1",
    });
    expect(status).toBe(8);
    expect(out).toMatch(/missing_env_MIGRATE_ALLOW_REMOTE/);
  });

  it("the wrapper never sets PRISMA_BYPASS_SAFETY and sets the hand-off only on the Prisma child", () => {
    const src = readFileSync(WRAPPER, "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/PRISMA_BYPASS_SAFETY/);
    expect(code).not.toMatch(/process\.env\.SAFE_MIGRATE_WRAPPER_OK\s*=/);
    expect(code).not.toMatch(/spawnSync\(\s*"pnpm"/);
  });
});

describe("services/api/Dockerfile — the runtime carries its own pinned pnpm", () => {
  const dockerfile = readFileSync(resolve(API_ROOT, "Dockerfile"), "utf8");
  const runnerAt = dockerfile.search(/^FROM .* AS runner$/m);
  const runner = dockerfile
    .slice(runnerAt)
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  it("installs pnpm at build time from the root packageManager pin, never at run time", () => {
    expect(runnerAt).toBeGreaterThan(-1);
    const pin = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).packageManager as string;
    expect(pin).toMatch(/^pnpm@\d+\.\d+\.\d+/);
    // The pin is read from the root manifest, not restated in the Dockerfile.
    expect(runner).toMatch(/^COPY package\.json \/tmp\/corepack-pin\/package\.json$/m);
    expect(runner).toMatch(/corepack install(?!\s+-g)/);
    expect(runner).toMatch(/^ENV COREPACK_HOME=\S+$/m);
    expect(runner).toMatch(/^ENV COREPACK_ENABLE_NETWORK=0$/m);
    // Installed before the image drops to the unprivileged user.
    expect(runner.indexOf("corepack install")).toBeLessThan(runner.search(/^USER app$/m));
  });

  it("appends — never prepends — the hoisted .bin directory to PATH", () => {
    expect(runner).toMatch(/^ENV PATH=\$PATH:\/app\/node_modules\/\.bin$/m);
    expect(runner).not.toMatch(/^ENV PATH=\/app\/node_modules\/\.bin/m);
  });
});
