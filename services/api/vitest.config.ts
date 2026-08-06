import { defineConfig } from "vitest/config";

/**
 * PHASE 12 — POINT 7: the canonical bootstrap is a --import PRELOAD.
 *
 * Set HERE, in the runner configuration, because this file is evaluated in the
 * main process before any worker is spawned and workers inherit NODE_OPTIONS.
 * That makes the bootstrap the FIRST thing every worker runs — earlier than a
 * setup file, which the previous pass proved is not early enough: module-level
 * clients in the application graph had already captured the machine environment
 * by then, and the outbound guard caught one of them dialling Upstash.
 */
const POINT7_BOOTSTRAP = new URL("./test/setup/test-bootstrap.mjs", import.meta.url).href;
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${POINT7_BOOTSTRAP}`]
  .filter(Boolean)
  .join(" ");


/**
 * Canonical API UNIT project.
 *
 * PHASE 12 POINT 4 — integration suites live in their own project
 * (`vitest.integration.config.ts`) because they need a real PostgreSQL and a
 * booted Fastify app. They are excluded here by FILE SUFFIX, not skipped at
 * runtime: a `describe.skip` would report them as "skipped" in this run and
 * invite the fiction that they are pending. Every `*.integration.test.ts` is
 * executed by `pnpm test:integration` against a disposable Postgres.
 *
 * This exclusion is narrow and mechanical (one suffix). It is NOT a broad
 * exclusion: no directory, glob-family, or capability is removed from the
 * unit run, and the skip/live-pending gate asserts that the two projects
 * together discover every test file in `test/`.
 */
export default defineConfig({
  test: {
    environment: "node",
    // PHASE 12 POINT 7 CORRECTIVE PASS — the safe-environment authority runs
    // BEFORE the test module imports anything, which is the only place it can
    // run: db.ts opens with `import "dotenv/config"`, so by the time a test
    // body executes the machine's .env has already been merged in. It scrubs
    // every credential-shaped variable, points dotenv at nothing, and installs
    // the outbound socket guard.
    setupFiles: ["./test/setup/safe-environment.ts"],
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "test/**/*.integration.test.ts"],
  },
});
