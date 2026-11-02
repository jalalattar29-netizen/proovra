/**
 * RT-016 — the trust status page works for every workspace. Proven on a database
 * built by `prisma migrate deploy` (the harness) and on the affected state, by
 * restoring the global constraint and running the forward migration file whole,
 * exactly as `migrate deploy` does.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { seedOrganizationTenant, type OrganizationTenant } from "./point7/product-fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  path.resolve(HERE, "../prisma/migrations/20281107000000_status_components_per_workspace_key/migration.sql"),
  "utf8",
);

describe("RT-016 — status components are per workspace (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let conn: pg.Client;
  let A: OrganizationTenant;
  let B: OrganizationTenant;

  const status = (token: string) =>
    h.app.inject({ method: "GET", url: "/v1/trust/status", headers: { authorization: `Bearer ${token}` } });
  const rows = async (teamId: string) =>
    (await conn.query(`SELECT id, key FROM status_components WHERE team_id = $1::uuid ORDER BY key`, [teamId])).rows as Array<{
      id: string;
      key: string;
    }>;
  const uniqueKeys = async () =>
    (
      await conn.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'status_components' AND indexdef ILIKE '%UNIQUE%' AND indexname <> 'status_components_pkey' ORDER BY indexname`,
      )
    ).rows.map((r: { indexdef: string }) => r.indexdef.replace(/^.*\((.*)\)$/, "$1"));

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    conn = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await conn.connect();
    const { prisma } = await import("../src/db.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const deps = {
      prisma: prisma as never,
      tag: `rt016-${Date.now().toString(36)}`,
      mintToken: (userId: string, email: string) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authAt: Math.floor(Date.now() / 1000), authMethod: "PASSWORD" } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    A = await seedOrganizationTenant(deps);
    B = await seedOrganizationTenant(deps);
    for (const org of [A, B]) {
      await conn.query(`UPDATE users SET current_workspace_id = $1::uuid WHERE id = $2::uuid`, [org.workspaceId, org.owner.userId]);
    }
  });

  afterAll(async () => {
    await conn?.end();
    await h?.cleanup();
  });

  beforeEach(async () => {
    await conn.query(`DELETE FROM status_components`);
  });

  it("a fresh schema from the migrations carries the workspace key and no global one", async () => {
    expect(await uniqueKeys()).toEqual(["team_id, key"]);
  });

  it("two workspaces both read their own components on the migrated schema", async () => {
    const first = await status(A.owner.token);
    const second = await status(B.owner.token);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const a = await rows(A.workspaceId);
    const b = await rows(B.workspaceId);
    expect(a.length).toBeGreaterThan(0);
    expect(b.map((r) => r.key)).toEqual(a.map((r) => r.key));
    expect(new Set([...a, ...b].map((r) => r.id)).size).toBe(a.length + b.length);
  });

  it("upgrade: the affected state fails the second workspace, the migration repairs it and keeps the first workspace's rows", async () => {
    await conn.query(`ALTER TABLE "status_components" ADD CONSTRAINT "status_components_key_key" UNIQUE ("key")`);
    try {
      expect((await status(A.owner.token)).statusCode).toBe(200);
      const before = await rows(A.workspaceId);
      expect(before.length).toBeGreaterThan(0);
      // Negative control: this is the reported failure, not a state the test invented.
      expect((await status(B.owner.token)).statusCode).toBe(500);

      await conn.query(MIGRATION);

      expect(await uniqueKeys()).toEqual(["team_id, key"]);
      expect((await status(B.owner.token)).statusCode).toBe(200);
      expect((await status(A.owner.token)).statusCode).toBe(200);
      expect((await rows(A.workspaceId)).map((r) => r.id)).toEqual(before.map((r) => r.id));
      expect((await rows(B.workspaceId)).length).toBe(before.length);
    } finally {
      await conn.query(`ALTER TABLE "status_components" DROP CONSTRAINT IF EXISTS "status_components_key_key"`);
    }
  });

  it("upgrade: a database that lost the workspace key gets it back before the global key goes", async () => {
    await conn.query(`DROP INDEX "status_components_team_key_uniq"`);
    await conn.query(`ALTER TABLE "status_components" ADD CONSTRAINT "status_components_key_key" UNIQUE ("key")`);
    expect(await uniqueKeys()).toEqual(["key"]);
    await conn.query(MIGRATION);
    expect(await uniqueKeys()).toEqual(["team_id, key"]);
  });

  it("the migration is safe to rerun and leaves one workspace key", async () => {
    await conn.query(MIGRATION);
    await conn.query(MIGRATION);
    expect(await uniqueKeys()).toEqual(["team_id, key"]);
  });

  it("a workspace still cannot hold the same component twice", async () => {
    expect((await status(A.owner.token)).statusCode).toBe(200);
    const [row] = await rows(A.workspaceId);
    await expect(
      conn.query(
        `INSERT INTO status_components (key, label, description, team_id, upstream_source, updated_at)
         VALUES ($1, 'dup', 'dup', $2::uuid, 'LOCAL', now())`,
        [row!.key, A.workspaceId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
