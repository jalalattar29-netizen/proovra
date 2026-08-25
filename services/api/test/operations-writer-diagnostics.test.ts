/**
 * THE FAILURE-DIAGNOSTICS AND WRITER-CONTRACT AUTHORITIES.
 *
 * These are the two pieces that make the Operations writer's failures visible
 * instead of silent, and they are unit-tested here — without a database —
 * because both are PURE decisions about classification and neither should need
 * PostgreSQL to be provable.
 *
 * `operations-production-signature.integration.test.ts` proves they behave
 * correctly against a live database and a real drift. This file proves the
 * decisions themselves: which category a given error is, whether that category
 * is retryable, whose stage wins when two claim one, and that a run whose
 * failed sources carry no reasons is detectable as a defect.
 */

import { describe, expect, it } from "vitest";

import {
  emptySourceAccounting,
  isRetryableOperationsFailure,
  sourceFailuresWithoutReason,
} from "@proovra/shared-runtime";

import {
  inSourceStage,
  operationsFailureCategory,
  taggedSourceStage,
  toSourceFailure,
} from "../src/services/operations/operations-source-diagnostics.js";

import {
  OPERATIONS_WRITER_MODELS,
  checkOperationsWriterContract,
  describeWriterContractFailure,
  missingColumnsSql,
  resolveWriterContract,
  writerModelColumns,
} from "../scripts/operations-writer-schema-contract.mjs";

/** A Prisma-shaped error, as the client actually produces it. */
function prismaError(code: string, message: string, meta?: Record<string, unknown>) {
  const err = new Error(message) as Error & {
    code?: string;
    meta?: Record<string, unknown>;
  };
  err.name = "PrismaClientKnownRequestError";
  err.code = code;
  if (meta) err.meta = meta;
  return err;
}

describe("Operations failure classification", () => {
  it("classifies a missing column STRUCTURALLY, from P2022 rather than from the message", () => {
    // This is the exact message Prisma produces for a model/database column
    // disagreement. Note what it does NOT contain: the column's name. Reading
    // the category out of the text would work by luck of phrasing and stop
    // working the moment Prisma reworded it, which is why the code wins.
    const err = prismaError(
      "P2022",
      "The column `(not available)` does not exist in the current database.",
      { modelName: "OperationalIncident" },
    );
    expect(operationsFailureCategory(err)).toBe("schema_mismatch");
  });

  it("classifies a missing table, a bad enum value and a pool timeout", () => {
    expect(operationsFailureCategory(prismaError("P2021", "table missing"))).toBe(
      "schema_mismatch",
    );
    expect(
      operationsFailureCategory(prismaError("P2023", "inconsistent column data")),
    ).toBe("schema_mismatch");
    expect(operationsFailureCategory(prismaError("P2024", "pool"))).toBe("timeout");
  });

  it("reads a raw-query SQLSTATE out of the message Prisma embeds it in", () => {
    // Prisma does not surface the SQLSTATE as a field for raw queries. It is
    // in the message, and it is the single most diagnostic fact available.
    const undefinedColumn = prismaError(
      "P2010",
      "Raw query failed. Code: `42703`. Message: `column x does not exist`",
    );
    expect(operationsFailureCategory(undefinedColumn)).toBe("schema_mismatch");

    const insufficientPrivilege = prismaError(
      "P2010",
      "Raw query failed. Code: `42501`. Message: `permission denied`",
    );
    expect(operationsFailureCategory(insufficientPrivilege)).toBe("permission_denied");

    const statementTimeout = prismaError(
      "P2010",
      "Raw query failed. Code: `57014`. Message: `canceling statement`",
    );
    expect(operationsFailureCategory(statementTimeout)).toBe("timeout");
  });

  it("falls back to the shared message classifier for anything unstructured", () => {
    expect(operationsFailureCategory(new Error("connect ETIMEDOUT"))).toBe("timeout");
    expect(operationsFailureCategory(new Error("ECONNREFUSED"))).toBe(
      "database_unavailable",
    );
    expect(operationsFailureCategory(new Error("something odd"))).toBe(
      "unexpected_error",
    );
  });

  it("marks a deployment disagreement NON-retryable and a transient retryable", () => {
    // The rule the browser branches on. A schema mismatch fails identically
    // every time until something is deployed; offering "Check again" for one
    // is an instruction to waste an operator's time during an incident.
    expect(isRetryableOperationsFailure("schema_mismatch")).toBe(false);
    expect(isRetryableOperationsFailure("permission_denied")).toBe(false);
    expect(isRetryableOperationsFailure("timeout")).toBe(true);
    expect(isRetryableOperationsFailure("database_unavailable")).toBe(true);
    expect(isRetryableOperationsFailure("unexpected_error")).toBe(true);
  });
});

