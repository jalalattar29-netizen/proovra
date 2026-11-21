/**
 * NEW-RG-26-4 (owner decision E) — the organization ownership-offer handoff on
 * the phone, end to end over the real screens and the real apiFetch:
 *
 *   link → DeepLinkGate (signed out: kept pending, sign-in) → useCompleteLogin
 *   replays the organization route (directly, or through the legal gate) →
 *   the organization screen reads the offer for THAT organization → the
 *   recipient accepts with their own step-up (or declines); the offerer
 *   withdraws; a non-party (another account on a shared phone) is told the
 *   linked offer is not open to them; an account the phone cannot step up is
 *   handed to the web page of the same organization.
 *
 * Before this, native had no recipient UI at all: the offer existed only on
 * the web (out-org.md: "Native recipient-acceptance UI is absent").
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, authMe, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const OFFER = "0b0b0b0b-0000-4000-8000-000000000002";
const LINK = `https://www.proovra.com/organizations/${ORG}?ownershipOffer=${OFFER}`;
const ROUTE = `/organizations/${ORG}?ownershipOffer=${OFFER}`;

let Screen;
let Gate;
let Flow;
let Legal;
let requests = [];
let routes = {};
let me = "user-1";
let offer;
let acceptAnswer;
const mounted = [];

before(async () => {
  Screen = await loadModule("app/(stack)/organizations/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  Gate = await loadModule("test/support/deep-link-gate-probe.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  Flow = await loadModule("test/support/providers.tsx", [
    "test/support/expo-stub.mjs",
    "src/auth/use-auth-flow.ts",
    "src/deep-link/pending-intent.ts",
    "src/auth/legal-gate.ts",
  ]);
  Legal = await loadModule("app/(stack)/legal-acceptance.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/deep-link/pending-intent.ts",
  ]);
});

const pendingOffer = (over = {}) => ({
  id: OFFER,
  organizationId: ORG,
  fromUserId: "u-owner",
  toUserId: "user-1",
  status: "PENDING",
  expiresAtUtc: "2026-11-28T00:00:00.000Z",
  ...over,
});

beforeEach(async () => {
  requests = [];
  me = "user-1";
  offer = pendingOffer();
  acceptAnswer = (body) =>
    body?.stepUp?.currentPassword === "pw-ok"
      ? { transferred: true, newOwnerUserId: me, previousOwnerUserId: "u-owner", billingOwnerTransferred: false, billingOwnerUserId: "u-owner", workspacesTransferred: 1 }
      : { __status: 401, error: { code: "STEP_UP_REQUIRED", methods: ["password", "mfa"] } };
  globalThis.__EXPO_PARAMS__ = { id: ORG, ownershipOffer: OFFER };
  delete globalThis.__EXPO_URL__;
  routes = {
    ...authenticatedRoutes({ "/v1/auth/me": () => authMe({ id: me, email: me === "user-1" ? "recipient@example.test" : "other@example.test" }) }),
    "/v1/users/legal-status": () => ({ ok: true, missingPolicies: [], requiredVersions: {} }),
    [`/v1/orgs/${ORG}/workspaces`]: () => ({ organizationId: ORG, workspaces: [] }),
    [`/v1/orgs/${ORG}/members`]: () => ({
      members: [
        { id: "m1", userId: "u-owner", displayName: "Olive Owner", email: "olive@example.test", role: "ORG_OWNER", status: "ACTIVE" },
        { id: "m2", userId: "user-1", displayName: "Rae Recipient", email: "recipient@example.test", role: "ORG_ADMIN", status: "ACTIVE" },
      ],
    }),
    [`/v1/orgs/${ORG}/audit-events`]: () => ({ events: [] }),
    [`/v1/orgs/${ORG}/closure`]: () => ({ closure: null }),
    [`/v1/orgs/${ORG}/invites`]: () => ({ invites: [] }),
    [`/v1/orgs/${ORG}/ownership-offer/${OFFER}/accept`]: (_m, body) => {
      const res = acceptAnswer(body);
      if (!res.__status) offer = null;
      return res;
    },
    [`/v1/orgs/${ORG}/ownership-offer/${OFFER}/decline`]: () => {
      offer = null;
      return { offer: pendingOffer({ status: "DECLINED" }) };
    },
    [`/v1/orgs/${ORG}/ownership-offer/${OFFER}/cancel`]: () => {
      offer = null;
      return { offer: pendingOffer({ status: "CANCELLED" }) };
    },
    // The server answers the offer to its two parties only.
    [`/v1/orgs/${ORG}/ownership-offer`]: () =>
      offer && (offer.toUserId === me || offer.fromUserId === me)
        ? { offer, billingOwnerStays: true, billingOwnerUserId: "u-owner" }
        : { offer: null },
    [`/v1/orgs/${ORG}`]: () => ({ organizationId: ORG, name: "Acme Legal", status: "ACTIVE", callerRole: me === "u-owner" ? "ORG_OWNER" : "ORG_ADMIN", summary: { memberCount: 2, workspaceCount: 0 } }),
    "/v1/deep-link/resolve": () => ({ ok: true, workspaceId: "team-1" }),
    "/v1/platform/context/switch-workspace": () => ({}),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });
    const bare = path.split("?")[0];
    const key = routes[bare] ? bare : Object.keys(routes).filter((p) => bare.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](method, body) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  for (const m of [Screen, Gate, Flow, Legal]) m.calls.reset();
  await signIn(Screen);
});
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  delete globalThis.__EXPO_PARAMS__;
  delete globalThis.__EXPO_URL__;
  delete process.env.EXPO_PUBLIC_WEB_BASE;
});

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async (M, child) => {
  const r = await renderComponent(h(M.TestProviders, null, child ?? h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
const posts = (suffix) => requests.filter((q) => q.method === "POST" && q.path.endsWith(suffix));

/* ------------------------------------------------------------ the link */

