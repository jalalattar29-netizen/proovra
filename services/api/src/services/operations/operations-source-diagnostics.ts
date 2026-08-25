/**
 * WHY A FAILED OPERATIONS SOURCE SAYS WHY.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES
 * ---------------------------------------------------------------------------
 * The discovery sweep caught every source's exception with a bare `catch {}`.
 * Not `catch (err)` — the error object was not bound at all, so the cause was
 * destroyed at the instant it occurred. A production workspace reported six
 * failed sources and `safeFailureCategory: null`, and there was no log line,
 * no run-row field and no response field from which the reason could be
 * recovered. Diagnosing it required writing a separate read-only script and
 * running it against the production database by hand.
 *
 * "Something is wrong and I will not say what" is not a safe default. It is a
 * report that costs an outage the time it takes to rediscover the cause from
 * outside the system.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS, AND WHAT IT IS CAREFUL NOT TO BE
 * ---------------------------------------------------------------------------
 * It converts one thrown value into two different things with two different
 * audiences, and the separation is the whole design:
 *
 *   * `toSourceFailure` — the BOUNDED record. A source id, a stage, a coarse
 *     category from the shared vocabulary, and whether a retry could help.
 *     This is persisted on the run row and projected to the browser, so it
 *     carries no message, no stack, no SQL, no column name, no identifier and
 *     no record content. It cannot: every field is drawn from a closed set.
 *
 *   * `reportSourceFailure` — the OPERATOR-SIDE detail. Prisma code, PG
 *     SQLSTATE, model name, stage, retryability and the request/trace ids,
 *     to server logs and Sentry. This is what makes the next incident
 *     diagnosable from a dashboard instead of from a hand-written script.
 *
 * Nothing here decides whether a source failed. That is the sweep's job. This
 * only decides how a failure is DESCRIBED, in one place, so the description
 * cannot drift between sources.
 */

import {
  isRetryableOperationsFailure,
  safeOperationsFailureCategory,
  type OperationsSourceFailure,
  type OperationsSourceStage,
} from "@proovra/shared-runtime";

import { captureException } from "../../observability/sentry.js";
import { error as logError } from "../../utils/logger.js";

/** Correlation the sweep can pass through when it has it. */
export type SourceFailureContext = {
  workspaceId: string;
  requestId?: string | null;
  traceId?: string | null;
};

/**
 * Prisma reports its own error class code (`P####`) on `.code`, and reports
 * the PostgreSQL SQLSTATE only inside the message for raw queries or inside
 * `meta` for some model queries. Both are extracted, because they answer
 * different questions: `P2022` says "a column the model declares is not in the
 * database", `25006`/`42501` say something about the session or the role.
 */
function prismaErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && /^P\d{4}$/.test(code) ? code : null;
}

