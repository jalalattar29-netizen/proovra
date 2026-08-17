/**
 * PHASE 12 — POINT 7 (2026-08-05): this module NO LONGER loads a `.env` file.
 *
 * It used to open with `import "dotenv/config"`, and that one line is the root
 * cause of the production-isolation incident. `db.ts` is a LIBRARY module —
 * almost everything in the API graph reaches it — so every process that
 * imported anything database-shaped silently acquired the deployment
 * environment, including every test process. On this machine that environment
 * carries the production Sentry DSN, an Upstash Redis URL, the production
 * evidence bucket and live AWS/Stripe/Resend/OpenAI credentials.
 *
 * The real entrypoints never needed it: `services/api/src/index.ts` opens with
 * `import "./env.js"` and the worker with `import "./env-loader.js"`, both of
 * which load configuration EXPLICITLY. The dotenv import was redundant there
 * and load-bearing only for callers that had not asked for it.
 *
 * The rule this establishes: environment files are loaded by ENTRYPOINTS, never
 * by libraries.
 *   production / staging → `src/env.ts` (API) · `src/env-loader.ts` (worker)
 *   tests                → `test/setup/test-bootstrap.mjs`, as a `--import`
 *                          preload, before any application module resolves
 *   CLI / seed scripts    → `import "./env.js"` at the top of the script
 *
 * A caller that reaches here without having loaded configuration gets a clear
 * "DATABASE_URL is not set" below, which is a far better failure than silently
 * connecting to production.
 */

import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

/**
 * Close the connection pool THIS module owns.
 *
 * PHASE 13 §4. The pool was module-private and unexported, so nothing could
 * shut it down. In the integration run that meant the disposable PostgreSQL
 * container was stopped while pooled connections were still checked out:
 * PostgreSQL answered `57P01 terminating connection due to administrator
 * command`, `pg` raised it asynchronously after the last assertion had already
 * passed, and the runner exited 1 on a suite where 662 of 662 tests passed. A
 * certification that reports a non-zero exit for a teardown race is worthless
 * in both directions — it hides real failures and manufactures fake ones.
 *
 * `prisma.$disconnect()` alone is not enough with a driver adapter: the adapter
 * wraps a pool the CALLER owns, so the caller has to end it. Both are done
 * here, in order, and the pool's own counters are returned so a teardown guard
 * can assert that nothing was still borrowed rather than trusting the call.
 */
export async function closeDatabasePool(): Promise<{
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}> {
  await prisma.$disconnect().catch(() => undefined);
  // `end()` on an already-ended pool throws; ending twice is not an error worth
  // propagating out of a teardown path.
  await pool.end().catch(() => undefined);
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}
