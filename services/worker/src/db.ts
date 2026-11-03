import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "./config.js";

/**
 * The connection pool's ceiling (CAP-9, capacity 2026-11-03). Unset keeps the
 * `pg` default of 10, which is what every deployment ran before this setting
 * existed. A value must be a whole number from 1 to 500; anything else stops the
 * process rather than guessing. The right production number depends on the
 * database's connection limit and pooler and is not chosen here
 * (docs/operations/capacity-measurements.md).
 */
export const DEFAULT_DATABASE_POOL_MAX = 10;

export function databasePoolMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DATABASE_POOL_MAX;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new Error("DATABASE_POOL_MAX must be a whole number from 1 to 500");
  }
  return n;
}

const pool = new Pool({ connectionString: env.DATABASE_URL, max: databasePoolMax(process.env.DATABASE_POOL_MAX) });
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });
