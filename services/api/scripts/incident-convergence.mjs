#!/usr/bin/env node
"use strict";

/**
 * ADM-013 PHASE 4 — PLATFORM INCIDENT CONVERGENCE. DRY-RUN BY DEFAULT.
 *
 * =============================================================================
 * WHAT THIS EXISTS TO FIX
 * =============================================================================
 * `operational_incidents` carries `@@unique([teamId, fingerprint])`, and every
 * reader assumes that means one row per condition per workspace AND one row per
 * platform condition. It means the first and not the second: a standard
 * Postgres unique index treats NULL as distinct from NULL, so `(NULL, 'x')` and
 * `(NULL, 'x')` are two different keys. Measured — two identical NULL-team rows
 * insert with no error.
 *
 * So every PLATFORM-scope and LEGACY_UNSCOPED incident has been
 * un-deduplicated, and `recordIncident`'s read-then-create had nothing
 * underneath it. The fix is a partial unique index on `(fingerprint) WHERE
 * team_id IS NULL`, and a unique index cannot be created over existing
 * duplicates — so the duplicates converge first.
 *
 * =============================================================================
 * WHY A DRIVER AND NOT ONLY THE SQL
 * =============================================================================
 * The first version of this was a single SQL file that re-parented three child
 * relations: events, SLA cycles, and review escalations. Asking the catalog how
 * many things actually reference `operational_incidents.id` returned TWELVE
 * columns across ten tables. The nine it did not know about — causality links,
 * causality chains, correlations, operational workflows, governance
 * notifications, governance export snapshots, immutable storage checks — would
 * have been silently orphaned by the DELETE, pointing at ids that no longer
 * exist, with no foreign key to complain.
 *
 * A hand-maintained list of relations is a list that goes stale the next time
 * somebody adds a column. This DISCOVERS them, classifies each against a
 * reviewed disposition, and REFUSES TO RUN if it finds one it has never been
 * told about. "Abort on unexpected relations" is the requirement, and the only
 * way to honour it is to look rather than to remember.
 *
 * =============================================================================
 * USAGE
 * =============================================================================
 *   # read-only. Writes nothing, opens no transaction that commits.
 *   node scripts/incident-convergence.mjs --dry-run
 *
 *   # after the dry-run has been reviewed and convergence approved:
 *   node scripts/incident-convergence.mjs --apply
 *
 *   --database-url=…   overrides DATABASE_URL (never read from a .env file)
 *   --json             machine-readable report on stdout
 *
 * `--apply` runs ONE transaction with `SELECT … FOR UPDATE` over the affected
 * rows. It either converges everything and creates the index, or changes
 * nothing.
 */

import { Pool } from "pg";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const APPLY = has("--apply");
const JSON_OUT = has("--json");
const DRY_RUN = !APPLY;

const out = [];
const say = (line) => {
  if (!JSON_OUT) process.stdout.write(`${line}\n`);
  out.push(line);
};
const fail = (msg) => {
  process.stderr.write(`incident-convergence: ${msg}\n`);
  process.exit(2);
};

// =============================================================================
// THE REVIEWED DISPOSITION OF EVERY REFERENCE.
//
// A relation is only converged if somebody decided how. The three kinds:
//
//   REPARENT        point the child at the survivor
//   REPARENT_CYCLE  the same, but the target carries UNIQUE(incident, cycle),
//                   so a collision is renumbered rather than dropped
//   REPARENT_ARRAY  a uuid[] or json array of ids — every element rewritten
//
// A reference not in this table stops the run. That is the point.
// =============================================================================
const DISPOSITIONS = {
  "operational_incident_events.incident_id": {
    kind: "REPARENT",
    why: "the condition's timeline. ON DELETE CASCADE would take it with the row.",
  },
  "operational_incident_sla_cycles.incident_id": {
    kind: "REPARENT_CYCLE",
    unique: "cycle_number",
    why: "UNIQUE(incident_id, cycle_number) rejects a blind re-parent the moment a duplicate and its survivor both hold cycle 1 — the common case, because the same condition opened both.",
  },
  "review_escalations.incident_id": {
    kind: "REPARENT",
    why: "a soft reference with no FK; an orphan here silently detaches an escalation from its cause.",
  },
  "operational_causality_links.source_incident_id": {
    kind: "REPARENT",
    why: "one half of a causality edge. An orphaned edge renders as a link to nothing.",
  },
  "operational_causality_links.target_incident_id": {
    kind: "REPARENT",
    why: "the other half of the same edge.",
  },
  "operational_workflows.source_incident_id": {
    kind: "REPARENT",
    why: "the workflow's originating condition; orphaning it detaches remediation from the fault.",
  },
  "governance_notifications.related_incident_id": {
    kind: "REPARENT",
    why: "the notification's subject. An orphan makes an already-sent notification unexplainable.",
  },
  "immutable_storage_checks.raised_incident_id": {
    kind: "REPARENT",
    why: "the condition a storage check raised; orphaning it loses the link between a drift finding and its incident.",
  },
  "operational_correlations.linked_incident_ids": {
    kind: "REPARENT_ARRAY",
    json: true,
    why: "a JSON array of incident ids. Elements are rewritten and de-duplicated in place.",
  },
  "operational_causality_chains.linked_incident_ids": {
    kind: "REPARENT_ARRAY",
    json: true,
    why: "as above, for a chain.",
  },
  "governance_export_snapshots.governance_incident_ids": {
    kind: "REPARENT_ARRAY",
    json: false,
    why: "a uuid[] column. Elements are rewritten and de-duplicated in place.",
  },
};

