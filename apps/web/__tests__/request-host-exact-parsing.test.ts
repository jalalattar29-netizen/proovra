/**
 * AUD-021 — the web middleware decides "local development / Vercel preview"
 * from the exact hostname, never from a substring of the Host header.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { hostnameOf, isLocalOrPreviewHost } from "../lib/security/request-host";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("loopback and preview hosts are recognised exactly, with or without a port", () => {
  for (const host of [
    "localhost",
    "localhost:3000",
    "127.0.0.1:3007",
    "[::1]:3000",
    "web.localhost:3000",
    "proovra-git-main-team.vercel.app",
  ]) {
    assert.equal(isLocalOrPreviewHost(host), true, host);
  }
});

test("look-alike hosts that merely CONTAIN a local name are not local", () => {
  for (const host of [
    "localhost.attacker.example",
    "127.0.0.1.nip.io",
    "evil-localhost.com",
    "www.proovra.com",
    "app.proovra.com:443",
    "vercel.app.attacker.example",
    "a.b.vercel.app",
    "",
  ]) {
    assert.equal(isLocalOrPreviewHost(host), false, host);
  }
  assert.equal(isLocalOrPreviewHost(null), false);
});

test("hostnameOf strips the port and IPv6 brackets only", () => {
  assert.equal(hostnameOf("App.Proovra.com:8443"), "app.proovra.com");
  assert.equal(hostnameOf("[::1]:3000"), "::1");
  assert.equal(hostnameOf("localhost"), "localhost");
});

test("the middleware routes its local/preview decision through the exact helper", () => {
  const src = readFileSync(resolve(__dirname, "..", "middleware.ts"), "utf8");
  assert.match(src, /isLocalOrPreviewHost\(host\)/);
  assert.doesNotMatch(src, /host\.includes\(/);
});
