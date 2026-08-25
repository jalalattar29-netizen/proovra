/**
 * THE OPERATIONS WRITER SCHEMA CONTRACT.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR
 * ---------------------------------------------------------------------------
 * `recordIncident` opens with a lookup, then creates or updates a row, and
 * both of the latter return the full row. Prisma answers those by naming every
 * scalar column the MODEL declares. So one column the model declares and the
 * database lacks fails the writer before any condition-specific logic runs,
 * identically for every incident category — while every read-only surface in
 * the product keeps working, because none of them touch that table's full
 * width.
 *
 * That combination is what makes the failure so quiet. `/readyz` answered ok.
 * `SELECT 1` answered ok. The canary table existed. Discovery found 34 TSA
 * failures. And the workspace's Operations page reported zero conditions,
 * because every source that tried to RECORD one hit the same absent column and
 * the sweep caught it with a bare `catch {}`.
 *
 * This module makes that state un-servable: an API image whose Prisma model
 * requires a writer column its database does not have must not report ready.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DERIVED AND NOT DECLARED
 * ---------------------------------------------------------------------------
 * `runtime-schema-requirements.mjs` lists individual objects by hand, which is
 * right for a RELEASE requirement — the point there is to name the migration
 * that supplies it and the remedy. A hand-written list is the wrong shape for
 * this question, because the question is not "does the database have these
 * four things" but "does the database satisfy EVERYTHING this image's model
 * asserts about the writer's tables". A hand-maintained list answers that
 * correctly only until the next model change forgets to update it —
 * `src/runtime/schema-validation.ts` has exactly that shape and did not catch
 * this.
 *
 * So the column set is read from the DEPLOYED generated client's own data
 * model. It cannot drift from the model, because it IS the model.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not repair anything, and it must not be mistaken for a repair. A
 * disagreement here means a migration has not been applied to this database;
 * the answer is to apply it, not to teach the writer to work without the
 * column. Narrowing a read to dodge a missing column hides a deployment fault
 * until something less forgiving finds it.
 *
 * It also checks only the WRITER-owned tables. A contract over every model
 * would be a second schema authority competing with `db:raw-schema-verify`,
 * and would fail readiness for a drift in some table no request path touches.
 */

/**
 * The models the incident writer touches, in call order.
 *
 * MANDATORY   `recordIncident` cannot record the observation without it. Its
 *             absence loses a real, observed condition, which is the failure
 *             this contract exists to prevent.
 * BEST_EFFORT the condition is still recorded; bookkeeping is degraded. Still
 *             checked, because "the event history silently stopped being
 *             written" is a fact an operator is entitled to before it matters.
 *
 * Derived from the real call graph in
 * `src/services/observability/incident.service.ts` and
 * `src/services/operations/incident-sla-cycle.service.ts`.
 *
 * @typedef {{ model: string, criticality: "MANDATORY" | "BEST_EFFORT", stage: string }} WriterModel
 * @type {ReadonlyArray<WriterModel>}
 */
export const OPERATIONS_WRITER_MODELS = Object.freeze([
  {
    model: "OperationalIncident",
    criticality: "MANDATORY",
    stage: "LOOKUP / CREATE / UPDATE",
  },
  {
    model: "OperationalIncidentEvent",
    criticality: "BEST_EFFORT",
    stage: "EVENT",
  },
  {
    model: "WorkspaceSlaPolicyVersion",
    criticality: "BEST_EFFORT",
    stage: "SLA",
  },
  {
    model: "OperationalIncidentSlaCycle",
    criticality: "BEST_EFFORT",
    stage: "SLA",
  },
]);

/**
 * The physical columns one model asserts, from a Prisma data model.
 *
 * Relation fields are excluded: they are not columns. The foreign-key scalars
 * behind them ARE columns and are declared as scalars, so they are included by
 * the same rule that includes everything else.
 *
 * @param {{ datamodel?: { models?: Array<any> } }} dmmf
 * @param {string} modelName
 * @returns {{ table: string, columns: string[] } | null}
 */
export function writerModelColumns(dmmf, modelName) {
  const model = dmmf?.datamodel?.models?.find((m) => m.name === modelName);
  if (!model) return null;
  const columns = (model.fields ?? [])
    .filter((f) => f.kind === "scalar" || f.kind === "enum")
    .filter((f) => f.relationName == null)
    .map((f) => f.dbName ?? f.name);
  return { table: model.dbName ?? model.name, columns };
}

/**
 * The whole contract, resolved against a data model.
 *
 * @param {{ datamodel?: { models?: Array<any> } }} dmmf
 * @returns {Array<{ model: string, table: string, columns: string[], criticality: string, stage: string }>}
 */
export function resolveWriterContract(dmmf) {
  const out = [];
  for (const entry of OPERATIONS_WRITER_MODELS) {
    const resolved = writerModelColumns(dmmf, entry.model);
    // A model the client does not declare is not a database problem, and
    // asserting a table name for it would be a guess. Skipped rather than
    // reported as missing — `writerContractModelsPresent` is what notices.
    if (!resolved) continue;
    out.push({
      model: entry.model,
      table: resolved.table,
      columns: resolved.columns,
      criticality: entry.criticality,
      stage: entry.stage,
    });
  }
  return out;
}

