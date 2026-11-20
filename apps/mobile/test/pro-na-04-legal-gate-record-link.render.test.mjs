/**
 * PRO-NA-04 — a record link opened while signed out, when the sign-in passes
 * through the legal-acceptance gate first.
 *
 * The sign-in flow (src/auth/use-auth-flow.ts) keeps the link pending (route +
 * original URL) and opens the gate with { next: "/(tabs)", resume: "record-link" }.
 * Leaving the gate must replay the link through the SAME server resolve +
 * workspace switch a signed-in tap uses (replayRecordLinkAfterSignIn), never
 * the raw route in whatever workspace is active. The real screen and the real
 * apiFetch over a stubbed network.
 *
 * Acceptance: positive (switch to the record's workspace, then open it);
 * refusal (no access -> "This item is not available.", nothing opened);
 * a plain non-record destination is still handed over as its route.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let requests;
let resolveAnswer;
const mounted = [];

before(async () => {
  M = await loadModule("app/(stack)/legal-acceptance.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "test/support/react-native-stub.mjs",
    "src/deep-link/pending-intent.ts",
    "src/auth/legal-gate.ts",
  ]);
});

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  requests = [];
  resolveAnswer = () => reply(200, { ok: true, workspaceId: "team-B" });
  delete globalThis.__EXPO_CAN_GO_BACK__;
  globalThis.__EXPO_PARAMS__ = {};
  let accepted = false;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method: init.method ?? "GET", path, body });
    if (path === "/v1/users/legal-status") {
      const missing = accepted ? [] : ["terms"];
      return reply(200, { ok: accepted, requiresReacceptance: !accepted, missingPolicies: missing, acceptedVersions: {}, requiredVersions: { terms: "2026-11" } });
    }
    if (path === "/v1/users/legal-acceptance" && init.method === "POST") {
      accepted = true;
      return reply(200, { items: [] });
    }
    if (path === "/v1/deep-link/resolve") return resolveAnswer();
    if (path === "/v1/platform/context/switch-workspace") return reply(200, { activeWorkspaceId: "team-B" });
    return reply(200, {});
  };
  M.calls.reset();
  M.clearPendingRoute();
});
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  M.clearPendingRoute();
});
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};

test("PRO-NA-04 — after the gate, the record link is resolved, the app switches to the record's workspace, then opens it", async () => {
  M.setPendingRoute("/(stack)/evidence/ev-1", "proovra://evidence/ev-1");
  globalThis.__EXPO_PARAMS__ = { policies: "terms", next: "/(tabs)", resume: M.LEGAL_GATE_RESUME_RECORD_LINK };
  const r = await render();
  // Nothing is resolved before the terms are accepted.
  assert.equal(requests.some((q) => q.path === "/v1/deep-link/resolve"), false);
  await r.press("Accept and continue");
  await settle();
  assert.deepEqual(M.calls.replace, ["/(tabs)"]);
  const resolve = requests.find((q) => q.path === "/v1/deep-link/resolve");
  assert.deepEqual(resolve?.body, { resourceType: "evidence", resourceId: "ev-1" });
  const switchIdx = requests.findIndex((q) => q.path === "/v1/platform/context/switch-workspace");
  assert.ok(switchIdx > requests.indexOf(resolve), "the workspace switch follows the server resolve");
  assert.deepEqual(M.calls.push, ["/(stack)/evidence/ev-1"]);
  // One-shot: the intent is consumed.
  assert.equal(M.peekPendingRoute(), null);
});

test("PRO-NA-04 — refusal: a record the person cannot open is not opened and nothing is switched", async () => {
  resolveAnswer = () => reply(404, { error: { code: "not_found" } });
  const alerts = [];
  globalThis.__ALERT__ = (title, message) => alerts.push([title, message]);
  M.setPendingRoute("/(stack)/evidence/ev-2", "proovra://evidence/ev-2");
  globalThis.__EXPO_PARAMS__ = { policies: "terms", next: "/(tabs)", resume: M.LEGAL_GATE_RESUME_RECORD_LINK };
  const r = await render();
  await r.press("Accept and continue");
  await settle();
  assert.deepEqual(M.calls.replace, ["/(tabs)"]);
  assert.ok(requests.some((q) => q.path === "/v1/deep-link/resolve"));
  assert.equal(requests.some((q) => q.path === "/v1/platform/context/switch-workspace"), false);
  assert.deepEqual(M.calls.push, []);
  assert.deepEqual(alerts, [["Not available", "This item is not available."]]);
  assert.equal(M.peekPendingRoute(), null);
  delete globalThis.__ALERT__;
});

test("PRO-NA-04 — the gate opened without the resume marker (428 interceptor, plain destination) leaves a pending route alone", async () => {
  M.setPendingRoute("/invite/tok", null);
  globalThis.__EXPO_PARAMS__ = { policies: "terms", next: "/billing" };
  const r = await render();
  await r.press("Accept and continue");
  await settle();
  assert.deepEqual(M.calls.replace, ["/billing"]);
  assert.equal(requests.some((q) => q.path === "/v1/deep-link/resolve"), false);
  assert.equal(M.peekPendingRoute(), "/invite/tok");
});

test("PRO-NA-04 — takePendingRecordLink takes only a record link", () => {
  M.setPendingRoute("/(tabs)/notifications");
  assert.equal(M.takePendingRecordLink(), null);
  assert.equal(M.peekPendingRoute(), "/(tabs)/notifications");
  M.setPendingRoute("/(stack)/evidence/ev-3", "proovra://evidence/ev-3");
  assert.equal(M.takePendingRecordLink(), "proovra://evidence/ev-3");
  assert.equal(M.peekPendingRoute(), null);
});

/* -------- the sign-in half: useCompleteLogin hands the gate the record link */

test("PRO-NA-04 — signing in with terms owed keeps the record link pending and opens the gate in resume mode", async () => {
  const F = await loadModule("test/support/providers.tsx", [
    "test/support/expo-stub.mjs",
    "src/auth/use-auth-flow.ts",
    "src/deep-link/pending-intent.ts",
    "src/auth/legal-gate.ts",
  ]);
  F.calls.reset();
  F.clearPendingRoute();
  F.setPendingRoute("/(stack)/evidence/ev-9", "proovra://evidence/ev-9");
  let complete = null;
  function Probe() {
    complete = F.useCompleteLogin();
    return null;
  }
  const r = await renderComponent(h(F.TestProviders, null, h(Probe)));
  mounted.push(r);
  await settle();
  await act(async () => {
    await complete({ kind: "session", token: "tok-na04", user: { id: "u-1", email: "a@example.test" } }, "email");
  });
  await settle();
  const gate = F.calls.replace.find((x) => typeof x === "object" && x?.pathname === "/legal-acceptance");
  assert.ok(gate, JSON.stringify(F.calls.replace));
  assert.equal(gate.params.next, "/(tabs)", "the raw record route is not handed to the gate");
  assert.equal(gate.params.resume, F.LEGAL_GATE_RESUME_RECORD_LINK);
  // The link waits behind the gate with its original URL; nothing resolved yet.
  assert.equal(F.takePendingRecordLink(), "proovra://evidence/ev-9");
  assert.equal(requests.some((q) => q.path === "/v1/deep-link/resolve"), false);
  F.clearPendingRoute();
});
