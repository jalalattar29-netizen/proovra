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
 *   kind: "enum_type" | "enum_value" | "column" | "index" | "table",
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
  {
    id: "operational_incidents.metric_snapshot",
    kind: "column",
    detail: 'column public."operational_incidents"."metric_snapshot" must exist',
    requiredBy:
      "aggregate conditions carry their CURRENT value here, refreshed on every observation. The writer selects it to compute previousValue and delta, and the queue reads it; without the column the number returns to the title, where recordIncident never rewrote it and a backlog of 26 stayed 26 for the life of the condition",
    suppliedBy: "20271225000000_operational_incident_metric_snapshot",
  },
  {
    id: "teams.closed_at_utc",
    kind: "column",
    detail: 'column public."teams"."closed_at_utc" must exist',
    requiredBy:
      "THE workspace-liveness authority. Every Platform Admin population query filters on it through liveWorkspaceWhere()/workspaceLifecycleWhere(), executeWorkspaceClosure writes it inside the closure transaction and reopenClosedWorkspace clears it. Without the column the console cannot distinguish a closed workspace from a live one — the exact defect the column exists to remove — and every one of those readers fails on the first request rather than degrading",
    suppliedBy: "20271230000000_workspace_lifecycle_authority",
  },
  /**
   * WORKSPACE INVITATION LIFECYCLE (Release A, `20280501000000`).
   *
   * These were the columns this module exists for and did not cover. The
   * release shipped code that names them and no declaration that the database
   * must have them, so `db:preflight` reported healthy against the previous
   * schema — the one answer the header above says it must never give — and the
   * absence surfaced instead as
   *
   *     Invalid `prisma.teamInvite.findMany()` invocation
   *     The column `(not available)` does not exist in the current database
   *
   * inside a live request, with a Sentry transaction label that pointed at a
   * neighbouring route because the client issues four workspace reads at once.
   * A driver error naming no column is exactly the diagnosis this file replaces
   * with "apply 20280501000000".
   *
   * Both are declared because they fail differently and both are load-bearing:
   * `token_hash` is the sole lookup authority for accepting an invitation, and
   * `revoked_at` is named in the WHERE of every pending-invitation reader, so
   * without it the seat allowance, the collaboration entitlement projection and
   * the workspace invitation list all fail rather than degrade.
   */
  {
    id: "team_invites.token_hash",
    kind: "column",
    detail: 'column public."team_invites"."token_hash" must exist',
    requiredBy:
      "THE invitation lookup authority. acceptWorkspaceInvitation resolves a link by hashing the raw token and matching this column, and createWorkspaceInvitation/resendWorkspaceInvitation are the only writers of it. Without the column no workspace invitation can be issued or accepted at all",
    suppliedBy: "20280501000000_workspace_invite_lifecycle_hardening",
  },
  {
    id: "team_invites.revoked_at",
    kind: "column",
    detail: 'column public."team_invites"."revoked_at" must exist',
    requiredBy:
      "revocation is a STATE, not a deletion. Every pending-invitation reader filters on it — the workspace invitation list, resolveWorkspaceInvitationAllowance (the seat gate) and the collaboration entitlement projection — so its absence fails those reads outright instead of degrading, and a revoked invitation would otherwise be indistinguishable from a live one",
    suppliedBy: "20280501000000_workspace_invite_lifecycle_hardening",
  },

  /**
   * ==========================================================================
   * P3-9 (2026-09-10) — THE TWO TABLES THE OUTPUT EXPERIENCE NOW RESTS ON.
   * ==========================================================================
   * Both predate this file and neither was declared, and the reason they were
   * missed is the reason they are the most dangerous omission in it: every
   * READER of them degrades gracefully.
   *
   * `reportGenerationRequest` is read through `.catch(() => null)` on the
   * artifact-status projection, an async IIFE with a try/catch in the Reports
   * aggregator, `.catch(() => [])` in the user-scoped fallback and a try/catch
   * in the billing projection — because a missing row is a normal state and
   * those surfaces must render without one. So if the TABLE were absent, no
   * request would fail: every record would simply project `NOT_REQUESTED`,
   * every Generate click would return `REQUEST_PERSIST_FAILED`, and the
   * preflight would report the release healthy. A silent, product-wide output
   * outage with a green deploy — which is precisely the answer the header above
   * says this file must never give.
   *
   * The UNIQUE indexes are declared alongside the tables rather than assumed,
   * because in both cases the uniqueness IS the correctness property:
   *
   *   report_generation_requests.idempotency_key
   *       the version-anchored key is what collapses two concurrent completion
   *       fan-outs into one request and lets the DB elect a single winner of a
   *       supersession race. Without the index both callers succeed and two
   *       runnable requests race for one artifact version.
   *
   *   evidence_credit_ledger_entries.evidence_id
   *       the serialization point for credit spend. Without it a retried
   *       completion can burn a second credit for one record — a customer
   *       charged twice — and `resolveEvidenceFunding` can no longer answer
   *       "how was this record funded" with one row.
   */
  {
    id: "report_generation_requests.table",
    kind: "table",
    detail: 'table public."report_generation_requests" must exist',
    requiredBy:
      "THE durable generation-intent authority. It is the only real execution state the platform has for report and verification-package generation: createReportGenerationRequest is its one writer, the worker claims and settles rows in it, and the artifact-status projection, the Reports aggregator, the user-scoped Reports fallback and the Billing eligibility count all read it. Every one of those readers degrades on error rather than failing, so an absent table does not surface as an error — it silently reports every record as never-requested and refuses every Generate click, with a green preflight",
    suppliedBy: "20271113000000_point5_report_generation_authority",
  },
  {
    id: "report_generation_requests.idempotency_key_unique",
    kind: "index",
    detail:
      'a UNIQUE index on public."report_generation_requests"("idempotency_key") must exist',
    requiredBy:
      "the version-anchored idempotency key is what makes duplicate generation intent collapse instead of racing. Two concurrent completion fan-outs for one record compute the same key and the unique violation elects one winner; the loser reuses the winner's row. Without the index both inserts succeed, two runnable requests exist for one baseline artifact version, and the supersession chain can advance twice",
    suppliedBy: "20271113000000_point5_report_generation_authority",
  },
  {
    id: "evidence_credit_ledger_entries.table",
    kind: "table",
    detail: 'table public."evidence_credit_ledger_entries" must exist',
    requiredBy:
      "THE evidence-credit authority. It records purchases, admin grants and per-record consumption, and it answers two questions nothing else can: how a record's completion was funded (resolveEvidenceFunding — which decides whether a FREE account's record earns a report and verification package) and whether an account is genuinely an evidence-credit customer (hasSettledEvidenceCreditGrant — which decides storage-add-on eligibility). Its absence silently downgrades every credit-funded record to plan-only entitlement",
    suppliedBy: "20271227000000_billing_commercial_correctness",
  },
  {
    id: "evidence_credit_ledger_entries.evidence_id_unique",
    kind: "index",
    detail:
      'a UNIQUE index on public."evidence_credit_ledger_entries"("evidence_id") must exist',
    requiredBy:
      "the serialization point for credit spend. consumeEvidenceCreditForCompletion decrements the wallet conditionally and then INSERTs this row inside the completion transaction; the unique violation is what rolls a concurrent second spend back. Without the index a retried or re-delivered completion can burn a second credit for one evidence record — a customer charged twice for one capture",
    suppliedBy: "20271227000000_billing_commercial_correctness",
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
  "teams.closed_at_utc": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'teams'
       AND column_name = 'closed_at_utc'
     LIMIT 1`,
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
  "operational_incidents.metric_snapshot": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operational_incidents'
       AND column_name = 'metric_snapshot'
     LIMIT 1`,
  "team_invites.token_hash": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'team_invites'
       AND column_name = 'token_hash'
     LIMIT 1`,
  "team_invites.revoked_at": `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'team_invites'
       AND column_name = 'revoked_at'
     LIMIT 1`,

  // P3-9 — the two output/commercial tables and the two uniqueness properties
  // that make them correct. Read-only, information_schema / pg_catalog only.
  "report_generation_requests.table": `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'report_generation_requests'
     LIMIT 1`,
  /*
   * Asserted through pg_index rather than by index NAME.
   *
   * Prisma's `@unique` generates `report_generation_requests_idempotency_key_key`,
   * but the property this release depends on is the UNIQUENESS, not the name a
   * generator chose — and a hand-written migration or a rename would satisfy
   * the requirement while failing a name match. The predicate asks the
   * question the code actually relies on: is there a unique index whose single
   * column is `idempotency_key`.
   */
  "report_generation_requests.idempotency_key_unique": `
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = t.oid
       AND a.attnum = i.indkey[0]
     WHERE n.nspname = 'public'
       AND t.relname = 'report_generation_requests'
       AND i.indisunique
       AND i.indnatts = 1
       AND a.attname = 'idempotency_key'
     LIMIT 1`,
  "evidence_credit_ledger_entries.table": `
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'evidence_credit_ledger_entries'
     LIMIT 1`,
  "evidence_credit_ledger_entries.evidence_id_unique": `
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = t.oid
       AND a.attnum = i.indkey[0]
     WHERE n.nspname = 'public'
       AND t.relname = 'evidence_credit_ledger_entries'
       AND i.indisunique
       AND i.indnatts = 1
       AND a.attname = 'evidence_id'
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