/** Which contract models the deployed client actually declares. */
export function writerContractModelsPresent(dmmf) {
  return OPERATIONS_WRITER_MODELS.filter(
    (e) => writerModelColumns(dmmf, e.model) != null,
  ).map((e) => e.model);
}

/**
 * One parameterless, read-only SQL statement per table that returns one row
 * per DECLARED column the database does not have.
 *
 * Parameterless on purpose: the same statement text is used by the release
 * preflight, by `/readyz` and by CI, and a statement that needs bind
 * parameters cannot be handed to a probe that only takes SQL.
 *
 * The column list is inlined as a VALUES list. It is built from the data
 * model — never from user input — and every literal is passed through
 * `quoteLiteral`, which refuses anything that is not a plain identifier, so
 * the statement cannot become anything other than a catalog read.
 *
 * @param {{ table: string, columns: string[] }} entry
 */
export function missingColumnsSql(entry) {
  const values = entry.columns.map((c) => `(${quoteLiteral(c)})`).join(", ");
  return `
    SELECT d.col AS missing_column
      FROM (VALUES ${values}) AS d(col)
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = ${quoteLiteral(entry.table)}
          AND c.column_name = d.col
     )
     ORDER BY d.col`;
}

/**
 * Refuse anything that is not a bare SQL identifier.
 *
 * Prisma column names cannot contain a quote, so this can only ever reject a
 * malformed data model — which is precisely when a silent pass would be worst.
 */
function quoteLiteral(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(
      `operations writer contract: refusing to build SQL for an unexpected identifier`,
    );
  }
  return `'${value}'`;
}

/**
 * THE LEGACY FAMILY — the half of the contract the first version missed.
 *
 * A model field carrying `@map` had, at some earlier point, no `@map`, and a
 * Prisma client without it emits the FIELD NAME as the column name. Where such
 * a generation ever ran against a database, the table now carries BOTH: the
 * canonical mapped column that migrations manage, and a legacy twin named
 * after the field.
 *
 * That is not cosmetic, and "every declared column is present" cannot see it:
 *
 *   * a legacy twin that is NOT NULL with no default cannot be satisfied by an
 *     INSERT naming only the canonical columns, so EVERY write fails 23502 —
 *     measured against a reproduced hybrid, with the real writer, at
 *     `create()`;
 *   * a UNIQUE index built on the legacy pair does not deduplicate writes made
 *     to the canonical pair, so the writer's dedupe contract enforces nothing;
 *   * two columns for one fact drift, and each reader gets whichever half its
 *     own query names.
 *
 * So the expected legacy set is derived the same way the drift was: every
 * field whose `dbName` differs from its `name`.
 */
export function legacyColumnsFor(dmmf, modelName) {
  const model = dmmf?.datamodel?.models?.find((m) => m.name === modelName);
  if (!model) return null;
  const columns = (model.fields ?? [])
    .filter((f) => f.kind === "scalar" || f.kind === "enum")
    .filter((f) => f.relationName == null)
    .filter((f) => f.dbName && f.dbName !== f.name)
    .map((f) => f.name);
  return { table: model.dbName ?? model.name, columns };
}

/**
 * One statement per table returning any LEGACY twin that is physically
 * present. Empty is the healthy answer.
 */
export function legacyColumnsSql(entry) {
  if (entry.columns.length === 0) return null;
  const values = entry.columns.map((c) => `(${quoteLiteral(c)})`).join(", ");
  return `
    SELECT c.column_name AS legacy_column
      FROM information_schema.columns c
      JOIN (VALUES ${values}) AS d(col) ON d.col = c.column_name
     WHERE c.table_schema = 'public'
       AND c.table_name = ${quoteLiteral(entry.table)}
     ORDER BY c.column_name`;
}

/**
 * The DEDUPE BINDING, checked directly.
 *
 * The single most consequential object on this table. `recordIncident`'s whole
 * idempotency story is "the unique on (team_id, fingerprint) collapses a
 * re-observation into an increment". If no such index exists — because the
 * live one is on `("teamId", fingerprint)` — then two concurrent writers
 * create two rows for one condition and nothing says so.
 */
export function canonicalDedupeIndexSql() {
  return `
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
     WHERE t.relname = 'operational_incidents'
       AND i.indisunique
       AND (
         SELECT array_agg(a.attname ORDER BY a.attname)
           FROM unnest(i.indkey) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       ) = ARRAY['fingerprint','team_id']::name[]
     LIMIT 1`;
}

