/**
 * THE PREFLIGHT MUST NOT REPORT HEALTHY AGAINST THE PREVIOUS SCHEMA.
 *
 * The deploy this pins: code ships before its migrations, the preflight passes
 * — the URL is local, no migration carries a blocked pattern, the migration
 * files match the schema — and the first Operations request answers
 * `column "scope" does not exist`. Every check that passed was about the
 * REPOSITORY. None asked the database.
 *
 * The four cases below are the four states a rollout can actually be in, and
 * the two half-applied ones matter most: the release needs an enum value from
 * one migration AND a column from another, so a database can satisfy either
 * half and still be unable to serve a request. A check that looked for one
 * object would call both of those healthy.
 *
 * They run against an INJECTED probe rather than a live catalog. That is not a
 * shortcut — a live database can be in exactly one state per run, so proving
 * the half-applied cases against one would mean mutating a real schema into a
 * shape no migration produces. The probe is the seam the module already
 * exposes, and the SQL it hands back is asserted separately to be read-only.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(HERE, "../scripts/runtime-schema-requirements.mjs");

type Requirement = {
  id: string;
  kind: string;
  detail: string;
  requiredBy: string;
  suppliedBy: string;
};
type CheckResult = {
  ok: boolean;
  missing: Requirement[];
  indeterminate: string[];
};
type Mod = {
  RUNTIME_SCHEMA_REQUIREMENTS: ReadonlyArray<Requirement>;
  checkRuntimeSchemaRequirements: (
    probe: (sql: string) => Promise<boolean>,
  ) => Promise<CheckResult>;
  describeRuntimeSchemaFailure: (r: {
    missing: Requirement[];
    indeterminate: string[];
  }) => string;
};

const load = (): Promise<Mod> => import(`file://${MODULE_PATH}`) as Promise<Mod>;

/**
 * A database in a given state, expressed as the objects it HAS.
 *
 * Matching on the probe SQL rather than on a requirement id is deliberate: it
 * exercises the real probe strings, so a probe that looks for the wrong object
 * fails here instead of passing against a fixture keyed to its own name.
 */
function databaseWith(present: {
  reconciliationEnumValue?: boolean;
  incidentScopeType?: boolean;
  scopeColumn?: boolean;
  scopeIndex?: boolean;
}) {
  return async (sql: string): Promise<boolean> => {
    if (sql.includes("WORKSPACE_OPERATIONS")) return present.reconciliationEnumValue === true;
    if (sql.includes("typname = 'IncidentScope'")) return present.incidentScopeType === true;
    if (sql.includes("column_name = 'scope'")) return present.scopeColumn === true;
    if (sql.includes("operational_incidents_scope_team_status_idx")) {
      return present.scopeIndex === true;
    }
    throw new Error(`unrecognised probe:\n${sql}`);
  };
}

const FULLY_MIGRATED = {
  reconciliationEnumValue: true,
  incidentScopeType: true,
  scopeColumn: true,
  scopeIndex: true,
};

