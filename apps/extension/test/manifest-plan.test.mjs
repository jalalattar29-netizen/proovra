/**
 * UC-SEC-002 / UC-TQ-008 — the built manifest's host access. A release declares
 * exactly PROOVRA's API + storage origins (so its calls are not CORS-bound);
 * only the E2E TEST build carries `<all_urls>` and a fixed key.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  E2E_EXTENSION_ID,
  E2E_EXTENSION_PUBLIC_KEY,
  E2E_OAUTH_REDIRECT,
  originMatchPattern,
  planManifest,
  releaseManifestProblems,
} from "../scripts/manifest-plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(readFileSync(resolve(HERE, "../public/manifest.json"), "utf8"));
const cfg = { apiOrigin: "https://api.proovra.com", storageOrigins: ["https://evidence.s3.eu-central-1.amazonaws.com"] };

test("a release build grants host access to exactly the API and storage origins", () => {
  const m = planManifest(source, cfg);
  assert.deepEqual(m.host_permissions, ["https://api.proovra.com/*", "https://evidence.s3.eu-central-1.amazonaws.com/*"]);
  assert.equal(m.key, undefined);
  assert.deepEqual(releaseManifestProblems(m, cfg), []);
  assert.deepEqual(m.permissions, ["activeTab", "scripting", "storage", "identity"]);
});

test("the source manifest itself stays host-less", () => {
  assert.deepEqual(source.host_permissions, []);
});

test("the E2E test build is refused as a release", () => {
  const m = planManifest(source, { ...cfg, e2e: true });
  assert.ok(m.host_permissions.includes("<all_urls>"));
  assert.equal(m.key, E2E_EXTENSION_PUBLIC_KEY);
  const problems = releaseManifestProblems(m, cfg);
  assert.ok(problems.some((p) => /<all_urls>/.test(p)));
  assert.ok(problems.some((p) => /E2E key/.test(p)));
});

test("an unconfigured or wildcard host is refused", () => {
  const m = { ...planManifest(source, cfg), host_permissions: ["https://*/*", "https://evil.example.com/*"] };
  assert.equal(releaseManifestProblems(m, cfg).length, 2);
  assert.throws(() => originMatchPattern("https://*.proovra.com"));
});

test("the E2E id is the one Chrome derives from the E2E key, and its redirect is the chromiumapp one", () => {
  const der = Buffer.from(E2E_EXTENSION_PUBLIC_KEY, "base64");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  assert.equal(id, E2E_EXTENSION_ID);
  assert.equal(E2E_OAUTH_REDIRECT, `https://${E2E_EXTENSION_ID}.chromiumapp.org/oauth2`);
});
