/**
 * T-12 / RC-13 — a collaboration invite refused by the OWNER'S PLAN.
 *
 * The web shows a panel with "View billing" (aria "View billing and upgrade
 * options") and "Back to Teams" (accept/page.tsx:405, :440). Native showed a
 * generic error with "Try again" — a retry that cannot succeed, because only
 * the owner's plan can change the answer.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let acceptAnswer = () => ({ status: 409, body: { error: { code: "TEAM_MEMBER_LIMIT_REACHED", details: { plan: "PRO", maxMembersPerTeam: 5, currentMemberCount: 5 } } } });

before(async () => {
  M = await loadModule("app/(stack)/invite/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/api.ts"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { token: "tok" };
  const routes = authenticatedRoutes();
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/v1/collaboration-team-invites/accept") {
      const a = acceptAnswer();
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }
    const key = Object.keys(routes).find((p) => path.startsWith(p));
    return new Response(JSON.stringify(key ? routes[key]() : {}), { status: 200, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);
  // The screen reads the in-memory token at mount (signed-out → Sign In).
  M.setAuthToken("test-token");
});

async function renderAndAccept() {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  await r.press("Accept invitation");
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  return r;
}

test("at capacity: the web's title, the counts from the server, billing and back — no retry", async () => {
  const r = await renderAndAccept();
  assert.ok(r.hasText("This team is at capacity for the owner's plan"));
  assert.ok(r.hasText("The team owner needs to free a seat or upgrade their plan before you can join. (5 of 5 seats in use on plan PRO)"));
  assert.equal(r.byLabel("Try again").length, 0, "a retry that cannot succeed is offered");
  await r.press("View billing and upgrade options");
  assert.deepEqual(M.calls.push, ["/billing"]);
  await r.press("Back to Teams");
  assert.deepEqual(M.calls.replace, ["/teams"]);
});

test("plan no longer supports invites: 'This invitation is unavailable'", async () => {
  acceptAnswer = () => ({ status: 402, body: { error: { code: "TEAM_INVITES_NOT_INCLUDED" } } });
  const r = await renderAndAccept();
  assert.ok(r.hasText("This invitation is unavailable"));
  assert.ok(r.hasText("The Team owner's current plan no longer supports this invitation."));
});

test("no counts are invented when the server gives none", () => {
  assert.equal(
    M.inviteRefusal({ code: "TEAM_MEMBER_LIMIT_REACHED" }).body,
    "The team owner needs to free a seat or upgrade their plan before you can join.",
  );
});
