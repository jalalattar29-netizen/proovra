/**
 * OPERATIONS WRITER PROBE — operator-only, READ ONLY, production-safe.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `ops-source-diagnosis.mjs` proved the DISCOVERY half: the sweep finds the
 * conditions. It reported 34 TSA failures, a report backlog, a package backlog
 * and stale telemetry in a workspace whose Operations page showed `recorded 0`
 * and `open 0`.
 *
 * That leaves exactly one boundary unexamined, and it is the one every failed
 * source has in common:
 *
 *     source crosses threshold -> calls recordIncident -> source FAILED
 *     source does not cross    -> never calls it       -> source SUCCEEDED
 *
 * Six sources failed. All six write. Five succeeded. None of them write. The
 * shared writer is therefore the suspect, and `incident-generator.service.ts`
 * catches its error with a bare `catch {}` — the error object is not even
 * bound — so the cause is destroyed at the moment it occurs and cannot be
 * recovered from any log, run row or API response.
 *
 * This script recovers it. It reads the writer's tables the way the writer
 * reads them, compares the deployed Prisma data model against the physical
 * catalog column by column, and reports the exact code.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROVES, AND WHY THE FULL-WIDTH READ IS RUN SEPARATELY
 * ---------------------------------------------------------------------------
 * `recordIncident` opens with:
 *
 *     client.operationalIncident.findUnique({
 *       where: { teamId_fingerprint: { teamId, fingerprint } },
 *     })
 *
 * with no `select`. Prisma answers such a query by requesting EVERY scalar
 * column the model declares. So a model column that is absent — or of a type
 * the client cannot read — fails that statement before any condition-specific
 * logic runs, identically for every category, which is precisely the observed
 * signature: six writing sources down, five non-writing sources up, zero rows.
 *
 * The probe therefore runs two reads as SEPARATE, independently reported
 * probes: the writer's own full-width lookup, and a minimal explicit-select
 * equivalent asking only for the fields the writer actually consumes. If the
 * first fails and the second succeeds, the width of the read IS the fault and
 * the difference between them names the columns responsible.
 *
 * ---------------------------------------------------------------------------
 * SAFETY — enforced by PostgreSQL, not by this script's good intentions
 * ---------------------------------------------------------------------------
 *   * Requires an explicit DATABASE_URL and an explicit workspace id.
 *   * Every statement runs inside `SET TRANSACTION READ ONLY`, on BOTH
 *     sessions it uses (the catalog client and the Prisma client), and the
 *     script PROVES it on each by attempting one write and requiring SQLSTATE
 *     25006 back. If a write succeeds, the script aborts.
 *   * Zero reconciliation. Zero incident, event, SLA, audit or queue writes.
 *     Zero schema or migration activity. No BullMQ connection is opened.
 *   * Every probe is attempted even when earlier ones fail; each read is
 *     isolated so an aborted statement cannot poison the ones after it.
 *   * Codes, bounded metadata and stacks go to the OPERATOR TERMINAL only.
 *     Nothing here is returned to a browser or persisted anywhere.
 *   * Database credentials are redacted. No tenant row content and no evidence
 *     content is printed — the probes report shapes, codes and counts.
 *
 * ---------------------------------------------------------------------------
 * FIDELITY — and its refusal
 * ---------------------------------------------------------------------------
 * The model side of every comparison comes from the DEPLOYED generated client
 * (`Prisma.dmmf`), not from a schema file this script carries. That is the
 * whole point: the question is whether the image's own model agrees with the
 * database the image is connected to, and only the image can answer the first
 * half. Where an authority cannot be resolved inside the container, the
 * affected section reports UNAVAILABLE rather than approximating it.
 *
 * ---------------------------------------------------------------------------
 * USAGE (on the server; nothing is checked out and `main` is untouched)
 * ---------------------------------------------------------------------------
 *   git fetch origin fix/operations-root-cause-closure
 *   git show <commit>:services/api/scripts/ops-writer-probe.mjs \
 *     | docker exec -i -w /app/services/api \
 *         -e OPS_PROBE_WORKSPACE_ID=<workspace-uuid> \
 *         <api-container> node --input-type=module
 */

import { createRequire } from "node:module";