test("signed out: the ownership-offer link waits behind sign-in with the organization and offer, and nothing is resolved or switched", async () => {
  await Gate.deleteItemAsync("proovra-token");
  Gate.setAuthToken(null);
  globalThis.__EXPO_URL__ = LINK;
  await render(Gate, h(Gate.DeepLinkGate));
  assert.deepEqual(Gate.calls.replace, ["/(stack)/auth"]);
  assert.equal(Gate.peekPendingRoute(), ROUTE);
  assert.equal(requests.some((q) => q.path === "/v1/deep-link/resolve"), false);
  assert.equal(requests.some((q) => q.path === "/v1/platform/context/switch-workspace"), false);
  Gate.takePendingRoute();
});

test("signed in: the link opens the organization screen for that organization, without a workspace resolve or switch", async () => {
  await signIn(Gate);
  globalThis.__EXPO_URL__ = LINK;
  await render(Gate, h(Gate.DeepLinkGate));
  assert.deepEqual(Gate.calls.push, [ROUTE]);
  assert.equal(Gate.calls.replace.length, 0);
  assert.equal(requests.some((q) => q.path === "/v1/deep-link/resolve"), false);
  assert.equal(requests.some((q) => q.path === "/v1/platform/context/switch-workspace"), false);
});

test("refused: an admin-console path under the organization is not opened by the gate", async () => {
  await signIn(Gate);
  globalThis.__EXPO_URL__ = `https://www.proovra.com/organizations/${ORG}/admin/members`;
  await render(Gate, h(Gate.DeepLinkGate));
  assert.equal(Gate.calls.push.some((r) => String(r).startsWith("/organizations")), false);
  assert.equal(Gate.peekPendingRoute(), null);
});

/* ------------------------------------------------- sign-in, then resume */

test("after sign-in the pending organization route is opened (terms already accepted)", async () => {
  Flow.clearPendingRoute();
  Flow.setPendingRoute(ROUTE);
  let complete = null;
  function Probe() {
    complete = Flow.useCompleteLogin();
    return null;
  }
  await render(Flow, h(Probe));
  await act(async () => {
    await complete({ kind: "session", token: "tok-offer", user: { id: "user-1", email: "recipient@example.test" } }, "email");
  });
  await settle();
  assert.equal(Flow.calls.replace.at(-1), ROUTE);
  assert.equal(Flow.peekPendingRoute(), null, "the intent is one-shot");
});

test("after sign-in with terms owed, the legal gate carries the organization route and resumes it after acceptance", async () => {
  let accepted = false;
  routes["/v1/users/legal-status"] = () =>
    accepted
      ? { ok: true, missingPolicies: [], requiredVersions: { terms: "2026-11" } }
      : { ok: false, requiresReacceptance: true, missingPolicies: ["terms"], acceptedVersions: {}, requiredVersions: { terms: "2026-11" } };
  routes["/v1/users/legal-acceptance"] = () => {
    accepted = true;
    return { items: [] };
  };
  Flow.clearPendingRoute();
  Flow.setPendingRoute(ROUTE);
  let complete = null;
  function Probe() {
    complete = Flow.useCompleteLogin();
    return null;
  }
  await render(Flow, h(Probe));
  await act(async () => {
    await complete({ kind: "session", token: "tok-offer2", user: { id: "user-1", email: "recipient@example.test" } }, "email");
  });
  await settle();
  const gate = Flow.calls.replace.find((x) => typeof x === "object" && x?.pathname === "/legal-acceptance");
  assert.ok(gate, JSON.stringify(Flow.calls.replace));
  assert.equal(gate.params.next, ROUTE);
  assert.equal(Flow.safeLegalGateNext(gate.params.next), ROUTE, "the gate accepts the organization route as an in-app destination");

  globalThis.__EXPO_PARAMS__ = gate.params;
  const r = await render(Legal);
  await r.press("Accept and continue");
  await settle();
  assert.equal(Legal.calls.replace.at(-1), ROUTE);
});

/* ----------------------------------------------------- the offer itself */

test("the recipient sees the offer for this organization, with the billing owner who stays", async () => {
  const r = await render(Screen);
  assert.ok(requests.some((q) => q.method === "GET" && q.path === `/v1/orgs/${ORG}/ownership-offer`));
  assert.ok(r.hasText("Olive Owner has offered you ownership of Acme Legal"), r.texts().join(" | "));
  assert.ok(r.hasText("Billing does not move with ownership: the organization's billing owner stays Olive Owner."));
  assert.equal(r.byTestId("org-ownership-offer-link-notice").length, 0);
  assert.equal(r.byLabel("Withdraw offer").length, 0, "the recipient is not offered the offerer's control");
});