describe("Which stage failed", () => {
  it("a pass that knows its own stage beats the caller's fallback", async () => {
    const err = await inSourceStage("WRITE", async () => {
      throw prismaError("P2022", "column gone");
    }).catch((e) => e);

    expect(taggedSourceStage(err)).toBe("WRITE");
    // The caller says SCAN because from out there it cannot tell. The tag
    // wins, because the pass's own view is knowledge and the caller's is a
    // guess — and the two describe very different workspace states.
    expect(toSourceFailure("evidence_integrity.tsa_failed", "SCAN", err).stage).toBe(
      "WRITE",
    );
  });

  it("the OUTERMOST stage does not overwrite an inner one", async () => {
    const err = await inSourceStage("SCAN", async () =>
      inSourceStage("WRITE", async () => {
        throw new Error("inner");
      }),
    ).catch((e) => e);
    expect(taggedSourceStage(err)).toBe("WRITE");
  });

  it("an untagged error uses the caller's fallback and never invents a stage", () => {
    const failure = toSourceFailure("pipeline.report_backlog", "SCAN", new Error("x"));
    expect(failure.stage).toBe("SCAN");
    expect(taggedSourceStage(new Error("x"))).toBeNull();
  });

  it("the tag is non-enumerable, so it cannot be serialised out to a client", async () => {
    const err = await inSourceStage("WRITE", async () => {
      throw new Error("boom");
    }).catch((e) => e);
    expect(Object.keys(err)).not.toContain("stage");
    expect(JSON.stringify({ ...err })).not.toContain("WRITE");
  });

  it("passes the value through untouched when nothing throws", async () => {
    await expect(inSourceStage("SCAN", async () => 42)).resolves.toBe(42);
  });
});

describe("Every failed source must say why", () => {
  it("names the failed ids that carry no reason", () => {
    // This is the exact production state — six ids and no cause — expressed
    // as a detectable defect rather than as something only a human notices.
    const accounting = {
      ...emptySourceAccounting(),
      failedSources: ["a", "b", "c"],
      sourceFailures: [
        { sourceId: "a", stage: "WRITE" as const, category: "schema_mismatch", retryable: false },
      ],
    };
    expect(sourceFailuresWithoutReason(accounting)).toEqual(["b", "c"]);
  });

  it("is empty when nothing failed, and when everything that failed is explained", () => {
    expect(sourceFailuresWithoutReason(emptySourceAccounting())).toEqual([]);
    expect(
      sourceFailuresWithoutReason({
        failedSources: ["a"],
        sourceFailures: [
          { sourceId: "a", stage: "SCAN", category: "timeout", retryable: true },
        ],
      }),
    ).toEqual([]);
  });

  it("a fresh accounting carries the reasons array rather than omitting it", () => {
    // Omitting it would make "no failures" and "reasons not recorded"
    // indistinguishable at the type level, which is the ambiguity this whole
    // field exists to remove.
    expect(emptySourceAccounting().sourceFailures).toEqual([]);
  });
});