describe("runtime schema requirements", () => {
  it("the PREVIOUS schema is REFUSED, with a bounded actionable reason", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith({}));

    expect(result.ok, "a pre-migration database must not be reported healthy").toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);

    const reason = describeRuntimeSchemaFailure(result);
    // ACTIONABLE: names the object, the reason and the migration that supplies it.
    expect(reason).toContain('column public."operational_incidents"."scope" must exist');
    expect(reason).toContain("20271223000000_operational_incident_scope");
    expect(reason).toContain("20271222000000_workspace_operations_reconciliation_kind");
    // …and states the ORDER, because applying them the other way round is the
    // mistake the message exists to prevent.
    expect(reason).toContain("20271222000000, commit, then 20271223000000");
    // BOUNDED: an operator has to be able to read it.
    expect(reason.split("\n").length).toBeLessThan(30);
  });

  it("the FULLY MIGRATED schema is accepted", async () => {
    const { checkRuntimeSchemaRequirements } = await load();
    const result = await checkRuntimeSchemaRequirements(databaseWith(FULLY_MIGRATED));
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.indeterminate).toEqual([]);
  });

  it("enum present but the scope COLUMN absent is REFUSED", async () => {
    // 20271222000000 applied, 20271223000000 not. The reconciliation sweep
    // would claim its run and the incident readers would then fail on a column
    // that is not there.
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ reconciliationEnumValue: true }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toContain("operational_incidents.scope");
    expect(describeRuntimeSchemaFailure(result)).toContain(
      "20271223000000_operational_incident_scope",
    );
  });

  it("the scope column present but the required ENUM VALUE absent is REFUSED", async () => {
    // The mirror image: 20271223000000 applied, 20271222000000 not. Nothing
    // about the incident readers is wrong; scheduled Operations discovery
    // cannot claim its run.
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const result = await checkRuntimeSchemaRequirements(
      databaseWith({ incidentScopeType: true, scopeColumn: true, scopeIndex: true }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.id)).toEqual([
      "governance_reconciliation_kind.workspace_operations",
    ]);
    expect(describeRuntimeSchemaFailure(result)).toContain(
      "20271222000000_workspace_operations_reconciliation_kind",
    );
  });

  it("a probe that THROWS fails closed and never surfaces the raw error", async () => {
    const { checkRuntimeSchemaRequirements, describeRuntimeSchemaFailure } = await load();
    const secret =
      'password authentication failed for user "proovra" at 10.0.0.7:5432';
    const result = await checkRuntimeSchemaRequirements(async () => {
      throw new Error(secret);
    });

    expect(result.ok, "an unreadable catalog is not a healthy one").toBe(false);
    expect(result.indeterminate.length).toBe(4);

    const reason = describeRuntimeSchemaFailure(result);
    expect(reason).toContain("treated as absent");
    // The driver's words are the operator's problem to find in a log, never
    // something this function hands onward.
    expect(reason).not.toContain(secret);
    expect(reason).not.toContain("password");
    expect(reason).not.toContain("10.0.0.7");
  });

  it("every requirement has a probe — a silent pass is the failure mode", async () => {
    const { RUNTIME_SCHEMA_REQUIREMENTS, checkRuntimeSchemaRequirements } = await load();
    const seen: string[] = [];
    await checkRuntimeSchemaRequirements(async (sql) => {
      seen.push(sql);
      return true;
    });
    expect(seen.length).toBe(RUNTIME_SCHEMA_REQUIREMENTS.length);
  });

  it("the probes are read-only catalog reads", async () => {
    // This runs against a production database during a release. It must not be
    // able to write, and must not depend on an application table that a
    // half-migrated database might not have.
    const source = readFileSync(MODULE_PATH, "utf8");
    const probes = source.slice(source.indexOf("const PROBES"), source.indexOf("export async function"));
    for (const banned of ["INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "DROP"]) {
      expect(probes.toUpperCase(), `a probe must not ${banned}`).not.toContain(` ${banned} `);
    }
    for (const catalog of ["pg_type", "pg_enum", "information_schema.columns", "pg_indexes"]) {
      expect(probes).toContain(catalog);
    }
  });
});

describe("the preflight consumes the declaration", () => {
  const preflight = readFileSync(resolve(HERE, "../scripts/db-preflight.mjs"), "utf8");

  it("db:preflight runs the runtime schema check", () => {
    expect(preflight).toContain("runtime-schema-requirements.mjs");
    expect(preflight).toContain("checkRuntimeSchemaRequirements");
  });

  it("a skip is recorded as WARN, never as PASS", () => {
    // "We did not look" must not read like "it is there".
    const block = preflight.slice(preflight.indexOf("Check 4"));
    const skip = block.slice(block.indexOf("skipDrift || !databaseUrl"), block.indexOf("} else {"));
    expect(skip).toContain('status: "WARN"');
    expect(skip).not.toContain('status: "PASS"');
  });

  it("an unreadable catalog is a FAIL, not a skip", () => {
    const block = preflight.slice(preflight.indexOf("Check 4"));
    const rescue = block.slice(block.indexOf("} catch {"), block.indexOf("} finally {"));
    expect(rescue).toContain('status: "FAIL"');
    expect(rescue).toContain("treated as absent");
  });
});
