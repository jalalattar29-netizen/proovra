/**
 * THE MERGED MIGRATION ON A DATABASE THAT ALREADY HOLDS EIGHT-YEAR EVIDENCE
 * (owner decision 2026-10-15) — executed upgrade proof.
 *
 * `20281014000000_free_outputs_canonical_verification_retention_archive` is
 * applied by Prisma itself (`prisma migrate deploy`) to a database that was
 * first migrated to the state BEFORE it and seeded with the shapes Production
 * holds:
 *
 *   - a record sealed in October 2026 whose original is locked until 2034,
 *     with a report object locked even later (mixed object dates);
 *   - an ordinary record inside its eight-year window;
 *   - a trashed record under Legal Hold whose retention has passed;
 *   - a trashed record with NO retention metadata.
 *
 * Proven: the migration changes no existing retain-until, lifecycle or
 * deletion value, writes no row anywhere (so it enqueues nothing destructive),
 * and leaves the new purge/barrier facts EMPTY — so nothing is purge-eligible
 * until the version-aware sweep reads storage. The canonical lifecycle
 * authority, fed the migrated rows, keeps the 2034 record retention-blocked and
 * the metadata-less one fail-closed.
 *
 * Everything runs against the disposable test server only (the harness's own
 * database guards apply to its URL); a separate database is created for the
 * upgrade and dropped afterwards.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluateTrashExit } from "@proovra/shared";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "20281014000000_free_outputs_canonical_verification_retention_archive";
const LEGACY_2034 = "2034-10-14T00:00:00.000Z";
const REPORT_LATER = "2034-11-02T00:00:00.000Z";

describe("the merged migration preserves eight-year evidence (Prisma upgrade on a seeded database)", () => {
  let release: (() => Promise<void>) | undefined;
  let adminUrl = "";
  let upgradeUrl = "";
  let dbName = "";
  let tmp = "";
  const ids = { legacy: randomUUID(), ordinary: randomUUID(), held: randomUUID(), missing: randomUUID() };

  function deploy(migrationsDir: string) {
    const config = join(tmp, `prisma.config.${migrationsDir.endsWith("full") ? "full" : "pre"}.ts`);
    writeFileSync(
      config,
      `import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: ${JSON.stringify(join(API_ROOT, "prisma", "schema.prisma"))}, migrations: { path: ${JSON.stringify(migrationsDir)} }, datasource: { url: ${JSON.stringify(upgradeUrl)} } });\n`,
    );
    const run = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", config], {
      cwd: API_ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, DATABASE_URL: upgradeUrl },
    });
    if (run.status !== 0) throw new Error(`migrate deploy failed:\n${run.stdout}\n${run.stderr}`);
    return run.stdout;
  }

  async function withDb<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    const { acquireIntegrationDatabase } = await import("./integration-harness.js");
    const db = await acquireIntegrationDatabase();
    release = db.release;
    adminUrl = db.url;
    dbName = `eight_year_upgrade_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const u = new URL(adminUrl);
    u.pathname = `/${dbName}`;
    upgradeUrl = u.toString();
    await withDb(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));

    // Two migration sets in a gitignored scratch directory: without the
    // target (the database as Production holds it today), and complete.
    tmp = join(API_ROOT, ".p7tmp", `upgrade-${randomUUID()}`);
    const pre = join(tmp, "migrations-pre");
    const full = join(tmp, "migrations-full");
    mkdirSync(tmp, { recursive: true });
    const src = join(API_ROOT, "prisma", "migrations");
    cpSync(src, full, { recursive: true });
    cpSync(src, pre, { recursive: true });
    rmSync(join(pre, TARGET), { recursive: true, force: true });
    expect(readdirSync(full)).toContain(TARGET);
    expect(readdirSync(pre)).not.toContain(TARGET);
    deploy(pre);
  }, 900_000);

  afterAll(async () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (dbName) await withDb(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)).catch(() => null);
    await release?.();
  }, 120_000);

  it("changes no retain-until, lifecycle or deletion value, writes no row, and leaves nothing purge-eligible", async () => {
    // ── seed the pre-migration database with Production's shapes ──────────
    await withDb(upgradeUrl, async (c) => {
      const userId = randomUUID();
      const orgId = randomUUID();
      const teamId = randomUUID();
      await c.query(`INSERT INTO users (id, provider, provider_user_id, updated_at) VALUES ($1, 'EMAIL', $2, now())`, [userId, `u-${userId}`]);
      await c.query(`INSERT INTO organizations (id, name, updated_at) VALUES ($1, 'Upgrade fixture', now())`, [orgId]);
      await c.query(
        `INSERT INTO teams (id, name, owner_user_id, organization_id, workspace_kind, is_personal, updated_at) VALUES ($1, 'Upgrade fixture', $2, $3, 'PERSONAL', true, now())`,
        [teamId, userId, orgId],
      );
      const evidence = async (id: string, cols: Record<string, unknown>) => {
        const base: Record<string, unknown> = { id, type: "DOCUMENT", owner_user_id: userId, team_id: teamId, organization_id: orgId, status: "REPORTED", updated_at: new Date(), ...cols };
        const keys = Object.keys(base);
        await c.query(
          `INSERT INTO evidence (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
          keys.map((k) => base[k]),
        );
      };
      const DAY = 86_400_000;
      await evidence(ids.legacy, {
        created_at: new Date("2026-10-14T00:00:00Z"),
        signed_at_utc: new Date("2026-10-14T00:00:00Z"),
        storage_bucket: "lock",
        storage_key: `evidence/${ids.legacy}/original`,
        storage_object_lock_mode: "GOVERNANCE",
        storage_object_lock_retain_until_utc: new Date(LEGACY_2034),
        lifecycle_state: "TRASHED",
        deleted_at: new Date(Date.now() - 100 * DAY),
        deleted_at_utc: new Date(Date.now() - 100 * DAY),
      });
      await c.query(
        `INSERT INTO reports (evidence_id, version, storage_bucket, storage_key, generated_at_utc, storage_object_lock_mode, storage_object_lock_retain_until_utc) VALUES ($1, 1, 'lock', $2, now(), 'GOVERNANCE', $3)`,
        [ids.legacy, `reports/${ids.legacy}/v1.pdf`, new Date(REPORT_LATER)],
      );
      await evidence(ids.ordinary, {
        signed_at_utc: new Date(),
        storage_object_lock_mode: "GOVERNANCE",
        storage_object_lock_retain_until_utc: new Date(Date.now() + 2920 * DAY),
      });
      await evidence(ids.held, {
        storage_object_lock_mode: "GOVERNANCE",
        storage_object_lock_retain_until_utc: new Date("2020-01-01T00:00:00Z"),
        lifecycle_state: "TRASHED",
        deleted_at: new Date(Date.now() - 200 * DAY),
      });
      await c.query(
        `INSERT INTO evidence_legal_holds (team_id, evidence_id, title, placed_by_user_id, status, updated_at) VALUES ($1, $2, 'Hold', $3, 'ACTIVE', now())`,
        [teamId, ids.held, userId],
      );
      await evidence(ids.missing, { lifecycle_state: "TRASHED", deleted_at: new Date(Date.now() - 200 * DAY) });
    });

    const snapshot = () =>
      withDb(upgradeUrl, async (c) => {
        const rows = (
          await c.query(
            `SELECT id, lifecycle_state::text, status::text, deleted_at, deleted_at_utc, archived_at, retention_until_utc,
                    storage_object_lock_mode, storage_object_lock_retain_until_utc
               FROM evidence ORDER BY id`,
          )
        ).rows;
        const reports = (await c.query(`SELECT evidence_id, storage_object_lock_retain_until_utc FROM reports ORDER BY evidence_id`)).rows;
        const tables = (
          await c.query(`SELECT relname FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname`)
        ).rows.map((r) => r.relname as string);
        const counts: Record<string, number> = {};
        for (const t of tables) counts[t] = Number((await c.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n);
        return { rows, reports, counts };
      });

    const before = await snapshot();
    const out = deploy(join(tmp, "migrations-full"));
    expect(out).toContain(TARGET);
    const after = await snapshot();

    // Every pre-existing value is untouched — the 2034 lock above all.
    expect(after.rows).toEqual(before.rows);
    expect(after.reports).toEqual(before.reports);
    const legacy = after.rows.find((r) => r.id === ids.legacy)!;
    expect(new Date(legacy.storage_object_lock_retain_until_utc).toISOString()).toBe(LEGACY_2034);
    // No table gained or lost a row (the new table starts empty): nothing was
    // enqueued, archived, purged or backfilled by the migration.
    for (const [t, n] of Object.entries(before.counts)) {
      // Prisma's own ledger records exactly the one migration it applied.
      expect(after.counts[t], t).toBe(t === "_prisma_migrations" ? n + 1 : n);
    }
    expect(after.counts.evidence_archive_restore_requests).toBe(0);

    // The new facts start EMPTY: nothing is purge-eligible by migration.
    const facts = await withDb(upgradeUrl, (c) =>
      c.query(
        `SELECT id, latest_required_retain_until_utc, purge_eligible_at_utc, retention_barrier_state, retention_archived_at_utc, verification_ref, verification_access_state
           FROM evidence ORDER BY id`,
      ),
    );
    for (const f of facts.rows) {
      expect(f).toMatchObject({
        latest_required_retain_until_utc: null,
        purge_eligible_at_utc: null,
        retention_barrier_state: null,
        retention_archived_at_utc: null,
        verification_ref: null,
        verification_access_state: "AVAILABLE",
      });
    }

    // The ONE lifecycle authority, fed the migrated rows and their storage
    // truth: the 2034 record stays retention-blocked (latest object = the later
    // report), the held record stays held, the metadata-less one fails closed.
    const now = new Date();
    const exit = (id: string, extra: Record<string, unknown>) => {
      const r = after.rows.find((x) => x.id === id)!;
      return evaluateTrashExit(
        {
          lifecycleState: r.lifecycle_state,
          lockedAt: null,
          legalHold: false,
          trashedAt: r.deleted_at,
          // The 90-day Trash has ended for every seeded record.
          trashGraceUntil: new Date(new Date(r.deleted_at).getTime() + 90 * 86_400_000),
          appRetentionUntil: r.retention_until_utc,
          objectLockRetainUntil: r.storage_object_lock_retain_until_utc,
          objectLockMode: r.storage_object_lock_mode,
          ...extra,
        },
        now,
      );
    };
    const legacyExit = exit(ids.legacy, { requiredObjectRetainUntil: new Date(REPORT_LATER), storageRetentionTruth: "VERIFIED" });
    expect(legacyExit.decision).toBe("RETENTION_ARCHIVE");
    expect(new Date(legacyExit.purgeEligibleAt!).toISOString()).toBe(REPORT_LATER);
    expect(exit(ids.held, { legalHold: true, requiredObjectRetainUntil: new Date("2020-01-01T00:00:00Z"), storageRetentionTruth: "VERIFIED" }).decision).toBe("RETENTION_ARCHIVE");
    expect(exit(ids.missing, { requiredObjectRetainUntil: null, storageRetentionTruth: "MISSING" }).decision).toBe("RETENTION_ARCHIVE");
  }, 900_000);
});
