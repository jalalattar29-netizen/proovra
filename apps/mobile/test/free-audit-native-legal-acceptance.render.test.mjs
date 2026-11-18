/**
 * SN-0051 /legal-acceptance (Free audit 0ea0, residual coverage §2.5; B3B-G-162)
 * — the native terms gate, walked through the real screen and the real apiFetch.
 *
 * Entries traced:
 *   - sign-in bootstrap (src/auth/use-auth-flow.ts:114) router.replace with
 *     { policies, next: <destination> } — nothing beneath it;
 *   - the runtime 428 interceptor (src/api.ts:169 → src/auth/legal-gate.ts:16)
 *     router.push with { policies } and NO next — the interrupted screen beneath;
 *   - Settings › Legal acceptance (app/(tabs)/settings.tsx:492) router.push, no params.
 * Server (services/api/src/routes/users.routes.ts):
 *   GET  /v1/users/legal-status   { ok, requiresReacceptance, missingPolicies, acceptedVersions, requiredVersions }
 *   POST /v1/users/legal-acceptance { source, acceptances: [{ policyKey, policyVersion }] } (min 1)
 *        400 { error: { code: LEGAL_POLICY_VERSION_NOT_CURRENT, details: { requiredVersions } } }
 *   Writes are refused with 428 LEGAL_REACCEPT_REQUIRED until accepted; reads stay
 *   open; account, recovery and privacy writes are exempt (legal-acceptance-route-policy.ts).
 *
 * Gaps (fail-first):
 *   NAT-LEGAL-01 — a policy re-issued while the screen was open: the POST is
 *     refused LEGAL_POLICY_VERSION_NOT_CURRENT and the screen re-posted the SAME
 *     stale versions on every tap ("Reload and try again", with nothing to reload).
 *   NAT-LEGAL-02 — the 428 interceptor and Settings open the gate over the
 *     current screen, but leaving it always did router.replace("/(tabs)"),
 *     throwing away the interrupted screen (the web keeps the page, B1-F-010)
 *     and bouncing Settings to Home.
 *   NAT-LEGAL-03 — the gate had no way out but "Accept": at sign-in it is the
 *     only screen, so a person who will not accept could not reach the exempt
 *     paths (sign out, export, close the account). The web step has "Not now"
 *     (LegalAcceptanceStep.tsx:55-60, A1-06); writes stay refused server-side.
 *   NAT-LEGAL-04 — `next` was any string starting with "/": `next=/legal-acceptance`
 *     re-opened the gate forever once accepted (status ok → replace → status ok …),
 *     and `//host` is not an in-app path.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let posts;
let statusReads;
let required;
let accepted;
let refuseNext;
const mounted = [];

before(async () => {
  M = await loadModule("app/(stack)/legal-acceptance.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/auth/legal-gate.ts"]);
});

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  posts = [];
  statusReads = 0;
  required = { terms: "2026-09", privacy: "2026-08", cookies: "2026-01" };
  accepted = { cookies: "2026-01" };
  refuseNext = null;
  delete globalThis.__EXPO_CAN_GO_BACK__;
  globalThis.__EXPO_PARAMS__ = {};
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/v1/users/legal-status") {
      statusReads += 1;
      const missing = Object.keys(required).filter((k) => accepted[k] !== required[k]);
      return reply(200, { ok: missing.length === 0, requiresReacceptance: missing.length > 0, missingPolicies: missing, acceptedVersions: accepted, requiredVersions: required });
    }
    if (path === "/v1/users/legal-acceptance" && init.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (refuseNext) {
        const r = refuseNext;
        refuseNext = null;
        return r();
      }
      // users.routes.ts D12 — only the current version of a required policy.
      if (body.acceptances.some((a) => required[a.policyKey] !== a.policyVersion)) {
        return reply(400, { error: { code: "LEGAL_POLICY_VERSION_NOT_CURRENT", message: "Only the current version of a required policy can be accepted. Reload and try again.", details: { requiredVersions: required } } });
      }
      for (const a of body.acceptances) accepted[a.policyKey] = a.policyVersion;
      return reply(200, { items: [] });
    }
    return reply(200, {});
  };
  M.calls.reset();
});
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};

/* ---------------------------------------------- NAT-LEGAL-01 (fail-first) */

test("NAT-LEGAL-01 — terms re-issued while the gate was open: the gate re-reads the versions and the next tap accepts the current ones", async () => {
  globalThis.__EXPO_PARAMS__ = { next: "/billing" };
  const r = await render();
  required = { ...required, terms: "2026-11" }; // re-issued meanwhile
  await r.press("Accept and continue");
  await settle();
  assert.equal(posts.length, 1);
  assert.ok(r.hasText("The terms changed while this screen was open"), r.texts().join(" | "));
  assert.equal(statusReads, 2, "the required versions were not re-read after the refusal");
  assert.ok(r.hasText("Version 2026-11 · Read the document"), "the list still shows the stale version");
  await r.press("Accept and continue");
  await settle();
  assert.deepEqual(posts.at(-1).acceptances.find((a) => a.policyKey === "terms"), { policyKey: "terms", policyVersion: "2026-11" });
  assert.equal(M.calls.replace.at(-1), "/billing");
});

/* ---------------------------------------------- NAT-LEGAL-02 (fail-first) */

test("NAT-LEGAL-02 — opened by a refused write (no next, a screen beneath): accepting returns to that screen", async () => {
  globalThis.__EXPO_PARAMS__ = { policies: "terms,privacy" };
  const r = await render();
  await r.press("Accept and continue");
  await settle();
  assert.equal(posts.length, 1);
  assert.equal(M.calls.back, 1, "the interrupted screen was not resumed");
  assert.deepEqual(M.calls.replace, [], "the interrupted screen was replaced by Home");
});

