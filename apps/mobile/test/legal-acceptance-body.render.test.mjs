/**
 * DEFECT (P0) — the legal-acceptance gate posted `{ policyKey, version }`; the
 * server schema (services/api/src/routes/users.routes.ts LegalAcceptanceBody)
 * requires `{ policyKey, policyVersion }`, so every native acceptance was a
 * 400 and a user who owed a re-acceptance could never get past the gate.
 * Driven through the real gate screen; the stub enforces the server's schema.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let posts = [];

before(async () => {
  M = await loadModule("app/(stack)/legal-acceptance.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  posts = [];
  globalThis.__EXPO_PARAMS__ = { next: "/billing" };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/v1/users/legal-status") {
      return new Response(JSON.stringify({ ok: false, missingPolicies: ["terms", "privacy"], requiredVersions: { terms: "2026-09", privacy: "2026-08" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/users/legal-acceptance" && init.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push(body);
      // The server's zod schema, as it is.
      const valid = Array.isArray(body.acceptances) && body.acceptances.length > 0 &&
        body.acceptances.every((a) => typeof a.policyKey === "string" && typeof a.policyVersion === "string" && a.policyVersion.length > 0);
      return valid
        ? new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "Invalid request" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("accepting posts the server's schema and the gate lets the user through", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  const accept = r.texts().find((t) => /accept/i.test(t) && !/policies|following/i.test(t));
  assert.ok(accept, r.texts().join(" | "));
  const node = r.byLabel(accept).find((n) => n.props.onPress) ?? r.byLabel(accept)[0];
  await act(async () => { await node.props.onPress(); });
  await settle();
  assert.deepEqual(posts.at(-1), {
    source: "mobile_legal_gate",
    acceptances: [
      { policyKey: "terms", policyVersion: "2026-09" },
      { policyKey: "privacy", policyVersion: "2026-08" },
    ],
  });
  assert.equal(M.calls.replace.at(-1), "/billing", "the gate did not let the user through");
});
