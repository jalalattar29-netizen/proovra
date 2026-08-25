/**
 * Generate `test/fixtures/production-hybrid-incident-schema.sql`.
 *
 * A GENERATOR, run once by a human and committed — not something the tests
 * call. The fixture it writes must be reviewable as a flat file, because it is
 * the thing the convergence migration is tested against; a fixture computed at
 * test time could drift with the model and quietly stop reproducing the shape
 * it exists to reproduce.
 *
 * Usage (against any fully-migrated disposable database):
 *   DATABASE_URL=postgresql://... node scripts/gen-hybrid-fixture.mjs
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { Prisma } = require("@prisma/client");

const TABLES = ["OperationalIncident", "OperationalIncidentEvent"];

/**
 * The legacy family, DERIVED rather than chosen.
 *
 * A Prisma field without `@map` makes the client emit the FIELD NAME as the
 * column name. So the legacy columns are exactly the field names of every
 * field that currently carries a `@map` — which is what the un-annotated model
 * would have produced, and is why this list is generated from the deployed
 * data model instead of typed out.
 */
function pairs() {
  const out = [];
  for (const name of TABLES) {
    const m = Prisma.dmmf.datamodel.models.find((x) => x.name === name);
    const table = m.dbName ?? m.name;
    for (const f of m.fields) {
      if (f.kind === "object") continue;
      const col = f.dbName ?? f.name;
      if (col === f.name) continue;
      out.push({ table, legacy: f.name, canonical: col });
    }
  }
  return out;
}

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

/**
 * The legacy column's FULL definition, copied from its canonical twin.
 *
 * NULLABILITY AND DEFAULTS ARE THE WHOLE EXPERIMENT, NOT DECORATION.
 *
 * Both families were declared by the same `CREATE TABLE` semantics, so the
 * legacy twin carries the same NOT NULL and the same DEFAULT as the canonical
 * column. That is not a detail: it decides whether the hybrid merely rots or
 * actively refuses writes.
 *
 * A legacy column that is NULLABLE lets Prisma's INSERT — which names only the
 * canonical columns — succeed, leaving the legacy half NULL. A legacy column
 * that is NOT NULL WITH A DEFAULT also succeeds, because PostgreSQL fills it.
 * A legacy column that is NOT NULL WITH NO DEFAULT cannot be satisfied by an
 * INSERT that does not name it, and every such INSERT fails 23502.
 *
 * On these tables exactly one column is in that third category —
 * `safe_summary`, declared `VARCHAR(400) NOT NULL` with no default by
 * `20260529100000_add_operational_incidents_phase21` — which is why the fault
 * presents as "every write fails" rather than "some data is missing".
 */
