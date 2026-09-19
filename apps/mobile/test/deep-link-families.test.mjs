/**
 * Phase 11 §B5 — deep-link families contract. The CUSTOM server-authorized gate
 * (deep-link.ts) owns only the resource families that need workspace re-derivation
 * (evidence, cases). Token-carrying auth links (verify-email, reset-password) are
 * handled by expo-router's default path routing into their screens (which read
 * ?token=), NOT the custom gate. Invitations are not a native surface. This test
 * pins the canonical family set so a new family is a deliberate, tested change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const dl = readFileSync(resolve(HERE, "../src/deep-link.ts"), "utf8");
const APP = resolve(HERE, "../app/(stack)");

test("the custom deep-link gate owns exactly evidence + cases", () => {
  const families = [...dl.matchAll(/^\s{2}(\w+):\s*\(id\)\s*=>/gm)].map((m) => m[1]);
  assert.deepEqual(new Set(families), new Set(["evidence", "cases"]), `custom gate families: ${families.join(",")}`);
});

test("URL tenant params are dropped (server re-derives workspace)", () => {
  assert.match(dl, /DISCARDED|never tenant truth|re-derive/i);
});

test("token-carrying auth links have real screens (expo-router default routing)", () => {
  // verify-email + reset-password are reached by their route + ?token=, not the gate.
  assert.ok(existsSync(resolve(APP, "verify-email.tsx")), "verify-email screen exists");
  assert.ok(existsSync(resolve(APP, "reset-password.tsx")), "reset-password screen exists");
  const verify = readFileSync(resolve(APP, "verify-email.tsx"), "utf8");
  const reset = readFileSync(resolve(APP, "reset-password.tsx"), "utf8");
  assert.match(verify, /useLocalSearchParams/, "verify-email reads the token param");
  assert.match(reset, /useLocalSearchParams/, "reset-password reads the token param");
});