test("accept: the server's step-up is answered and the SAME request is sent again with the proof; ownership moves", async () => {
  const r = await render(Screen);
  await r.press("Accept ownership");
  await settle();
  assert.ok(r.hasText("This action needs one more proof that it is you."), "no step-up sheet for STEP_UP_REQUIRED");
  assert.ok(r.hasText("Confirm accepting ownership of this organization."));
  assert.equal(posts("/accept").length, 1);
  assert.deepEqual(posts("/accept")[0].body, {});
  await r.type("Your password", "pw-ok");
  await r.press("Confirm");
  await settle();
  const accepts = posts("/accept");
  assert.equal(accepts.length, 2);
  assert.equal(accepts[1].path, `/v1/orgs/${ORG}/ownership-offer/${OFFER}/accept`);
  assert.deepEqual(accepts[1].body, { stepUp: { method: "password", currentPassword: "pw-ok" } });
  assert.ok(r.hasText("You now own Acme Legal. Billing ownership did not change: the organization's billing owner is still Olive Owner."), r.texts().join(" | "));
  // The organization is re-read after acceptance.
  assert.ok(requests.filter((q) => q.method === "GET" && q.path === `/v1/orgs/${ORG}`).length >= 2);
});

test("accept refused: an offerer who lost ownership — the server's reason is shown and nothing is claimed", async () => {
  acceptAnswer = () => ({ __status: 409, error: { code: "ownership_offer_offerer_not_owner" } });
  const r = await render(Screen);
  await r.press("Accept ownership");
  await settle();
  assert.ok(r.hasText("The person who made this offer no longer owns the organization, so it was withdrawn. Nothing changed."), r.texts().join(" | "));
  assert.ok(!r.texts().some((t) => t.startsWith("You now own")));
});

test("accept with a wrong password: the sheet stays with the server's message; no transfer is reported", async () => {
  acceptAnswer = (body) =>
    body?.stepUp ? { __status: 401, error: { code: "STEP_UP_INVALID", methods: ["password"], message: "That password is not correct." } } : { __status: 401, error: { code: "STEP_UP_REQUIRED", methods: ["password"] } };
  const r = await render(Screen);
  await r.press("Accept ownership");
  await settle();
  await r.type("Your password", "wrong");
  await r.press("Confirm");
  await settle();
  assert.ok(r.hasText("That password is not correct."));
  assert.ok(!r.texts().some((t) => t.startsWith("You now own")));
});

test("decline: one POST to decline; ownership did not change", async () => {
  const r = await render(Screen);
  await r.press("Decline");
  await settle();
  assert.equal(posts("/decline").length, 1);
  assert.equal(posts("/decline")[0].path, `/v1/orgs/${ORG}/ownership-offer/${OFFER}/decline`);
  assert.equal(posts("/accept").length, 0);
  assert.ok(r.hasText("Offer declined. Ownership did not change."));
});

test("the offerer sees the pending offer and can withdraw it; no accept control", async () => {
  me = "u-owner";
  const r = await render(Screen);
  assert.ok(r.hasText("You offered ownership to Rae Recipient"), r.texts().join(" | "));
  assert.equal(r.byLabel("Accept ownership").length, 0);
  await r.press("Withdraw offer");
  await settle();
  assert.equal(posts("/cancel").length, 1);
  assert.ok(r.hasText("Offer withdrawn. Ownership did not change."));
});

test("shared phone: another account opens the link — it is told the offer is not open to it, and no control is offered", async () => {
  me = "user-2";
  const r = await render(Screen);
  assert.ok(r.hasText("not open to the account you are signed in as (other@example.test)"), r.texts().join(" | "));
  assert.equal(r.byLabel("Accept ownership").length, 0);
  assert.equal(r.byLabel("Decline").length, 0);
  assert.ok(!r.hasText("Olive Owner has offered you"));
});

test("no link and no offer for this account: the panel is absent", async () => {
  me = "user-2";
  globalThis.__EXPO_PARAMS__ = { id: ORG };
  const r = await render(Screen);
  assert.equal(r.byTestId("org-ownership-offer").length, 0);
});

test("an account the phone cannot step up (reauth only) is handed to the web page of the SAME organization", async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  acceptAnswer = () => ({ __status: 401, error: { code: "STEP_UP_REQUIRED", methods: ["reauth"] } });
  const r = await render(Screen);
  await r.press("Accept ownership");
  await settle();
  assert.ok(!r.hasText("This action needs one more proof that it is you."), "a dead step-up sheet was shown");
  assert.equal(r.byTestId("org-ownership-offer-web-handoff").length, 1);
  await r.press("Continue in the web app");
  assert.deepEqual(Screen.calls.openURL, [`https://www.proovra.com/organizations/${ORG}`]);
  assert.ok(!r.texts().some((t) => t.startsWith("You now own")));
});
