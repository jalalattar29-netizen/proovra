/**
 * PRO-113 / MOBILE-01 and PRO-116 / MOBILE-04 — a verification link that
 * belongs to ANOTHER account, opened on a signed-in device.
 *
 * Since 432b7d10e the link alone no longer signs anyone in: the server asks for
 * the link owner's password. What remained: once that password was typed (an
 * attacker can talk a victim into typing a password the attacker chose), the
 * screen replaced the signed-in session without asking, never revoked it and
 * never tore capture down. Every reply below is the real route's shape
 * (auth.routes.ts email/verify, logout, me).
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let Verify;
let Settings;
let requests = [];
let answer;

const VICTIM = { id: "u-victim", email: "victim@example.invalid" };
const OWNER = { id: "u-owner", email: "owner@example.invalid" };
const json = (status, body) => ({ status, body });

before(async () => {
  Verify = await loadModule("app/(stack)/verify-email.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/capture/capture-session-store.ts",
  ]);
  Settings = await loadModule("app/(tabs)/settings.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

/** The route table: who the bearer is, and what the verify link mints. */
function server({ sessions, linkUser, linkToken = "sess-link" }) {
  return (path, init) => {
    const bearer = (new Headers(init.headers || {}).get("authorization") || "").replace(/^Bearer /, "");
    if (path === "/v1/auth/me") {
      const u = sessions[bearer];
      return u ? json(200, { user: u }) : json(401, { error: { code: "UNAUTHORIZED" } });
    }
    if (path === "/v1/auth/email/verify") {
      const b = init.body ? JSON.parse(init.body) : {};
      if (!b.password) return json(403, { error: { code: "EMAIL_VERIFICATION_PASSWORD_REQUIRED", message: "Enter the password." } });
      sessions[linkToken] = linkUser;
      return json(200, { token: linkToken, user: linkUser });
    }
    if (path === "/v1/auth/logout") {
      delete sessions[bearer];
      return json(200, { ok: true });
    }
    if (path === "/v1/users/legal-status") return json(200, { ok: true, missingPolicies: [], requiredVersions: {} });
    if (path === "/v1/platform/context") return json(200, { activeSpace: null });
    if (path.endsWith("/discard")) return json(200, { result: { discarded: true } });
    return json(200, {});
  };
}

beforeEach(() => {
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const auth = new Headers(init.headers || {}).get("authorization");
    requests.push({ method: init.method || "GET", path, auth, body: init.body ? JSON.parse(init.body) : null });
    const a = answer(path, init);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
});
const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});
const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const hold = async () => {
  await act(async () => { await new Promise((x) => setTimeout(x, 1400)); });
  await settle();
};
const logouts = () => requests.filter((q) => q.path === "/v1/auth/logout").map((q) => q.auth);

async function openLink({ signedInAs }) {
  const M = Verify;
  M.AsyncStorage.__reset();
  await M.deleteItemAsync("proovra-token");
  if (signedInAs) {
    await M.setItemAsync("proovra-token", signedInAs);
    await M.setItemAsync("proovra-auth-mode", "email");
  }
  globalThis.__EXPO_PARAMS__ = { token: "link-verification-token" };
  M.calls.reset();
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
}

async function typeOwnerPassword(r) {
  assert.equal(r.byTestId("verify-password").length, 1, "the link alone must still ask for the password");
  await r.type("Password", "the-owner-password");
  await r.press("Verify my email");
  await settle();
}

test("PRO-113: a foreign link on a signed-in device asks before switching, and nothing changes while it asks", async () => {
  answer = server({ sessions: { "sess-victim": VICTIM }, linkUser: OWNER });
  const r = await openLink({ signedInAs: "sess-victim" });
  await typeOwnerPassword(r);
  await hold();
  assert.equal(r.byTestId("verify-switch-account").length, 1, "no account-switch question");
  assert.ok(r.hasText(`This device is signed in as ${VICTIM.email}. The link you opened belongs to ${OWNER.email}.`));
  assert.equal(await Verify.getItemAsync("proovra-token"), "sess-victim", "the session was replaced without asking");
  assert.deepEqual(logouts(), []);
  assert.equal(Verify.calls.replace.length, 0, "it navigated before the answer");
});

test("PRO-113: Stay signed in revokes the session the link created and keeps the current one", async () => {
  answer = server({ sessions: { "sess-victim": VICTIM }, linkUser: OWNER });
  const r = await openLink({ signedInAs: "sess-victim" });
  await typeOwnerPassword(r);
  await r.press("Stay signed in");
  await settle();
  assert.deepEqual(logouts(), ["Bearer sess-link"], "the link's session was left live, or the wrong one was revoked");
  assert.equal(await Verify.getItemAsync("proovra-token"), "sess-victim");
  assert.equal(Verify.calls.replace.at(-1), "/(tabs)");
});

