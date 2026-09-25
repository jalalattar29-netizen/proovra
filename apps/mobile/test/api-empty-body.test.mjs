/**
 * A 204 No Content reply (ten server routes, e.g. case delete) is a SUCCESS.
 * apiFetch/publicFetch called res.json() on every success and threw on the
 * empty body, so the user was told a completed write had failed.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let A;
before(async () => {
  A = await loadModule("src/api.ts", ["test/support/expo-stub.mjs"]);
});

test("204 and empty 200 bodies resolve to null; JSON still parses", async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await A.apiFetch("/v1/cases/c1", { method: "DELETE" }), null);
  assert.equal(await A.publicFetch("/v1/x", { method: "DELETE" }), null);
  globalThis.fetch = async () => new Response("", { status: 200 });
  assert.equal(await A.apiFetch("/v1/x"), null);
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  assert.deepEqual(await A.apiFetch("/v1/x"), { ok: true });
});
