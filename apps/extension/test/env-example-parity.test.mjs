/**
 * UC-LCH-005 — every environment variable the Direct Web Capture code reads is
 * documented in the matching .env.example. EXTENSION_OAUTH_REDIRECT_ALLOW (API
 * sign-in fails closed without it) and NEXT_PUBLIC_EXTENSION_INSTALL_URL (the
 * install button stays hidden without it) used to appear in none.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

function envReads(source) {
  const names = new Set();
  for (const m of source.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[\s*["']([A-Z0-9_]+)["']\s*\])/g)) {
    names.add(m[1] ?? m[2]);
  }
  return [...names].sort();
}

function documented(example) {
  return new Set([...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
}

test("API capture/extension code reads only documented variables", () => {
  const api = documented(read("services/api/.env.example"));
  const reads = [
    ...envReads(read("services/api/src/services/auth/extension-oauth.service.ts")),
    ...envReads(read("services/api/src/routes/extension-oauth.routes.ts")),
    ...envReads(read("services/api/src/services/auth/extension-scope.ts")),
  ];
  assert.ok(reads.includes("EXTENSION_OAUTH_REDIRECT_ALLOW"));
  assert.deepEqual(reads.filter((n) => !api.has(n)), []);
  assert.ok(api.has("EXTENSION_ALLOWED_ORIGINS"));
});

test("web capture capability reads only documented variables", () => {
  const web = documented(read("apps/web/.env.example"));
  const reads = envReads(read("apps/web/app/(app)/capture/_lib/useCaptureCapabilities.ts"));
  assert.ok(reads.includes("NEXT_PUBLIC_EXTENSION_INSTALL_URL"));
  assert.deepEqual(reads.filter((n) => !web.has(n)), []);
});
