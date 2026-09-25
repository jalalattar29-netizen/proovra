/**
 * T-10 / RC-11 — Google and Apple sign-up on native registration, plus the
 * web's live email-availability check.
 *
 * THE DEFECT THIS WOULD HAVE CAUGHT
 * ---------------------------------
 * `app/(stack)/register.tsx` imported no `useOAuth` at all: email + password
 * was the only way to create an account on a phone, while the web register
 * page offers Google and Apple above the form (`register/page.tsx:1063-1101`).
 * Someone who already had an account was also only told so AFTER satisfying
 * every password rule and submitting.
 *
 * Runtime completion of the Google/Apple exchange depends on T-01 (deployed
 * audience allow-list) and is NOT proven here — only that the controls exist,
 * use the one shared ceremony, and route through the one completion path.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const h = React.createElement;
let M;
let routes = {};
let requests = [];

function installFetch() {
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    return new Response(JSON.stringify(hit ? hit[1](path) : { message: "unstubbed" }), {
      status: hit ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  };
}

before(async () => {
  M = await loadModule("app/(stack)/register.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/auth/email-availability.ts",
  ]);
});
beforeEach(() => {
  routes = {};
  requests = [];
  installFetch();
  M.calls.reset();
});

const render = () => renderComponent(h(M.TestProviders, null, h(M.default, {})));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function typeEmailAndWait(r, value) {
  await r.type("Email address", value);
  await act(async () => {
    await sleep(M.EMAIL_AVAILABILITY_DEBOUNCE_MS + 300);
  });
}

test("Google and Apple sign-up are offered above the email form, as on the web", async () => {
  const r = await render();
  await act(async () => {
    await sleep(0);
  });
  assert.equal(r.byLabel("Continue with Google").length > 0, true, "no Google sign-up");
  assert.equal(r.byLabel("Continue with Apple").length > 0, true, "no Apple sign-up where Apple is available");
  assert.ok(r.hasText("Create your account using Google, Apple, or email and continue directly into your PROOVRA workspace."));
  const texts = r.texts();
  assert.ok(
    texts.indexOf("Continue with Google") < texts.findIndex((t) => t === "Or"),
    "the OAuth controls must come before the Or divider",
  );
});

test("sign-up uses the ONE shared OAuth ceremony and completion path", () => {
  const src = readFileSync(resolve(MOBILE, "app/(stack)/register.tsx"), "utf8");
  assert.match(src, /import \{ useOAuth \} from "\.\.\/\.\.\/src\/auth\/use-oauth"/);
  assert.match(src, /import \{ useCompleteLogin \} from "\.\.\/\.\.\/src\/auth\/use-auth-flow"/);
  // The third argument records the consent just given, source "register" (register/page.tsx:525-534).
  assert.match(src, /void completeLogin\(result, mode(, \{ legalAcceptedSource: "register" \})?\)/, "OAuth results must go through useCompleteLogin (MFA + legal gates)");
  // No second exchange: the screen must not call the provider endpoints itself.
  assert.doesNotMatch(src, /\/v1\/auth\/(google|apple)/);
});

test("availability: a free address reads 'Email is available.'", async () => {
  routes["/v1/auth/email/availability"] = () => ({ available: true });
  const r = await render();
  await typeEmailAndWait(r, "new@example.com");
  assert.ok(r.hasText("Email is available."));
  assert.ok(requests.some((p) => p === "/v1/auth/email/availability?email=new%40example.com"));
});

test("availability: an existing account says so and offers sign-in with the address carried", async () => {
  routes["/v1/auth/email/availability"] = () => ({ available: false, reason: "EMAIL_ALREADY_EXISTS" });
  const r = await render();
  await typeEmailAndWait(r, "taken@example.com");
  assert.ok(r.hasText("An account already exists for this email."));
  await r.press("Sign in");
  assert.deepEqual(M.calls.replace, [{ pathname: "/(stack)/auth", params: { email: "taken@example.com" } }]);
});

test("availability: a failed check never claims the address is free", async () => {
  routes["/v1/auth/email/availability"] = () => ({ weird: true });
  const r = await render();
  await typeEmailAndWait(r, "who@example.com");
  assert.ok(r.hasText("Could not verify email — you can still try to register."));
  assert.ok(!r.hasText("Email is available."));
});

test("availability: a malformed address is flagged without asking the server", async () => {
  const r = await render();
  await typeEmailAndWait(r, "not-an-email");
  assert.ok(r.hasText("Enter a valid email address."));
  assert.equal(requests.filter((p) => p.startsWith("/v1/auth/email/availability")).length, 0);
});

test("classifyAvailability maps the server's three answers and nothing else to success", () => {
  assert.equal(M.classifyAvailability({ available: true }), "available");
  assert.equal(M.classifyAvailability({ available: false, reason: "EMAIL_ALREADY_EXISTS" }), "exists");
  assert.equal(M.classifyAvailability({ available: false, reason: "INVALID_FORMAT" }), "invalid-format");
  assert.equal(M.classifyAvailability({ available: "yes" }), "error");
  assert.equal(M.classifyAvailability(null), "error");
});

test("T-12: the password rules are one named list, and the commitments row is present", async () => {
  const r = await render();
  await r.type("Password", "abc");
  const rules = r.byTestId("password-requirements")[0];
  assert.ok(rules, "the rules are not grouped");
  assert.equal(rules.props.role, "list");
  assert.equal(rules.props.accessibilityLabel, "Password requirements");
  const commitments = r.byTestId("register-commitments")[0];
  assert.equal(commitments.props.accessibilityLabel, "Security and privacy commitments");
  for (const c of ["TLS Protected", "Privacy-First Design", "GDPR-Aware Data Handling", "No Credit Card Required"]) {
    assert.ok(r.hasText(c), c);
  }
});