function postgresSqlState(err: unknown): string | null {
  const direct = (err as { code?: unknown })?.code;
  if (typeof direct === "string" && /^[0-9A-Za-z]{5}$/.test(direct) && !/^P\d{4}$/.test(direct)) {
    return direct;
  }
  const meta = (err as { meta?: Record<string, unknown> })?.meta;
  const hay = `${(err as { message?: unknown })?.message ?? ""} ${
    meta ? JSON.stringify(meta) : ""
  }`;
  const m =
    hay.match(/Code:\s*`([0-9A-Za-z]{5})`/) ??
    hay.match(/\bSQLSTATE[:\s(]*([0-9A-Za-z]{5})/i);
  return m ? m[1] : null;
}

/**
 * `safeOperationsFailureCategory` classifies by message text, which is right
 * for the general case and blind to the one that actually happened: Prisma
 * reports a model/database column disagreement as
 * "The column `(not available)` does not exist in the current database" — a
 * sentence that contains the word "column" only by luck of phrasing, and would
 * classify differently the moment Prisma reworded it.
 *
 * `P2022` states the same fact structurally, so it is trusted over the text.
 * The other codes here are the ones whose category the message cannot be
 * relied on to carry.
 */
const PRISMA_CODE_CATEGORIES: Readonly<Record<string, string>> = {
  /** The column does not exist in the current database. */
  P2022: "schema_mismatch",
  /** The table does not exist in the current database. */
  P2021: "schema_mismatch",
  /** Inconsistent column data — includes enum values the database lacks. */
  P2023: "schema_mismatch",
  /**
   * NULL CONSTRAINT VIOLATION — and it is a SCHEMA fact, not an app bug.
   *
   * Prisma validates the required fields of its OWN model client-side and
   * refuses to send the query at all, so a null-constraint violation that
   * actually reaches PostgreSQL is necessarily on a column the model does not
   * declare. That is exactly what a legacy duplicate column does: the model
   * writes `safe_summary`, the database also carries a `"safeSummary"` NOT
   * NULL with no default from an earlier un-`@map`'d generation of the same
   * field, and the INSERT cannot satisfy it.
   *
   * Measured, not reasoned about: against a reproduced production-hybrid
   * schema the real `recordIncident` fails P2011 / 23502 with
   * `null value in column "safeSummary" ... violates not-null constraint`,
   * on the CREATE, with the lookup having succeeded. Classifying it as a
   * constraint violation would mark it retryable, and no number of retries
   * can make an undeclared NOT NULL column satisfiable.
   */
  P2011: "schema_mismatch",
  /** Timed out fetching a connection from the pool. */
  P2024: "timeout",
  /** Unique constraint failed. */
  P2002: "constraint_violation",
  /** Foreign key constraint failed. */
  P2003: "constraint_violation",
  /** Could not connect to the database server. */
  P1001: "database_unavailable",
  /** Authentication against the database failed. */
  P1000: "permission_denied",
};

/**
 * The bounded category, from the structural code where one exists and from the
 * shared message classifier otherwise.
 */
export function operationsFailureCategory(err: unknown): string {
  const code = prismaErrorCode(err);
  if (code && PRISMA_CODE_CATEGORIES[code]) return PRISMA_CODE_CATEGORIES[code];
  // A raw-query failure carries the SQLSTATE and not much else.
  const sqlState = postgresSqlState(err);
  if (
    sqlState === "42703" || // undefined_column
    sqlState === "42P01" || // undefined_table
    sqlState === "42704" || // undefined_object (enum value, type)
    sqlState === "23502" //   not_null_violation on an undeclared column
  ) {
    return "schema_mismatch";
  }
  if (sqlState === "42501" || sqlState === "25006") return "permission_denied";
  if (sqlState === "57014") return "timeout";
  return safeOperationsFailureCategory(err);
}

/**
 * A stage marker attached to the error itself.
 *
 * A pass that both scans and writes — the per-record integrity pass does both
 * — cannot have its stage attributed by the caller catching it, because from
 * out there the two are indistinguishable. Rather than have the caller GUESS,
 * the pass tags its own error at the point it knows, and the caller's argument
 * becomes a fallback for the case where nothing tagged it.
 *
 * A symbol, and a non-enumerable one, so the tag cannot land in a JSON
 * serialisation of the error and reach a client.
 */
const STAGE_TAG = Symbol.for("proovra.operations.sourceStage");

/**
 * Run `fn`, and tag anything it throws with the stage it was running in.
 *
 * The original error is re-thrown unchanged in every other respect: this adds
 * a property, it never replaces, wraps or swallows.
 */
export async function inSourceStage<T>(
  stage: OperationsSourceStage,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err != null && typeof err === "object" && !(STAGE_TAG in err)) {
      try {
        Object.defineProperty(err, STAGE_TAG, {
          value: stage,
          enumerable: false,
          configurable: true,
        });
      } catch {
        /* a frozen error keeps the caller's fallback stage */
      }
    }
    throw err;
  }
}

/** The stage a thrown value was tagged with, if any. */
export function taggedSourceStage(err: unknown): OperationsSourceStage | null {
  if (err == null || typeof err !== "object") return null;
  const v = (err as Record<symbol, unknown>)[STAGE_TAG];
  return v === "SCAN" || v === "WRITE" || v === "UNKNOWN" ? v : null;
}

/**
 * The bounded record that is persisted and projected.
 *
 * `fallbackStage` is used only when the error was not tagged by the code that
 * actually knew — the tag always wins, because the caller's view of "which
 * half of that pass broke" is a guess and the pass's own view is not.
 */
export function toSourceFailure(
  sourceId: string,
  fallbackStage: OperationsSourceStage,
  err: unknown,
): OperationsSourceFailure {
  const category = operationsFailureCategory(err);
  return {
    sourceId,
    stage: taggedSourceStage(err) ?? fallbackStage,
    category,
    retryable: isRetryableOperationsFailure(category),
  };
}

/**
 * The operator-side half.
 *
 * Deliberately separate from the record above and deliberately NOT awaited by
 * anything: an observability write must not be able to change whether a source
 * is reported as failed. It also never throws — a logger that can take down
 * the sweep it is describing is worse than no logger.
 */
export function reportSourceFailure(
  failure: OperationsSourceFailure,
  err: unknown,
  ctx: SourceFailureContext,
): void {
  const detail = {
    sourceId: failure.sourceId,
    stage: failure.stage,
    category: failure.category,
    retryable: failure.retryable,
    prismaCode: prismaErrorCode(err),
    pgSqlState: postgresSqlState(err),
    modelName:
      (err as { meta?: { modelName?: unknown } })?.meta?.modelName != null
        ? String((err as { meta?: { modelName?: unknown } }).meta?.modelName)
        : null,
    workspaceId: ctx.workspaceId,
    requestId: ctx.requestId ?? null,
    traceId: ctx.traceId ?? null,
  };
  try {
    // `logger.error` is the only level that survives production, which is
    // correct here: a source that could not complete is an error even though
    // the sweep continues past it.
    logError("operations.source_failed", detail);
  } catch {
    /* an observability write may never change the outcome it describes */
  }
  try {
    captureException(err, { operationsSourceFailure: detail });
  } catch {
    /* likewise */
  }
}
