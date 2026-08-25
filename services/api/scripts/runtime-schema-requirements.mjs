/**
 * WHAT THE RUNNING CODE REQUIRES OF THE DATABASE — declared, and checked
 * against the database it is actually pointed at.
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * A deploy that applies the code before the migrations passes every check the
 * preflight used to run — the URL is local, no migration carries a blocked
 * pattern, the migration files are in sync with the schema — and then serves
 * its first Operations request with:
 *
 *     column "scope" does not exist
 *
 * Every one of those checks was about the REPOSITORY. None of them asked the
 * connected database whether it has the objects the new readers name. So the
 * preflight reported healthy against the previous schema, which is the one
 * answer it must never give.
 *
 * WHY A DECLARATION RATHER THAN A QUERY PER READER
 * ---------------------------------------------------------------------------
 * The requirement is a property of a RELEASE, not of a statement. Listing it
 * once, with the migration that supplies it and the remedy, means the failure
 * message can say what is missing, which migration provides it and what to run
 * — instead of surfacing a driver error that names a column and leaves the
 * operator to work out which migration they skipped.
 *
 * EXPAND-ONLY, AND THAT IS WHY ROLLBACK IS CODE-FIRST
 * ---------------------------------------------------------------------------
 * Every requirement below is an added enum value, an added column or an added
 * index. None is a narrowing. An OLDER process runs unharmed against the
 * EXPANDED schema — it simply never selects the value and never reads the
 * column — so rolling a release back means reverting API/Worker/Web code and
 * LEAVING the schema expanded. Dropping an enum value is not supported by
 * PostgreSQL, and dropping `scope` would destroy the only record of which
 * incidents were classified deliberately. Neither belongs in a rollback.
 */

/**
 * @typedef {{
 *   id: string,
 *   kind: "enum_type" | "enum_value" | "column" | "index",
 *   detail: string,
 *   requiredBy: string,
 *   suppliedBy: string,
 * }} RuntimeSchemaRequirement
 */

/** @type {ReadonlyArray<RuntimeSchemaRequirement>} */
export const RUNTIME_SCHEMA_REQUIREMENTS = Object.freeze([
  {
    id: "governance_reconciliation_kind.workspace_operations",
    kind: "enum_value",
    detail: 'enum "GovernanceReconciliationKind" must contain WORKSPACE_OPERATIONS',
    requiredBy:
      "scheduled Operations discovery claims its run through the shared reconciliation-run authority",
    suppliedBy: "20271222000000_workspace_operations_reconciliation_kind",
  },
  {
    id: "incident_scope.type",
    kind: "enum_type",
    detail: 'enum type "IncidentScope" must exist',
    requiredBy: "operational_incidents.scope is typed by it",
    suppliedBy: "20271223000000_operational_incident_scope",
  },
  {
    id: "operational_incidents.scope",
    kind: "column",
    detail: 'column public."operational_incidents"."scope" must exist',
    requiredBy:
      "tenant incident reads are scope-discriminated; without it a workspace read returns other tenants' orphans or fails outright",
    suppliedBy: "20271223000000_operational_incident_scope",
  },
  {
    id: "operational_incidents_scope_team_status_idx",
    kind: "index",
    detail:
      'index "operational_incidents_scope_team_status_idx" must exist on public."operational_incidents"',
    requiredBy: "the scope-discriminated incident readers scan (scope, team_id, status)",
    suppliedBy: "20271223000000_operational_incident_scope",
  },
]);

/**
 * The catalog probes, one per requirement id.
 *
 * Read-only, `information_schema` / `pg_catalog` only, and parameterless — this
 * runs before a release is trusted, so it must not depend on application
 * tables, and must not be able to write anything.
 */
const PROBES = Object.freeze({
  "governance_reconciliation_kind.workspace_operations": `
    SELECT 1
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname = 'GovernanceReconciliationKind'
       AND e.enumlabel = 'WORKSPACE_OPERATIONS'
     LIMIT 1`,
  "incident_scope.type": `
    SELECT 1 FROM pg_type WHERE typname = 'IncidentScope' LIMIT 1`,
  "operational_incidents.scope": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'scope'
     LIMIT 1`,
  operational_incidents_scope_team_status_idx: `
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'operational_incidents'
       AND indexname = 'operational_incidents_scope_team_status_idx'
     LIMIT 1`,
});

/**
 * Check every requirement against a database.
 *
 * `probe` is injected rather than a client being constructed here, for two
 * reasons: the caller owns the connection lifetime, and the four cases this
 * has to get right — previous schema, fully migrated, half-applied each way —
 * are then provable without a database at all.
 *
 * @param {(sql: string) => Promise<boolean>} probe resolves true when the
 *   object exists. It MAY reject; a rejection is treated as "cannot establish
 *   the schema", which fails closed.
 * @returns {Promise<{ ok: boolean, missing: RuntimeSchemaRequirement[], indeterminate: string[] }>}
 */
export async function checkRuntimeSchemaRequirements(probe) {
  const missing = [];
  const indeterminate = [];
  for (const requirement of RUNTIME_SCHEMA_REQUIREMENTS) {
    const sql = PROBES[requirement.id];
    if (!sql) {
      // A requirement with no probe would pass silently, which is the failure
      // mode this whole module exists to remove.
      indeterminate.push(requirement.id);
      continue;
    }
    let present;
    try {
      present = await probe(sql);
    } catch {
      // FAIL CLOSED. "The check errored" is not "the object is there"; the
      // ERROR ITSELF is deliberately not carried forward — see
      // `describeRuntimeSchemaFailure`.
      indeterminate.push(requirement.id);
      continue;
    }
    if (!present) missing.push(requirement);
  }
  return { ok: missing.length === 0 && indeterminate.length === 0, missing, indeterminate };
}

/**
 * The operator-facing explanation. BOUNDED and ACTIONABLE.
 *
 * It names what is absent, which migration supplies it, and what to run. It
 * never contains a driver message: a raw database error is the wrong thing to
 * put in front of a person deciding whether to roll forward, and it is the
 * wrong thing to leak anywhere a user can see. The caller has the exception if
 * it wants it for a log.
 *
 * @param {{ missing: RuntimeSchemaRequirement[], indeterminate: string[] }} result
 */
export function describeRuntimeSchemaFailure(result) {
  const lines = [];
  if (result.missing.length > 0) {
    lines.push(
      `the database is missing ${result.missing.length} object(s) this release requires:`,
    );
    for (const r of result.missing) {
      lines.push(`  - ${r.detail}`);
      lines.push(`      needed because: ${r.requiredBy}`);
      lines.push(`      supplied by:    ${r.suppliedBy}`);
    }
  }
  if (result.indeterminate.length > 0) {
    lines.push(
      `could not establish ${result.indeterminate.length} requirement(s): ` +
        `${result.indeterminate.join(", ")} — treated as absent`,
    );
  }
  lines.push(
    "apply the migrations in order (20271222000000, commit, then 20271223000000) " +
      "before deploying API and Worker; deploy Web afterward.",
  );
  return lines.join("\n");
}
