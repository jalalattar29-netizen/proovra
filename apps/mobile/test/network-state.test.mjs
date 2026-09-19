/**
 * Phase 11 §B9 — network-state semantics. Offline means transport-unreachable,
 * NEVER "an HTTP request failed": a 4xx/5xx is a completed response and the API
 * layer reports it as ONLINE. State recovers when reachability returns.
 * Transpile-and-import (the module has no runtime imports).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/network/network-state.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { getNetworkStatus, subscribeNetwork, reportNetworkOnline, reportNetworkOffline } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

test("starts unknown", () => {
  assert.equal(getNetworkStatus(), "unknown");
});

test("transport failure → offline; completed response → online (recovery)", () => {
  reportNetworkOffline();
  assert.equal(getNetworkStatus(), "offline");
  reportNetworkOnline();
  assert.equal(getNetworkStatus(), "online");
});

test("subscribers are notified only on change", () => {
  const seen = [];
  const unsub = subscribeNetwork((s) => seen.push(s));
  reportNetworkOnline(); // no change (already online) → no notify
  reportNetworkOffline(); // change
  reportNetworkOffline(); // no change
  reportNetworkOnline(); // change
  unsub();
  reportNetworkOffline(); // after unsub → not seen
  assert.deepEqual(seen, ["offline", "online"]);
});

test("the API layer semantics: a completed HTTP response (even an error) is online", () => {
  // The api client calls reportNetworkOnline() as soon as fetch resolves —
  // BEFORE inspecting res.ok — so a 500/401/404 never flips us offline.
  const api = readFileSync(resolve(HERE, "../src/api.ts"), "utf8");
  const onlineIdx = api.indexOf("reportNetworkOnline()");
  const okCheckIdx = api.indexOf("if (!res.ok)");
  assert.ok(onlineIdx >= 0 && okCheckIdx >= 0 && onlineIdx < okCheckIdx, "online must be reported before the res.ok branch");
  assert.match(api, /catch[\s\S]*reportNetworkOffline\(\)/, "a transport reject must report offline");
});
