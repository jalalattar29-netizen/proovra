/**
 * Canonical prerequisites for the API integration suite.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `clean-db-boot` ran `pnpm test:integration` against a clean checkout and all
 * 23 suites died during module COLLECTION with
 *
 *     Failed to resolve entry for package "@proovra/shared-runtime"
 *
 * because every export of that package points at `./dist/*`, `pnpm install`
 * does not produce `dist`, and the root `build:shared` script builds shared,
 * shared-evidence-presentation, shared-billing and ui — but NOT shared-runtime.
 * The run reported 86 tests with 84 skipped, which was not 84 skipped tests: it
 * was the cases of the two suites that loaded, while 23 suites never registered
 * a case at all. Locally the command passed only because certification happened
 * to build the shared packages first.
 *
 * ORDER, AND WHY IT IS THIS ORDER
 * ---------------------------------------------------------------------------
 *   1. `prisma generate` — 11 files under `packages/shared-runtime/src` import
 *      `@prisma/client`. Without generation the client is MODULE_NOT_FOUND and
 *      the shared-runtime `tsc` build exits 2. Measured, not assumed.
 *   2. `build:deps` — the workspace packages `services/api/src` imports, in the
 *      order the API's own `prebuild` already established. That script is the
 *      single owner of the ordering; this file does not restate it.
 *
 * Each step must succeed before the next runs, and a failure here must stop the
 * suite from starting — a partial `dist` is worse than none, because Vitest
 * would collect against half a package and report something that looks like a
 * test result.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Anchored to this file, not to the caller's working directory: the steps below
 * are `services/api` package scripts, so invoking the prepare script from the
 * repository root must not silently resolve a different package's scripts.
 */
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `prisma generate` loads `prisma.config.ts`, which is a SAFETY hook: it
 * classifies the DATABASE_URL host and refuses remote ones. It therefore
 * requires the variable to exist even though generation never opens a
 * connection.
 *
 * When the caller has not supplied one, use an unmistakably local placeholder.
 * The host policy still runs and still refuses anything remote — nothing is
 * relaxed. An existing DATABASE_URL is never overwritten, so CI and developers
 * keep whatever they configured.
 */
const PLACEHOLDER =
  "postgresql://integration-prepare:integration-prepare@127.0.0.1:1/prisma_generate_only";

const env = { ...process.env };
if (!env.DATABASE_URL || env.DATABASE_URL.trim().length === 0) {
  env.DATABASE_URL = PLACEHOLDER;
  console.log(
    "integration-prepare: DATABASE_URL was unset; using a loopback placeholder for `prisma generate` only.",
  );
}

const steps = [
  { name: "prisma generate", args: ["run", "prisma:generate"] },
  { name: "build workspace dependencies", args: ["run", "build:deps"] },
];

for (const step of steps) {
  console.log(`integration-prepare: ${step.name}`);
  const r = spawnSync("pnpm", step.args, {
    cwd: API_ROOT,
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error(
      `integration-prepare: ${step.name} FAILED (exit ${r.status}). ` +
        "Refusing to start Vitest — an unbuilt or half-built package collects as " +
        "a resolution error, which reads as skipped tests rather than as a failure.",
    );
    process.exit(r.status ?? 1);
  }
}

console.log("integration-prepare: prerequisites ready.");
