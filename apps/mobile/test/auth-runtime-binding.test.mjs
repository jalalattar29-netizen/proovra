/**
 * PERMANENT GUARD — the bootstrap machine is the RUNTIME authority (A3, Law of
 * One). The tested bootReducer/shouldClearToken must actually drive auth-context,
 * not sit beside a hand-rolled token-clear + bootPhase ternary. Source-as-text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ctx = readFileSync(resolve(HERE, "../src/auth-context.tsx"), "utf8");

test("auth-context imports and uses the bootstrap machine", () => {
  assert.match(ctx, /from\s+["']\.\/bootstrap\/bootstrap-machine["']/);
  assert.match(ctx, /bootReducer/, "must reduce transitions through bootReducer");
  assert.match(ctx, /shouldClearToken/, "the purge decision must come from shouldClearToken");
});

test("the boot phase is derived from the machine, not a hand-rolled ternary", () => {
  assert.match(ctx, /bootPhase:\s*BootPhase\s*=\s*bootState\.phase/, "bootPhase must be bootState.phase");
  // The old ternary chained token/user checks to fabricate a phase — must be gone.
  assert.doesNotMatch(ctx, /!authReady\s*\?\s*["']restoring["']/, "hand-rolled bootPhase ternary must be removed");
});

test("session-expiry transitions flow through ME_FAILED with a classified reason", () => {
  assert.match(ctx, /ME_FAILED/, "restore must dispatch ME_FAILED");
  assert.match(ctx, /reason:\s*isAuthError\(err\)\s*\?\s*["']auth["']\s*:\s*["']network["']/, "reason must be auth vs network");
  assert.match(ctx, /SIGNED_OUT/, "logout must dispatch SIGNED_OUT");
  assert.match(ctx, /SIGNED_IN/, "sign-in must dispatch SIGNED_IN");
});
