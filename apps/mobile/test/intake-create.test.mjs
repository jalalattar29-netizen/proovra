/**
 * T-16 / RC-20 (+ T-12 "What are you asking for?" / "Link expires in") —
 * native intake-link creation.
 *
 * THE DEFECT
 * ----------
 * Native said creating an intake link "stays in the PROOVRA web app",
 * justified by the RESEND constraint (the API never persists the raw token).
 * That constraint does not apply to creation: the create response carries the
 * token, so the creating session can show, share and send it. A caseworker on
 * a phone could not request evidence from anyone.
 *
 * WHAT IS PROVEN
 * --------------
 *   - validation matches the web's rules and copy (E.164, email, custom sender
 *     name via the SHARED validator, expiry bounds, kinds);
 *   - the request body matches the API's zod CreateBody (location policy sent
 *     explicitly; maxUses by mode; intakeUrlBase only when something is sent);
 *   - the rendered journey: New intake link → 4 steps → create → the one-time
 *     link, addressed on EXPO_PUBLIC_WEB_BASE;
 *   - the policy refusal the WEB mis-maps reads correctly here.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let C; // pure module
let S; // screen
let requests = [];
let handlers = {};

before(async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  C = await loadModule("src/product/intake-create.ts");
  S = await loadModule("app/(stack)/intake-link-create.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

function install() {
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
}

beforeEach(async () => {
  requests = [];
  handlers = {
    ...Object.fromEntries(Object.entries(authenticatedRoutes()).map(([p, f]) => [`GET ${p}`, () => ({ body: f() })])),
    "GET /v1/platform/context": () => ({ body: platformContextEnvelope({ capabilities: { INTAKE_LINKS_MANAGE: true } }) }),
    "GET /v1/me/inbox/summary": () => ({ body: { unread: 0 } }),
    "GET /v1/billing/overview": () => ({ body: {} }),
    "GET /v1/workflow/intake-links/sender-identity": () => ({ body: { email: { configured: true }, sms: { configured: false } } }),
    "GET /v1/workflow/templates": () => ({ body: { templates: [] } }),
  };
  install();
  S.calls.reset();
  await signIn(S);
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/* --------------------------------------------------------------- pure */

test("E.164 and email validation reproduce the web's three phone outcomes and copy", () => {
  const base = C.initialWizardState({ workspaceName: "Acme", channel: "SMS" });
  const err = (phone) => C.validateStep("delivery", { ...base, channel: "SMS", recipientPhone: phone }, C.BUILT_IN_PURPOSES, null).recipientPhone;
  assert.equal(err(""), "Enter the recipient's phone number in international format.");
  assert.equal(err("4155550123"), "Include the country code, for example +14155550123.");
  assert.equal(err("+1"), "That doesn't look like a valid international number.");
  assert.equal(err("+1 (415) 555-0123"), undefined, "separators are allowed; the canonical value is what is sent");
  const email = C.validateStep("delivery", { ...base, channel: "EMAIL", recipientEmail: "nope" }, C.BUILT_IN_PURPOSES, null).recipientEmail;
  assert.equal(email, "That doesn't look like an email address.");
});

test("the custom sender name uses the SHARED validator, with the web's copy", () => {
  const base = C.initialWizardState({ workspaceName: null, channel: "MANUAL" });
  const err = (name) => C.validateStep("delivery", { ...base, senderMode: "CUSTOM", senderName: name }, C.BUILT_IN_PURPOSES, null).senderName;
  assert.equal(err(""), "Enter a display name.");
  assert.equal(err("City Police Department"), "Display names can't impersonate courts, police, government, or banks.");
  assert.equal(err("Smith & Partners"), undefined);
});

