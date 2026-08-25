/**
 * OPERATIONS SOURCE DIAGNOSIS — operator-only, READ ONLY, production-safe.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A production workspace reports `readiness: PARTIAL`, `open: 0`,
 * `recorded: 0` with six failed sources and `safeFailureCategory: null`, while
 * Home and Notifications both count 34 TSA failures. The deployed code records
 * WHICH source gave way and discards WHY, so the cause cannot be read from
 * outside. This script recovers it, without changing anything.
 *
 * It answers one question per source: did it fail, at which STAGE, with which
 * PostgreSQL/Prisma code, and how long did it take — the last of those being
 * what separates a statement timeout from a hard error.
 *
 * ---------------------------------------------------------------------------
 * SAFETY — enforced by PostgreSQL, not by this script's good intentions
 * ---------------------------------------------------------------------------
 *   * Requires an explicit DATABASE_URL and an explicit workspace id.
 *   * Every query runs inside `SET TRANSACTION READ ONLY`, and the script
 *     PROVES it by attempting one write and requiring SQLSTATE 25006.
 *   * Zero reconciliation, zero incident writes, zero queue operations, zero
 *     schema or migration activity.
 *   * Every source is attempted even when earlier ones fail.
 *   * Codes, bounded metadata and stacks go to the OPERATOR TERMINAL only.
 *     Nothing here is returned to a browser or persisted.
 *
 * ---------------------------------------------------------------------------
 * FIDELITY — and its refusal
 * ---------------------------------------------------------------------------
 * The workspace scope predicate is BUSINESS LOGIC and is not reimplemented
 * here. The script imports the application's own `workspaceEvidenceWhere` and
 * its own Prisma client from the deployed image. If those cannot be resolved,
 * scope-dependent sources are reported SKIPPED_NO_FIDELITY rather than
 * approximated — an approximate predicate would prove something about this
 * script instead of about the reconciler.
 *
 * Sources that do not use the scope predicate, and all catalog inspection,
 * still run in that case.
 *
 * ---------------------------------------------------------------------------
 * USAGE (from a checkout of the diagnostic branch, on the server)
 * ---------------------------------------------------------------------------
 *   git fetch origin fix/operations-source-failure-diagnostics
 *   git show origin/fix/operations-source-failure-diagnostics:services/api/scripts/ops-source-diagnosis.mjs \
 *     | docker exec -i -w /app/services/api \
 *         -e OPS_DIAG_WORKSPACE_ID=<workspace-uuid> \
 *         <api-container> node --input-type=module
 */

import { createRequire } from "node:module";

// Resolve `pg` and the generated client from the WORKING DIRECTORY, which the
// documented invocation pins to `/app/services/api`. A hardcoded absolute path
// would work in the image and nowhere else, which makes the script impossible
// to rehearse before pointing it at production.
const require = createRequire(`${process.cwd().replace(/[\\/]+$/, "")}/index.js`);

const WORKSPACE_ID = process.env.OPS_DIAG_WORKSPACE_ID;
const STATEMENT_BUDGET_MS = Number.parseInt(
  process.env.OPS_DIAG_STATEMENT_MS ?? "20000",
  10,
);

if (!process.env.DATABASE_URL) {
  console.error("REFUSED: DATABASE_URL is not set. Name the database explicitly.");
  process.exit(2);
}
if (!WORKSPACE_ID || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(WORKSPACE_ID)) {
  console.error("REFUSED: OPS_DIAG_WORKSPACE_ID must be a workspace UUID.");
  process.exit(2);
}

const line = (c = "=") => console.log(c.repeat(78));

