/**
 * ET-REC-05 — a non-2xx remediation answer reaches the Operations page as the
 * server's OUTCOME, not as the generic "could not be started".
 *
 * The remediate route answered 409/503 with a bare `{ remediation }` body.
 * `apiFetch` lifts only the standard `error` envelope from a failed response,
 * so the page lost the sentence — e.g. "use Retry after exhausted failure" for
 * NOT_ELIGIBLE, or "recorded, will be picked up" for QUEUE_UNAVAILABLE — and
 * showed a failure for work that was recorded. The route now also sends
 * `error: { code, message, remediation }`; this drives the REAL `apiFetch`.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { apiFetch, ApiError } from "../lib/api";

async function thrownFrom(status: number, body: unknown) {
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  try {
    await apiFetch("/v1/ops/incidents/x/remediate", { method: "POST" });
    assert.fail("apiFetch resolved on a non-2xx response");
  } catch (err) {
    return err as ApiError & { body?: { error?: { remediation?: { result: string; message: string } } } };
  } finally {
    (globalThis as { fetch: unknown }).fetch = original;
  }
}

test("a 503 QUEUE_UNAVAILABLE answer keeps its remediation outcome on the thrown error", async () => {
  const remediation = { result: "QUEUE_UNAVAILABLE", message: "Recorded; it will be picked up when the queue recovers." };
  const err = await thrownFrom(503, {
    remediation,
    error: { code: "remediation_queue_unavailable", message: remediation.message, remediation },
  });
  assert.ok(err instanceof ApiError);
  assert.deepEqual(err.body?.error?.remediation, remediation);
});

test("a bare { remediation } body (the previous server) has no outcome to lift — why the envelope was needed", async () => {
  const err = await thrownFrom(409, { remediation: { result: "NOT_ELIGIBLE", message: "Not eligible." } });
  assert.equal((err as { body?: unknown }).body, undefined);
});

test("the page shows the lifted outcome instead of the generic failure", () => {
  const page = readFileSync(new URL("../app/(app)/operations/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\?\.error\?\.remediation;/);
  assert.match(page, /setRemediationOutcome\(answered\);/);
});