test("the body matches the API: explicit location, maxUses by mode, intakeUrlBase only when sending", () => {
  const s = { ...C.initialWizardState({ workspaceName: "Acme", channel: "MANUAL" }), recipientPhone: "+1 415 555 0123" };
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const manual = C.buildCreateBody(s, { teamId: "t", origin: "https://www.proovra.com", idempotencyKey: "create:k", nowMs: now });
  assert.equal(manual.locationPolicy, "OPTIONAL", "the server default is NONE; the UI default must be sent");
  assert.equal(manual.maxUses, 1);
  assert.equal("intakeUrlBase" in manual, false);
  assert.equal(manual.recipientPhone, "+14155550123");
  assert.equal(manual.expiresAtUtc, "2026-09-27T12:00:00.000Z", "72 hours");
  const reusable = C.buildCreateBody({ ...s, channel: "EMAIL", intakeMode: "EXTERNAL_REUSABLE" }, { teamId: "t", origin: "https://www.proovra.com", idempotencyKey: "k", nowMs: now });
  assert.equal(reusable.maxUses, 1000);
  assert.equal(reusable.intakeUrlBase, "https://www.proovra.com");
});

test("the policy refusal the web mis-maps reads correctly on native", () => {
  assert.equal(C.friendlyCreateError("external_intake_disabled_by_policy", null), "Your workspace policy doesn't allow this kind of intake link.");
  assert.equal(C.friendlyCreateError(null, "HTTP 403: API error"), "Couldn't create the intake link.", "a transport string is never shown");
});

test("the two T-12 selects carry the web's options verbatim", () => {
  assert.deepEqual(C.EXPIRY_OPTIONS.map((o) => o.label), ["24 hours", "3 days", "7 days", "30 days", "Custom…"]);
  assert.equal(C.BUILT_IN_PURPOSES.length, 9);
  assert.equal(C.BUILT_IN_PURPOSES[0].label, "General evidence request");
});

/* -------------------------------------------------------------- render */

test("create journey: 4 steps → POST → the one-time link on EXPO_PUBLIC_WEB_BASE", async () => {
  handlers["POST /v1/workflow/intake-links"] = () => ({
    status: 201,
    body: {
      link: { id: "link-1", hasRecipientEmail: true, hasRecipientPhone: false },
      rawToken: "tok_abc",
      warning: "The raw token is shown exactly once.",
      delivery: { method: "EMAIL", status: "sent", communicationMessageId: "m1" },
    },
  });
  const r = await renderComponent(h(S.TestProviders, null, h(S.default, {})));
  for (let i = 0; i < 4; i += 1) await settle();
  assert.ok(r.hasText("New intake link"));
  // Step 1 → 2. SMS is unconfigured here, so the default channel is EMAIL.
  await r.press("Continue");
  // The web marks the channel's recipient field required (wizard/fields.tsx:44).
  assert.ok(r.hasText("Recipient email (required)"), "the required recipient field was not marked");
  await r.type("Recipient email", "witness@example.com");
  await r.press("Continue");
  await r.press("Link expires in: 7 days");
  await r.press("Continue");
  assert.ok(r.hasText("Message preview"), "the review step shows the message the recipient receives");
  await r.press("Create and send");
  for (let i = 0; i < 3; i += 1) await settle();

  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/workflow/intake-links");
  assert.ok(post, "the create request was never sent");
  assert.equal(post.body.deliveryMethod, "EMAIL");
  assert.equal(post.body.recipientEmail, "witness@example.com");
  assert.equal(post.body.intakeUrlBase, "https://www.proovra.com");
  assert.match(post.body.idempotencyKey, /^create:/);
  assert.ok(r.hasText("Secure link created"));
  assert.ok(r.hasText("https://www.proovra.com/intake/tok_abc"), "the one-time link is not shown");
  assert.ok(r.hasText("Handed to the provider via Email. Track it under Delivery history on the link."));
});

test("a step with errors does not advance, and names the problem", async () => {
  const r = await renderComponent(h(S.TestProviders, null, h(S.default, {})));
  for (let i = 0; i < 4; i += 1) await settle();
  await r.press("Continue");
  await r.press("Continue"); // email empty
  assert.ok(r.hasText("Enter the recipient's email address."));
  assert.ok(r.hasText("step 2 of 4"));
});