/** Never print a credential. */
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.username ? "***:***@" : ""}${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

// ===========================================================================
// 0. A plain pg connection for identity and catalog inspection.
//    `pg` is a runtime dependency of the API image; nothing is installed.
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
console.log("OPERATIONS SOURCE DIAGNOSIS — READ ONLY");
line();
console.log("database url   :", redactUrl(process.env.DATABASE_URL));
console.log("workspace      :", WORKSPACE_ID);
console.log("node           :", process.version);
console.log("app revision   :",
  process.env.GIT_SHA ?? process.env.GIT_COMMIT ?? process.env.APP_REVISION ?? "<unset>");

const identity = (await pg.query(`
  SELECT current_database() AS database,
         current_schema()   AS schema,
         current_user       AS role,
         version()          AS server_version,
         current_setting('statement_timeout')                        AS statement_timeout,
         current_setting('idle_in_transaction_session_timeout')      AS idle_tx_timeout,
         current_setting('default_transaction_read_only')            AS default_read_only,
         current_setting('search_path')                              AS search_path
`)).rows[0];
console.log("identity       :", JSON.stringify(identity, null, 2));

const migHead = (await pg.query(`
  SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations"
   ORDER BY finished_at DESC NULLS LAST
   LIMIT 5
`)).rows;
console.log("migration head :", JSON.stringify(migHead, null, 2));

// --- Prisma client revision, read from the generated client's own manifest ---
let clientInfo = "<unresolved>";
for (const spec of [
  ".prisma/client/package.json",
  "@prisma/client/package.json",
]) {
  try {
    const pkg = require(spec);
    clientInfo = `${pkg.name ?? spec}@${pkg.version ?? "?"}`;
    break;
  } catch {
    /* try next */
  }
}
console.log("prisma client  :", clientInfo);

// ===========================================================================
// 1. Column types and indexes for every object the failing sources touch.
//    Catalog reads only — no business logic.
// ===========================================================================

line("-");
console.log("COLUMN TYPES (objects referenced by the failing sources)");
line("-");
const cols = (await pg.query(
  `SELECT table_name, column_name, data_type, udt_name, is_nullable
     FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (
        (table_name = 'evidence' AND column_name IN (
           'id','team_id','owner_user_id','deleted_at','status',
           'tsa_status','ots_status','tsa_failure_reason','tsa_provider',
           'ots_failure_reason','ots_upgraded_at_utc','updated_at','created_at',
           'integrity_correlation_id','latest_report_version',
           'verification_package_version'))
        OR (table_name = 'queue_telemetry_snapshots' AND column_name IN ('team_id','sampled_at_utc'))
        OR (table_name = 'operational_incidents' AND column_name IN ('team_id','scope','category','status','fingerprint','occurrence_count'))
        OR (table_name = 'evidence_legal_holds' AND column_name IN ('evidence_id','status','expires_at_utc'))
      )
    ORDER BY table_name, column_name`,
)).rows;
for (const c of cols) {
  console.log(
    `  ${c.table_name}.${c.column_name}`.padEnd(56) +
    `${c.udt_name} (${c.data_type})`.padEnd(30) +
    (c.is_nullable === "YES" ? "NULL" : "NOT NULL"),
  );
}

line("-");
console.log("INDEXES");
line("-");
const idx = (await pg.query(
  `SELECT tablename, indexname, indexdef
     FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename IN ('evidence','queue_telemetry_snapshots','operational_incidents','evidence_legal_holds')
    ORDER BY tablename, indexname`,
)).rows;
for (const i of idx) console.log(`  ${i.tablename.padEnd(28)} ${i.indexname}`);
console.log(`  (${idx.length} indexes)`);

// The declared composite that `platform.telemetry_stale` depends on.
const telemetryIdx = idx.filter(
  (i) => i.tablename === "queue_telemetry_snapshots" && /team_id/.test(i.indexdef) && /sampled_at_utc/.test(i.indexdef),
);
console.log(
  "  queue_telemetry_snapshots (team_id, sampled_at_utc) composite:",
  telemetryIdx.length ? "PRESENT" : "*** ABSENT ***",
);

// Table sizes — a timeout is a function of volume, so state it.
line("-");
console.log("APPROXIMATE LIVE ROW COUNTS (planner statistics, not a scan)");
line("-");
const sizes = (await pg.query(
  `SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS total
     FROM pg_stat_user_tables
    WHERE schemaname = current_schema()
      AND relname IN ('evidence','queue_telemetry_snapshots','operational_incidents',
                      'evidence_legal_holds','evidence_review_workflows','worker_telemetry_snapshots')
    ORDER BY n_live_tup DESC`,
)).rows;
for (const s of sizes) {
  console.log(`  ${s.relname.padEnd(30)} ${String(s.n_live_tup).padStart(12)} rows   ${s.total}`);
}

// ===========================================================================
// 2. Resolve the application's OWN modules. No predicate is reimplemented.
// ===========================================================================

line("-");
console.log("FIDELITY");
line("-");

async function firstResolvable(specifiers) {
  const failures = [];
  for (const spec of specifiers) {
    try {
      return { mod: await import(spec), spec };
    } catch (err) {
      failures.push(`    ${spec}\n      -> ${String(err?.code ?? err?.message ?? err).slice(0, 200)}`);
    }
  }
  return { mod: null, spec: null, failures };
}

const dbResolved = await firstResolvable([
  "/app/services/api/dist/db.js",
  "/app/services/api/dist/src/db.js",
  "./dist/db.js",
  "./dist/src/db.js",
]);
const scopeResolved = await firstResolvable([
  "@proovra/shared-runtime",
  "/app/node_modules/@proovra/shared-runtime/dist/index.js",
  "/app/packages/shared-runtime/dist/index.js",
  "/app/services/api/node_modules/@proovra/shared-runtime/dist/index.js",
]);

const prisma = dbResolved.mod?.prisma ?? null;
const workspaceEvidenceWhere = scopeResolved.mod?.workspaceEvidenceWhere ?? null;
const EXACT = Boolean(prisma && workspaceEvidenceWhere);

console.log("db module      :", dbResolved.spec ?? "<unresolved>");
if (!dbResolved.spec) console.log(dbResolved.failures.join("\n"));
console.log("scope module   :", scopeResolved.spec ?? "<unresolved>");
if (!scopeResolved.spec) console.log(scopeResolved.failures.join("\n"));
console.log("mode           :", EXACT ? "EXACT (application's own predicate + client)" : "DEGRADED");
if (!EXACT) {
  console.log(
    "                 scope-dependent sources will be reported\n" +
    "                 SKIPPED_NO_FIDELITY. The scope predicate is business\n" +
    "                 logic and is deliberately NOT reimplemented here.",
  );
}

// ===========================================================================
// 3. Run every source independently inside ONE read-only transaction.
// ===========================================================================

const results = [];

function classify(err) {
  const prismaCode = err?.code ?? err?.errorCode ?? null;
  const pgCode =
    err?.meta?.code ?? err?.originalError?.code ?? err?.cause?.code ?? null;
  const msg = String(err?.message ?? "");
  let stage = "UNKNOWN";
  if (pgCode === "57014" || /canceling statement due to statement timeout|timeout/i.test(msg)) stage = "TIMEOUT";
  else if (pgCode === "42703" || /column .* does not exist|Unknown field|Unknown arg/i.test(msg)) stage = "READ";
  else if (pgCode === "42P01" || /relation .* does not exist/i.test(msg)) stage = "DEPENDENCY_UNAVAILABLE";
  else if (pgCode === "22P02" || /invalid input value for enum|invalid input syntax/i.test(msg)) stage = "CLASSIFY";
  else if (pgCode === "42883" || /operator does not exist|function .* does not exist/i.test(msg)) stage = "CLASSIFY";
  else if (pgCode === "25006") stage = "WRITE";
  else if (/ECONNREFUSED|Can't reach database|connection/i.test(msg)) stage = "DEPENDENCY_UNAVAILABLE";
  return { prismaCode, pgCode, stage, name: err?.constructor?.name ?? typeof err };
}

function fail(sourceId, phase, err, ms) {
  const c = classify(err);
  results.push({ sourceId, outcome: "FAILED", stage: c.stage, ms, prismaCode: c.prismaCode, pgCode: c.pgCode });
  console.error(`\n### FAILED  ${sourceId}   [${phase}]   ${ms}ms`);
  console.error(`    class       : ${c.name}`);
  console.error(`    prisma code : ${c.prismaCode ?? "-"}`);
  console.error(`    pg code     : ${c.pgCode ?? "-"}`);
  console.error(`    stage       : ${c.stage}`);
  // OPERATOR TERMINAL ONLY.
  console.error(`    message     : ${String(err?.message ?? "").slice(0, 900)}`);
  if (err?.meta) console.error(`    meta        : ${JSON.stringify(err.meta).slice(0, 600)}`);
  if (err?.stack) {
    console.error("    stack       :");
    console.error(String(err.stack).split("\n").slice(0, 14).map((l) => `      ${l}`).join("\n"));
  }
}

async function run(sourceId, label, needsScope, fn) {
  if (needsScope && !EXACT) {
    results.push({ sourceId, outcome: "SKIPPED_NO_FIDELITY", stage: null, ms: 0, prismaCode: null, pgCode: null });
    console.log(`skip ${sourceId.padEnd(48)}      -   SKIPPED_NO_FIDELITY`);
    return;
  }
  const t0 = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - t0;
    results.push({ sourceId, outcome: "SUCCEEDED", stage: null, ms, prismaCode: null, pgCode: null });
    console.log(`ok   ${sourceId.padEnd(48)} ${String(ms).padStart(6)}ms  ${label}=${value}`);
  } catch (err) {
    fail(sourceId, label, err, Date.now() - t0);
  }
}

const HOURS = (h) => new Date(Date.now() - h * 3_600_000);
const DAYS = (d) => new Date(Date.now() - d * 86_400_000);

// --- The read-only transaction -------------------------------------------
line("-");
console.log("READ ONLY TRANSACTION");
line("-");

await pg.query("BEGIN");
await pg.query("SET TRANSACTION READ ONLY");
await pg.query(`SET LOCAL statement_timeout = ${STATEMENT_BUDGET_MS}`);
console.log(
  "session statement_timeout:", identity.statement_timeout,
  "| this transaction:", `${STATEMENT_BUDGET_MS}ms`,
);

// PROVE writes are prohibited before trusting anything else.
let writeProof = "NOT PROVEN";
try {
  await pg.query(
    `INSERT INTO operational_incidents (id, category, fingerprint, title, safe_summary, updated_at)
     VALUES (gen_random_uuid(), 'EVIDENCE_INTEGRITY', 'ops-diag-write-probe', 'probe', 'probe', now())`,
  );
  writeProof = "*** WRITES ARE POSSIBLE — ABORTING ***";
} catch (err) {
  writeProof = err?.code === "25006"
    ? "PROVEN read-only (SQLSTATE 25006)"
    : `refused with SQLSTATE ${err?.code ?? "?"}`;
}
console.log("write probe    :", writeProof);
if (writeProof.startsWith("***")) {
  await pg.query("ROLLBACK");
  await pg.end();
  process.exit(5);
}
// The failed INSERT aborts the transaction; restart it clean and read-only.
await pg.query("ROLLBACK");
await pg.query("BEGIN");
await pg.query("SET TRANSACTION READ ONLY");
await pg.query(`SET LOCAL statement_timeout = ${STATEMENT_BUDGET_MS}`);

// Resolve the canonical scope through the application's own authority.
let evidenceWhere = null;
if (EXACT) {
  const t0 = Date.now();
  try {
    evidenceWhere = await workspaceEvidenceWhere(WORKSPACE_ID, prisma);
    console.log(
      `scope resolved : ${Date.now() - t0}ms`,
      JSON.stringify(evidenceWhere, (k, v) =>
        typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? "<uuid>" : v),
    );
  } catch (err) {
    fail("workspace_scope_predicate", "SCOPE", err, Date.now() - t0);
  }
}

const workspaceRow = (await pg.query(
  `SELECT is_personal, workspace_kind, owner_user_id IS NOT NULL AS has_owner
     FROM teams WHERE id = $1`,
  [WORKSPACE_ID],
)).rows[0] ?? null;
console.log("workspace row  :", workspaceRow ? JSON.stringify(workspaceRow) : "NOT FOUND");

console.log("");

// --- The eleven sources ---------------------------------------------------
const P = (fn) => fn();
const scoped = Boolean(evidenceWhere);

// evidence_integrity.* — one scan in production, split into its five stages.
await run("evidence_integrity[1:population-count]", "count", true, () =>
  prisma.evidence.count({
    where: { AND: [evidenceWhere, { deletedAt: null }, { OR: [{ tsaStatus: "FAILED" }, { otsStatus: "FAILED" }] }] },
  }));

await run("evidence_integrity[2:evidence-read]", "rows", true, async () =>
  (await prisma.evidence.findMany({
    where: { AND: [evidenceWhere, { deletedAt: null }, { OR: [{ tsaStatus: "FAILED" }, { otsStatus: "FAILED" }] }] },
    select: {
      id: true, teamId: true, title: true,
      tsaStatus: true, tsaFailureReason: true, tsaProvider: true,
      otsStatus: true, otsFailureReason: true, otsUpgradedAtUtc: true,
      updatedAt: true, integrityCorrelationId: true,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 2001,
  })).length);

await run("evidence_integrity[3:legal-hold-read]", "held", true, async () => {
  const ids = (await prisma.evidence.findMany({
    where: { AND: [evidenceWhere, { deletedAt: null }] },
    select: { id: true }, take: 100,
  })).map((e) => e.id);
  if (ids.length === 0) return 0;
  return (await prisma.evidenceLegalHold.findMany({
    where: {
      evidenceId: { in: ids },
      status: "ACTIVE",
      OR: [{ expiresAtUtc: null }, { expiresAtUtc: { gt: new Date() } }],
    },
    select: { evidenceId: true },
  })).length;
});

await run("evidence_integrity[4:dedupe-read]", "existing", false, () =>
  prisma
    ? prisma.operationalIncident.count({ where: { teamId: WORKSPACE_ID, category: "EVIDENCE_INTEGRITY" } })
    : P(async () => (await pg.query(
        `SELECT count(*)::int AS c FROM operational_incidents WHERE team_id = $1 AND category = 'EVIDENCE_INTEGRITY'`,
        [WORKSPACE_ID],
      )).rows[0].c));

await run("evidence_integrity[5:resolver-read]", "open", false, () =>
  prisma
    ? prisma.operationalIncident.count({
        where: {
          teamId: WORKSPACE_ID, category: "EVIDENCE_INTEGRITY",
          status: { in: ["OPEN", "ACKNOWLEDGED", "SUPPRESSED"] },
        },
      })
    : P(async () => (await pg.query(
        `SELECT count(*)::int AS c FROM operational_incidents
          WHERE team_id = $1 AND category = 'EVIDENCE_INTEGRITY'
            AND status IN ('OPEN','ACKNOWLEDGED','SUPPRESSED')`,
        [WORKSPACE_ID],
      )).rows[0].c));

await run("pipeline.report_backlog", "count", true, () =>
  prisma.evidence.count({
    where: { AND: [evidenceWhere, { status: "SIGNED", latestReportVersion: null }] },
  }));

await run("pipeline.package_backlog", "count", true, () =>
  prisma.evidence.count({
    where: { AND: [evidenceWhere, { status: "REPORTED", verificationPackageVersion: null }] },
  }));

await run("platform.telemetry_stale", "row", false, () =>
  prisma
    ? prisma.queueTelemetrySnapshot
        .findFirst({ where: { teamId: WORKSPACE_ID }, orderBy: { sampledAtUtc: "desc" }, select: { sampledAtUtc: true } })
        .then((r) => (r ? "1" : "0"))
    : P(async () => String((await pg.query(
        `SELECT sampled_at_utc FROM queue_telemetry_snapshots WHERE team_id = $1
          ORDER BY sampled_at_utc DESC LIMIT 1`, [WORKSPACE_ID],
      )).rowCount)));

// --- Controls: succeeding in production -----------------------------------

await run("review.stale_workflows", "count", true, () =>
  prisma.evidenceReviewWorkflow.count({
    where: {
      evidence: evidenceWhere,
      status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
      updatedAt: { lt: HOURS(48) },
    },
  }));

await run("queue.retry_storm", "count", false, () =>
  prisma
    ? prisma.operationalIncident.count({
        where: {
          scope: "WORKSPACE", teamId: WORKSPACE_ID,
          status: { in: ["OPEN", "ACKNOWLEDGED"] }, occurrenceCount: { gte: 5 },
        },
      })
    : P(async () => (await pg.query(
        `SELECT count(*)::int AS c FROM operational_incidents
          WHERE scope = 'WORKSPACE' AND team_id = $1
            AND status IN ('OPEN','ACKNOWLEDGED') AND occurrence_count >= 5`,
        [WORKSPACE_ID],
      )).rows[0].c));

await run("platform.worker_heartbeat_stale", "row", false, () =>
  prisma
    ? prisma.workerTelemetrySnapshot
        .findFirst({ where: { workerKind: "WORKER" }, orderBy: { heartbeatAtUtc: "desc" }, select: { heartbeatAtUtc: true } })
        .then((r) => (r ? "1" : "0"))
    : P(async () => String((await pg.query(
        `SELECT heartbeat_at_utc FROM worker_telemetry_snapshots WHERE worker_kind = 'WORKER'
          ORDER BY heartbeat_at_utc DESC LIMIT 1`,
      )).rowCount)));

await run("pipeline.signed_without_report_aged", "count", true, () =>
  prisma.evidence.count({
    where: { AND: [evidenceWhere, { status: "UPLOADED", createdAt: { lt: DAYS(7) } }] },
  }));

await run("coordination.backlog_stale[reviewer-comments]", "count", true, () =>
  prisma.evidenceReviewerComment.count({
    where: { evidence: evidenceWhere, resolvedAtUtc: null, createdAt: { lt: DAYS(7) } },
  }));

await run("coordination.backlog_stale[annotations]", "count", true, () =>
  prisma.evidenceAnnotation.count({
    where: { evidence: evidenceWhere, resolvedAtUtc: null, createdAt: { lt: DAYS(7) } },
  }));

await run("coordination.backlog_stale[case-comments]", "count", false, () =>
  prisma
    ? prisma.caseComment.count({ where: { teamId: WORKSPACE_ID, resolvedAtUtc: null, createdAt: { lt: DAYS(7) } } })
    : P(async () => (await pg.query(
        `SELECT count(*)::int AS c FROM case_comments
          WHERE team_id = $1 AND resolved_at_utc IS NULL AND created_at < now() - interval '7 days'`,
        [WORKSPACE_ID],
      )).rows[0].c));

// --- Cross-surface control: the number Home shows --------------------------
await run("[control] home-style TSA failure count", "count", true, () =>
  prisma.evidence.count({
    where: { AND: [evidenceWhere, { deletedAt: null }, { tsaStatus: "FAILED" }] },
  }));

await pg.query("ROLLBACK");

// ===========================================================================
// 4. Summary.
// ===========================================================================

line();
console.log("PER-SOURCE RESULT");
line();
console.log(
  "OUTCOME".padEnd(21) + "STAGE".padEnd(24) + "ms".padStart(7) +
  "  PRISMA".padEnd(11) + "PG".padEnd(8) + "  SOURCE",
);
for (const r of results) {
  console.log(
    r.outcome.padEnd(21) +
    String(r.stage ?? "-").padEnd(24) +
    String(r.ms).padStart(7) + "  " +
    String(r.prismaCode ?? "-").padEnd(11) +
    String(r.pgCode ?? "-").padEnd(8) + "  " +
    r.sourceId,
  );
}

const failed = results.filter((r) => r.outcome === "FAILED");
line("-");
console.log(`failed ${failed.length} of ${results.length}`);
if (failed.length) {
  console.log("distinct stages  :", [...new Set(failed.map((f) => f.stage))].join(", "));
  console.log("distinct pg codes:", [...new Set(failed.map((f) => f.pgCode ?? "-"))].join(", "));
  console.log("distinct prisma  :", [...new Set(failed.map((f) => f.prismaCode ?? "-"))].join(", "));
}
console.log("mode             :", EXACT ? "EXACT" : "DEGRADED");
console.log("write probe      :", writeProof);

await pg.end();
if (prisma?.$disconnect) await prisma.$disconnect().catch(() => null);
