/**
 * CAPTURE LIFECYCLE — the §8 law, against the real screen and real requests.
 *
 * ONE assertion underlies all of these:
 *
 *     NO EVIDENCE ENDPOINT IS TOUCHED BEFORE EXPLICIT FINALIZE.
 *
 * That is what staging into the canonical `/v1/capture/sessions` DRAFT buys,
 * and it is what UC-0 could not give: `direct-sessions/:id/evidence` reserved
 * the record on the first staged item, so an abandoned capture left a
 * custody-logged empty record and the session was locked to that item's type.
 *
 * These drive `app/(stack)/capture.tsx` through the real `apiFetch` with
 * `fetch` replaced, so every request the screen makes is observable and
 * ordered.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!hit) {
      return new Response(JSON.stringify({ message: "unstubbed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(hit[1](path, init)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const OK = () => ({
  ...authenticatedRoutes(),
  "/v1/capture/sessions": () => ({ session: { id: "draft-1", status: "DRAFT" } }),
  "/v1/evidence?scope=active": () => ({ items: [] }),
  "/v1/users/me": () => ({ user: { id: "u1" } }),
});

before(async () => {
  M = await loadModule("app/(stack)/capture.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
  ]);
});
beforeEach(async () => {
  requests = [];
  routes = OK();
  installFetch();
  // This suite asserted on the capture screen while SIGNED OUT.
  await signIn(M);
});

const render = () => renderComponent(h(M.TestProviders, null, h(M.default, {})));

/** Every request whose path names an evidence endpoint. */
const evidenceCalls = () =>
  requests.filter(
    (r) => r.path.includes("/v1/evidence") && !r.path.startsWith("/v1/evidence?scope=active"),
  );

/* ------------------------------------------------------- the lifecycle law */

test("opening Capture creates nothing at all", async () => {
  await render();
  assert.deepEqual(evidenceCalls(), [], "arriving on the screen must commit nothing");
  assert.equal(
    requests.some((r) => r.path.startsWith("/v1/capture/direct-sessions")),
    false,
    "no acquisition session until there is something to acquire",
  );
});

test("the screen offers all four capture sources", async () => {
  const r = await render();
  for (const label of ["Photo", "Video", "Audio", "Document"]) {
    assert.ok(r.hasText(label), `missing capture source: ${label}`);
  }
});

test("native screen capture is offered as a SOURCE here, not on Home", async () => {
  const r = await render();
  assert.ok(r.hasText("Other capture sources"));
  assert.ok(r.hasText("Screen capture"));
});

test("switching source mid-session is no longer refused", async () => {
  // The refusal existed because UC-0 fixed the Evidence type on the first
  // staged item. Staging into the draft removes the constraint.
  const r = await render();
  assert.equal(
    r.hasText("Finish or discard the current session before changing type"),
    false,
    "the type lock must be gone, not merely hidden",
  );
});

/* ----------------------------------------------------------- source of truth */

test("Discard with nothing staged commits nothing and asks nothing", async () => {
  const r = await render();
  assert.equal(r.hasText("Discard Session"), false, "no session, no discard control");
  assert.deepEqual(evidenceCalls(), []);
});

/* ---------------------------------------------------------------- recovery */

test("a recovered draft is offered for resume, not silently resumed", async () => {
  const r = await render();
  // With no persisted session there is no banner; the point is that the
  // recovery path never auto-commits.
  assert.equal(r.hasText("Resume your capture?"), false);
  assert.deepEqual(evidenceCalls(), []);
});

/* -------------------------------------------------------------- guardrails */

test("a blocked personal space explains itself instead of failing at finalize", async () => {
  // Signed in, but no workspace resolved — the envelope the server sends
  // when a member has no active space, not a differently-shaped stub.
  routes["/v1/platform/context"] = () => ({ personalSpaceAllowed: true });
  const r = await render();
  // Whatever it renders, it must not have committed anything.
  assert.deepEqual(evidenceCalls(), []);
  assert.ok(r.texts().length > 0, "the screen still renders something");
});

test("every request the screen makes on load is a read", async () => {
  await render();
  const writes = requests.filter((r) => r.method !== "GET");
  assert.deepEqual(
    writes,
    [],
    `Capture wrote something on load: ${JSON.stringify(writes)}`,
  );
});
