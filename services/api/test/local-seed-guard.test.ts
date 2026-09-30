/**
 * ET-UPL-04 — every seeder refuses a database that is not local, by name AND
 * host, before its first write.
 *
 * On a40ca76f seed-home-personas.ts imported dotenv/config (services/api/.env
 * carries live Production credentials) and refused only NODE_ENV=production,
 * so run without it, it wrote fabricated SIGNED evidence and custody into
 * whatever database that file named.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { localSeedDatabaseRefusal } from "../scripts/lib/local-seed-guard.js";

const refuse = (DATABASE_URL: string | undefined, NODE_ENV = "development") =>
  localSeedDatabaseRefusal({ DATABASE_URL, NODE_ENV } as NodeJS.ProcessEnv);

describe("local seed guard (ET-UPL-04)", () => {
  it("refuses a hosted production database", () => {
    expect(refuse("postgresql://u:p@ep-cool-name-123.eu-central-1.aws.neon.tech/neondb?sslmode=require")).toMatch(/does not look local|production/);
  });

  it("refuses a local-looking NAME on a remote HOST", () => {
    expect(refuse("postgresql://u:p@db.example.com:5432/proovra_test")).toMatch(/not loopback/);
  });

  it("refuses NODE_ENV=production, a missing URL and an unparseable one", () => {
    expect(refuse("postgresql://u:p@127.0.0.1:5432/proovra_test", "production")).toMatch(/production/);
    expect(refuse(undefined)).toMatch(/not set/);
    expect(refuse("not a url")).toMatch(/parseable/);
  });

  it("refuses a production-looking name even on loopback", () => {
    expect(refuse("postgresql://u:p@localhost:5432/proovra_prod_dev")).toMatch(/production/);
  });

  it("admits loopback and compose-service hosts with a local name", () => {
    expect(refuse("postgresql://er:er@127.0.0.1:58532/er_remediation_test")).toBeNull();
    expect(refuse("postgresql://u:p@localhost/proovra_fixture")).toBeNull();
    expect(refuse("postgresql://u:p@[::1]:5432/proovra_dev")).toBeNull();
    expect(refuse("postgresql://u:p@postgres:5432/proovra_local")).toBeNull();
  });

  it("both seeders run the one guard and neither loads dotenv/config", () => {
    for (const rel of ["../scripts/seed-home-personas.ts", "../scripts/seed-admin-fixture.ts"]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(src, rel).toMatch(/from "\.\/lib\/local-seed-guard\.js"/);
      expect(src, rel).not.toMatch(/^import "dotenv\/config"/m);
    }
    expect(readFileSync(new URL("../scripts/seed-home-personas.ts", import.meta.url), "utf8")).toMatch(
      /assertLocalSeedDatabase\("seed-home-personas"\);/,
    );
  });
});