/**
 * References that name an incident of a DIFFERENT kind.
 *
 * `status_incident_updates.incident_id` is a foreign key to `status_incidents`
 * — the public status-page incident, an unrelated table that happens to share a
 * noun. Listed rather than omitted so the next reader does not have to
 * re-establish that it is not our problem.
 */
const NOT_OUR_INCIDENT = new Set(["status_incident_updates.incident_id"]);

const SEVERITY_RANK = { CRITICAL: 1, HIGH: 2, WARNING: 3, INFO: 4 };
const RANK_SEVERITY = ["", "CRITICAL", "HIGH", "WARNING", "INFO"];

async function main() {
  const connectionString = val("database-url") ?? process.env.DATABASE_URL;
  if (!connectionString) {
    fail(
      "no database. Pass --database-url=… or set DATABASE_URL in the environment. " +
        "This script never reads a .env file.",
    );
  }

  const pool = new Pool({ connectionString });
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

  const [{ current_database: db }] = await q("SELECT current_database()");
  say(`database: ${db}`);
  say(`mode: ${APPLY ? "APPLY (writes, one transaction)" : "DRY-RUN (read-only)"}`);
  say("");

  // ==========================================================================
  // 1. DISCOVER every reference, and refuse on an unknown one.
  // ==========================================================================
  const fks = await q(`
    SELECT tc.table_name, kcu.column_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND ccu.table_name = 'operational_incidents'
  `);

  // Soft references carry no constraint, so they are found by NAME. A column
  // called `%incident%id%` that nobody has classified is the thing that would
  // otherwise be orphaned in silence.
  const soft = await q(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name LIKE '%incident%id%'
     ORDER BY 1, 2
  `);

  const discovered = new Map();
  for (const r of fks) {
    discovered.set(`${r.table_name}.${r.column_name}`, {
      hard: true,
      deleteRule: r.delete_rule,
    });
  }
  for (const r of soft) {
    const key = `${r.table_name}.${r.column_name}`;
    if (!discovered.has(key)) discovered.set(key, { hard: false, deleteRule: null });
  }

  say("REFERENCES DISCOVERED");
  const unknown = [];
  for (const [key, meta] of [...discovered].sort()) {
    if (NOT_OUR_INCIDENT.has(key)) {
      say(`  ${key.padEnd(52)} NOT-OURS   (a different incident table)`);
      continue;
    }
    const d = DISPOSITIONS[key];
    if (!d) {
      unknown.push(key);
      say(`  ${key.padEnd(52)} UNCLASSIFIED  ← blocks convergence`);
      continue;
    }
    say(
      `  ${key.padEnd(52)} ${d.kind.padEnd(14)} ${meta.hard ? `FK ${meta.deleteRule}` : "soft"}`,
    );
  }
  say("");

  if (unknown.length > 0) {
    say("REFUSED — unclassified references");
    say(
      "  Each column above marked UNCLASSIFIED points at an operational incident and",
    );
    say(
      "  has no reviewed disposition. Converging would delete rows they reference and",
    );
    say(
      "  leave them pointing at ids that no longer exist, with no foreign key to say so.",
    );
    say("  Add each to DISPOSITIONS in this script, with a reason, and re-run.");
    if (JSON_OUT) process.stdout.write(JSON.stringify({ refused: true, unknown }, null, 2) + "\n");
    await pool.end();
    process.exit(3);
  }

  // ==========================================================================
  // 2. THE DUPLICATE POPULATION.
  // ==========================================================================
  const groups = await q(`
    WITH ranked AS (
      SELECT id, fingerprint, first_seen_at_utc, last_seen_at_utc,
             occurrence_count, severity::text AS severity, status::text AS status,
             source_id,
             ROW_NUMBER() OVER (PARTITION BY fingerprint
                                ORDER BY first_seen_at_utc ASC, id ASC) AS rn
        FROM operational_incidents
       WHERE team_id IS NULL
    )
    SELECT fingerprint,
           COUNT(*)::int                      AS rows,
           MIN(first_seen_at_utc)             AS earliest_first_seen,
           MAX(last_seen_at_utc)              AS latest_last_seen,
           SUM(occurrence_count)::int         AS folded_occurrences,
           MIN(CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
                             WHEN 'WARNING' THEN 3 ELSE 4 END)::int AS worst_rank,
           bool_or(status = 'OPEN')           AS any_open,
           bool_or(status = 'ACKNOWLEDGED')   AS any_acknowledged,
           (array_agg(id ORDER BY first_seen_at_utc ASC, id ASC))[1] AS canonical_id,
           array_agg(DISTINCT source_id)      AS source_ids
      FROM ranked
     GROUP BY fingerprint
    HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC, fingerprint
  `);

  const totalPlatformRows = (
    await q("SELECT COUNT(*)::int AS n FROM operational_incidents WHERE team_id IS NULL")
  )[0].n;

  say("DUPLICATE GROUPS");
  if (groups.length === 0) {
    say("  none — every platform-scope condition already has exactly one row.");
  }
  let rowsToRemove = 0;
  for (const g of groups) {
    rowsToRemove += g.rows - 1;
    say(`  ${g.fingerprint}`);
    say(`    rows                ${g.rows}   (removing ${g.rows - 1})`);
    say(`    canonical candidate ${g.canonical_id}   (oldest first_seen, then lowest id)`);
    say(`    first_seen  →       ${g.earliest_first_seen?.toISOString?.() ?? g.earliest_first_seen}`);
    say(`    last_seen   →       ${g.latest_last_seen?.toISOString?.() ?? g.latest_last_seen}`);
    say(`    occurrences →       ${g.folded_occurrences}`);
    say(`    severity    →       ${RANK_SEVERITY[g.worst_rank]}   (by RANK, never lexical MAX)`);
    say(
      `    status      →       ${g.any_open ? "OPEN" : g.any_acknowledged ? "ACKNOWLEDGED (if survivor was RESOLVED)" : "unchanged"}`,
    );
    say(`    source ids          ${(g.source_ids ?? []).filter(Boolean).join(", ") || "(none)"}`);
  }
  say("");

  // ==========================================================================
  // 3. CHILD COUNTS, per classified relation.
  // ==========================================================================
  const dupIds = (
    await q(`
      WITH ranked AS (
        SELECT id, fingerprint,
               ROW_NUMBER() OVER (PARTITION BY fingerprint
                                  ORDER BY first_seen_at_utc ASC, id ASC) AS rn
          FROM operational_incidents WHERE team_id IS NULL
      )
      SELECT r.id FROM ranked r
       WHERE r.rn > 1
         AND EXISTS (SELECT 1 FROM ranked r2
                      WHERE r2.fingerprint = r.fingerprint AND r2.rn > 1)
    `)
  ).map((r) => r.id);

  say("CHILD RELATIONS ON THE ROWS THAT WOULD BE REMOVED");
  const childCounts = {};
  for (const [key, d] of Object.entries(DISPOSITIONS)) {
    const [table, column] = key.split(".");
    let n = 0;
    if (dupIds.length > 0) {
      if (d.kind === "REPARENT_ARRAY") {
        const sql = d.json
          ? `SELECT COUNT(*)::int AS n FROM "${table}" t
               WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(t."${column}", '[]'::jsonb)) e
                              WHERE e.value = ANY($1::text[]))`
          : `SELECT COUNT(*)::int AS n FROM "${table}" t
               WHERE t."${column}" && $1::uuid[]`;
        n = (await q(sql, [dupIds]))[0].n;
      } else {
        n = (
          await q(
            `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "${column}" = ANY($1::uuid[])`,
            [dupIds],
          )
        )[0].n;
      }
    }
    childCounts[key] = n;
    say(`  ${key.padEnd(52)} ${String(n).padStart(6)}`);
  }
  say("");

  // ==========================================================================
  // 4. SLA CYCLE COLLISIONS.
  // ==========================================================================
  const collisions =
    dupIds.length === 0
      ? []
      : await q(
          `
      WITH ranked AS (
        SELECT id, fingerprint,
               ROW_NUMBER() OVER (PARTITION BY fingerprint
                                  ORDER BY first_seen_at_utc ASC, id ASC) AS rn
          FROM operational_incidents WHERE team_id IS NULL
      ),
      mapping AS (
        SELECT r.id AS duplicate_id,
               (SELECT r2.id FROM ranked r2
                 WHERE r2.fingerprint = r.fingerprint AND r2.rn = 1) AS canonical_id
          FROM ranked r WHERE r.rn > 1
      )
      SELECT m.canonical_id, COUNT(*)::int AS colliding
        FROM operational_incident_sla_cycles s
        JOIN mapping m ON m.duplicate_id = s.incident_id
       WHERE EXISTS (SELECT 1 FROM operational_incident_sla_cycles e
                      WHERE e.incident_id = m.canonical_id
                        AND e.cycle_number = s.cycle_number)
       GROUP BY m.canonical_id ORDER BY 2 DESC
    `,
        );

  say("SLA CYCLE COLLISIONS (renumbered above the survivor's maximum, never dropped)");
  if (collisions.length === 0) say("  none");
  for (const c of collisions) say(`  ${c.canonical_id}   ${c.colliding}`);
  say("");

  // ==========================================================================
  // 5. INBOX.
  // ==========================================================================
  const inboxHits = (
    await q(
      // `inbox_item_state`, singular. The table name does not follow the
      // plural convention the rest of the schema uses, and a dry-run that
      // crashed on a typo is a dry-run nobody trusts.
      `SELECT COUNT(*)::int AS n FROM inbox_item_state
        WHERE source_id = ANY($1::text[])`,
      [dupIds],
    )
  )[0].n;
  say("INBOX STATE");
  say(
    `  inbox_item_states referencing a removed row by source_id: ${inboxHits}`,
  );
  say(
    "  (Inbox items key on EVIDENCE ids, not incident ids — a non-zero count here",
  );
  say("   would be a reference nobody has modelled and must be investigated.)");
  say("");

  // ==========================================================================
  // 6. THE INDEX.
  // ==========================================================================
  const indexPresent = (
    await q(`
      SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
        AND indexname='operational_incidents_platform_fingerprint_uk') AS present
    `)
  )[0].present;

  say("UNIQUENESS INDEX");
  say("  CREATE UNIQUE INDEX operational_incidents_platform_fingerprint_uk");
  say('    ON "operational_incidents" ("fingerprint") WHERE "team_id" IS NULL;');
  say(`  currently present: ${indexPresent}`);
  say("");

  say("SUMMARY");
  say(`  platform-scope rows          ${totalPlatformRows}`);
  say(`  duplicate groups             ${groups.length}`);
  say(`  rows that would be removed   ${rowsToRemove}`);
  say(`  index already present        ${indexPresent}`);
  say("");

  if (DRY_RUN) {
    say("DRY-RUN — nothing was written.");
    say("Re-run with --apply once this report has been reviewed and approved.");
    if (JSON_OUT) {
      process.stdout.write(
        JSON.stringify(
          {
            database: db,
            mode: "DRY_RUN",
            totalPlatformRows,
            groups: groups.map((g) => ({
              fingerprint: g.fingerprint,
              rows: g.rows,
              canonicalId: g.canonical_id,
              foldedOccurrences: g.folded_occurrences,
              foldedSeverity: RANK_SEVERITY[g.worst_rank],
              anyOpen: g.any_open,
            })),
            rowsToRemove,
            childCounts,
            slaCollisions: collisions,
            inboxReferences: inboxHits,
            indexPresent,
          },
          null,
          2,
        ) + "\n",
      );
    }
    await pool.end();
    return;
  }

  // ==========================================================================
  // APPLY.
  // ==========================================================================
  if (groups.length === 0 && indexPresent) {
    say("APPLY — nothing to converge and the index is already present. No-op.");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  const before = {
    platformRows: totalPlatformRows,
    events: childCounts["operational_incident_events.incident_id"],
    slaCycles: childCounts["operational_incident_sla_cycles.incident_id"],
  };

  try {
    await client.query("BEGIN");

    // LOCK the affected rows before reading anything else. Without this a
    // concurrent evaluator can insert a new duplicate between the read and the
    // index creation, and the CREATE fails after the merge has already run.
    await client.query(
      `SELECT id FROM operational_incidents WHERE team_id IS NULL FOR UPDATE`,
    );

    await client.query(`
      CREATE TEMPORARY TABLE adm013_map ON COMMIT DROP AS
      WITH ranked AS (
        SELECT id, fingerprint,
               ROW_NUMBER() OVER (PARTITION BY fingerprint
                                  ORDER BY first_seen_at_utc ASC, id ASC) AS rn
          FROM operational_incidents WHERE team_id IS NULL
      )
      SELECT r.id AS duplicate_id,
             (SELECT r2.id FROM ranked r2
               WHERE r2.fingerprint = r.fingerprint AND r2.rn = 1) AS canonical_id
        FROM ranked r
       WHERE r.rn > 1
         AND EXISTS (SELECT 1 FROM ranked r2
                      WHERE r2.fingerprint = r.fingerprint AND r2.rn > 1)
    `);

    // Fold the aggregates onto the survivor BEFORE anything is deleted.
    await client.query(`
      UPDATE operational_incidents c
         SET first_seen_at_utc = LEAST(c.first_seen_at_utc, agg.min_first),
             last_seen_at_utc  = GREATEST(c.last_seen_at_utc, agg.max_last),
             occurrence_count  = c.occurrence_count + agg.sum_occ,
             -- Postgres arrays are 1-INDEXED, and the rank scale starts at 1 for
             -- CRITICAL. A leading '' element shifted everything by one and made
             -- rank 1 select the empty string, which the enum rejected — caught by
             -- the rehearsal, which rolled back and changed nothing.
             severity = (ARRAY['CRITICAL','HIGH','WARNING','INFO'])[
               LEAST(CASE c.severity::text WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
                                           WHEN 'WARNING' THEN 3 ELSE 4 END,
                     agg.worst_rank)]::"IncidentSeverity",
             status = CASE
               WHEN agg.any_open THEN 'OPEN'
               WHEN agg.any_ack AND c.status::text = 'RESOLVED' THEN 'ACKNOWLEDGED'
               ELSE c.status::text END::"IncidentStatus",
             updated_at = now()
        FROM (
          SELECT m.canonical_id,
                 MIN(d.first_seen_at_utc) AS min_first,
                 MAX(d.last_seen_at_utc)  AS max_last,
                 SUM(d.occurrence_count)  AS sum_occ,
                 MIN(CASE d.severity::text WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
                                           WHEN 'WARNING' THEN 3 ELSE 4 END) AS worst_rank,
                 bool_or(d.status::text = 'OPEN')         AS any_open,
                 bool_or(d.status::text = 'ACKNOWLEDGED') AS any_ack
            FROM adm013_map m
            JOIN operational_incidents d ON d.id = m.duplicate_id
           GROUP BY m.canonical_id
        ) agg
       WHERE c.id = agg.canonical_id
    `);

    // Re-parent every classified relation.
    for (const [key, d] of Object.entries(DISPOSITIONS)) {
      const [table, column] = key.split(".");
      if (d.kind === "REPARENT") {
        await client.query(
          `UPDATE "${table}" t SET "${column}" = m.canonical_id
             FROM adm013_map m WHERE t."${column}" = m.duplicate_id`,
        );
      } else if (d.kind === "REPARENT_CYCLE") {
        // Renumber the colliding cycles above the survivor's maximum first,
        // then re-parent the rest. UNIQUE(incident_id, cycle_number) rejects a
        // blind move the moment both rows hold cycle 1.
        await client.query(`
          WITH collisions AS (
            SELECT s.id, m.canonical_id,
                   ROW_NUMBER() OVER (PARTITION BY m.canonical_id
                                      ORDER BY s.cycle_number, s.id) AS off
              FROM "${table}" s
              JOIN adm013_map m ON m.duplicate_id = s."${column}"
             WHERE EXISTS (SELECT 1 FROM "${table}" e
                            WHERE e."${column}" = m.canonical_id
                              AND e.cycle_number = s.cycle_number)
          ),
          ceilings AS (
            SELECT s."${column}" AS canonical_id, MAX(s.cycle_number) AS max_cycle
              FROM "${table}" s
              JOIN (SELECT DISTINCT canonical_id FROM adm013_map) c
                ON c.canonical_id = s."${column}"
             GROUP BY 1
          )
          UPDATE "${table}" s
             SET "${column}" = col.canonical_id,
                 cycle_number = COALESCE(ceil.max_cycle, 0) + col.off
            FROM collisions col
            LEFT JOIN ceilings ceil ON ceil.canonical_id = col.canonical_id
           WHERE s.id = col.id
        `);
        await client.query(
          `UPDATE "${table}" t SET "${column}" = m.canonical_id
             FROM adm013_map m WHERE t."${column}" = m.duplicate_id`,
        );
      } else if (d.kind === "REPARENT_ARRAY" && d.json) {
        await client.query(`
          UPDATE "${table}" t
             SET "${column}" = sub.rewritten
            FROM (
              SELECT t2.id,
                     (SELECT jsonb_agg(DISTINCT COALESCE(m.canonical_id::text, e.value))
                        FROM jsonb_array_elements_text(t2."${column}") e
                        LEFT JOIN adm013_map m ON m.duplicate_id::text = e.value
                     ) AS rewritten
                FROM "${table}" t2
               WHERE EXISTS (
                 SELECT 1 FROM jsonb_array_elements_text(COALESCE(t2."${column}", '[]'::jsonb)) e2
                   JOIN adm013_map m2 ON m2.duplicate_id::text = e2.value)
            ) sub
           WHERE t.id = sub.id
        `);
      } else if (d.kind === "REPARENT_ARRAY") {
        await client.query(`
          UPDATE "${table}" t
             SET "${column}" = sub.rewritten
            FROM (
              SELECT t2.id,
                     ARRAY(SELECT DISTINCT COALESCE(m.canonical_id, e)
                             FROM unnest(t2."${column}") e
                             LEFT JOIN adm013_map m ON m.duplicate_id = e) AS rewritten
                FROM "${table}" t2
               WHERE t2."${column}" && (SELECT array_agg(duplicate_id) FROM adm013_map)
            ) sub
           WHERE t.id = sub.id
        `);
      }
    }

    // Record the convergence on the survivor's own timeline.
    await client.query(`
      INSERT INTO operational_incident_events
        (id, incident_id, event_type, safe_message, metadata_json, created_at)
      SELECT gen_random_uuid(), m.canonical_id, 'merged',
             'Duplicate platform-scope rows for this condition were converged into this record. '
               || 'First-seen, last-seen, occurrence total, severity and status were folded from '
               || 'every merged row; their timelines, SLA cycles, causality links, workflows, '
               || 'notifications and correlations were re-parented here.',
             jsonb_build_object(
               'mergedIncidentIds', jsonb_agg(m.duplicate_id ORDER BY m.duplicate_id),
               'mergedCount', COUNT(*),
               'reason', 'ADM-013 PHASE 4 — team_id IS NULL was never deduplicated',
               'tool', 'scripts/incident-convergence.mjs'
             ),
             now()
        FROM adm013_map m
       GROUP BY m.canonical_id
    `);

    const del = await client.query(
      `DELETE FROM operational_incidents o USING adm013_map m WHERE o.id = m.duplicate_id`,
    );

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "operational_incidents_platform_fingerprint_uk"
        ON "operational_incidents" ("fingerprint") WHERE "team_id" IS NULL
    `);

    await client.query("COMMIT");

    const after = (
      await q("SELECT COUNT(*)::int AS n FROM operational_incidents WHERE team_id IS NULL")
    )[0].n;
    const afterEvents = (
      await q("SELECT COUNT(*)::int AS n FROM operational_incident_events")
    )[0].n;

    say("APPLIED");
    say(`  platform-scope rows   ${before.platformRows} → ${after}`);
    say(`  rows removed          ${del.rowCount}`);
    say(`  timeline events now   ${afterEvents} (includes one 'merged' per group)`);
    say(`  uniqueness index      created (or already present)`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    fail(
      `APPLY FAILED and was rolled back — nothing changed. ${String(
        err && err.message ? err.message : err,
      ).slice(0, 400)}`,
    );
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => {
  process.stderr.write(
    `incident-convergence: FATAL ${String(err && err.message ? err.message : err).slice(0, 400)}\n`,
  );
  process.exit(1);
});
