/**
 * B5A-F-03 (A2-14) — native record detail offers only what the caller may do.
 *
 * A VIEWER was offered Lock, Archive, Move to trash and Edit name; a MEMBER
 * Archive and Move to trash. Each failed with the server's concealed "not
 * found". The caller's role in the record's OWN workspace (envelope) feeds the
 * canonical role matrix the server enforces.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes;
let rendered;
let role;
let recordTeamId;

const LIFECYCLE = {
  productState: "ACTIVE", canArchive: true, canUnarchive: false, canTrash: true, canRestoreFromTrash: false,
  canRestoreFromArchive: false, trashBlockReason: null, archiveBlockReason: null, legalHold: false,
};

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  role = "VIEWER";
  recordTeamId = TEST_TEAM_ID;
  routes = {
    ...authenticatedRoutes(),
    "/v1/platform/context": () =>
      platformContextEnvelope({ workspace: { id: TEST_TEAM_ID, membership: { role } } }),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] }, reviewWorkflow: { teamId: TEST_TEAM_ID } }),
    "/v1/evidence/ev-1": () => ({
      evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO", teamId: recordTeamId, lockedAt: null, lifecycle: LIFECYCLE },
    }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : { __status: 404 };
    return new Response(JSON.stringify(res), { status: res.__status ?? 200, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
afterEach(() => {
  if (rendered) rendered.unmount();
  rendered = null;
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
async function mount() {
  rendered = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return rendered;
}
const has = (r, label) => r.byLabel(label).length > 0;

test("a VIEWER sees no Lock, Archive, Move to trash or Edit name", async () => {
  const r = await mount();
  assert.ok(has(r, "Copy verification link"), "the screen did not render");
  for (const label of ["Lock", "Archive", "Move to trash", "Edit name"]) assert.equal(has(r, label), false, `${label} offered to a VIEWER`);
});

test("a MEMBER keeps Lock and Edit name but sees no Archive or Move to trash", async () => {
  role = "MEMBER";
  const r = await mount();
  assert.ok(has(r, "Lock"));
  assert.ok(has(r, "Edit name"));
  assert.equal(has(r, "Archive"), false);
  assert.equal(has(r, "Move to trash"), false);
});

test("an OWNER is unchanged", async () => {
  role = "OWNER";
  const r = await mount();
  for (const label of ["Lock", "Archive", "Move to trash", "Edit name"]) assert.ok(has(r, label), `${label} missing for OWNER`);
});

test("a personal-scope record keeps every control for its owner", async () => {
  recordTeamId = null;
  const r = await mount();
  for (const label of ["Lock", "Archive", "Edit name"]) assert.ok(has(r, label), `${label} missing on a personal record`);
});
