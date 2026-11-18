/**
 * WS-REL / PRO-PSZ-05 (extension half) — the extension reports its contract
 * and capabilities, but only to an API that has said it accepts them.
 *
 * The extension's requests are CORS requests (no host permission): sending a
 * header an older API does not allow-list would fail the preflight and break
 * every call. So: no report headers until a response carries
 * `x-proovra-client-report-accepted: 1`; after that, every request carries
 * them. One module instance, so the steps run in order in one test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { apiFetch } from "./dist/api-client.js";

async function call(responseHeaders) {
  const realFetch = globalThis.fetch;
  let sent = null;
  try {
    globalThis.fetch = async (_url, init) => {
      sent = new Headers(init.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", ...responseHeaders },
      });
    };
    await apiFetch("t", "GET", "/v1/platform/context");
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

test("PRO-PSZ-05: no report to an API that has not accepted it; reported once it has", async () => {
  // An older API: never says it accepts the report.
  const first = await call({});
  assert.equal(first.get("x-proovra-client-contract"), null);
  const second = await call({ "x-proovra-client-report-accepted": "1" });
  // The request that LEARNS acceptance was still sent without it.
  assert.equal(second.get("x-proovra-client-contract"), null);
  const third = await call({ "x-proovra-client-report-accepted": "1" });
  assert.match(third.get("x-proovra-client-contract") ?? "", /^\d+$/);
  assert.equal(third.get("x-proovra-client-capabilities"), "update-required-notice");
  assert.equal(third.get("authorization"), "Bearer t");
});