describe("The Operations writer schema contract", () => {
  /** A minimal data model, in the shape Prisma's runtime DMMF uses. */
  const dmmf = {
    datamodel: {
      models: [
        {
          name: "OperationalIncident",
          dbName: "operational_incidents",
          fields: [
            { name: "id", kind: "scalar" },
            { name: "teamId", kind: "scalar", dbName: "team_id" },
            { name: "scope", kind: "enum" },
            { name: "runbookSlug", kind: "scalar", dbName: "runbook_slug" },
            // A relation is not a column and must not be demanded of one.
            { name: "team", kind: "object", relationName: "TeamToIncident" },
          ],
        },
        {
          name: "OperationalIncidentEvent",
          dbName: "operational_incident_events",
          fields: [{ name: "id", kind: "scalar" }],
        },
      ],
    },
  };

  it("derives the column set from the model, mapping @map names and dropping relations", () => {
    expect(writerModelColumns(dmmf, "OperationalIncident")).toEqual({
      table: "operational_incidents",
      columns: ["id", "team_id", "scope", "runbook_slug"],
    });
    expect(writerModelColumns(dmmf, "NoSuchModel")).toBeNull();
  });

  it("covers the writer's real call graph and marks the mandatory table as such", () => {
    const mandatory = OPERATIONS_WRITER_MODELS.filter(
      (m) => m.criticality === "MANDATORY",
    );
    // Exactly one table can lose the OBSERVATION itself; the rest degrade
    // bookkeeping. Conflating the two would make a missing event-history
    // column look as urgent as a missing incident column, or the reverse.
    expect(mandatory.map((m) => m.model)).toEqual(["OperationalIncident"]);
    expect(OPERATIONS_WRITER_MODELS.map((m) => m.model)).toContain(
      "OperationalIncidentSlaCycle",
    );
  });

  it("builds a parameterless catalog read, and refuses a malformed identifier", () => {
    const sql = missingColumnsSql({
      table: "operational_incidents",
      columns: ["id", "runbook_slug"],
    });
    expect(sql).toContain("information_schema.columns");
    expect(sql).toContain("'runbook_slug'");
    expect(sql).not.toContain("$1");

    // A quote in an identifier cannot come from a Prisma model, so reaching
    // this branch means the data model is malformed — exactly when silently
    // building SQL anyway would be worst.
    expect(() =>
      missingColumnsSql({ table: "t", columns: ["oops'; DROP TABLE x --"] }),
    ).toThrow(/unexpected identifier/);
  });

  it("passes a database that satisfies the model", async () => {
    const result = await checkOperationsWriterContract(dmmf, async () => []);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.checkedTables).toEqual([
      "operational_incidents",
      "operational_incident_events",
    ]);
  });

  it("names the missing columns and the stage they break", async () => {
    const result = await checkOperationsWriterContract(dmmf, async (sql) =>
      sql.includes("operational_incidents'")
        ? [{ missing_column: "runbook_slug" }]
        : [],
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({
      table: "operational_incidents",
      columns: ["runbook_slug"],
      criticality: "MANDATORY",
    });

    const described = describeWriterContractFailure(result);
    expect(described).toContain("runbook_slug");
    expect(described).toContain("LOOKUP / CREATE / UPDATE");
    // Actionable, and carrying nothing a driver said.
    expect(described).toContain("Apply the outstanding migrations");
    expect(described).not.toContain("SELECT");
  });

  it("FAILS CLOSED when the catalog cannot be read", async () => {
    // "The check errored" is not "the columns are there". Treating a failed
    // probe as a pass is the precise equivalence that let an image report
    // ready while it could not record a single operational condition.
    const result = await checkOperationsWriterContract(dmmf, async () => {
      throw new Error("connection lost");
    });
    expect(result.ok).toBe(false);
    expect(result.indeterminate).toEqual([
      "operational_incidents",
      "operational_incident_events",
    ]);
    expect(describeWriterContractFailure(result)).toContain("treated as unsatisfied");
  });

  it("skips a model the deployed client does not declare rather than guessing its table", () => {
    // A contract entry with no model in the client is a code question, not a
    // database one, and asserting a physical table name for it would be an
    // invention this module has no basis for.
    expect(resolveWriterContract({ datamodel: { models: [] } })).toEqual([]);
  });
});