async function columnDef(table, column) {
  const r = await c.query(
    `SELECT data_type, udt_name, character_maximum_length, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column],
  );
  if (!r.rows.length) throw new Error(`no canonical column ${table}.${column}`);
  const x = r.rows[0];
  let type;
  if (x.data_type === "USER-DEFINED") type = `"${x.udt_name}"`;
  else if (x.character_maximum_length) {
    type = `${x.data_type.toUpperCase()}(${x.character_maximum_length})`;
  } else {
    const map = {
      "timestamp with time zone": "TIMESTAMPTZ(6)",
      uuid: "UUID",
      integer: "INTEGER",
      boolean: "BOOLEAN",
      jsonb: "JSONB",
      text: "TEXT",
    };
    type = map[x.data_type] ?? x.data_type.toUpperCase();
  }
  return {
    type,
    notNull: x.is_nullable === "NO",
    // `updated_at` carries no default in the canonical schema (Prisma's
    // @updatedAt is client-side), so copying "no default" onto its legacy twin
    // would make it a SECOND write-blocking column and overstate the fault.
    // The historical CREATE TABLE gave it `DEFAULT NOW()`, so that is what the
    // legacy twin gets.
    default: x.column_default ?? (column === "updated_at" ? "NOW()" : null),
  };
}

const typed = [];
for (const p of pairs()) {
  const def = await columnDef(p.table, p.canonical);
  // `ADD COLUMN ... NOT NULL` on a populated table needs a default, and the
  // historical CREATE TABLE supplied one for every NOT NULL column except
  // `safe_summary`. So a NOT NULL column WITHOUT a default is reproduced as
  // nullable-then-SET NOT NULL below, which is the only way to land the shape
  // that actually blocks writes.
  const parts = [def.type];
  if (def.default) parts.push(`DEFAULT ${def.default}`);
  if (def.notNull && def.default) parts.push("NOT NULL");
  typed.push({
    ...p,
    sqlType: def.type,
    ddl: parts.join(" "),
    notNull: def.notNull,
    hasDefault: def.default != null,
    /** NOT NULL with no default: the shape an INSERT cannot satisfy. */
    blocksWrites: def.notNull && def.default == null,
  });
}
await c.end();

const inc = typed.filter((t) => t.table === "operational_incidents");
const ev = typed.filter((t) => t.table === "operational_incident_events");

const L = [];
const p = (s = "") => L.push(s);

p("-- =============================================================================");
p("-- THE PRODUCTION HYBRID INCIDENT SCHEMA — a TEST FIXTURE, never a migration.");
p("-- =============================================================================");
p("--");
p("-- WHAT THIS REPRODUCES, AND WHY IT IS NOT AN INVENTION");
p("-- ---------------------------------------------------------------------------");
p("-- Production carries BOTH column families on the incident tables: the canonical");
p("-- snake_case columns migrations manage, and a legacy camelCase family named");
p("-- after the Prisma FIELD names. This repository has already diagnosed that exact");
p("-- shape once, on other tables, in");
p("-- 20260620200000_reviewer_ops_naming_drift_repair:");
p("--");
p('--   "Without @map, the Prisma client emits quoted camelCase column names in');
p('--    INSERT/SELECT SQL. Migrations created snake_case columns. In production');
p('--    this produced TWO physical columns per affected field - one that migrations');
p('--    manage, one that the Prisma client actually reads and writes."');
p("--");
p('-- That migration deliberately did not drop the legacy columns, recording that "a');
p('-- separate cleanup migration will drop them after operators confirm". For the');
p("-- incident tables that cleanup was never written, so the hybrid survived every");
p("-- later migration - each of which used IF NOT EXISTS guards and therefore had");
p("-- nothing to object to.");
p("--");
p("-- The legacy column NAMES below are not chosen: they are generated from the");
p("-- deployed data model's field names, which is precisely what a client without");
p("-- @map emits. The TYPES are read from the canonical columns of a fully-migrated");
p("-- database, so the two families are type-identical and every difference the");
p("-- tests observe is about NAMING and BINDING rather than about types.");
p("--");
p("-- WHAT MAKES IT DANGEROUS");
p("-- ---------------------------------------------------------------------------");
p("-- Duplicate columns alone are survivable. What is not survivable is that the");
p("-- live UNIQUE index and the live FOREIGN KEY sit on the LEGACY family:");
p("--");
p('--   * a unique on ("teamId", fingerprint) does NOT deduplicate a write Prisma');
p("--     makes against (team_id, fingerprint), so the writer's entire dedupe");
p("--     contract is enforcing nothing about the columns it actually writes;");
p('--   * a foreign key on "incidentId" constrains nothing about a write to');
p("--     incident_id.");
p("--");
p("-- Reproducing the columns without those bindings would reproduce the appearance");
p("-- of the fault and not the fault.");
p("");
p("BEGIN;");
p("");
p("-- ---------------------------------------------------------------------------");
p("-- 1. The legacy column family on operational_incidents.");
p("-- ---------------------------------------------------------------------------");
p('ALTER TABLE "operational_incidents"');
p(inc.map((t) => `  ADD COLUMN IF NOT EXISTS "${t.legacy}" ${t.ddl}`).join(",\n") + ";");
p("");
p("-- The legacy family carries the data too: the un-annotated client wrote through");
p("-- it for as long as it was the model's view of this table.");
for (const t of inc) {
  p(
    `UPDATE "operational_incidents" SET "${t.legacy}" = "${t.canonical}" WHERE "${t.legacy}" IS NULL;`,
  );
}
p("");
p("-- The NOT NULL columns that carry NO default. This is the shape that turns a");
p("-- cosmetic duplicate into a write-blocking one: an INSERT naming only the");
p("-- canonical columns cannot satisfy a NOT NULL legacy twin with no default, so");
p("-- every such INSERT fails 23502. Applied AFTER the backfill above, exactly as");
p("-- the original CREATE TABLE would have had it from the start.");
for (const t of inc.filter((x) => x.blocksWrites)) {
  p(`ALTER TABLE "operational_incidents" ALTER COLUMN "${t.legacy}" SET NOT NULL;`);
}
p("");
p("-- ---------------------------------------------------------------------------");
p("-- 2. Move the UNIQUE and the hot indexes onto the LEGACY family.");
p("-- ---------------------------------------------------------------------------");
p('DROP INDEX IF EXISTS "operational_incidents_team_fingerprint_uk";');
p(
  'ALTER TABLE "operational_incidents" DROP CONSTRAINT IF EXISTS "operational_incidents_team_id_fingerprint_key";',
);
p('DROP INDEX IF EXISTS "operational_incidents_team_id_fingerprint_key";');
p('CREATE UNIQUE INDEX IF NOT EXISTS "operational_incidents_team_fingerprint_key"');
p('  ON "operational_incidents" ("teamId", "fingerprint");');
p('DROP INDEX IF EXISTS "operational_incidents_last_seen_at_idx";');
p('CREATE INDEX IF NOT EXISTS "operational_incidents_lastSeenAtUtc_idx"');
p('  ON "operational_incidents" ("lastSeenAtUtc" DESC);');
p('DROP INDEX IF EXISTS "operational_incidents_assigned_operator_user_id_idx";');
p('CREATE INDEX IF NOT EXISTS "operational_incidents_assignedOperatorUserId_idx"');
p('  ON "operational_incidents" ("assignedOperatorUserId");');
p("");
p("-- ---------------------------------------------------------------------------");
p("-- 3. operational_incident_events - the same, plus one HISTORICAL field name the");
p("--    current model no longer has at all (createdAtUtc). Production carries");
p("--    columns that pair with no current field, and a fixture without one would");
p("--    never exercise the UNPAIRED path.");
p("-- ---------------------------------------------------------------------------");
p('ALTER TABLE "operational_incident_events"');
p(ev.map((t) => `  ADD COLUMN IF NOT EXISTS "${t.legacy}" ${t.ddl}`).join(",\n") + ",");
p('  ADD COLUMN IF NOT EXISTS "createdAtUtc" TIMESTAMPTZ(6);');
for (const t of ev) {
  p(
    `UPDATE "operational_incident_events" SET "${t.legacy}" = "${t.canonical}" WHERE "${t.legacy}" IS NULL;`,
  );
}
p(
  'UPDATE "operational_incident_events" SET "createdAtUtc" = "created_at" WHERE "createdAtUtc" IS NULL;',
);
p("");
p("-- The write-blocking NOT NULLs on the events table, after its backfill.");
for (const t of ev.filter((x) => x.blocksWrites)) {
  p(`ALTER TABLE "operational_incident_events" ALTER COLUMN "${t.legacy}" SET NOT NULL;`);
}
p("");
p(
  'ALTER TABLE "operational_incident_events" DROP CONSTRAINT IF EXISTS "operational_incident_events_incident_id_fkey";',
);
p('ALTER TABLE "operational_incident_events"');
p('  ADD CONSTRAINT "operational_incident_events_incidentId_fkey"');
p('  FOREIGN KEY ("incidentId") REFERENCES "operational_incidents"("id") ON DELETE CASCADE;');
p('DROP INDEX IF EXISTS "operational_incident_events_incident_created_at_idx";');
p('CREATE INDEX IF NOT EXISTS "operational_incident_events_incidentId_createdAtUtc_idx"');
p('  ON "operational_incident_events" ("incidentId", "createdAtUtc" DESC);');
p("");
p("COMMIT;");

writeFileSync("test/fixtures/production-hybrid-incident-schema.sql", L.join("\n") + "\n");
console.log(
  `wrote test/fixtures/production-hybrid-incident-schema.sql — ${inc.length} incident + ${ev.length + 1} event legacy columns`,
);
