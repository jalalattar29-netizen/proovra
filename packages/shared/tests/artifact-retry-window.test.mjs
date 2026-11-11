/**
 * AUD-0056 — report generation's retry window outlasts a short storage outage.
 *
 * At the audit a 75 s storage stop sent every in-flight report request to
 * FAILED_TERMINAL within ~27 s (5 attempts from 1 s), and nothing re-attempted
 * them after storage returned. BullMQ's exponential backoff waits
 * delay * 2^(n-1) before retry n.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { RETRY_POLICIES } = await import("../dist/queue-integrity/retry-policy.js");

const windowMs = (p) => {
  let total = 0;
  for (let n = 1; n < p.attempts; n += 1) total += p.backoff === "exponential" ? p.backoffDelayMs * 2 ** (n - 1) : p.backoffDelayMs;
  return total;
};

test("the report queue's retries span more than the audited 75 s outage, by a margin", () => {
  const p = RETRY_POLICIES.ARTIFACT;
  assert.ok(windowMs(p) >= 5 * 60 * 1000, `retry window ${windowMs(p)} ms`);
  // The attempt made after the outage ends must exist: some retry lands after 75 s.
  assert.ok(windowMs(p) > 75_000);
});

test("the window stays under the report reconciler's claim ceiling", () => {
  const authority = readFileSync(new URL("../../../services/worker/src/report-generation-authority.ts", import.meta.url), "utf8");
  const ceiling = Number(/export const REPORT_RECONCILE_MAX_ATTEMPTS = (\d+);/.exec(authority)?.[1]);
  assert.ok(ceiling > 0);
  assert.ok(RETRY_POLICIES.ARTIFACT.attempts < ceiling, `${RETRY_POLICIES.ARTIFACT.attempts} attempts vs ceiling ${ceiling}`);
});
