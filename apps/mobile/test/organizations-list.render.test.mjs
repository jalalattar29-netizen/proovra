/**
 * T-14 — /organizations (page.tsx:283 / :291 enterprise info, :352 paste-token
 * join). Native had neither the Enterprise explanation nor any way to join an
 * organization from a token someone pasted to you.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
before(async () => {
  M = await loadModule("app/(stack)/organizations/index.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  // GET /v1/me/orgs replies { summary: { totalOrgs }, orgs: [...] } (organizations.routes.ts:337).
  routes = { ...authenticatedRoutes(), "/v1/me/orgs": () => ({ summary: { totalOrgs: 0 }, orgs: [] }) };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).find((p) => path.startsWith(p));
    const res = key ? routes[key]() : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);
});
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  return r;
};

test("About Enterprise organizations explains provisioning and says where a workspace comes from", async () => {
  const r = await render();
  await r.press("About Enterprise organizations");
  assert.ok(r.texts().some((t) => t.startsWith("Organizations are the legal, billing, and governance boundary")));
  assert.ok(r.texts().some((t) => t.startsWith("New workspaces are set up with PROOVRA")), "the sheet invited a workspace creation that cannot succeed");
  await r.press("Close");
  assert.equal(r.byTestId("enterprise-info").length === 0 || !r.hasText("Organizations are the legal, billing, and governance boundary for PROOVRA Enterprise customers. They are provisioned as part of an Enterprise agreement — they cannot be created self-service."), true);
});

test("a pasted invite token goes to the one accept screen; Cancel does nothing", async () => {
  const r = await render();
  await r.press("Accept invite token");
  await r.press("Cancel");
  assert.equal(M.calls.push.length, 0);
  await r.press("Accept invite token");
  await r.type("Invite token", "  oinv_abc/123  ");
  await r.press("Accept invite");
  assert.equal(M.calls.push.at(-1), "/org-invite/oinv_abc%2F123");
});

/* ---- web parity (organizations/page.tsx: header, empty state, org card, footer, error) ---- */

const ORG_ROW = {
  organizationId: "0a0a0a0a-0000-4000-8000-000000000009",
  name: "Acme Legal",
  status: "ACTIVE",
  role: "ORG_BILLING_ADMIN",
  orgCreatedAt: "2026-01-01T00:00:00.000Z",
  memberSince: "2026-02-03T00:00:00.000Z",
  memberCount: 1,
  workspaceCount: 3,
  pendingInviteCount: 2,
};
const settleList = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("the header carries the web eyebrow and subtitle; the footer says where workspace work lives", async () => {
  const r = await render();
  assert.ok(r.hasText("ACCOUNT · ORGANIZATIONS"));
  assert.ok(r.texts().some((t) => t.startsWith("Organizations are the governance + billing tenant.")));
  assert.ok(r.texts().some((t) => t.startsWith("Looking for evidence, cases, reviewer queues, or per-workspace billing?")));
  assert.equal(r.byTestId("organizations-footer").length, 1);
  r.unmount();
});

test("the empty state says what to do, with both of the web's calls to action", async () => {
  const r = await render();
  assert.ok(r.hasText("You’re not a member of any organization yet."));
  assert.ok(r.hasText("Accept an invite token if an organization administrator shared one with you."));
  assert.equal(r.byTestId("organizations-empty").length, 1);
  await r.press("Workspace administration");
  assert.equal(M.calls.push.at(-1), "/spaces");
  r.unmount();
});

test("each organization is a card: role, status and pending pills, counts, joined date, Open and Workspace admin", async () => {
  routes["/v1/me/orgs"] = () => ({ summary: { totalOrgs: 1 }, orgs: [ORG_ROW] });
  const r = await render();
  assert.equal(r.byTestId(`org-card-${ORG_ROW.organizationId}`).length, 1);
  assert.ok(r.hasText("Billing admin") && r.hasText("ACTIVE") && r.hasText("2 pending"));
  assert.ok(r.texts().some((t) => t.startsWith("1 member · 3 workspaces · you joined ")));
  await r.press(`Open ${ORG_ROW.name}`);
  assert.equal(M.calls.push.at(-1), `/organizations/${ORG_ROW.organizationId}`);
  await r.press("Workspace admin");
  assert.equal(M.calls.push.at(-1), "/spaces");
  r.unmount();
});

test("a load failure says Couldn’t load organizations with the status, and Retry reads again", async () => {
  let reads = 0;
  routes["/v1/me/orgs"] = () => {
    reads += 1;
    return reads === 1 ? { __status: 503, error: { code: "UNAVAILABLE" } } : { summary: { totalOrgs: 0 }, orgs: [] };
  };
  const r = await render();
  assert.ok(r.hasText("Couldn’t load organizations."));
  assert.ok(r.texts().some((t) => t.startsWith("HTTP 503")));
  await r.press("Retry");
  await settleList();
  assert.equal(reads, 2);
  assert.ok(r.hasText("You’re not a member of any organization yet."));
  r.unmount();
});
