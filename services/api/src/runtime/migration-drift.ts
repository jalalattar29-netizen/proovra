/**
 * Phase 28-F — Migration drift detector.
 *
 * Compares the on-disk `prisma/migrations/` directory with the
 * applied `_prisma_migrations` table to surface:
 *
 *   - unapplied migrations (on disk but no DB row OR finished_at=null)
 *   - rolled-back migrations (DB row with rolled_back_at != null)
 *   - history-only migrations (DB row but no directory) — usually
 *     means the working tree is out of date relative to the DB
 *
 * Read-only. Reports + alerts; never auto-runs migrations.
 *
 * Path resolution:
 *   The migrations directory is resolved relative to the api service
 *   workspace (`services/api/prisma/migrations`). In containerized
 *   deploys the workspace is bundled into the image; in local dev it
 *   is the repo's prisma directory.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db.js";

export type MigrationDriftEntry = {
  name: string;
  source: "disk_only" | "db_only" | "rolled_back" | "in_progress";
  /** Operator-readable bounded label. */
  detail: string;
  /** When the DB row exists, the timestamp the migration finished. */
  finishedAtUtc: string | null;
  /** When the DB row exists and was rolled back, the timestamp. */
  rolledBackAtUtc: string | null;
};

export type MigrationDriftReport = {
  status: "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";
  ranAtUtc: string;
  /** Stable fingerprint over the disk migrations list for change-detection. */
  fingerprint: string;
  diskCount: number;
  dbCount: number;
  drift: ReadonlyArray<MigrationDriftEntry>;
};

const MIGRATIONS_DIR_CANDIDATES = [
  // From services/api/src/runtime/migration-drift.ts → repo prisma dir.
  ["..", "..", "prisma", "migrations"],
  // Fall-back when the build flattens the layout.
  ["..", "..", "..", "prisma", "migrations"],
];

function resolveMigrationsDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const segments of MIGRATIONS_DIR_CANDIDATES) {
    const candidate = path.resolve(here, ...segments);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function listDiskMigrations(): string[] {
  const dir = resolveMigrationsDir();
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((name) => {
        const full = path.join(dir, name);
        try {
          return statSync(full).isDirectory() && name !== "migration_lock.toml";
        } catch {
          return false;
        }
      })
      // Prisma migration names are timestamp-prefixed; sort lexically.
      .sort();
  } catch {
    return [];
  }
}

async function fetchDbMigrations(
  prisma: PrismaClient,
): Promise<
  Array<{
    migration_name: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>
> {
  try {
    return await prisma.$queryRawUnsafe<
      Array<{
        migration_name: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }>
    >(
      `SELECT migration_name, finished_at, rolled_back_at
       FROM "_prisma_migrations"
       ORDER BY started_at ASC`,
    );
  } catch {
    return [];
  }
}

function fingerprintDisk(names: string[]): string {
  // 32-bit FNV-1a hash over the joined names — stable and short.
  let hash = 0x811c9dc5;
  const joined = names.join("|");
  for (let i = 0; i < joined.length; i++) {
    hash ^= joined.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `disk_${hash.toString(16).padStart(8, "0")}`;
}

export async function runMigrationDriftCheck(
  prisma: PrismaClient = defaultPrisma,
): Promise<MigrationDriftReport> {
  const disk = listDiskMigrations();
  const dbRows = await fetchDbMigrations(prisma);
  const dbByName = new Map(dbRows.map((r) => [r.migration_name, r] as const));
  const drift: MigrationDriftEntry[] = [];

  for (const name of disk) {
    const dbRow = dbByName.get(name);
    if (!dbRow) {
      drift.push({
        name,
        source: "disk_only",
        detail: "Migration exists on disk but has not been applied to the database.",
        finishedAtUtc: null,
        rolledBackAtUtc: null,
      });
      continue;
    }
    if (dbRow.rolled_back_at) {
      drift.push({
        name,
        source: "rolled_back",
        detail: "Migration was rolled back. DB schema may be inconsistent.",
        finishedAtUtc: dbRow.finished_at?.toISOString() ?? null,
        rolledBackAtUtc: dbRow.rolled_back_at.toISOString(),
      });
      continue;
    }
    if (!dbRow.finished_at) {
      drift.push({
        name,
        source: "in_progress",
        detail: "Migration started but not finished. Likely failed mid-apply.",
        finishedAtUtc: null,
        rolledBackAtUtc: null,
      });
    }
  }

  for (const row of dbRows) {
    if (!disk.includes(row.migration_name)) {
      drift.push({
        name: row.migration_name,
        source: "db_only",
        detail:
          "Migration recorded in the database but absent from the deployed prisma/migrations directory. Working tree may be out of date.",
        finishedAtUtc: row.finished_at?.toISOString() ?? null,
        rolledBackAtUtc: row.rolled_back_at?.toISOString() ?? null,
      });
    }
  }

  const hasRolledBack = drift.some((d) => d.source === "rolled_back");
  const hasInProgress = drift.some((d) => d.source === "in_progress");
  const status: MigrationDriftReport["status"] =
    hasRolledBack || hasInProgress
      ? "CRITICAL"
      : drift.length > 0
        ? "DEGRADED"
        : "HEALTHY";

  return {
    status,
    ranAtUtc: new Date().toISOString(),
    fingerprint: fingerprintDisk(disk),
    diskCount: disk.length,
    dbCount: dbRows.length,
    drift,
  };
}
