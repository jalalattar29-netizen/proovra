/**
 * THE VERIFICATION DISCLOSURE MIGRATION ON A POPULATED DATABASE (2026-10-18) —
 * executed upgrade proof.
 *
 * `20281018000000_verification_disclosure_policy` is applied by Prisma itself
 * (`prisma migrate deploy`) to a database first migrated to the state BEFORE it
 * and seeded with every shape the mapping must handle:
 *
 *   publication   PUBLISHED / NOT_PUBLISHED / SUSPENDED / UNPUBLISHED
 *   access        AVAILABLE / WITHDRAWN / SUSPENDED
 *   lifecycle     ACTIVE / TRASHED / RETENTION_ARCHIVED / DESTROYED (soft-deleted too)
 *   links         active and revoked OWNER_SHARE, REPORT links, on each kind of record
 *   location      a record with coordinates
 *
 * Proven: PUBLISHED → CONTENT_PREVIEW, everything else VERIFICATION_ONLY; no
 * record shows location; access, lifecycle, bytes, hashes, retention, custody,
 * reports and packages are unchanged; only active OWNER_SHARE links of records
 * that were not PUBLISHED (which answered 404) are closed; re-running the SQL
 * is a no-op and never overwrites an owner's later choice; a second deploy has
 * nothing to apply.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "20281018000000_verification_disclosure_policy";

type Shape = {
  key: string;
  publication: "PUBLISHED" | "NOT_PUBLISHED" | "SUSPENDED" | "UNPUBLISHED";
  access: "AVAILABLE" | "WITHDRAWN" | "SUSPENDED";
  lifecycle: "ACTIVE" | "TRASHED" | "RETENTION_ARCHIVED" | "DESTROYED";
  deleted?: boolean;
  coordinates?: boolean;
};
const SHAPES: Shape[] = [
  { key: "published", publication: "PUBLISHED", access: "AVAILABLE", lifecycle: "ACTIVE", coordinates: true },
  { key: "publishedWithdrawn", publication: "PUBLISHED", access: "WITHDRAWN", lifecycle: "ACTIVE" },
  { key: "notPublished", publication: "NOT_PUBLISHED", access: "AVAILABLE", lifecycle: "ACTIVE", coordinates: true },
  { key: "suspended", publication: "SUSPENDED", access: "AVAILABLE", lifecycle: "ACTIVE" },
  { key: "unpublished", publication: "UNPUBLISHED", access: "SUSPENDED", lifecycle: "ACTIVE" },
  { key: "trashedPublished", publication: "PUBLISHED", access: "AVAILABLE", lifecycle: "TRASHED", deleted: true },
  { key: "archived", publication: "SUSPENDED", access: "AVAILABLE", lifecycle: "RETENTION_ARCHIVED", deleted: true },
  { key: "destroyed", publication: "NOT_PUBLISHED", access: "AVAILABLE", lifecycle: "DESTROYED", deleted: true },
];

/** Every column the migration must leave exactly as it was. */
const PRESERVED_COLUMNS = [
  "status",
  "lifecycle_state",
  "deleted_at",
  "destroyed_at_utc",
  "file_sha256",
  "fingerprint_hash",
  "signature_base64",
  "storage_key",
  "storage_version_id",
  "retention_until_utc",
  "lat",
  "lng",
  "verification_ref",
  "verification_access_state",
  "public_verify_state",
  "legacy_verify_uuid_until_utc",
];

