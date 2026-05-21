/**
 * Phase 32.5 — bounded governance route error wrapper.
 *
 * The governance routes query a set of tables that may be absent on
 * environments where Phase 24-J / 25 / 27 / 30 / 31 / 32 migrations
 * have not been fully applied. Previously, a missing-table Prisma
 * error (P2022/P2025) propagated as an unhandled 500 — operators saw
 * a generic "Internal Server Error" with no actionable signal.
 *
 * This helper wraps a governance route's handler body and converts
 * known Prisma schema-drift errors into a bounded 503 response with
 * a single error code (`governance_schema_unavailable`) and a single
 * operator-safe message. The UI consumer can render a clean
 * "Governance subsystem currently degraded" banner instead of a
 * blank 500.
 *
 * Anti-leak invariants:
 *   - NEVER returns the raw Prisma error message (which can include
 *     SQL fragments + internal table names).
 *   - NEVER returns stack traces.
 *   - Returns a SINGLE bounded reason code so the UI can branch on it.
 *
 * Permitted leakage:
 *   - The HTTP status code (503) signals "service degraded, retry".
 *   - The bounded reason code (`governance_schema_unavailable`) is
 *     safe by construction — it does not name any specific table.
 *
 * Hard rule: This helper is NOT a substitute for the runtime
 * readiness probe. It catches the EDGE CASE where a route is invoked
 * while a degraded subsystem is being queried. The readiness probe
 * remains the authoritative source for "is governance healthy".
 */

import type { FastifyReply } from "fastify";

/**
 * Prisma error codes that signal a missing table/column/relation —
 * i.e. schema drift. Anything else is re-thrown for the framework
 * error handler to deal with.
 */
const PRISMA_SCHEMA_DRIFT_CODES = new Set<string>([
  "P2022", // Column does not exist
  "P2021", // Table does not exist
  "P2025", // Record(s) required by the query are not found (rare for reads)
]);

function isPrismaSchemaDriftError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  return PRISMA_SCHEMA_DRIFT_CODES.has(code);
}

/**
 * Phase 32.7.6 — bounded helper that returns true when the error
 * specifically signals a missing TABLE (P2021) or missing COLUMN
 * (P2022). Used by routes that want to treat their underlying
 * subsystem as OPTIONAL: when the table/column is absent, the
 * route returns a HEALTHY empty payload instead of a 503 "infra
 * unavailable" — appropriate for features that may not be
 * deployed in every environment (e.g., the Phase 14 case-legal-
 * holds table).
 *
 * P2025 ("record required") is NOT included here — that one is a
 * data condition, not a schema condition.
 */
export function isPrismaTableOrColumnMissing(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "P2021" || code === "P2022";
}

/**
 * Phase 32.7.4 — bounded structured diagnostic for the schema-drift
 * catch path. Server-side only — the client sees the same bounded
 * 503 body as before. The log line names the exact Prisma code +
 * missing column/table (from `err.meta`) so operators can triage
 * without scraping the raw Prisma exception body.
 *
 * Anti-leak: only Prisma-provided structured fields (code, name,
 * meta.column, meta.table, meta.modelName) are surfaced. The raw
 * message is bounded to 300 chars. NEVER includes row data,
 * SQL fragments, signature bytes, custody payloads, or private
 * note text.
 */
export function extractPrismaDiagnostic(err: unknown): {
  name: string;
  code: string;
  message: string;
  missingColumn: string | null;
  missingTable: string | null;
  modelName: string | null;
} {
  const e = err as {
    name?: string;
    code?: string;
    message?: string;
    meta?: { column?: unknown; table?: unknown; modelName?: unknown };
  };
  const meta = e?.meta ?? {};
  const readMetaString = (key: "column" | "table" | "modelName"): string | null => {
    const v = meta[key];
    return typeof v === "string" ? v.slice(0, 120) : null;
  };
  return {
    name: typeof e?.name === "string" ? e.name : "unknown_error",
    code: typeof e?.code === "string" ? e.code : "unknown_code",
    message: typeof e?.message === "string" ? e.message.slice(0, 300) : "",
    missingColumn: readMetaString("column"),
    missingTable: readMetaString("table"),
    modelName: readMetaString("modelName"),
  };
}

/**
 * Wrap a governance handler body so schema-drift errors map to a
 * bounded 503 response. ALL other errors continue to propagate to
 * Fastify's default error handler (we do NOT swallow real bugs).
 *
 * Returns the handler's result on success, or sends the bounded 503
 * reply on schema-drift and returns `undefined` (caller should
 * `return` immediately after to short-circuit subsequent code).
 */
export async function runGovernanceHandler<T>(
  reply: FastifyReply,
  handler: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await handler();
  } catch (err) {
    if (isPrismaSchemaDriftError(err)) {
      // Phase 32.6 — bounded SRE counter for governance schema drift.
      // Bumped from a single canonical site so dashboards can size
      // the impact without scraping logs.
      try {
        const { bump } = await import("@proovra/shared-runtime/ops");
        bump("governance_schema_unavailable_total");
      } catch {
        /* metrics are best-effort */
      }

      // Phase 32.7.4 — bounded structured server-side diagnostic.
      // Logs the EXACT Prisma error code + missing column/table so
      // operators can identify the schema gap without enabling
      // verbose Prisma logging in production. The client still
      // receives the same anti-leak 503 body below.
      const diag = extractPrismaDiagnostic(err);
      reply.log.warn(
        {
          event: "governance.schema_unavailable",
          requestId: reply.request?.id ?? null,
          method: reply.request?.method ?? null,
          url: reply.request?.url ?? null,
          prismaName: diag.name,
          prismaCode: diag.code,
          missingColumn: diag.missingColumn,
          missingTable: diag.missingTable,
          modelName: diag.modelName,
          message: diag.message,
        },
        "governance route returned 503 governance_schema_unavailable",
      );

      reply.code(503).send({
        error: {
          code: "governance_schema_unavailable",
          message:
            "Governance subsystem is currently degraded. Operators have been notified.",
        },
      });
      return undefined;
    }
    throw err;
  }
}
