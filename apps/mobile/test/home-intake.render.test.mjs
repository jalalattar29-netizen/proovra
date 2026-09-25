/**
 * T-15 / T-14 — Home "Intake status" (GET /v1/communications/messages?purpose=INTAKE_LINK).
 * Native Home carried an aggregate Intake KPI only: no stage counts, no latest
 * delivery per link, no Retry on a failed send.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

const LINKS = {
  items: [],
  links: [
    { id: "l1", recipientLabel: "Dana (witness)", status: "ACTIVE", usedCount: 0, maxUses: 3, expiresAtUtc: "2099-01-01T00:00:00.000Z" },
    { id: "l2", recipientLabel: "Acme claims", status: "ACTIVE", usedCount: 1, maxUses: null, expiresAtUtc: "2099-01-01T00:00:00.000Z" },
    { id: "l3", recipientLabel: "Old link", status: "EXPIRED", usedCount: 0, maxUses: 1, expiresAtUtc: "2020-01-01T00:00:00.000Z" },
  ],
};
const MESSAGES = {
  messages: [
    // l1: an older delivered message, then a newer FAILED one — the newest decides.
    { id: "m1", channel: "SMS", status: "DELIVERED", createdAt: "2026-09-20T10:00:00.000Z", deliveredAtUtc: "2026-09-20T10:01:00.000Z", relatedIntakeLinkId: "l1" },
    { id: "m2", channel: "SMS", status: "FAILED", createdAt: "2026-09-21T10:00:00.000Z", failedAtUtc: "2026-09-21T10:00:05.000Z", relatedIntakeLinkId: "l1" },
    { id: "m3", channel: "EMAIL", status: "DELIVERED", createdAt: "2026-09-22T10:00:00.000Z", deliveredAtUtc: "2026-09-22T10:00:09.000Z", relatedIntakeLinkId: "l2" },
  ],
};

before(async () => {
  M = await loadModule("app/(tabs)/index.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  M.calls.reset();
  routes = {
    ...authenticatedRoutes(),
    "/v1/platform/context": () => platformContextEnvelope({ planFeatures: { intakeIncluded: true } }),
    "/v1/evidence": () => ({ items: [] }),
    "/v1/dashboard/command-center": () => ({}),
    "/v1/dashboard/trust-summary": () => ({}),
    "/v1/billing/overview": () => ({}),
    "/v1/reports": () => ({ items: [] }),
    "/v1/workflow/intake-links": () => LINKS,
    "/v1/communications/messages": () => MESSAGES,
    "/v1/communications/messages/m2/retry": () => ({ message: { id: "m2", status: "RETRY_SCHEDULED" } }),
    "/v1/me/inbox": () => ({
      items: [
        { id: "i1", category: "intake_submission_pending_review", title: "t", href: "/x", occurredAt: "2026-09-22T00:00:00Z", context: { teamId: TEST_TEAM_ID } },
        { id: "i2", category: "intake_submission_pending_review", title: "t", href: "/x", occurredAt: "2026-09-22T00:00:00Z", context: { teamId: "another-team" } },
      ],
    }),
    "/v1/cases": () => ({ items: [] }),
    "/v1/evidence/records-by-type": () => ({}),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
/** The web renders these modules under a "Workspace views" tab; open it first. */
const render = async (view = "Operations") => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  if (view !== "Overview") await r.press(`Workspace views: ${view}`);
  return r;
};

test("stage counts are six distinct real numbers, scoped to this workspace", async () => {
  const r = await render();
  const msg = requests.find((q) => q.path.startsWith("/v1/communications/messages?"));
  assert.ok(msg, "Home never read intake deliveries");
  assert.ok(msg.path.includes("purpose=INTAKE_LINK") && msg.path.includes(`teamId=${TEST_TEAM_ID}`));
  assert.ok(r.hasText("Intake status"));
  for (const [label, n] of [
    ["Active links", 2], // l3 is EXPIRED
    ["Delivered", 2], // m1 + m3 carry deliveredAtUtc
    ["Awaiting response", 1], // l1 never used
    ["Pending review", 1], // the other team's item is excluded
    ["Needs more info", 0],
    ["Failed sends", 1], // l1's NEWEST message failed
  ]) {
    assert.equal(r.byLabel(`${label}: ${n}`).length, 1, `${label} is not ${n}`);
  }
  assert.ok(r.hasText("Dana (witness)") && r.hasText("Acme claims") && !r.hasText("Old link"));
});

test("a failed latest send offers Retry delivery, which posts the workspace", async () => {
  const r = await render();
  await r.press("Retry delivery: Dana (witness)");
  await settle();
  const retry = requests.find((q) => q.path === "/v1/communications/messages/m2/retry");
  assert.ok(retry && retry.method === "POST");
  assert.deepEqual(retry.body, { teamId: TEST_TEAM_ID });
});

test("a refused retry falls back to the link's delivery history", async () => {
  routes["/v1/communications/messages/m2/retry"] = () => ({ __status: 409, error: { code: "not_retryable" } });
  const r = await render();
  await r.press("Retry delivery: Dana (witness)");
  await settle();
  await r.press("Open delivery →");
  assert.deepEqual(M.calls.push.at(-1), { pathname: "/intake-links", params: { linkId: "l1" } });
});

test("a delivery read that failed says so instead of drawing zeros", async () => {
  routes["/v1/communications/messages"] = () => ({ __status: 500 });
  const r = await render();
  assert.ok(r.hasText("Intake status could not be loaded, so these counts are not shown."));
  assert.equal(r.byLabel("Failed sends: 0").length, 0);
});

test("a plan without intake sees the upsell, not a pipeline", async () => {
  routes["/v1/platform/context"] = () => platformContextEnvelope({ planFeatures: { intakeIncluded: false } });
  const r = await render();
  assert.ok(r.texts().some((t) => t.includes("Available on Pro and Team.")), "no upsell shown");
  assert.equal(r.byLabel("Active links: 2").length, 0);
});