// Resolve dependencies from the WORKING DIRECTORY, which the documented
// invocation pins to `/app/services/api`. A hardcoded absolute path would work
// in the image and nowhere else, which makes the script impossible to rehearse
// before pointing it at production.
const require = createRequire(`${process.cwd().replace(/[\\/]+$/, "")}/index.js`);

const WORKSPACE_ID = process.env.OPS_PROBE_WORKSPACE_ID;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!process.env.DATABASE_URL) {
  console.error("REFUSED: DATABASE_URL is not set. Name the database explicitly.");
  process.exit(2);
}
if (!WORKSPACE_ID || !UUID_RE.test(WORKSPACE_ID)) {
  console.error("REFUSED: OPS_PROBE_WORKSPACE_ID must be a workspace UUID.");
  process.exit(2);
}

const line = (c = "=") => console.log(c.repeat(78));
const head = (t) => {
  console.log("");
  line("-");
  console.log(t);
  line("-");
};

/** Never print a credential. */
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.username ? "***:***@" : ""}${u.hostname}:${
      u.port || "5432"
    }${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

/**
 * Everything an operator needs about a failure, and nothing that identifies a
 * tenant or a record. `meta` is filtered to Prisma's own bounded diagnostic
 * fields; Prisma puts the offending column name in there, which is the single
 * most useful fact this script can carry back.
 */
function describeError(err) {
  const out = {
    name: err?.name ?? null,
    prismaCode: err?.code ?? null,
    sqlState: err?.sqlState ?? err?.code ?? null,
    routine: err?.routine ?? null,
    table: err?.table ?? null,
    column: err?.column ?? null,
    constraint: err?.constraint ?? null,
    meta: null,
    message: null,
  };
  // A Prisma `code` is `P####`; a PostgreSQL SQLSTATE is 5 alphanumerics.
  if (typeof out.prismaCode === "string" && !/^P\d{4}$/.test(out.prismaCode)) {
    out.prismaCode = null;
  }
  if (typeof out.sqlState === "string" && /^P\d{4}$/.test(out.sqlState)) {
    out.sqlState = null;
  }
  // Prisma does not surface the SQLSTATE as a field. For a raw query it embeds
  // it in the message as ``Code: `25006```, and for a model query it puts the
  // driver's text in `meta.database_error`. Both are parsed rather than
  // reported as "<none>", because the SQLSTATE is the single fact that
  // separates a missing column from a timeout from a permission refusal.
  if (!out.sqlState) {
    const hay = `${err?.message ?? ""} ${JSON.stringify(err?.meta ?? {})}`;
    const m =
      hay.match(/Code:\s*`([0-9A-Za-z]{5})`/) ??
      hay.match(/\bSQLSTATE[:\s(]*([0-9A-Za-z]{5})/i);
    if (m) out.sqlState = m[1];
  }
  if (!out.column) {
    const m = String(err?.message ?? "").match(
      /column\s+"?(?:[\w.]+\.)?([\w]+)"?\s+does not exist/i,
    );
    if (m) out.column = m[1];
  }
  if (err?.meta && typeof err.meta === "object") {
    const m = {};
    for (const k of ["column", "table", "modelName", "database_error", "cause", "code"]) {
      if (err.meta[k] != null) m[k] = String(err.meta[k]).slice(0, 400);
    }
    out.meta = Object.keys(m).length ? m : null;
  }
  // The message is operator-terminal only and is clipped. Prisma embeds the
  // failing column in it even when `meta` is empty.
  if (err?.message) out.message = String(err.message).replace(/\s+/g, " ").slice(0, 700);
  return out;
}

function reportFailure(label, err, ms) {
  console.log(`  ${label}: FAILED in ${ms}ms`);
  const d = describeError(err);
  console.log(`    error            : ${d.name ?? "<unknown>"}`);
  console.log(`    prisma code      : ${d.prismaCode ?? "<none>"}`);
  console.log(`    pg SQLSTATE      : ${d.sqlState ?? "<none>"}`);
  if (d.table) console.log(`    table            : ${d.table}`);
  if (d.column) console.log(`    column           : ${d.column}`);
  if (d.constraint) console.log(`    constraint       : ${d.constraint}`);
  if (d.routine) console.log(`    pg routine       : ${d.routine}`);
  if (d.meta) console.log(`    meta             : ${JSON.stringify(d.meta)}`);
  if (d.message) console.log(`    message          : ${d.message}`);
  const stack = String(err?.stack ?? "").split("\n").slice(0, 6).join("\n      ");
  if (stack) console.log(`    stack            :\n      ${stack}`);
}

// ===========================================================================
// 0. Catalog session — a plain `pg` client, held READ ONLY for its lifetime.
// ===========================================================================

let Client;
try {
  ({ Client } = require("pg"));
} catch (err) {
  console.error("REFUSED: 'pg' is not resolvable inside this image.");
  console.error(String(err?.message ?? err));
  process.exit(2);
}

const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();

line();
console.log("OPERATIONS WRITER PROBE — READ ONLY");
line();
console.log("database url   :", redactUrl(process.env.DATABASE_URL));
console.log("workspace      :", WORKSPACE_ID);
console.log("node           :", process.version);
console.log(
  "app revision   :",
  process.env.GIT_SHA ?? process.env.GIT_COMMIT ?? process.env.APP_REVISION ?? "<unset>",
);

/** Overall verdict, printed once at the end. */
const verdict = {
  readOnlyProven: false,
  prismaReadOnlyProven: false,
  tables: [],
  fullWidthOk: null,
  narrowOk: null,
  problems: [],
};
const problem = (s) => {
  verdict.problems.push(s);
};

await pg.query("BEGIN");
await pg.query("SET TRANSACTION READ ONLY");

/**
 * Run one catalog query under a savepoint so a failure cannot abort the
 * enclosing read-only transaction and take every later probe with it.
 */
let sp = 0;
async function q(sql, params = []) {
  const name = `probe_sp_${++sp}`;
  await pg.query(`SAVEPOINT ${name}`);
  try {
    const r = await pg.query(sql, params);
    await pg.query(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, rows: r.rows };
  } catch (err) {
    await pg.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await pg.query(`RELEASE SAVEPOINT ${name}`);
    return { ok: false, err };
  }
}

// --- Session identity and posture ------------------------------------------

head("1. SESSION IDENTITY AND POSTURE");
{
  const r = await q(`
    SELECT current_database()                                  AS database,
           current_schema()                                    AS schema,
           current_user                                        AS role,
           session_user                                        AS session_role,
           version()                                           AS server_version,
           current_setting('statement_timeout')                AS statement_timeout,
           current_setting('idle_in_transaction_session_timeout') AS idle_tx_timeout,
           current_setting('default_transaction_read_only')     AS default_read_only,
           current_setting('transaction_read_only')             AS tx_read_only,
           pg_is_in_recovery()                                  AS in_recovery
  `);
  if (r.ok) {
    const row = r.rows[0];
    for (const [k, v] of Object.entries(row)) {
      console.log(`  ${k.padEnd(24)}: ${v}`);
    }
  } else {
    reportFailure("session identity", r.err, 0);
    problem("could not read session identity");
  }
}

// --- Write rejection proof --------------------------------------------------

head("2. WRITE REJECTION PROOF (must be SQLSTATE 25006)");
{
  const r = await q(
    `INSERT INTO "operational_incidents" ("category","fingerprint","title","safe_summary")
     VALUES ('DATABASE','ops_writer_probe.must_never_insert','probe','probe')`,
  );
  if (r.ok) {
    console.error("  ABORTING: a write SUCCEEDED. This session is not read-only.");
    await pg.query("ROLLBACK");
    await pg.end();
    process.exit(3);
  }
  const code = r.err?.code ?? "<none>";
  console.log(`  INSERT rejected with SQLSTATE ${code}`);
  if (code === "25006") {
    verdict.readOnlyProven = true;
    console.log("  read-only enforcement: PROVEN by PostgreSQL");
  } else {
    // 42703/42P01 would mean the table or column is missing, which is itself a
    // finding — but it does NOT prove the session is read-only, and the script
    // must not proceed as though it had.
    console.error(
      `  ABORTING: expected 25006, got ${code}. Read-only enforcement is unproven.`,
    );
    reportFailure("write probe", r.err, 0);
    await pg.query("ROLLBACK");
    await pg.end();
    process.exit(3);
  }
}

// ===========================================================================
// 3. Model-vs-database comparison for every writer-owned table.
// ===========================================================================

let dmmf = null;
try {
  ({ Prisma: { dmmf } } = { Prisma: require("@prisma/client").Prisma });
} catch (err) {
  console.error("\nREFUSED: the generated Prisma client is not resolvable.");
  console.error(String(err?.message ?? err));
  await pg.query("ROLLBACK");
  await pg.end();
  process.exit(2);
}

/**
 * The tables the incident writer touches, in call order, each labelled with
 * whether `recordIncident` can survive its failure.
 *
 * MANDATORY  the observation of the condition is lost when this fails.
 * BEST_EFFORT the condition is still recorded; bookkeeping is degraded.
 *
 * Derived from the real call graph in
 * `services/api/src/services/observability/incident.service.ts` and
 * `services/api/src/services/operations/incident-sla-cycle.service.ts`.
 */
const WRITER_MODELS = [
  ["OperationalIncident", "MANDATORY", "findUnique / create / update"],
  ["OperationalIncidentEvent", "BEST_EFFORT", "create (event history)"],
  ["WorkspaceGovernancePolicy", "BEST_EFFORT", "findUnique (SLA policy read)"],
  ["WorkspaceSlaPolicyVersion", "BEST_EFFORT", "findUnique / create (SLA version)"],
  ["OperationalIncidentSlaCycle", "BEST_EFFORT", "findFirst / create (SLA cycle)"],
];

function modelOf(name) {
  return dmmf?.datamodel?.models?.find((m) => m.name === name) ?? null;
}

/** Physical table name for a model, from the model's own `@@map`. */
function tableOf(model) {
  return model?.dbName ?? model?.name ?? null;
}

/** Every scalar/enum field the client would request in a full-width read. */
function scalarFields(model) {
  return (model?.fields ?? [])
    .filter((f) => f.kind === "scalar" || f.kind === "enum")
    .filter((f) => f.relationName == null)
    .map((f) => ({
      field: f.name,
      column: f.dbName ?? f.name,
      prismaType: f.type,
      kind: f.kind,
      isList: f.isList === true,
    }));
}

head("3. MODEL vs DATABASE — writer-owned tables");

for (const [modelName, criticality, usedFor] of WRITER_MODELS) {
  const model = modelOf(modelName);
  console.log("");
  console.log(`  ${modelName}  [${criticality}]  used for: ${usedFor}`);
  if (!model) {
    console.log("    model            : NOT PRESENT in the deployed data model");
    problem(`${modelName}: absent from the deployed Prisma data model`);
    continue;
  }
  const table = tableOf(model);
  console.log(`    physical table   : ${table}`);

  const exists = await q(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  if (!exists.ok || exists.rows.length === 0) {
    console.log("    TABLE            : MISSING");
    problem(`${table}: table is missing`);
    verdict.tables.push({ table, criticality, missing: ["<entire table>"], extra: [] });
    continue;
  }

  const cols = await q(
    `SELECT column_name, data_type, udt_name, is_nullable,
            column_default, character_maximum_length, numeric_precision
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  if (!cols.ok) {
    reportFailure("column read", cols.err, 0);
    problem(`${table}: columns unreadable`);
    continue;
  }
  const physical = new Map(cols.rows.map((r) => [r.column_name, r]));
  const declared = scalarFields(model);
  const declaredNames = new Set(declared.map((d) => d.column));

  const missing = [];
  console.log(
    `    ${"model field".padEnd(26)}${"db column".padEnd(30)}${"physical type".padEnd(
      22,
    )}${"prisma".padEnd(16)}null default`,
  );
  for (const d of declared) {
    const p = physical.get(d.column);
    if (!p) {
      missing.push(d.column);
      console.log(
        `    ${d.field.padEnd(26)}${d.column.padEnd(30)}${"** MISSING **".padEnd(
          22,
        )}${d.prismaType.padEnd(16)}`,
      );
      continue;
    }
    const type =
      p.data_type === "USER-DEFINED"
        ? `enum ${p.udt_name}`
        : p.character_maximum_length
          ? `${p.data_type}(${p.character_maximum_length})`
          : p.data_type;
    console.log(
      `    ${d.field.padEnd(26)}${d.column.padEnd(30)}${type.padEnd(22)}${d.prismaType.padEnd(
        16,
      )}${(p.is_nullable === "YES" ? "Y" : "N").padEnd(5)}${
        p.column_default ? String(p.column_default).slice(0, 40) : "-"
      }`,
    );
  }

  const extra = [...physical.keys()].filter((c) => !declaredNames.has(c));
  console.log(
    `    MISSING (model declares, database lacks) : ${
      missing.length ? missing.join(", ") : "none"
    }`,
  );
  console.log(
    `    EXTRA   (database has, model ignores)    : ${
      extra.length ? extra.join(", ") : "none"
    }`,
  );
  if (missing.length) {
    problem(
      `${table}: ${missing.length} column(s) declared by the deployed model are ABSENT: ${missing.join(", ")}`,
    );
  }
  verdict.tables.push({ table, criticality, missing, extra });

  // --- enum types used by this table ---
  const enums = await q(
    `SELECT c.column_name, t.typname,
            (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
               FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels
       FROM information_schema.columns c
       JOIN pg_type t ON t.typname = c.udt_name
      WHERE c.table_schema = 'public' AND c.table_name = $1
        AND c.data_type = 'USER-DEFINED'
      ORDER BY c.ordinal_position`,
    [table],
  );
  if (enums.ok && enums.rows.length) {
    for (const e of enums.rows) {
      console.log(`    enum ${e.column_name} (${e.typname}) : ${e.labels}`);
    }
  }

  // --- constraints, unique indexes, foreign keys, triggers ---
  const cons = await q(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid = to_regclass($1) ORDER BY conname`,
    [`public.${table}`],
  );
  if (cons.ok) {
    for (const c of cons.rows) {
      console.log(`    constraint ${c.contype} ${c.conname}: ${String(c.def).slice(0, 160)}`);
    }
  }
  const idx = await q(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`,
    [table],
  );
  if (idx.ok) {
    for (const i of idx.rows) {
      console.log(`    index ${i.indexname}: ${String(i.indexdef).slice(0, 170)}`);
    }
  }
  const trg = await q(
    `SELECT tgname, pg_get_triggerdef(oid) AS def
       FROM pg_trigger WHERE tgrelid = to_regclass($1) AND NOT tgisinternal`,
    [`public.${table}`],
  );
  console.log(
    `    triggers         : ${
      trg.ok && trg.rows.length ? trg.rows.map((t) => t.tgname).join(", ") : "none"
    }`,
  );

  // --- RLS and grants ---
  const rls = await q(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)`,
    [`public.${table}`],
  );
  if (rls.ok && rls.rows.length) {
    console.log(
      `    RLS              : enabled=${rls.rows[0].relrowsecurity} forced=${rls.rows[0].relforcerowsecurity}`,
    );
  }
  const pol = await q(
    `SELECT policyname, cmd FROM pg_policies WHERE schemaname='public' AND tablename=$1`,
    [table],
  );
  console.log(
    `    RLS policies     : ${
      pol.ok && pol.rows.length ? pol.rows.map((p) => `${p.policyname}(${p.cmd})`).join(", ") : "none"
    }`,
  );
  const grants = await q(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name=$1 AND grantee = current_user
      ORDER BY privilege_type`,
    [table],
  );
  console.log(
    `    grants (me)      : ${
      grants.ok && grants.rows.length ? grants.rows.map((g) => g.privilege_type).join(", ") : "none"
    }`,
  );
}

// --- canonical enum value comparison ---------------------------------------

head("4. ENUM VALUES — canonical application set vs database");
{
  let canonical = null;
  try {
    const shared = await import("@proovra/shared");
    canonical = {
      IncidentCategory: shared.INCIDENT_CATEGORIES,
      IncidentSeverity: shared.INCIDENT_SEVERITIES,
      IncidentStatus: shared.INCIDENT_STATUSES,
    };
  } catch {
    console.log("  @proovra/shared UNAVAILABLE in this image — comparison skipped.");
  }
  const typesToRead = ["IncidentCategory", "IncidentSeverity", "IncidentStatus", "IncidentScope"];
  for (const t of typesToRead) {
    const r = await q(
      `SELECT (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
                 FROM pg_enum e WHERE e.enumtypid = ty.oid) AS labels
         FROM pg_type ty WHERE ty.typname = $1`,
      [t],
    );
    if (!r.ok || r.rows.length === 0) {
      console.log(`  ${t.padEnd(20)}: TYPE MISSING`);
      problem(`enum type ${t} is missing`);
      continue;
    }
    const db = String(r.rows[0].labels ?? "").split(",").filter(Boolean);
    console.log(`  ${t.padEnd(20)}: ${db.join(", ")}`);
    const want = canonical?.[t];
    if (want) {
      const absent = want.filter((v) => !db.includes(v));
      if (absent.length) {
        console.log(`  ${"".padEnd(20)}  ** ABSENT in database: ${absent.join(", ")}`);
        problem(`enum ${t}: values absent in database: ${absent.join(", ")}`);
      }
    }
  }
}

await pg.query("ROLLBACK");

// ===========================================================================
// 5. The writer's own reads, executed through the deployed Prisma client.
// ===========================================================================

head("5. WRITER READS — through the deployed Prisma client, read-only");

let prisma = null;
try {
  const mod = await import(`${process.cwd().replace(/[\\/]+$/, "")}/dist/db.js`).catch(
    () => import("../dist/db.js"),
  );
  prisma = mod.prisma;
} catch {
  try {
    const { PrismaClient } = require("@prisma/client");
    const { Pool } = require("pg");
    const { PrismaPg } = require("@prisma/adapter-pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    console.log("  (constructed a client with the image's own adapter configuration)");
  } catch (err) {
    console.log("  Prisma client UNAVAILABLE — writer reads cannot be executed here.");
    reportFailure("prisma bootstrap", err, 0);
    prisma = null;
  }
}

/**
 * Run one probe inside its OWN read-only interactive transaction, so an
 * aborted statement cannot poison any other probe, and so nothing this script
 * does can be committed even in principle.
 */
class Rollback extends Error {}
async function prismaProbe(label, fn) {
  if (!prisma) return null;
  const started = Date.now();
  let captured = { ok: false, err: null, value: null };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      try {
        captured.value = await fn(tx);
        captured.ok = true;
      } catch (err) {
        captured.err = err;
      }
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) {
      // The transaction itself could not be opened or was aborted by the
      // failing statement. Either way the inner capture is what matters.
      if (!captured.err && !captured.ok) captured.err = err;
    }
  }
  const ms = Date.now() - started;
  if (captured.ok) {
    console.log(`  ${label}: SUCCEEDED in ${ms}ms`);
  } else {
    reportFailure(label, captured.err, ms);
  }
  return captured;
}

if (prisma) {
  // 5a. Prove the Prisma session refuses writes too.
  const w = await prismaProbe("write rejection (prisma session)", async (tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "operational_incidents" ("category","fingerprint","title","safe_summary")
       VALUES ('DATABASE','ops_writer_probe.must_never_insert','probe','probe')`,
    ),
  );
  if (w?.ok) {
    console.error("  ABORTING: the Prisma session accepted a write.");
    process.exit(3);
  }
  const wcode = describeError(w?.err ?? {}).sqlState;
  console.log(`    expected SQLSTATE 25006, observed: ${wcode ?? "<none>"}`);
  verdict.prismaReadOnlyProven = String(wcode ?? "").includes("25006");

  // 5b. THE WRITER'S OWN LOOKUP — byte-for-byte the shape `recordIncident`
  //     issues first, with no `select`, so Prisma requests every scalar column.
  const full = await prismaProbe(
    "recordIncident stage LOOKUP — findUnique, FULL WIDTH (no select)",
    async (tx) =>
      tx.operationalIncident.findUnique({
        where: {
          teamId_fingerprint: {
            teamId: WORKSPACE_ID,
            fingerprint: "ops_writer_probe.read_only_shape_check",
          },
        },
      }),
  );
  verdict.fullWidthOk = full?.ok ?? null;

  // 5c. The same lookup asking ONLY for what the writer consumes.
  const narrow = await prismaProbe(
    "recordIncident stage LOOKUP — findUnique, EXPLICIT SELECT (writer's real needs)",
    async (tx) =>
      tx.operationalIncident.findUnique({
        where: {
          teamId_fingerprint: {
            teamId: WORKSPACE_ID,
            fingerprint: "ops_writer_probe.read_only_shape_check",
          },
        },
        select: {
          id: true,
          teamId: true,
          status: true,
          severity: true,
          requestId: true,
          traceId: true,
          relatedEvidenceId: true,
          relatedJobId: true,
          relatedProvider: true,
          firstSeenAtUtc: true,
          lastSeenAtUtc: true,
        },
      }),
  );
  verdict.narrowOk = narrow?.ok ?? null;

  // 5d. The NULL-team branch, which takes a different statement entirely.
  await prismaProbe(
    "recordIncident stage LOOKUP — findFirst, NULL-team branch, FULL WIDTH",
    async (tx) =>
      tx.operationalIncident.findFirst({
        where: { teamId: null, fingerprint: "ops_writer_probe.read_only_shape_check" },
        orderBy: { firstSeenAtUtc: "asc" },
      }),
  );

  // 5e. Best-effort writer stages, as reads of the same width.
  await prismaProbe("stage EVENT — operationalIncidentEvent, full-width read", async (tx) =>
    tx.operationalIncidentEvent.findFirst({ where: { eventType: "ops_writer_probe" } }),
  );
  await prismaProbe("stage SLA — operationalIncidentSlaCycle, full-width read", async (tx) =>
    tx.operationalIncidentSlaCycle.findFirst({ where: { teamId: WORKSPACE_ID } }),
  );
  await prismaProbe("stage SLA — workspaceSlaPolicyVersion, full-width read", async (tx) =>
    tx.workspaceSlaPolicyVersion.findFirst({ where: { teamId: WORKSPACE_ID } }),
  );
  await prismaProbe("stage SLA — workspaceGovernancePolicy, full-width read", async (tx) =>
    tx.workspaceGovernancePolicy.findFirst({ where: { teamId: WORKSPACE_ID } }),
  );

  // 5f. Gauge refresh reads a grouped count; included because it is the last
  //     mandatory-awaited call in the writer even though its errors are caught.
  await prismaProbe("stage GAUGES — grouped status count", async (tx) =>
    tx.operationalIncident.groupBy({ by: ["status"], _count: { _all: true } }),
  );

  // 5g. What the workspace currently holds, as counts only.
  await prismaProbe("workspace incident counts", async (tx) => {
    const total = await tx.operationalIncident.count({ where: { teamId: WORKSPACE_ID } });
    console.log(`    incidents with team_id = workspace : ${total}`);
    return total;
  });
}

// ===========================================================================
// 6. Verdict
// ===========================================================================

head("6. VERDICT");
console.log(`  catalog session read-only proven : ${verdict.readOnlyProven}`);
console.log(`  prisma session read-only proven  : ${verdict.prismaReadOnlyProven}`);
console.log(`  full-width writer lookup         : ${verdict.fullWidthOk === null ? "not run" : verdict.fullWidthOk ? "SUCCEEDED" : "FAILED"}`);
console.log(`  explicit-select writer lookup    : ${verdict.narrowOk === null ? "not run" : verdict.narrowOk ? "SUCCEEDED" : "FAILED"}`);
for (const t of verdict.tables) {
  console.log(
    `  ${t.table.padEnd(38)} [${t.criticality}] missing=${t.missing.length} extra=${t.extra.length}`,
  );
}
console.log("");
if (verdict.problems.length === 0) {
  console.log("  NO MODEL/DATABASE DISAGREEMENT FOUND on writer-owned tables.");
} else {
  console.log("  PROBLEMS:");
  for (const p of verdict.problems) console.log(`    * ${p}`);
}
if (verdict.fullWidthOk === false && verdict.narrowOk === true) {
  console.log("");
  console.log("  READ WIDTH IS THE FAULT: the writer's full-width lookup fails where an");
  console.log("  explicit-select lookup of the same row succeeds.");
}
line();

await pg.end().catch(() => {});
try {
  await prisma?.$disconnect?.();
} catch {
  /* nothing to recover */
}
process.exit(0);