describe("the disclosure migration maps every shape fail closed (Prisma upgrade on a seeded database)", () => {
  let release: (() => Promise<void>) | undefined;
  let adminUrl = "";
  let upgradeUrl = "";
  let dbName = "";
  let tmp = "";
  const ids: Record<string, string> = Object.fromEntries(SHAPES.map((s) => [s.key, randomUUID()]));
  const links: Record<string, string> = {};

  function deploy(migrationsDir: string, label: string) {
    const config = join(tmp, `prisma.config.${label}.ts`);
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
    return `${run.stdout}\n${run.stderr}`;
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

  const snapshot = () =>
    withDb(upgradeUrl, async (c) => ({
      evidence: (await c.query(`SELECT id, ${PRESERVED_COLUMNS.join(", ")} FROM evidence ORDER BY id`)).rows,
      custody: Number((await c.query(`SELECT count(*)::int AS n FROM custody_events`)).rows[0].n),
      reports: (await c.query(`SELECT id, evidence_id, version, storage_key, generated_at_utc FROM reports ORDER BY id`)).rows,
    }));

  beforeAll(async () => {
    const { acquireIntegrationDatabase } = await import("./integration-harness.js");
    const db = await acquireIntegrationDatabase();
    release = db.release;
    adminUrl = db.url;
    dbName = `disclosure_upgrade_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const u = new URL(adminUrl);
    u.pathname = `/${dbName}`;
    upgradeUrl = u.toString();
    await withDb(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
    tmp = join(API_ROOT, ".p7tmp", `upgrade-${randomUUID()}`);
    const pre = join(tmp, "migrations-pre");
    const full = join(tmp, "migrations-full");
    mkdirSync(tmp, { recursive: true });
    const src = join(API_ROOT, "prisma", "migrations");
    cpSync(src, full, { recursive: true });
    cpSync(src, pre, { recursive: true });
    rmSync(join(pre, TARGET), { recursive: true, force: true });
    expect(readdirSync(full)).toContain(TARGET);
    deploy(pre, "pre");

    // ── seed the immediate pre-migration schema ─────────────────────────────
    await withDb(upgradeUrl, async (c) => {
      const userId = randomUUID();
      const orgId = randomUUID();
      const teamId = randomUUID();
      await c.query(`INSERT INTO users (id, provider, provider_user_id, updated_at) VALUES ($1, 'EMAIL', $2, now())`, [userId, `u-${userId}`]);
      await c.query(`INSERT INTO organizations (id, name, updated_at) VALUES ($1, 'Disclosure upgrade', now())`, [orgId]);
      await c.query(
        `INSERT INTO teams (id, name, owner_user_id, organization_id, workspace_kind, is_personal, updated_at) VALUES ($1, 'Disclosure upgrade', $2, $3, 'ORGANIZATION', false, now())`,
        [teamId, userId, orgId],
      );
      let n = 0;
      for (const shape of SHAPES) {
        n += 1;
        const id = ids[shape.key]!;
        const ref = `pvr_${(shape.key + "x".repeat(27)).slice(0, 27).replace(/[^A-Za-z0-9_-]/g, "x")}`;
        await c.query(
          `INSERT INTO evidence (id, type, owner_user_id, team_id, organization_id, status, updated_at,
             public_verify_state, verification_access_state, lifecycle_state, deleted_at, destroyed_at_utc,
             file_sha256, fingerprint_hash, signature_base64, storage_key, storage_version_id, retention_until_utc,
             lat, lng, verification_ref, legacy_verify_uuid_until_utc)
           VALUES ($1, 'DOCUMENT', $2, $3, $4, 'REPORTED', now(), $5, $6, $7, $8, $9, $10, $11, 'c2ln', $12, $13, $14, $15, $16, $17, $18)`,
          [
            id,
            userId,
            teamId,
            orgId,
            shape.publication,
            shape.access,
            shape.lifecycle,
            shape.deleted ? new Date("2026-10-01T00:00:00Z") : null,
            shape.lifecycle === "DESTROYED" ? new Date("2026-10-02T00:00:00Z") : null,
            String(n).repeat(64).slice(0, 64),
            String(n + 1).repeat(64).slice(0, 64),
            `evidence/${id}/parts/000-secret-name-${n}.pdf`,
            `v${n}`,
            new Date("2034-10-14T00:00:00Z"),
            shape.coordinates ? 48.137154 : null,
            shape.coordinates ? 11.576124 : null,
            ref,
            shape.publication === "PUBLISHED" ? new Date("2027-03-01T00:00:00Z") : null,
          ],
        );
        // An active recipient link, a revoked one, and a report link on every record.
        for (const [kind, purpose, revoked] of [
          ["active", "OWNER_SHARE", false],
          ["revoked", "OWNER_SHARE", true],
          ["report", "REPORT", false],
        ] as const) {
          const linkId = randomUUID();
          links[`${shape.key}:${kind}`] = linkId;
          await c.query(
            `INSERT INTO verification_share_tokens (id, evidence_id, team_id, token_hash, purpose, projection, created_at_utc, revoked_at_utc, revocation_reason)
             VALUES ($1, $2, $3, $4, $5, 'STANDARD', now(), $6, $7)`,
            [linkId, id, teamId, randomUUID().replace(/-/g, "").padEnd(64, "0"), purpose, revoked ? new Date("2026-10-05T00:00:00Z") : null, revoked ? "OWNER_REVOKED" : null],
          );
        }
        await c.query(
          `INSERT INTO reports (id, evidence_id, version, storage_bucket, storage_key, generated_at_utc) VALUES ($1, $2, 1, 'b', $3, now())`,
          [randomUUID(), id, `reports/${id}/v1.pdf`],
        );
      }
    });
  }, 900_000);

  afterAll(async () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (dbName) await withDb(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)).catch(() => null);
    await release?.();
  }, 120_000);

  let before: Awaited<ReturnType<typeof snapshot>>;

  it("maps PUBLISHED → CONTENT_PREVIEW and everything else → VERIFICATION_ONLY, location off, nothing else changed", async () => {
    before = await snapshot();
    const out = deploy(join(tmp, "migrations-full"), "full");
    expect(out).toMatch(/disclosure-migration pre:|Applying migration|applied/i);
    const after = await snapshot();
    expect(after.evidence).toEqual(before.evidence);
    expect(after.custody).toBe(before.custody);
    expect(after.reports).toEqual(before.reports);
    await withDb(upgradeUrl, async (c) => {
      for (const shape of SHAPES) {
        const row = (
          await c.query(
            `SELECT verification_disclosure_mode, show_recorded_location, verification_disclosure_version, verification_disclosure_changed_at_utc FROM evidence WHERE id = $1`,
            [ids[shape.key]],
          )
        ).rows[0];
        expect(row.verification_disclosure_mode, shape.key).toBe(shape.publication === "PUBLISHED" ? "CONTENT_PREVIEW" : "VERIFICATION_ONLY");
        expect(row.show_recorded_location, shape.key).toBe(false);
        expect(row.verification_disclosure_version).toBe(0);
        expect(row.verification_disclosure_changed_at_utc).toBeNull();
      }
    });
  });

  it("closes only the active recipient links of records that were not PUBLISHED; report links and revoked links are untouched", async () => {
    await withDb(upgradeUrl, async (c) => {
      for (const shape of SHAPES) {
        const row = async (kind: string) =>
          (await c.query(`SELECT revoked_at_utc, revocation_reason FROM verification_share_tokens WHERE id = $1`, [links[`${shape.key}:${kind}`]])).rows[0];
        const active = await row("active");
        if (shape.publication === "PUBLISHED") {
          expect(active.revoked_at_utc, shape.key).toBeNull();
        } else {
          expect(active.revocation_reason, shape.key).toBe("DISCLOSURE_MODEL_MIGRATION");
          expect(active.revoked_at_utc).not.toBeNull();
        }
        const revoked = await row("revoked");
        expect(revoked.revocation_reason).toBe("OWNER_REVOKED");
        expect(new Date(revoked.revoked_at_utc).toISOString()).toBe("2026-10-05T00:00:00.000Z");
        expect((await row("report")).revoked_at_utc).toBeNull();
      }
      // No link of any kind gained the original-download grant.
      expect(Number((await c.query(`SELECT count(*)::int AS n FROM verification_share_tokens WHERE allow_original_download`)).rows[0].n)).toBe(0);
    });
  });

  it("is idempotent: replaying the SQL changes nothing and never overwrites an owner's later choice", async () => {
    const sql = readFileSync(join(API_ROOT, "prisma", "migrations", TARGET, "migration.sql"), "utf8");
    await withDb(upgradeUrl, async (c) => {
      // The owner of the published record later chose verification only.
      await c.query(
        `UPDATE evidence SET verification_disclosure_mode = 'VERIFICATION_ONLY', verification_disclosure_version = 1, verification_disclosure_changed_at_utc = now() WHERE id = $1`,
        [ids.published],
      );
      const linksBefore = (await c.query(`SELECT id, revoked_at_utc, revocation_reason FROM verification_share_tokens ORDER BY id`)).rows;
      const modesBefore = (await c.query(`SELECT id, verification_disclosure_mode, show_recorded_location, verification_disclosure_version FROM evidence ORDER BY id`)).rows;
      await c.query(sql);
      expect((await c.query(`SELECT id, revoked_at_utc, revocation_reason FROM verification_share_tokens ORDER BY id`)).rows).toEqual(linksBefore);
      expect((await c.query(`SELECT id, verification_disclosure_mode, show_recorded_location, verification_disclosure_version FROM evidence ORDER BY id`)).rows).toEqual(modesBefore);
      const published = (await c.query(`SELECT verification_disclosure_mode FROM evidence WHERE id = $1`, [ids.published])).rows[0];
      expect(published.verification_disclosure_mode).toBe("VERIFICATION_ONLY");
    });
    expect((await snapshot()).evidence).toEqual(before.evidence);
  });

  it("refuses an uninterpretable policy and a second deploy has nothing to apply", async () => {
    await withDb(upgradeUrl, async (c) => {
      await expect(
        c.query(`UPDATE evidence SET show_recorded_location = true WHERE id = $1`, [ids.notPublished]),
      ).rejects.toThrow(/evidence_recorded_location_requires_content_preview/);
      await expect(
        c.query(`UPDATE evidence SET verification_disclosure_mode = 'PUBLISHED' WHERE id = $1`, [ids.notPublished]),
      ).rejects.toThrow(/evidence_verification_disclosure_mode_check/);
    });
    const again = deploy(join(tmp, "migrations-full"), "again");
    expect(again).toMatch(/No pending migrations to apply/i);
  });
});
