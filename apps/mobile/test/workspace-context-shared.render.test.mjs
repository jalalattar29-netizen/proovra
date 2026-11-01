/**
 * MOBILE-013 — one workspace context for everything mounted.
 *
 * The header, the shell and the tab screens stay mounted across a switch, and
 * each hook instance used to hold its own copy. These tests mount two real
 * consumers beside each other with the real AuthProvider, and move the server
 * pointer underneath them.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, platformContextEnvelope } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let Tab;
let routes = {};
let requests = [];
let pointer = "A";

const envelopeOf = (id) =>
  platformContextEnvelope({
    activeSpace: { id, type: "ORGANIZATION", plan: "BUSINESS", displayName: `Workspace ${id}`, status: "active" },
  });

before(async () => {
  const extras = [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/platform-context.ts",
  ];
  M = await loadModule("app/(stack)/spaces.tsx", extras);
  Tab = await loadModule("app/(tabs)/evidence.tsx", extras);
});

beforeEach(async () => {
  requests = [];
  pointer = "A";
  globalThis.__APP_STATE__ = "active";
  routes = authenticatedRoutes({
    "/v1/platform/context": () => envelopeOf(pointer),
  });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`));
    if (!key) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    const body = routes[key](path);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
  await signIn(Tab);
});

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});

const Probe = ({ mod, id }) => {
  const { context, refresh, loading, error } = mod.usePlatformContext();
  return h(
    "Text",
    { testID: id, onPress: refresh },
    `${context?.displayName ?? "none"}|${loading ? "loading" : "idle"}|${error ? "error" : "ok"}`,
  );
};

const renderProbes = async (mod) => {
  const r = await renderComponent(
    h(mod.TestProviders, null, h(Probe, { mod, id: "header" }), h(Probe, { mod, id: "tab" })),
  );
  mounted.push(r);
  await settle();
  return r;
};
const shown = (r, id) => r.byTestId(id)[0].props.children;

test("a refresh from one consumer reaches every other mounted consumer", async () => {
  const r = await renderProbes(M);
  assert.equal(shown(r, "header"), "Workspace A|idle|ok");
  assert.equal(shown(r, "tab"), "Workspace A|idle|ok");

  pointer = "B";
  await act(async () => { r.byTestId("header")[0].props.onPress(); });
  await settle();
  assert.equal(shown(r, "header"), "Workspace B|idle|ok");
  assert.equal(shown(r, "tab"), "Workspace B|idle|ok", "the consumer that did not refresh follows too");
});

test("two consumers mounting together cost one read", async () => {
  await renderProbes(M);
  assert.equal(requests.filter((q) => q.path === "/v1/platform/context").length, 1);
});

test("returning to the foreground picks up a switch made elsewhere", async () => {
  const r = await renderProbes(Tab);
  pointer = "B";
  await act(async () => { globalThis.__emitAppState("active"); });
  await settle();
  assert.equal(shown(r, "tab"), "Workspace B|idle|ok");
});

test("a revalidation is silent: nothing returns to a loading state", async () => {
  const r = await renderProbes(Tab);
  const seen = [];
  routes["/v1/platform/context"] = () => {
    seen.push(shown(r, "tab"));
    return envelopeOf("A");
  };
  await act(async () => { globalThis.__emitAppState("active"); });
  assert.deepEqual(seen, ["Workspace A|idle|ok"]);
});

test("a background failure keeps what is known; a failed forced read does not", async () => {
  const r = await renderProbes(Tab);
  routes["/v1/platform/context"] = () => new Response("{}", { status: 500 });
  await act(async () => { globalThis.__emitAppState("active"); });
  await settle();
  assert.equal(shown(r, "tab"), "Workspace A|idle|ok");

  await act(async () => { r.byTestId("header")[0].props.onPress(); });
  await settle();
  assert.equal(shown(r, "tab"), "none|idle|error", "a forced read was asked for because this may be wrong");
});

test("an older answer cannot overwrite a newer one", async () => {
  const r = await renderProbes(Tab);
  let releaseOld;
  routes["/v1/platform/context"] = () =>
    new Promise((resolve) => {
      releaseOld = () => resolve(envelopeOf("A"));
    }).then((body) => new Response(JSON.stringify(body), { status: 200 }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/v1/platform/context") return routes["/v1/platform/context"]();
    return realFetch(url, init);
  };
  await act(async () => { globalThis.__emitAppState("active"); });
  const slow = releaseOld;

  routes["/v1/platform/context"] = () => new Response(JSON.stringify(envelopeOf("B")), { status: 200 });
  await act(async () => { r.byTestId("header")[0].props.onPress(); });
  await settle();
  assert.equal(shown(r, "tab"), "Workspace B|idle|ok");

  slow();
  await settle();
  assert.equal(shown(r, "tab"), "Workspace B|idle|ok");
});

test("the Spaces switch moves the mounted header with it", async () => {
  routes["/v1/platform/context/switch-workspace"] = () => {
    pointer = "B";
    return {};
  };
  routes["/v1/platform/context"] = () => ({
    ...envelopeOf(pointer),
    canonical: {
      organizations: [{ organizationId: "org-1", name: "Org" }],
      organizationWorkspaces: [
        { workspaceId: "A", name: "Workspace A", organizationId: "org-1" },
        { workspaceId: "B", name: "Workspace B", organizationId: "org-1" },
      ],
    },
  });
  const r = await renderComponent(
    h(M.TestProviders, null, h(Probe, { mod: M, id: "header" }), h(M.default, {})),
  );
  mounted.push(r);
  await settle();
  assert.equal(shown(r, "header"), "Workspace A|idle|ok");
  const row = r.root.findAll((n) => typeof n.type === "string" && n.props?.onPress && n.props?.accessibilityLabel?.includes("Workspace B"));
  await act(async () => { await row[0].props.onPress(); });
  await settle();
  assert.ok(requests.some((q) => q.path === "/v1/platform/context/switch-workspace" && q.method === "POST"));
  assert.equal(shown(r, "header"), "Workspace B|idle|ok");
});

test("the Evidence tab rereads when the workspace changes, and only then", async () => {
  routes["/v1/evidence"] = () => ({ items: [], pageInfo: null });
  const r = await renderComponent(
    h(Tab.TestProviders, null, h(Probe, { mod: Tab, id: "header" }), h(Tab.default, {})),
  );
  mounted.push(r);
  await settle();
  await act(async () => { await new Promise((x) => setTimeout(x, 350)); });
  await settle();
  const lists = () => requests.filter((q) => /^\/v1\/evidence(\?|$)/.test(q.path)).length;
  const cases = () => requests.filter((q) => q.path === "/v1/cases").length;
  const before = lists();
  assert.equal(before, 1, "the first resolution of the workspace is not a change");
  assert.equal(cases(), 1);

  pointer = "B";
  await act(async () => { r.byTestId("header")[0].props.onPress(); });
  await settle();
  assert.equal(lists(), before + 1);
  assert.equal(cases(), 2);
});
