/**
 * Phase 3 — deterministic bootstrap state machine (pure). Locks the dead-token
 * fix: an auth failure clears the token and routes to the gateway; a network
 * failure keeps the session (offline), never a dead authenticated shell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/bootstrap/bootstrap-machine.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { bootReducer, bootDestination, shouldClearToken, INITIAL_BOOT_STATE } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

test("no token → anonymous → gateway", () => {
  const s = bootReducer(INITIAL_BOOT_STATE, { type: "RESTORE_NO_TOKEN" });
  assert.equal(s.phase, "anonymous");
  assert.equal(bootDestination(s), "gateway");
});

test("token + /me ok → authenticated → main", () => {
  let s = bootReducer(INITIAL_BOOT_STATE, { type: "RESTORE_FOUND_TOKEN" });
  assert.equal(bootDestination(s), "pending"); // still restoring
  s = bootReducer(s, { type: "ME_OK" });
  assert.equal(s.phase, "authenticated");
  assert.equal(bootDestination(s), "main");
});

test("token + /me AUTH failure → expired → gateway, token cleared (the dead-token fix)", () => {
  const found = bootReducer(INITIAL_BOOT_STATE, { type: "RESTORE_FOUND_TOKEN" });
  const failed = bootReducer(found, { type: "ME_FAILED", reason: "auth" });
  assert.equal(failed.phase, "expired");
  assert.equal(failed.hasToken, false);
  assert.equal(bootDestination(failed), "gateway");
  assert.equal(shouldClearToken(found, failed), true);
});

test("token + /me NETWORK failure → offlineAuthed → main, token kept (offline ≠ invalid)", () => {
  const found = bootReducer(INITIAL_BOOT_STATE, { type: "RESTORE_FOUND_TOKEN" });
  const offline = bootReducer(found, { type: "ME_FAILED", reason: "network" });
  assert.equal(offline.phase, "offlineAuthed");
  assert.equal(offline.hasToken, true);
  assert.equal(bootDestination(offline), "main");
  assert.equal(shouldClearToken(found, offline), false);
});

test("runtime expiry and sign-out both route to the gateway", () => {
  assert.equal(bootDestination(bootReducer(INITIAL_BOOT_STATE, { type: "SESSION_EXPIRED" })), "gateway");
  assert.equal(bootDestination(bootReducer(INITIAL_BOOT_STATE, { type: "SIGNED_OUT" })), "gateway");
});

test("unknown event leaves state unchanged (total function)", () => {
  const s = bootReducer(INITIAL_BOOT_STATE, { type: "NOPE" });
  assert.deepEqual(s, INITIAL_BOOT_STATE);
});