/**
 * Check the contract against a database.
 *
 * `query` is injected rather than a client being constructed here: the caller
 * owns the connection lifetime, and every case this has to get right — fully
 * migrated, one column short, table absent, database unreachable — is then
 * provable without a database at all.
 *
 * FAILS CLOSED. A probe that rejects is reported as `indeterminate`, never as
 * satisfied: "the check errored" is not "the columns are there", and the whole
 * reason this module exists is that something answered ok when it did not know.
 *
 * @param {{ datamodel?: { models?: Array<any> } }} dmmf
 * @param {(sql: string) => Promise<Array<{ missing_column: string }>>} query
 * @returns {Promise<{
 *   ok: boolean,
 *   checkedTables: string[],
 *   missing: Array<{ model: string, table: string, criticality: string, stage: string, columns: string[] }>,
 *   indeterminate: string[],
 * }>}
 */
export async function checkOperationsWriterContract(dmmf, query) {
  const contract = resolveWriterContract(dmmf);
  const missing = [];
  const legacy = [];
  const bindings = [];
  const indeterminate = [];
  const checkedTables = [];
  for (const entry of contract) {
    let rows;
    try {
      rows = await query(missingColumnsSql(entry));
    } catch {
      indeterminate.push(entry.table);
      continue;
    }
    checkedTables.push(entry.table);
    const cols = (Array.isArray(rows) ? rows : [])
      .map((r) => r?.missing_column)
      .filter((c) => typeof c === "string");
    if (cols.length > 0) {
      missing.push({
        model: entry.model,
        table: entry.table,
        criticality: entry.criticality,
        stage: entry.stage,
        columns: cols,
      });
    }

    // The half `missing` cannot see. A present canonical column says nothing
    // about a legacy twin sitting beside it with its own NOT NULL.
    const legacySpec = legacyColumnsFor(dmmf, entry.model);
    const legacySql = legacySpec ? legacyColumnsSql(legacySpec) : null;
    if (legacySql) {
      try {
        const found = await query(legacySql);
        const legacyCols = (Array.isArray(found) ? found : [])
          .map((r) => r?.legacy_column)
          .filter((c) => typeof c === "string");
        if (legacyCols.length > 0) {
          legacy.push({
            model: entry.model,
            table: entry.table,
            criticality: entry.criticality,
            stage: entry.stage,
            columns: legacyCols,
          });
        }
      } catch {
        indeterminate.push(`${entry.table} (legacy scan)`);
      }
    }
  }

  // The dedupe binding, checked once and directly.
  if (checkedTables.includes("operational_incidents")) {
    try {
      const found = await query(canonicalDedupeIndexSql());
      if (!Array.isArray(found) || found.length === 0) {
        bindings.push({
          table: "operational_incidents",
          issue:
            "no UNIQUE index covers (team_id, fingerprint) — the writer's deduplication is not enforced by the database",
        });
      }
    } catch {
      indeterminate.push("operational_incidents (dedupe binding)");
    }
  }

  return {
    ok:
      missing.length === 0 &&
      legacy.length === 0 &&
      bindings.length === 0 &&
      indeterminate.length === 0,
    checkedTables,
    missing,
    legacy,
    bindings,
    indeterminate,
  };
}

/**
 * The operator-facing explanation. BOUNDED and ACTIONABLE.
 *
 * Names the table, the columns, which writer stage they break and what to do.
 * It never carries a driver message: a raw database error is the wrong thing
 * to put in front of somebody deciding whether to roll forward, and the wrong
 * thing to leak anywhere a user can see.
 *
 * @param {{ missing: Array<any>, indeterminate: string[] }} result
 */
export function describeWriterContractFailure(result) {
  const lines = [];
  for (const m of result.missing) {
    lines.push(
      `  - ${m.table} is missing ${m.columns.length} column(s) the deployed model declares: ${m.columns.join(", ")}`,
    );
    lines.push(`      breaks writer stage: ${m.stage} [${m.criticality}]`);
  }
  for (const l of result.legacy ?? []) {
    lines.push(
      `  - ${l.table} carries ${l.columns.length} LEGACY duplicate column(s): ${l.columns.join(", ")}`,
    );
    lines.push(
      `      these are earlier, un-mapped generations of fields the model now maps.`,
    );
    lines.push(
      `      A legacy twin that is NOT NULL with no default makes EVERY insert fail 23502,`,
    );
    lines.push(`      and any index built on one enforces nothing about the canonical column.`);
  }
  for (const b of result.bindings ?? []) {
    lines.push(`  - ${b.table}: ${b.issue}`);
  }
  for (const t of result.indeterminate) {
    lines.push(`  - ${t}: contract could not be established — treated as unsatisfied`);
  }
  if (lines.length > 0) {
    lines.push(
      "the incident writer cannot be trusted on EVERY category until the database and the",
    );
    lines.push(
      "deployed model agree. Apply the outstanding convergence migration before serving",
    );
    lines.push("traffic; do not narrow the writer's reads or writes to work around it.");
  }
  return lines.join("\n");
}

/**
 * Resolve the deployed data model.
 *
 * Separated so callers that already hold a client can pass their own, and so
 * the pure functions above stay testable without importing Prisma at all.
 */
export async function loadDeployedDatamodel() {
  const { Prisma } = await import("@prisma/client");
  return Prisma.dmmf;
}
