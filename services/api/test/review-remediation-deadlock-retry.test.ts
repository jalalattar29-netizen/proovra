/**
 * Review remediation IR-06 (2026-11-28) — the bounded whole-transaction retry
 * used as the backstop to the review-first lock order. Only lock-cycle and
 * serialization aborts are retried, a bounded number of times; every other
 * error (a refusal, a constraint, a dry run) propagates on the first attempt.
 * The lock order itself is proven against PostgreSQL in
 * review-remediation-lock-order.integration.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

import { isRetryableTransactionAbort, withDeadlockRetry } from "../src/services/assignment/deadlock-retry.js";

describe("isRetryableTransactionAbort", () => {
  it("recognises Prisma P2034, SQLSTATE 40P01 / 40001 (code, meta, message, cause)", () => {
    expect(isRetryableTransactionAbort({ code: "P2034" })).toBe(true);
    expect(isRetryableTransactionAbort({ code: "40P01" })).toBe(true);
    expect(isRetryableTransactionAbort({ code: "P2010", meta: { code: "40P01" } })).toBe(true);
    expect(isRetryableTransactionAbort({ code: "P2010", meta: { code: "40001" } })).toBe(true);
    expect(isRetryableTransactionAbort(new Error("ERROR: deadlock detected"))).toBe(true);
    expect(isRetryableTransactionAbort({ message: "wrapped", cause: { code: "40P01" } })).toBe(true);
  });

  it("does not retry anything else", () => {
    expect(isRetryableTransactionAbort(null)).toBe(false);
    expect(isRetryableTransactionAbort(new Error("reviewer_not_eligible"))).toBe(false);
    expect(isRetryableTransactionAbort({ code: "P2002" })).toBe(false);
    expect(isRetryableTransactionAbort({ code: "P2010", meta: { code: "23505" } })).toBe(false);
  });
});

describe("withDeadlockRetry", () => {
  it("runs the whole callback again after a lock-cycle abort and returns its result", async () => {
    const run = vi.fn().mockRejectedValueOnce({ code: "P2034" }).mockResolvedValueOnce("recorded");
    await expect(withDeadlockRetry(run)).resolves.toBe("recorded");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("is bounded: after the last attempt the abort propagates", async () => {
    const abort = { code: "40P01" };
    const run = vi.fn().mockRejectedValue(abort);
    await expect(withDeadlockRetry(run, 3)).rejects.toBe(abort);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("a refusal propagates at once, never retried", async () => {
    const refusal = new Error("reviewer_not_eligible");
    const run = vi.fn().mockRejectedValue(refusal);
    await expect(withDeadlockRetry(run)).rejects.toBe(refusal);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
