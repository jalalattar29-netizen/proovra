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
