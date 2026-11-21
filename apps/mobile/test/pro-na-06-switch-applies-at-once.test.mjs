/**
 * PRO-NA-06 — an accepted workspace switch moves the request header at once.
 *
 * The header (x-proovra-workspace-id) used to change only when the follow-up
 * context re-read landed — and never, when that re-read failed — so requests
 * after "You are now working in …" still named the workspace that was left.
 * The real platform-context + api modules over a scripted network:
 *   - allowed: after the switch answer, the next request names the new
 *     workspace even though the context re-read FAILS;
 *   - the server's answer decides: a switch envelope naming another workspace
 *     than the one asked is followed, not the request;
 *   - control: before any switch the header is the earlier workspace.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadModule } from "./support/render.mjs";

let M;
let requests = [];

before(async () => {
  M = await loadModule("src/product/platform-context.ts", ["src/api.ts", "test/support/expo-stub.mjs"]);
});

beforeEach(() => {
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const headers = new Headers(init.headers ?? {});
    requests.push({ path, workspace: headers.get("x-proovra-workspace-id") });
    if (path.startsWith("/v1/platform/context")) {
      return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "down" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  M.setAuthToken("test-token");
  M.setActiveWorkspaceId("ws-old");
});

const settle = () => new Promise((r) => setTimeout(r, 20));
const lastProbe = () => requests.filter((r) => r.path.startsWith("/v1/probe")).at(-1);

test("control: before a switch the request names the earlier workspace", async () => {
  await M.apiFetch("/v1/probe");
  assert.equal(lastProbe().workspace, "ws-old");
});

test("allowed: after the switch answer the next request names the new workspace, even when the context re-read fails", async () => {
  M.adoptSwitchedWorkspace({ ok: true }, "ws-new");
  await settle();
  await M.apiFetch("/v1/probe");
  assert.equal(lastProbe().workspace, "ws-new", "the header still named the workspace that was left");
});

test("the server's switch envelope decides when it names another workspace than the one asked", async () => {
  M.adoptSwitchedWorkspace(
    { activeSpace: { id: "ws-server", type: "ORGANIZATION", plan: "BUSINESS", displayName: "Server choice", status: "active" } },
    "ws-asked",
  );
  await settle();
  await M.apiFetch("/v1/probe");
  assert.equal(lastProbe().workspace, "ws-server");
});
