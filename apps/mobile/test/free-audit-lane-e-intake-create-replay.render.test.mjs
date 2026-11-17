/**
 * LANE E — B3B-F-102 (native half): a keyed create is idempotent.
 *
 * A retried `POST /v1/workflow/intake-links` with the same key answers the
 * ORIGINAL link (200, `replayed: true`) and never its one-time token
 * (`rawToken: null`). Before: the native screen parsed that as a failed create
 * ("Couldn't create the intake link."). A key reused with changed details
 * answers 409 IDEMPOTENCY_KEY_REUSED, which fell to the raw/generic copy.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let S;
let handlers = {};

before(async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  S = await loadModule("app/(stack)/intake-link-create.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  handlers = {
    ...Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [`GET ${p}`, () => ({ body: f() })])),
    "GET /v1/platform/context": () => ({ body: platformContextEnvelope({ capabilities: { INTAKE_LINKS_MANAGE: true } }) }),
    "GET /v1/me/inbox/summary": () => ({ body: { unread: 0 } }),
    "GET /v1/billing/overview": () => ({ body: {} }),
    "GET /v1/workflow/intake-links/sender-identity": () => ({ body: { email: { configured: true }, sms: { configured: false } } }),
    "GET /v1/workflow/templates": () => ({ body: { templates: [] } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const key = Object.keys(handlers)
      .filter((k) => {
        const [m, p] = k.split(" ");
        return m === method && path.startsWith(p);
      })
      .sort((a, b) => b.length - a.length)[0];
    const res = key ? handlers[key]() : { status: 500, body: { message: "unstubbed" } };
    return new Response(JSON.stringify(res.body ?? {}), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
  };
  S.calls.reset();
  await signIn(S);
});
const matches = (r, re) => r.texts().some((t) => re.test(t));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function submitCreate() {
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

test("B3B-F-102: a replayed create says the link already exists and shows no secure link", async () => {
  handlers["POST /v1/workflow/intake-links"] = () => ({
    status: 200,
    body: {
      link: { id: "link-1", hasRecipientEmail: true, hasRecipientPhone: false },
      rawToken: null,
      tokenRevealed: false,
      replayed: true,
      delivery: { method: "EMAIL", status: "sent", communicationMessageId: "m-1" },
    },
  });
  const r = await submitCreate();
  const all = r.texts().join(" | ");
  assert.ok(matches(r, /already created by your earlier attempt/), all);
  assert.ok(matches(r, /sent by email/), all);
  assert.ok(!r.hasText("Couldn't create the intake link."), all);
  assert.ok(!all.includes("/intake/null"), all);
  assert.ok(!r.hasText("Copy link"), all);
});

test("B3B-F-102: a key reused with changed details (409) says so in English", async () => {
  handlers["POST /v1/workflow/intake-links"] = () => ({
    status: 409,
    body: { error: { code: "IDEMPOTENCY_KEY_REUSED", message: "HTTP 409" } },
  });
  const r = await submitCreate();
  const all = r.texts().join(" | ");
  assert.ok(matches(r, /already created from this form with different details/), all);
  assert.ok(!all.includes("IDEMPOTENCY_KEY_REUSED"), all);
});
