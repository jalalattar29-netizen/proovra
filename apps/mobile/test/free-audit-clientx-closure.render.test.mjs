/**
 * CLIENT-X — B3A-F-008 (native half).
 *
 * `POST /v1/teams/:id/reopen` now (1) answers a non-owner exactly like an
 * unknown id — 404 `team_not_found` — and (2) is about to require the same
 * account step-up closure requires. Before: native sent `{}` once with no
 * step-up loop (a STEP_UP_REQUIRED surfaced as a generic failure and the
 * reopen could never complete), and the 404 said "This workspace no longer
 * exists" to a non-owner of a live workspace.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
const TEAM = "7e000000-0000-4000-8000-0000000000aa";
let M;
let requests = [];
let reopenAnswer;

before(async () => {
  M = await loadModule("src/ui/workspace-closure-card.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  reopenAnswer = (body) =>
    body?.stepUp?.currentPassword === "pw-ok"
      ? { __status: 200, reopened: { teamId: TEAM } }
      : { __status: 401, error: { code: "STEP_UP_REQUIRED", methods: ["password"] } };
  const routes = {
    ...authenticatedRoutes(),
    [`/v1/teams/${TEAM}/closure`]: () => ({
      request: { id: "req-1", status: "COMPLETED" },
      blockers: [],
      confirmationPhrase: "CLOSE",
      coolingOffDays: 7,
    }),
    [`/v1/teams/${TEAM}/reopen`]: (_m, body) => reopenAnswer(body),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });
    const res = routes[path] ? routes[path](method, body) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const reopens = () => requests.filter((q) => q.method === "POST" && q.path === `/v1/teams/${TEAM}/reopen`);

test("B3A-F-008: reopen answers a step-up challenge with the sheet and retries the SAME request with stepUp", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.WorkspaceClosureCard, { teamId: TEAM })));
  await settle();
  await r.press("Reopen workspace");
  await settle();
  assert.equal(reopens().length, 1);
  assert.deepEqual(reopens()[0].body, {}, "the first attempt carries no proof");
  assert.ok(r.hasText("This action needs one more proof that it is you."), "no step-up sheet was raised for STEP_UP_REQUIRED");
  await r.type("Your password", "pw-ok");
  await r.press("Confirm");
  await settle();
  assert.equal(reopens().length, 2, "the reopen was not retried with the proof");
  assert.deepEqual(reopens()[1].body, { stepUp: { method: "password", currentPassword: "pw-ok" } });
  assert.ok(r.hasText("Workspace reopened."), "the reopened notice did not show");
});

test("B3A-F-008: an API that does not enforce step-up yet reopens on the first attempt", async () => {
  reopenAnswer = () => ({ __status: 200, reopened: { teamId: TEAM } });
  const r = await renderComponent(h(M.TestProviders, null, h(M.WorkspaceClosureCard, { teamId: TEAM })));
  await settle();
  await r.press("Reopen workspace");
  await settle();
  assert.equal(reopens().length, 1);
  assert.ok(r.hasText("Workspace reopened."));
  assert.ok(!r.hasText("This action needs one more proof that it is you."));
});

test("B3A-F-008: 404 team_not_found (non-owner) says not found OR not the owner, never that it was deleted", async () => {
  reopenAnswer = () => ({ __status: 404, error: { code: "team_not_found" } });
  const r = await renderComponent(h(M.TestProviders, null, h(M.WorkspaceClosureCard, { teamId: TEAM })));
  await settle();
  await r.press("Reopen workspace");
  await settle();
  assert.ok(r.hasText("This workspace could not be found, or you are not its owner."), r.texts().join(" | "));
  assert.ok(!r.hasText("no longer exists"));
  assert.ok(!r.hasText("Only its owner can"));
});
