import { randomUUID } from "node:crypto";

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
 * PHASE 12 — POINT 5: one run identifier per integration run.
 *
 * Minted HERE, at config load, so every suite in the run records the same
 * value and a proof artifact can be attributed to a single run. The family
 * gate rejects records that disagree, records with no run id, and records
 * bound to a registry or manifest that has since changed — which is what
 * stops last month's artifact from crediting today's closure.
 */
const POINT5_RUN_ID = randomUUID();

/**
 * PHASE 12 — POINT 7: the same discipline for the product-behaviour matrix.
 *
 * A SEPARATE identifier rather than a reuse of the Point-5 one. The two points
 * prove different things and their proof artifacts are read by different
 * gates; sharing one id would let a Point-5-only run appear to refresh Point-7
 * credit, which is exactly the stitching the run id exists to prevent.
 *
 * INHERITED when the environment already carries one. Point 7's evidence spans
 * TWO runners — this project and the Playwright browser project — and the gate
 * requires every record to share ONE run id. A certification run therefore
 * exports `POINT7_RUN_ID` once and both runners adopt it; minting
 * unconditionally here would guarantee the server and browser halves never
 * agreed, which would make a complete run permanently ungradeable.
 */
const POINT7_RUN_ID = process.env.POINT7_RUN_ID ?? randomUUID();

/**
 * Canonical API INTEGRATION project.
 *
 * PHASE 12 POINT 4 — these suites were previously `describe.skip`ped at
 * runtime and registered as "live pending". That was false: every one of them
 * runs faithfully against a disposable PostgreSQL 16, which the repository
 * already provides two ways —
 *
 *   1. CI: the `postgres:16-alpine` service container used by
 *      `.github/workflows/schema-reproducibility.yml`, addressed through
 *      `TEST_DATABASE_URL`;
 *   2. locally: `@testcontainers/postgresql`, started by the harness when
 *      `TEST_DATABASE_URL` is absent.
 *
 * The suites are therefore separated by PROJECT, not disabled by a skip. The
 * unit project excludes the `*.integration.test.ts` suffix; this project runs
 * exactly that suffix. No test is skipped in either.
 *
 * `RUN_LIVE_INTEGRATION` is set here rather than demanded of the operator: the
 * flag's job was to keep these out of the unit run, and the project boundary
 * now does that. The harness's REAL safety guards are untouched — it still
 * refuses to read `DATABASE_URL`, and a supplied `TEST_DATABASE_URL` must name
 * a database containing "test" unless `RUN_LIVE_INTEGRATION_DB_OK=1`.
 *
 * Timeouts are declared here, bounded and explicit, because pulling/starting a
 * Postgres image plus booting Fastify does not fit vitest's 10s hook default —
 * that default is why these gates could never pass even when a database WAS
 * available.
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
    include: ["test/**/*.integration.test.ts"],
    // Container start + `prisma migrate deploy` + Fastify boot.
    hookTimeout: 900_000,
    // PHASE 12 — measured, not guessed.
    //
    // 300_000 was five minutes of silence per test. Three tests hit it in CI
    // when losing purge transactions blocked on a row lock with no
    // `lock_timeout`, and the job burned ~19 minutes to report nothing but
    // "Test timed out in 300000ms".
    //
    // Healthy execution measured against a disposable PostgreSQL 16 + pgvector:
    // the slowest ENTIRE FILE is ~13s (51 tests), the whole integration project
    // ~131s. 60s per test is roughly 4.6x the slowest whole file and far above
    // any single case, while the harness bounds each session below it
    // (lock 15s, statement 30s, idle-in-transaction 30s) so the database
    // reports a classified cause before this deadline is ever reached.
    testTimeout: 60_000,
    teardownTimeout: 120_000,
    // Serial: the suites seed and tear down overlapping fixture namespaces in
    // one database, and a shared container must not be raced.
    fileParallelism: false,
    env: {
      RUN_LIVE_INTEGRATION: "1",
      POINT5_RUN_ID,
      POINT7_RUN_ID,
      // PHASE 12 — POINT 7 (final pass): the outbound ledger, RUN-SCOPED.
      //
      // One file for the whole product run — the server matrix here and the
      // browser matrix API process — so the closure gate reads a single record
      // of what THAT run reached for.
      //
      // The default is run-scoped for the same reason the proof artifact is
      // strength-scoped. It used to be a fixed shared path, so every ordinary
      // `pnpm test:integration` APPENDED its own connections to the canonical
      // Point-7 product ledger under a fresh run id — and the gate, correctly,
      // refused the whole proof with "N ledger record(s) belong to a different
      // run id". A diagnostic run must not be able to invalidate an
      // authoritative one by merely existing.
      //
      // `scripts/point7-run.mjs` NAMES the canonical path explicitly and clears
      // it at the start of the run, so the one workflow that is entitled to
      // write the canonical ledger still does.
      P7_NETWORK_LEDGER:
        process.env.P7_NETWORK_LEDGER ??
        `../../.p7tmp/product-run-network.${POINT7_RUN_ID}.jsonl`,
      // The isolation canary writes to a DIFFERENT file, because its one
      // deliberate forbidden attempt must never be able to excuse or accuse a
      // product run. Run-scoped for the same reason as above.
      P7_CANARY_LEDGER:
        process.env.P7_CANARY_LEDGER ??
        `../../.p7tmp/canary-network.${POINT7_RUN_ID}.jsonl`,
      P7_PHASE: "product",
      P7_PROCESS: "vitest-integration",
      // The local recording email provider's mailbox for this run.
      EMAIL_RECORDER_FILE:
        process.env.EMAIL_RECORDER_FILE ?? "../../.p7tmp/recorded-emails.jsonl",
      // Non-production, test-only signing secret for harness-minted tokens.
      // Never a real key: the harness only needs a syntactically valid HS256
      // secret to exercise the authenticated request pipeline.
      AUTH_JWT_SECRET:
        process.env.AUTH_JWT_SECRET ?? "integration-only-secret-0123456789abcdef",
    },
  },
});
