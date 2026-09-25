/**
 * T-14 — evidence library Retention filter (EvidenceFilters.tsx:214). The
 * list row carries `storage` (mapEvidenceListItem); the web filters the
 * loaded rows on storage.verified, and native now does the same.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
before(async () => {
  M = await loadModule("app/(tabs)/evidence.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  const routes = {
    ...authenticatedRoutes(),
    // Real reply shapes: saved-views answers { items } (evidence.saved-views.routes.ts:239),
    // the list answers { scope, items, pageInfo } (evidence.routes.ts:6908).
    "/v1/evidence/library-summary": () => ({}),
    "/v1/evidence/saved-views": () => ({ items: [] }),
    "/v1/evidence": () => ({
      items: [
        { id: "e1", type: "PHOTO", status: "SIGNED", createdAt: "2026-09-01T00:00:00Z", displayTitle: "Locked photo", storage: { immutable: true, verified: true } },
        { id: "e2", type: "PHOTO", status: "SIGNED", createdAt: "2026-09-02T00:00:00Z", displayTitle: "Plain photo", storage: null },
      ],
      pageInfo: { limit: 50, nextCursor: null, hasMore: false },
    }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key]() : {}), { status: key ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("Retention narrows the rows to recorded storage protection, or its absence", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assert.ok(r.hasText("Locked photo") && r.hasText("Plain photo"));
  await r.press("More filters");
  await r.press("Retention: Storage protection recorded");
  assert.ok(r.hasText("Locked photo"));
  assert.equal(r.hasText("Plain photo"), false);
  await r.press("Retention: Protection not recorded");
  assert.ok(r.hasText("Plain photo"));
  assert.equal(r.hasText("Locked photo"), false);
  await r.press("Clear filters");
  assert.ok(r.hasText("Locked photo") && r.hasText("Plain photo"));
  r.unmount();
});
