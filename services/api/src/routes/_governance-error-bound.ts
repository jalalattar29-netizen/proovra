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
