/**
 * BILLING REMEDIATION (2026-10-31) — the release preview, run as the operator runs
 * it. The preview comes before approval, so it can meet a database that does not
 * have the migrations yet. One missing column must not cost every other count, and
 * a count that could not be read must never read as zero.
 *
 * The unmigrated database is a copy of the tables in a separate schema, so a shared
 * TEST_DATABASE_URL is not disturbed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireIntegrationDatabase, type IntegrationDatabase } from "./integration-harness.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/billing-repair-dry-run.mjs");
const OLD_SCHEMA = "billing_dry_run_unmigrated";

type Line = { id: string; count: number | null; unavailable?: string };

function runPreview(databaseUrl: string) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  const lines = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
  return { status: result.status, stderr: result.stderr, lines };
}

describe("billing repair dry run (live PostgreSQL)", () => {
  let db: IntegrationDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    db = await acquireIntegrationDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${OLD_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${OLD_SCHEMA}`);
    const { rows } = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> 'billing_provider_binding_checks'",
    );
    for (const { tablename } of rows) {
      await client.query(`CREATE TABLE ${OLD_SCHEMA}."${tablename}" (LIKE public."${tablename}")`);
    }
    await client.query(`ALTER TABLE ${OLD_SCHEMA}.subscriptions DROP COLUMN superseded_by_subscription_id`);
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${OLD_SCHEMA} CASCADE`);
    await client?.end();
    await db?.release();
  });

  it("counts every line on a migrated database", () => {
    const { status, lines } = runPreview(db.url);
    expect(status).toBe(0);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(typeof line.count, line.id).toBe("number");
  });

  it("before the migrations, gives up only the lines that need them and says so", () => {
    const url = new URL(db.url);
    url.searchParams.set("options", `-c search_path=${OLD_SCHEMA}`);
    const { status, stderr, lines } = runPreview(url.toString());

    expect(stderr).toBe("");
    expect(status).toBe(3);

    const unavailable = lines.filter((line) => line.unavailable === "NEEDS_MIGRATION").map((line) => line.id);
    expect(unavailable).toEqual(
      expect.arrayContaining([
        "R3_ENTITLEMENT_DRIFT",
        "AUTO_R3_WOULD_LOWER_PLAN",
        "AUTO_SUPERSEDED_CANCELS_DUE",
        "AUTO_PROVIDER_REFERENCES_NOT_YET_CHECKED",
      ]),
    );
    for (const line of lines) {
      if (unavailable.includes(line.id)) expect(line.count, line.id).toBeNull();
      else expect(typeof line.count, line.id).toBe("number");
    }
    // Every finding still reports: the missing column cost its own line only.
    expect(lines.length).toBe(runPreview(db.url).lines.length);
    expect(lines.length).toBeGreaterThan(unavailable.length);
  });

  it("fails loudly when the database cannot be read at all", () => {
    const url = new URL(db.url);
    url.pathname = "/billing_dry_run_no_such_database";
    const { status, lines } = runPreview(url.toString());
    expect(status).toBe(2);
    expect(lines).toEqual([]);
  });
});
