import { AppError } from "../../errors.js";

/**
 * PRO-E1-05 / PRO-E2-07 — what a bulk record failure may say.
 *
 * The bulk loop's domain refusals are deliberate short sentences or bounded
 * codes (the lifecycle outcome codes, the case-link authority's codes). An
 * unexpected Error — a Prisma or service fault — carried its raw message into
 * the 200 response. Only an AppError, a known sentence or a bounded code
 * passes; anything else is "Operation failed".
 */
export const BULK_OPERATION_FAILED = "Operation failed";
const BULK_REFUSAL_SENTENCES: ReadonlySet<string> = new Set([
  "Case not found",
  "Cannot add deleted evidence to a case",
  "Cross-workspace attach is not permitted",
  "Evidence is not assigned to a case",
  "Evidence not found",
  "Forbidden",
  "Unsupported bulk action",
  BULK_OPERATION_FAILED,
]);
const BULK_REFUSAL_CODE = /^(?:[A-Z][A-Z0-9_]{2,63}|[a-z][a-z0-9_]{2,63})$/;

export function bulkRefusalReason(error: unknown): string {
  if (error instanceof AppError) return error.message;
  // A Prisma error is an Error too, but its message is never a known sentence
  // nor a bare bounded code, so it falls through.
  if (error instanceof Error && !error.name.startsWith("PrismaClient")) {
    if (BULK_REFUSAL_SENTENCES.has(error.message) || BULK_REFUSAL_CODE.test(error.message)) return error.message;
  }
  return BULK_OPERATION_FAILED;
}
