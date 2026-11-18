/**
 * WS-REL / PRO-PSZ-05 (native half) — every native request states the client's
 * own presentation contract and its truthful capabilities, so the API can
 * stage enforcement per client. Reporting only: the request is unchanged
 * otherwise. Native fetch is not subject to CORS.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let M;
before(async () => {
  M = await loadModule("src/api.ts", ["src/network/client-contract.ts"]);
});

test("PRO-PSZ-05: a native request carries the client contract and capabilities", async () => {
  let sent = null;
  globalThis.fetch = async (_url, init) => {
    sent = new Headers(init.headers);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const body = await M.apiFetch("/v1/anything");
  assert.deepEqual(body, { ok: true });
  assert.match(sent.get("x-proovra-client-contract") ?? "", /^\d+$/);
  assert.equal(sent.get("x-proovra-client-capabilities"), "update-required-notice");
});

test("PRO-PSZ-05: a caller-set value is not overwritten", () => {
  const h = new Headers({ "x-proovra-client-contract": "9" });
  M.applyClientContractReport(h);
  assert.equal(h.get("x-proovra-client-contract"), "9");
});
