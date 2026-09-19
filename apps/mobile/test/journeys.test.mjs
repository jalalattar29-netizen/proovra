/**
 * JOURNEY TESTS (Master Program §18, M6). Composes the real pure state machines /
 * projections into named end-to-end journeys, so a regression in the composition
 * (not just a unit) fails. Node's test runner can't mount RN, so journeys run over
 * the canonical pure logic that drives the screens: the bootstrap machine (auth),
 * the deep-link parser + verification-id extractor, and the durable pending intent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
function load(rel, transform = (s) => s) {
  const src = transform(readFileSync(resolve(HERE, rel), "utf8"));
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

const boot = await load("../src/bootstrap/bootstrap-machine.ts");
const dl = await load("../src/deep-link.ts");
const pi = await load("../src/deep-link/pending-intent.ts", (s) => {
  const ttl = s.match(/export const PENDING_INTENT_TTL_MS = [^;]+;/)[0];
  const parse = s.match(/export function parsePersistedIntent[\s\S]*?\n}/)[0];
  const fresh = s.match(/export function isFreshPendingIntent[\s\S]*?\n}/)[0];
  return [ttl, fresh, parse].join("\n");
});

/** Drive the boot machine through a sequence of events, return the destinations. */
function run(events) {
  let state = boot.INITIAL_BOOT_STATE;
  const clears = [];
  const dests = [boot.bootDestination(state)];
  for (const ev of events) {
    const next = boot.bootReducer(state, ev);
    clears.push(boot.shouldClearToken(state, next));
    dests.push(boot.bootDestination(next));
    state = next;
  }
  return { dests, clears, final: state };
}

test("journey: fresh launch (no token) → auth gateway", () => {
  const { dests } = run([{ type: "RESTORE_NO_TOKEN" }]);
  assert.deepEqual(dests, ["pending", "gateway"]);
});

test("journey: restore a valid session → main app", () => {
  const { dests } = run([{ type: "RESTORE_FOUND_TOKEN" }, { type: "ME_OK" }]);
  assert.deepEqual(dests, ["pending", "pending", "main"]);
});

test("journey: dead token → expired → gateway, token purged exactly once", () => {
  const { dests, clears, final } = run([{ type: "RESTORE_FOUND_TOKEN" }, { type: "ME_FAILED", reason: "auth" }]);
  assert.deepEqual(dests, ["pending", "pending", "gateway"]);
  assert.deepEqual(clears, [false, true]); // purge fires on the transition into expired
  assert.equal(final.hasToken, false);
});

test("journey: offline restore → main app, token kept (offline ≠ invalid)", () => {
  const { dests, clears, final } = run([{ type: "RESTORE_FOUND_TOKEN" }, { type: "ME_FAILED", reason: "network" }]);
  assert.deepEqual(dests, ["pending", "pending", "main"]);
  assert.deepEqual(clears, [false, false]);
  assert.equal(final.hasToken, true);
});

test("journey: sign in then log out → main → gateway", () => {
  const { dests } = run([{ type: "SIGNED_IN" }, { type: "SIGNED_OUT" }]);
  assert.deepEqual(dests, ["pending", "main", "gateway"]);
});

test("journey: session expiry mid-use → gateway (re-auth)", () => {
  const { dests, final } = run([{ type: "SIGNED_IN" }, { type: "SESSION_EXPIRED" }]);
  assert.deepEqual(dests, ["pending", "main", "gateway"]);
  assert.equal(final.hasToken, false);
});

test("journey: deep link → resource route (evidence / case), unsupported ignored", () => {
  assert.equal(dl.parseCanonicalMobileDeepLink("proovra://evidence/ev-1").route, "/(stack)/evidence/ev-1");
  assert.equal(dl.parseCanonicalMobileDeepLink("https://proovra.com/cases/c-9").route, "/(stack)/case/c-9");
  assert.equal(dl.parseCanonicalMobileDeepLink("https://proovra.com/admin/panel"), null);
});

test("journey: verification link (deep or pasted) → the id the verify screen loads", () => {
  assert.equal(dl.extractVerificationId("https://proovra.com/verify/ev-77"), "ev-77");
  assert.equal(dl.extractVerificationId("proovra://verify?id=ev-77"), "ev-77");
});

test("journey: invite link → auth → (process death) → rehydrated pending intent", () => {
  // The unauthenticated gate stashes /invite/<token>; if the app dies mid-journey,
  // a FRESH persisted intent still rehydrates so the accept resumes.
  const now = 1_000_000_000_000;
  const persisted = JSON.stringify({ route: "/invite/tok-abc", savedAtMs: now - 5 * 60_000 });
  assert.equal(pi.parsePersistedIntent(persisted, now), "/invite/tok-abc");
  const stale = JSON.stringify({ route: "/invite/tok-abc", savedAtMs: now - (pi.PENDING_INTENT_TTL_MS + 1) });
  assert.equal(pi.parsePersistedIntent(stale, now), null); // journey abandoned → dropped
});