test("PRO-113 / PRO-116: Switch ends the current account first — capture torn down, old session revoked, residue gone", async () => {
  answer = server({ sessions: { "sess-victim": VICTIM }, linkUser: OWNER });
  const r = await openLink({ signedInAs: "sess-victim" });
  // The victim's own staged capture and its link group, bound to the victim.
  await Verify.saveCaptureSession({
    captureSessionId: "cs-victim", expiresAtUtc: "", evidenceId: "ev-v", type: "PHOTO",
    items: [{ id: "i1", uri: "file:///cache/victim.jpg", mimeType: "image/jpeg", partIndex: 0, source: "CAMERA", uploaded: false }],
  });
  await Verify.AsyncStorage.setItem("proovra.capture.links.v1:u-victim", JSON.stringify({ groups: [{ id: "g1", members: [] }] }));
  await Verify.AsyncStorage.setItem("proovra:user:u-victim:tenant:t1:search:recent", JSON.stringify(["restricted matter"]));
  await typeOwnerPassword(r);
  await r.press("Switch to this account");
  await settle(20);

  const discard = requests.find((q) => q.path === "/v1/capture/direct-sessions/cs-victim/discard");
  assert.ok(discard, "the victim's open capture session was not released");
  assert.equal(discard.auth, "Bearer sess-victim", "capture was released under the wrong session");
  assert.ok(logouts().includes("Bearer sess-victim"), "the replaced session was not revoked");
  const revokeAt = requests.findIndex((q) => q.path === "/v1/auth/logout" && q.auth === "Bearer sess-victim");
  assert.ok(requests.indexOf(discard) < revokeAt, "capture must be released while the old token is still valid");
  assert.equal(await Verify.AsyncStorage.getItem("proovra.capture.links.v1:u-victim"), null, "capture-link groups survived the switch");
  assert.equal(await Verify.AsyncStorage.getItem("proovra:user:u-victim:tenant:t1:search:recent"), null);
  assert.equal(await Verify.getItemAsync("proovra-token"), "sess-link");
  assert.equal(Verify.calls.replace.at(-1), "/(tabs)");
});

test("control: a signed-out device verifies and continues as before, with no question", async () => {
  answer = server({ sessions: {}, linkUser: OWNER });
  const r = await openLink({ signedInAs: null });
  await typeOwnerPassword(r);
  assert.equal(r.byTestId("verify-success").length, 1);
  await hold();
  assert.equal(r.byTestId("verify-switch-account").length, 0);
  assert.equal(await Verify.getItemAsync("proovra-token"), "sess-link");
  assert.deepEqual(logouts(), []);
});

test("control: the account's own link, while signed in to it, needs no question and leaves no second live session", async () => {
  answer = server({ sessions: { "sess-old": OWNER }, linkUser: OWNER });
  const r = await openLink({ signedInAs: "sess-old" });
  await typeOwnerPassword(r);
  assert.equal(r.byTestId("verify-switch-account").length, 0);
  await hold();
  assert.deepEqual(logouts(), ["Bearer sess-old"], "the superseded session of the same account stayed live");
  assert.equal(await Verify.getItemAsync("proovra-token"), "sess-link");
  assert.equal(requests.filter((q) => q.path.endsWith("/discard")).length, 0, "the same account's capture was torn down");
});

test("PRO-116: Settings sign-out removes the capture-link groups with the rest of the account's residue", async () => {
  const A = Settings.AsyncStorage;
  A.__reset();
  await Settings.setItemAsync("proovra-token", "sess-user1");
  await A.setItem("proovra.capture.links.v1:u-user1", JSON.stringify({ groups: [{ id: "g1", members: [] }] }));
  await A.setItem("proovra.capture.links.v1:u-other", JSON.stringify({ groups: [{ id: "g2", members: [] }] }));
  answer = server({ sessions: { "sess-user1": { id: "u-user1", email: "user1@example.invalid" } }, linkUser: OWNER });
  Settings.calls.reset();
  globalThis.__EXPO_PARAMS__ = {};
  const r = await renderComponent(h(Settings.TestProviders, null, h(Settings.default, {})));
  mounted.push(r);
  await settle(12);
  await r.press("Sign out");
  await settle(12);
  assert.ok(logouts().includes("Bearer sess-user1"), "positive control: server sign-out");
  assert.equal(await A.getItem("proovra.capture.links.v1:u-user1"), null, "the signed-out account's link groups stayed");
  // Another account's groups (whose records a server-ended session kept) are not this sign-out's to remove.
  assert.notEqual(await A.getItem("proovra.capture.links.v1:u-other"), null);
});
