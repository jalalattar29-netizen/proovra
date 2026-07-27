/**
 * CLEAN-DB MIGRATION-CHAIN CONTRACT — a completely empty PostgreSQL database
 * must be able to replay the ENTIRE migration history in lexical order.
 *
 * Root cause this pins (2026-07-27): five migrations authored 2026-07-21/22
 * were named 202607214xxxxx.. while the `organizations` table they reference is
 * physically created by the FUTURE-DATED historical migration
 * `20260926000000_p2_7x_stage1_org_model_additive` — so a clean checkout
 * failed at lexical position 73 with 42P01 (`relation "organizations" does not
 * exist`) while incremental dev databases (which had the historical set applied
 * first, chronologically) never noticed. The five were re-dated to 2027092xxxxx
 * (after their prerequisites, before their dependents).
 *
 * Guard 1 proves the ORDER invariant statically for every table: no migration
 * may reference a table whose CREATE TABLE lives in a lexically LATER
 * migration. This catches the whole 42P01 class at PR time with no database.
 *
 * Guard 2 pins the named regression: `organizations` physically exists before
 * any migration references it.
 *
 * Guard 3: no workflow/script shortcuts the chain with `prisma db push` or
 * `prisma migrate resolve` — the chain itself must stay the only truth.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = resolve(__dirname, "../prisma/migrations");
const REPO = resolve(__dirname, "../../..");

const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const sql = new Map<string, string>(
  dirs.map((d) => {
    const p = join(MIGRATIONS, d, "migration.sql");
    return [d, existsSync(p) ? readFileSync(p, "utf8").replace(/\r\n/g, "\n") : ""];
  }),
);

/** Strip SQL comments so prose can neither satisfy nor trip the scan. */
function stripSqlComments(s: string): string {
  return s
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** First (lexically earliest) migration that CREATEs each table. */
const createdBy = new Map<string, string>();
for (const d of dirs) {
  const body = stripSqlComments(sql.get(d) ?? "");
  for (const m of body.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-z_]+)"?/gi)) {
    const table = m[1].toLowerCase();
    if (!createdBy.has(table)) createdBy.set(table, d);
  }
}

describe("clean-DB migration chain — lexical order integrity", () => {
  it("no migration references a table created by a lexically LATER migration (42P01 class)", () => {
    const defects: string[] = [];
    for (const d of dirs) {
      const body = stripSqlComments(sql.get(d) ?? "");
      const referenced = new Set<string>();
      for (const m of body.matchAll(
        // `"public"."table"` — capture the TABLE, not the schema qualifier.
        /(?:ALTER TABLE|REFERENCES|UPDATE|INSERT INTO|DELETE FROM|JOIN|FROM)\s+(?:ONLY\s+)?(?:"public"\.)?"([a-z_]+)"/g,
      )) {
        if (m[1] !== "public") referenced.add(m[1].toLowerCase());
      }
      for (const t of referenced) {
        const creator = createdBy.get(t);
        if (creator && creator > d) {
          defects.push(`${d} references "${t}" created later by ${creator}`);
        }
      }
    }
    expect(defects, defects.join("\n")).toEqual([]);
  });

  it("the organizations physical table is created BEFORE any migration references it", () => {
    const creator = createdBy.get("organizations");
    expect(creator, "no migration creates organizations").toBeTruthy();
    const firstRef = dirs.find((d) =>
      /(?:ALTER TABLE|REFERENCES|UPDATE|JOIN)\s+"organizations"/.test(
        stripSqlComments(sql.get(d) ?? ""),
      ),
    );
    expect(firstRef && creator! <= firstRef, `first reference ${firstRef} precedes creator ${creator}`).toBe(true);
  });

  it("every migration directory contains a migration.sql (no empty/broken entries)", () => {
    const empty = dirs.filter((d) => (sql.get(d) ?? "").trim().length === 0);
    expect(empty).toEqual([]);
  });

  it("no workflow or package script shortcuts the chain with db push / migrate resolve", () => {
    const offenders: string[] = [];
    const scan = (path: string) => {
      if (!existsSync(path)) return;
      const body = readFileSync(path, "utf8");
      if (/prisma\s+db\s+push|migrate\s+resolve/.test(body)) offenders.push(path);
    };
    const wf = join(REPO, ".github/workflows");
    if (existsSync(wf)) for (const f of readdirSync(wf)) scan(join(wf, f));
    scan(resolve(__dirname, "../package.json"));
    scan(join(REPO, "package.json"));
    expect(offenders).toEqual([]);
  });
});
