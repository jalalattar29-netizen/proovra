/**
 * CLIENT-X — B3B-F-101 / B3B-F-102 (native half).
 *
 * `POST /v1/workflow/intake-links/:id/send` now answers 409
 * `INTAKE_NOT_INCLUDED` (a workspace without secure intake) and 409
 * `delivery_in_progress` (a second send with the same key while the first is
 * in flight). Before: the created view showed the generic transport text for
 * both ("Couldn't send the link." / the raw server code).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let S;
let requests = [];
let handlers = {};

before(async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  S = await loadModule("app/(stack)/intake-link-create.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  handlers = {
    ...Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [`GET ${p}`, () => ({ body: f() })])),
    "GET /v1/platform/context": () => ({ body: platformContextEnvelope({ capabilities: { INTAKE_LINKS_MANAGE: true } }) }),
    "GET /v1/me/inbox/summary": () => ({ body: { unread: 0 } }),
    "GET /v1/billing/overview": () => ({ body: {} }),
    "GET /v1/workflow/intake-links/sender-identity": () => ({ body: { email: { configured: true }, sms: { configured: false } } }),
    "GET /v1/workflow/templates": () => ({ body: { templates: [] } }),
    "POST /v1/workflow/intake-links": () => ({
      status: 201,
      body: { link: { id: "link-1", hasRecipientEmail: true, hasRecipientPhone: false }, rawToken: "tok_abc", delivery: { method: "MANUAL", status: "skipped" } },
    }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const req = { path, method, body: init.body ? JSON.parse(init.body) : null };
    requests.push(req);
    const key = Object.keys(handlers)
      .filter((k) => {
        const [m, p] = k.split(" ");
        return m === method && path.startsWith(p);
      })
      .sort((a, b) => b.length - a.length)[0];
    const res = key ? handlers[key](req) : { status: 500, body: { message: "unstubbed" } };
    return new Response(JSON.stringify(res.body ?? {}), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
  };
  S.calls.reset();
  await signIn(S);
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function createdView() {
  const r = await renderComponent(h(S.TestProviders, null, h(S.default, {})));
  for (let i = 0; i < 4; i += 1) await settle();
  await r.press("Continue");
  await r.type("Recipient email", "witness@example.com");
  await r.press("Continue");
  await r.press("Continue");
  await r.press("Create and send");
  for (let i = 0; i < 3; i += 1) await settle();
  return r;
}

test("B3B-F-101: a 409 INTAKE_NOT_INCLUDED on send says the plan does not include secure intake", async () => {
  handlers["POST /v1/workflow/intake-links/link-1/send"] = () => ({
    status: 409,
    body: { error: { code: "INTAKE_NOT_INCLUDED", message: "HTTP 409" } },
  });
  const r = await createdView();
  await r.press("Send by email");
  for (let i = 0; i < 3; i += 1) await settle();
  assert.ok(r.hasText("Secure intake is not included in this workspace's plan."), r.texts().join(" | "));
});

test("B3B-F-102: a 409 delivery_in_progress on send says it is already sending", async () => {
  handlers["POST /v1/workflow/intake-links/link-1/send"] = () => ({ status: 409, body: { error: { code: "delivery_in_progress" } } });
  const r = await createdView();
  await r.press("Send by email");
  for (let i = 0; i < 3; i += 1) await settle();
  assert.ok(r.hasText("Already sending — check again in a moment."), r.texts().join(" | "));
});
