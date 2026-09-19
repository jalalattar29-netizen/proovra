/**
 * GUARD — durable pending deep-link intent (Master Program §14, M7). A persisted
 * intent must survive a process death during the auth journey, and a stale one
 * (older than the TTL) must be dropped. Pure parse/freshness are unit-tested
 * (the AsyncStorage IO is thin and defensive).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
// Slice out the two pure functions + the TTL (avoid the AsyncStorage import).
const full = readFileSync(resolve(HERE, "../src/deep-link/pending-intent.ts"), "utf8");
const ttl = full.match(/export const PENDING_INTENT_TTL_MS = [^;]+;/)[0];
const fresh = full.match(/export function isFreshPendingIntent[\s\S]*?\n}/)[0];
const parse = full.match(/export function parsePersistedIntent[\s\S]*?\n}/)[0];
const js = ts.transpileModule([ttl, fresh, parse].join("\n"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const NOW = 1_000_000_000_000;

test("a fresh persisted intent rehydrates its route", () => {
  const raw = JSON.stringify({ route: "/invite/tok123", savedAtMs: NOW - 60_000 });
  assert.equal(mod.parsePersistedIntent(raw, NOW), "/invite/tok123");
});

test("a stale persisted intent (past TTL) is dropped", () => {
  const raw = JSON.stringify({ route: "/invite/tok", savedAtMs: NOW - (mod.PENDING_INTENT_TTL_MS + 1) });
  assert.equal(mod.parsePersistedIntent(raw, NOW), null);
});

test("freshness boundary", () => {
  assert.equal(mod.isFreshPendingIntent(NOW - mod.PENDING_INTENT_TTL_MS, NOW), true);
  assert.equal(mod.isFreshPendingIntent(NOW - mod.PENDING_INTENT_TTL_MS - 1, NOW), false);
  assert.equal(mod.isFreshPendingIntent("nope", NOW), false);
});

test("malformed / empty persisted blobs fail safe to null", () => {
  assert.equal(mod.parsePersistedIntent(null, NOW), null);
  assert.equal(mod.parsePersistedIntent("{not json", NOW), null);
  assert.equal(mod.parsePersistedIntent(JSON.stringify({ savedAtMs: NOW }), NOW), null); // no route
  assert.equal(mod.parsePersistedIntent(JSON.stringify({ route: "", savedAtMs: NOW }), NOW), null);
});
