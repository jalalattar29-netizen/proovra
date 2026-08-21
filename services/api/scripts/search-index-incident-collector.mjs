/**
 * READ-ONLY evidence collector for the Search "STALLED at 0/N" incident.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The code-level diagnosis is complete and is covered by executable tests
 * (`services/api/test/search-automatic-recovery.integration.test.ts`). What
 * those tests cannot establish is which of the possible histories actually
 * happened in production for a given workspace — whether the two records were
 * created while the `GovernanceReconciliationKind` enum was missing its
 * `SEARCH_INDEX` value, whether the worker was ever restarted after the
 * migration landed, and whether any reconciliation run was ever recorded.
 *
 * That question can only be answered by reading production, and this repository
 * has no production access. So this script exists instead of a guess. Run by an
 * operator, it returns exactly the facts the incident write-up needs and
 * nothing else.
 *
 * WHAT IT WILL NOT DO
 * ---------------------------------------------------------------------------
 * It will not read `DATABASE_URL`, and it will not read `.env`. It requires an
 * EXPLICIT read-only credential supplied for this purpose and nothing else:
 *
 *     SEARCH_INCIDENT_READONLY_DATABASE_URL
 *
 * That refusal is deliberate. A diagnostic that quietly picks up whatever
 * connection string is lying around is one `UPDATE` away from being an
 * incident of its own, and the ambient credential is usually a read-WRITE one.
 *
 * Every statement it issues is a `SELECT`. There is no INSERT, UPDATE, DELETE,
 * ALTER, TRUNCATE or `prisma migrate` path in this file and there must never
 * be. It does not enqueue anything, does not rebuild an index, does not touch
 * Redis, and does not restart or drain anything. Recovering the workspace is a
 * separate, deliberate operator action — never a side effect of looking at it.
 *
 * WHAT IT COLLECTS
 * ---------------------------------------------------------------------------
 * Scoped to ONE workspace, named by its immutable id:
 *
 *   * whether migration `20271215000000_search_index_reconciliation_kind` is
 *     recorded applied, and whether it is recorded as rolled back or failed;
 *   * whether the PostgreSQL enum actually carries `SEARCH_INDEX` — the
 *     migration ledger and the type are separate facts and the incident is
 *     precisely the case where they disagreed;
 *   * the workspace's kind and eligible/indexed counts, by the SAME eligibility
 *     predicate the product uses;
 *   * the eligible records' creation and last-update timestamps, so they can be
 *     placed relative to the migration;
 *   * every `SEARCH_INDEX` reconciliation run for the workspace, with status,
 *     trigger, lease age and counters;
 *   * the same run history globally, bucketed by trigger, so "the scheduler has
 *     never recorded a run for ANY workspace" can be distinguished from "not
 *     for this one".
 *
 * CONTENT NEVER LEAVES THE PROCESS IN READABLE FORM. Record titles, filenames,
 * OCR text and user identifiers are not selected at all; identifiers that are
 * needed for correlation are hashed. The output is safe to paste into an
 * incident ticket.
 *
 * USAGE (owner-operated)
 * ---------------------------------------------------------------------------
 *     SEARCH_INCIDENT_READONLY_DATABASE_URL="postgres://<readonly-user>:<pw>@<host>:<port>/<db>" \
 *       node services/api/scripts/search-index-incident-collector.mjs \
 *         --workspace <team-uuid> \
 *         --out /var/tmp/search-incident.json
 *
 * The deployed-revision and worker-restart facts are NOT collectable from the
 * database. They are listed in `operatorMustAlsoCapture` in the output so the
 * write-up cannot silently omit them.
 */

import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CREDENTIAL_ENV = "SEARCH_INCIDENT_READONLY_DATABASE_URL";
const MIGRATION = "20271215000000_search_index_reconciliation_kind";
const ENUM_TYPE = "GovernanceReconciliationKind";
const ENUM_VALUE = "SEARCH_INDEX";

/** The product's own eligibility predicate, kept in one place here too. */
const ELIGIBLE_SQL =
  `COALESCE(e."lifecycle_state", 'ACTIVE') NOT IN ('DESTROYED','PENDING_DESTRUCTION')`;

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(`search-index-incident-collector: ${message}`);
  process.exit(1);
}