test("NAT-LEGAL-02 — opened from Settings with nothing owed: back to Settings, not Home", async () => {
  accepted = { ...required };
  await render();
  assert.equal(M.calls.back, 1);
  assert.deepEqual(M.calls.replace, []);
  assert.equal(posts.length, 0);
});

test("NAT-LEGAL-02 — with nothing beneath and no next, accepting goes Home", async () => {
  globalThis.__EXPO_CAN_GO_BACK__ = false;
  const r = await render();
  await r.press("Accept and continue");
  await settle();
  assert.equal(M.calls.replace.at(-1), "/(tabs)");
});

/* ---------------------------------------------- NAT-LEGAL-03 (fail-first) */

test("NAT-LEGAL-03 — 'Not now' at sign-in leaves for the destination without recording anything", async () => {
  globalThis.__EXPO_CAN_GO_BACK__ = false;
  globalThis.__EXPO_PARAMS__ = { policies: "terms,privacy", next: "/(tabs)/settings" };
  const r = await render();
  assert.ok(r.hasText("Until you accept, PROOVRA cannot save changes"), r.texts().join(" | "));
  await r.press("Not now");
  assert.equal(posts.length, 0, "Not now recorded an acceptance");
  assert.equal(M.calls.replace.at(-1), "/(tabs)/settings");
});

test("NAT-LEGAL-03 — 'Not now' over an interrupted screen goes back to it", async () => {
  globalThis.__EXPO_PARAMS__ = { policies: "terms" };
  const r = await render();
  await r.press("Not now");
  assert.equal(posts.length, 0);
  assert.equal(M.calls.back, 1);
});

/* ---------------------------------------------- NAT-LEGAL-04 (fail-first) */

test("NAT-LEGAL-04 — next=/legal-acceptance never re-opens the gate (no loop), and //host is not a destination", async () => {
  accepted = { ...required };
  globalThis.__EXPO_CAN_GO_BACK__ = false;
  for (const next of ["/legal-acceptance", "/(stack)/legal-acceptance?next=/x", "//evil.example/path", "/\\evil.example"]) {
    M.calls.reset();
    globalThis.__EXPO_PARAMS__ = { next };
    await render();
    assert.deepEqual(M.calls.replace, ["/(tabs)"], `next=${next} → ${JSON.stringify(M.calls.replace)}`);
  }
  assert.equal(M.safeLegalGateNext("/billing?tab=plans"), "/billing?tab=plans");
  assert.equal(M.safeLegalGateNext("/legal-acceptance"), null);
  assert.equal(M.safeLegalGateNext("//evil.example"), null);
  assert.equal(M.safeLegalGateNext("https://evil.example"), null);
  assert.equal(M.safeLegalGateNext(undefined), null);
});

/* --------------------------------------------- traced behaviour (pinned) */

test("trace: the gate lists only the missing policies with their required versions, each opening its document", async () => {
  globalThis.__EXPO_PARAMS__ = { next: "/billing" };
  const r = await render();
  assert.ok(r.hasText("Version 2026-09 · Read the document"));
  assert.ok(r.hasText("Version 2026-08 · Read the document"));
  assert.ok(!r.hasText("Version 2026-01 · Read the document"), "an already-accepted policy was listed");
  await r.press("Terms of Service");
  await r.press("Privacy Policy");
  assert.deepEqual(M.calls.push, ["/legal/terms", "/legal/privacy"]);
  assert.equal(posts.length, 0);
});

test("trace: accepting posts exactly the missing policies at the required versions, source mobile_legal_gate", async () => {
  globalThis.__EXPO_PARAMS__ = { next: "/billing" };
  const r = await render();
  await r.press("Accept and continue");
  await settle();
  assert.deepEqual(posts, [{ source: "mobile_legal_gate", acceptances: [{ policyKey: "terms", policyVersion: "2026-09" }, { policyKey: "privacy", policyVersion: "2026-08" }] }]);
  assert.equal(M.calls.replace.at(-1), "/billing");
});

test("trace: a status read that fails shows a retry, and records nothing", async () => {
  const real = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (url, init) => (String(url).endsWith("/v1/users/legal-status") && fail ? reply(503, { error: { code: "SERVICE_UNAVAILABLE", message: "x" } }) : real(url, init));
  const r = await render();
  assert.ok(r.byLabel("Try again").length > 0 || r.byLabel("Retry").length > 0, r.texts().join(" | "));
  assert.equal(posts.length, 0);
  fail = false;
  await r.press(r.byLabel("Try again").length > 0 ? "Try again" : "Retry");
  await settle();
  assert.ok(r.hasText("Version 2026-09 · Read the document"));
});

test("trace: a failed save keeps the gate with the message and the list", async () => {
  globalThis.__EXPO_PARAMS__ = { next: "/billing" };
  refuseNext = () => reply(500, { error: { code: "INTERNAL", message: "boom at row 3" } });
  const r = await render();
  await r.press("Accept and continue");
  await settle();
  assert.equal(M.calls.replace.length, 0);
  assert.ok(r.hasText("Version 2026-09 · Read the document"));
  assert.ok(!r.hasText("boom at row 3"), "raw server text leaked");
});

test("trace: the 428 interceptor opens the gate once per burst, carrying the missing policies", async () => {
  M.calls.reset();
  M.triggerLegalGate(["terms"]);
  M.triggerLegalGate(["terms"]);
  assert.deepEqual(M.calls.push, [{ pathname: "/legal-acceptance", params: { policies: "terms" } }]);
});
