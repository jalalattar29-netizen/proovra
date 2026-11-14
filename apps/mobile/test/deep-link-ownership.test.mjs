/**
 * Free audit F-13 — every incoming link has ONE owner. expo-router navigated
 * to the URL's path itself while DeepLinkGate pushed its own route for the same
 * URL (twice-opened screens; "+not-found" under the gate's screen; an evidence
 * link opened before the server resolve). `app/+native-intent.ts` now takes
 * the gate's links away from the router and leaves every other link to it.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadModule } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let L;
let Intent;

before(async () => {
  L = await loadModule("src/deep-link/link-ownership.ts", ["test/support/expo-stub.mjs"]);
  Intent = await loadModule("app/+native-intent.ts");
});

const GATE_LINKS = [
  "https://www.proovra.com/invite/tok-123",
  "https://www.proovra.com/reset-password?token=abc",
  "https://www.proovra.com/auth/verify-email?token=abc",
  "https://www.proovra.com/legal/terms",
  "https://www.proovra.com/intake/tok-9",
  "https://www.proovra.com/evidence/0b9f3c1e-0000-4000-8000-000000000001",
  "proovra://step-up/complete?result=ok",
  "proovra://sign-in/passkey-complete",
];

test("F-13: links the gate routes are taken away from the router (warm: ignored; cold: boot screen)", () => {
  for (const url of GATE_LINKS) {
    assert.equal(L.deepLinkGateOwns(url), true, `${url} should be owned by DeepLinkGate`);
    assert.equal(Intent.redirectSystemPath({ path: url, initial: false }), "", url);
    assert.equal(Intent.redirectSystemPath({ path: url, initial: true }), "/", url);
  }
});

test("F-13: links the gate does not route stay with the router unchanged (/verify among them)", () => {
  for (const url of [
    "https://www.proovra.com/verify/pvr_abc",
    "https://www.proovra.com/verify/package/pkg-1",
    "https://www.proovra.com/some/unknown/page",
  ]) {
    assert.equal(L.deepLinkGateOwns(url), false, url);
    assert.equal(Intent.redirectSystemPath({ path: url, initial: false }), url);
    assert.equal(Intent.redirectSystemPath({ path: url, initial: true }), url);
  }
});

test("F-13: the router ignores an empty URL — the contract the warm-start answer relies on", () => {
  // expo-router 4 useLinking.native.js getStateFromURL: `if (!url …) return undefined`.
  const src = readFileSync(resolve(HERE, "../node_modules/expo-router/build/fork/useLinking.native.js"), "utf8");
  assert.match(src, /if \(!url \|\|/);
  // And it reads the hook from app/+native-intent.
  const cfg = readFileSync(resolve(HERE, "../node_modules/expo-router/build/getLinkingConfig.js"), "utf8");
  assert.match(cfg, /\\\+native-intent/);
});