/** Correlation without disclosure. */
function hashId(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

/**
 * A connection string is a credential. Only its shape is ever reported, so an
 * operator can confirm they pointed at the right host without the output
 * carrying the password that got them there.
 */
function describeTargetSafely(url) {
  try {
    const u = new URL(url);
    return {
      protocol: u.protocol.replace(":", ""),
      host: hashId(u.hostname),
      port: u.port || null,
      database: hashId(u.pathname.replace(/^\//, "")),
      // Named so an operator can confirm they used the read-only role, without
      // the name itself becoming a hint about the account layout.
      user: hashId(u.username),
    };
  } catch {
    return { protocol: null, host: null, port: null, database: null, user: null };
  }
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * The repository this script lives in, found by its workspace marker.
 *
 * Used only to REFUSE writing evidence into it. Returns null when the marker
 * cannot be found — in which case the refusal cannot be enforced and the
 * operator's explicit `--out` stands on its own.
 */
function findRepoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Is `target` inside `root`?
 *
 * `path.relative` alone is not enough on Windows: across DRIVES it returns an
 * absolute path (`C:\Temp\x.json`), which does not begin with `..` — so a
 * naive `!startsWith("..")` check reported every other drive as being inside
 * the repository and refused perfectly valid destinations. The absolute case
 * has to be excluded explicitly.
 */
function isInside(root, target) {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith(`..${sep}`) && rel !== "..";
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const connectionString = process.env[CREDENTIAL_ENV]?.trim();
  if (!connectionString) {
    fail(
      `${CREDENTIAL_ENV} is not set. This tool deliberately refuses to read ` +
        `DATABASE_URL or .env — supply an explicit READ-ONLY credential.`,
    );
  }
  const workspaceId = arg("workspace");
  if (!workspaceId || !UUID_RE.test(workspaceId)) {
    fail("--workspace <team-uuid> is required and must be a UUID.");
  }
  /**
   * WHERE THE EVIDENCE LANDS IS THE OPERATOR'S DECISION, NOT A DEFAULT.
   *
   * This used to default to `search-incident.json` in the working directory,
   * which for anyone running it from a checkout means dropping an untracked
   * file full of production facts into the repository — one `git add -A` away
   * from being committed. An incident tool must not leave evidence lying in a
   * source tree.
   *
   * `--out` is therefore required, and a path that resolves inside this
   * repository is refused outright rather than warned about.
   */
  const outArg = arg("out");
  if (!outArg) {
    fail(
      "--out <path> is required. Choose a location OUTSIDE this repository — " +
        "the report contains production facts and must not land in a source tree.",
    );
  }
  const outPath = resolve(outArg);
  const repoRoot = findRepoRoot();
  if (repoRoot && isInside(repoRoot, outPath)) {
    fail(
      `refusing to write inside the repository (${repoRoot}). ` +
        "Choose an --out path outside the source tree.",
    );
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString,
    // Bounded: a diagnostic that hangs on a busy production database is an
    // incident of its own.
    statement_timeout: 30_000,
    query_timeout: 30_000,
    connectionTimeoutMillis: 15_000,
    application_name: "search-index-incident-collector",
  });

  await client.connect();

  /**
   * Every read goes through here, and the session is pinned READ ONLY before
   * the first one. Belt and braces with the read-only role: if the operator
   * supplies a write-capable credential by mistake, the transaction still
   * cannot write.
   */
  await client.query("BEGIN TRANSACTION READ ONLY");

  const q = async (text, params = []) => (await client.query(text, params)).rows;

  try {
    // ---- 1. Deployment compatibility -------------------------------------
    const migrationRows = await q(
      `SELECT "migration_name",
              "started_at",
              "finished_at",
              "rolled_back_at",
              "applied_steps_count"
         FROM "_prisma_migrations"
        WHERE "migration_name" = $1`,
      [MIGRATION],
    );

    const enumRows = await q(
      `SELECT e.enumlabel AS label, e.enumsortorder AS sort_order
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = $1
        ORDER BY e.enumsortorder`,
      [ENUM_TYPE],
    );
    const enumLabels = enumRows.map((r) => r.label);

    // The most recent migrations, so an operator can see where in the ledger
    // this one sits and whether anything after it is missing.
    const migrationTail = await q(
      `SELECT "migration_name", "finished_at", "rolled_back_at"
         FROM "_prisma_migrations"
        ORDER BY "started_at" DESC
        LIMIT 10`,
    );

    // ---- 2. The workspace -------------------------------------------------
    const teamRows = await q(
      `SELECT "id",
              "is_personal",
              "created_at",
              ("organization_id" IS NOT NULL) AS has_organization
         FROM "teams"
        WHERE "id" = $1::uuid`,
      [workspaceId],
    );
    if (teamRows.length === 0) {
      fail("no workspace with that id exists on the target database.");
    }

    const counts = (
      await q(
        `SELECT
           (SELECT COUNT(*)::int FROM "evidence" e
             WHERE e."team_id" = $1::uuid AND ${ELIGIBLE_SQL}) AS eligible,
           (SELECT COUNT(*)::int FROM "evidence_search_documents" d
             WHERE d."team_id" = $1::uuid AND d."document_type" = 'EVIDENCE') AS indexed_documents,
           (SELECT COUNT(*)::int
              FROM "evidence_search_documents" d
              LEFT JOIN "evidence" e ON e."id" = d."source_id"
             WHERE d."team_id" = $1::uuid
               AND d."document_type" = 'EVIDENCE'
               AND (e."id" IS NULL OR NOT (${ELIGIBLE_SQL}))) AS unresolved_removals,
           (SELECT MAX(d."indexed_at_utc") FROM "evidence_search_documents" d
             WHERE d."team_id" = $1::uuid) AS last_indexed_at_utc`,
        [workspaceId],
      )
    )[0];

    // The eligible records themselves — TIMESTAMPS AND IDENTITY ONLY. No
    // title, no filename, no type. Enough to place them relative to the
    // migration and to the last index write, and nothing else.
    const eligibleRecords = (
      await q(
        `SELECT e."id"                AS id,
                e."created_at"        AS created_at,
                e."updated_at"        AS updated_at,
                e."lifecycle_state"   AS lifecycle_state,
                (d."source_id" IS NOT NULL) AS has_document,
                d."indexed_at_utc"    AS indexed_at_utc
           FROM "evidence" e
           LEFT JOIN "evidence_search_documents" d
                  ON d."source_id" = e."id"
                 AND d."document_type" = 'EVIDENCE'
          WHERE e."team_id" = $1::uuid
            AND ${ELIGIBLE_SQL}
          ORDER BY e."created_at" ASC
          LIMIT 50`,
        [workspaceId],
      )
    ).map((r) => ({
      evidenceId: hashId(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lifecycleState: r.lifecycle_state,
      hasSearchDocument: r.has_document,
      indexedAtUtc: r.indexed_at_utc,
    }));

    // ---- 3. Reconciliation runs ------------------------------------------
    // Guarded: on a database where the enum value does not exist, comparing
    // `kind = 'SEARCH_INDEX'` is itself the error being investigated. The
    // comparison is done as TEXT so this collector can still report on the
    // exact database state that breaks the product.
    const workspaceRuns = (
      await q(
        `SELECT "id",
                "status",
                "trigger",
                "started_at_utc",
                "finished_at_utc",
                "scanned_count",
                "created_count",
                "skipped_count",
                "failed_count",
                ("error_summary" IS NOT NULL) AS has_error_summary,
                LEFT("error_summary", 120) AS error_summary_head,
                "metadata"
           FROM "governance_reconciliation_runs"
          WHERE "team_id" = $1::uuid
            AND "kind"::text = $2
          ORDER BY "started_at_utc" DESC
          LIMIT 25`,
        [workspaceId, ENUM_VALUE],
      )
    ).map((r) => ({
      runId: hashId(r.id),
      status: r.status,
      trigger: r.trigger,
      startedAtUtc: r.started_at_utc,
      finishedAtUtc: r.finished_at_utc,
      leaseAgeMs: r.finished_at_utc
        ? null
        : Date.now() - new Date(r.started_at_utc).getTime(),
      counters: {
        scanned: r.scanned_count,
        created: r.created_count,
        skipped: r.skipped_count,
        failed: r.failed_count,
      },
      // The message itself is an internal diagnostic; its HEAD is included
      // because the enum error is the specific string this investigation is
      // trying to confirm, and it contains no tenant data.
      hasErrorSummary: r.has_error_summary,
      errorSummaryHead: r.error_summary_head,
      metadata: r.metadata ?? null,
    }));

    // Global run history by trigger. This is what separates "the scheduler is
    // dead everywhere" from "this workspace was never selected".
    const runsByTrigger = await q(
      `SELECT "trigger",
              "status",
              COUNT(*)::int      AS n,
              MAX("started_at_utc") AS most_recent
         FROM "governance_reconciliation_runs"
        WHERE "kind"::text = $1
        GROUP BY "trigger", "status"
        ORDER BY "trigger", "status"`,
      [ENUM_VALUE],
    );

    // How many OTHER workspaces are currently in the same shape. A fleet-wide
    // number tells an operator whether this is one workspace or a deployment.
    const fleet = (
      await q(
        `SELECT COUNT(*)::int AS workspaces_with_drift
           FROM (
             SELECT e."team_id"
               FROM "evidence" e
               LEFT JOIN "evidence_search_documents" d
                      ON d."source_id" = e."id"
                     AND d."document_type" = 'EVIDENCE'
              WHERE e."team_id" IS NOT NULL
                AND ${ELIGIBLE_SQL}
                AND d."source_id" IS NULL
              GROUP BY e."team_id"
           ) t`,
      )
    )[0];

    const team = teamRows[0];
    const migration = migrationRows[0] ?? null;

    const report = {
      collector: "search-index-incident-collector",
      collectedAtUtc: new Date().toISOString(),
      target: describeTargetSafely(connectionString),
      readOnly: true,

      deployment: {
        migrationName: MIGRATION,
        migrationRecorded: migration != null,
        migrationFinishedAt: migration?.finished_at ?? null,
        migrationRolledBackAt: migration?.rolled_back_at ?? null,
        migrationAppliedStepsCount: migration?.applied_steps_count ?? null,
        // The two facts that can disagree, reported separately on purpose.
        enumType: ENUM_TYPE,
        enumHasSearchIndexValue: enumLabels.includes(ENUM_VALUE),
        enumLabels,
        recentMigrations: migrationTail.map((m) => ({
          name: m.migration_name,
          finishedAt: m.finished_at,
          rolledBackAt: m.rolled_back_at,
        })),
      },

      workspace: {
        // Echoed in the clear because the operator supplied it and the whole
        // report is scoped to it; nothing else about the tenant is disclosed.
        teamId: workspaceId,
        isPersonal: team.is_personal,
        hasOrganization: team.has_organization,
        createdAt: team.created_at,
        eligibleCount: counts.eligible,
        indexedDocumentCount: counts.indexed_documents,
        unresolvedRemovals: counts.unresolved_removals,
        lastIndexedAtUtc: counts.last_indexed_at_utc,
        eligibleRecords,
      },

      reconciliation: {
        workspaceRuns,
        workspaceRunCount: workspaceRuns.length,
        globalRunsByTrigger: runsByTrigger.map((r) => ({
          trigger: r.trigger,
          status: r.status,
          count: r.n,
          mostRecent: r.most_recent,
        })),
        fleetWorkspacesWithMissingDocuments: fleet.workspaces_with_drift,
      },

      /**
       * NOT KNOWABLE FROM THE DATABASE.
       *
       * Listed rather than omitted so a write-up built from this file cannot
       * quietly present a partial picture as a complete one. Each is a fact the
       * incident question genuinely depends on.
       */
      operatorMustAlsoCapture: [
        "API deployed git revision + image digest",
        "worker deployed git revision + image digest",
        "worker container start time, compared against migrationFinishedAt above",
        "whether any worker replica predates the migration (an old replica keeps failing)",
        "SEARCH_INDEX_RECONCILER_ENABLED and SEARCH_INDEX_RECONCILER_INTERVAL_MS on the worker",
        "worker logs for search_index.reconciler.scheduled / .unhealthy / worker.search_index.workspace_claim_failed",
        "Redis reachability from the API and the worker (queue enqueue is best-effort and fails soft)",
        "BullMQ 'search-indexing' queue depth and failed-job count",
      ],
    };

    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    // eslint-disable-next-line no-console
    console.log(
      `search-index-incident-collector: wrote ${outPath} ` +
        `(eligible=${counts.eligible} indexed=${counts.indexed_documents} ` +
        `runs=${workspaceRuns.length} enumOk=${enumLabels.includes(ENUM_VALUE)})`,
    );
  } finally {
    // The transaction is read-only, so this is a formality — but a rollback is
    // the correct way to end a transaction that was never meant to change
    // anything.
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

/**
 * A driver error is not always a sentence.
 *
 * `pg` raises connection failures with an empty `.message` and the only useful
 * information on `.code` (`ECONNREFUSED`, `ENOTFOUND`, `28P01`). Reporting
 * `err.message` alone printed the tool's own name followed by nothing, which
 * tells an operator that something failed and refuses to say what.
 */
function describeError(err) {
  if (!(err instanceof Error)) return String(err ?? "unknown error");
  const code = /** @type {{ code?: unknown }} */ (err).code;
  const parts = [err.message, typeof code === "string" ? `(${code})` : null]
    .filter((p) => typeof p === "string" && p.length > 0);
  return parts.length > 0 ? parts.join(" ") : "unknown error";
}

main().catch((err) => {
  fail(describeError(err));
});
