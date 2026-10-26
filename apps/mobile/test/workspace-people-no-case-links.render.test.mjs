/**
 * MEMBERS RE-AUDIT DEFECT 21 — the native destinations manifest documented
 * "CASE LINKS ported" for the mobile People screen after case linking was
 * removed from it (MEM-05). The manifest is the parity record; it must state
 * what the screen does, and the screen must indeed offer no case-link control
 * and make no case-link request.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";
import { NATIVE_DESTINATIONS } from "../src/product/native-destinations.mjs";

const h = React.createElement;
let M;

before(async () => {
  M = await loadModule("app/(stack)/workspace-people.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

test("the manifest does not claim case links on the People screen", () => {
  const gaps = NATIVE_DESTINATIONS["/teams/[id]"].gaps.join("\n");
  assert.doesNotMatch(gaps, /CASE LINKS ported|POST \/cases\/link/);
  assert.match(gaps, /NO CASE LINKS on this screen/);
});

test("the People screen renders no case-link control and sends no case-link request", async () => {
  const requests = [];
  const routes = {
    ...authenticatedRoutes(),
    "/v1/teams/team-1/members": () => ({ members: [], nextCursor: null, total: 0 }),
    "/v1/teams/team-1/invites": () => ({ invites: [] }),
    "/v1/teams/team-1/cases": () => ({ items: [{ id: "c-1", name: "Harbour claim", teamId: "team-1" }] }),
    "/v1/teams/team-1/activity": () => ({ activities: [] }),
    "/v1/teams/team-1": () => ({
      id: "team-1",
      name: "Acme",
      ownerUserId: "u-own",
      currentUserRole: "ADMIN",
      canManageMembers: true,
      canManageWorkspace: false,
      effectivePlan: "team",
      stats: { memberCount: 1, pendingInviteCount: 0, caseCount: 1, seatLimit: null, seatUsed: null, seatAvailable: null },
      memberPage: { total: 0, returned: 0, hasMore: false, endpoint: "/v1/teams/team-1/members" },
      members: [],
    }),
    "/v1/cases": () => ({ items: [{ id: "c-3", name: "Free case", teamId: null }] }),
    "/v1/me/inbox/summary": () => ({ unread: 0 }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    return new Response(JSON.stringify(res ?? {}), { status: res === undefined ? 500 : 200, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);

  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });

  assert.ok(r.hasText("Members & Access"));
  for (const t of r.texts()) assert.doesNotMatch(t, /link (a )?case|unlink/i);
  assert.equal(requests.filter((q) => /\/cases\/link|\/teams\/team-1\/cases\/c-/.test(q.path)).length, 0);
  r.unmount();
});
