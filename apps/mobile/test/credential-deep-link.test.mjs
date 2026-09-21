/**
 * Credential deep links (verify-email / reset-password / invite).
 *
 * Behavioural: drives the real parser and asserts the destination it produces.
 * These three screens existed but nothing navigated to them — every emailed
 * account-recovery link dead-ended — so these cases pin the entry points.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/deep-link.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { parseCredentialDeepLink, parseCanonicalMobileDeepLink } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

test("web verify-email link with a query token routes to the native screen", () => {
  const r = parseCredentialDeepLink("https://app.proovra.com/auth/verify-email?token=tok-123");
  assert.equal(r.family, "verify-email");
  assert.equal(r.token, "tok-123");
  assert.equal(r.route, "/(stack)/verify-email?token=tok-123");
});

test("password reset link routes to the reset screen", () => {
  const r = parseCredentialDeepLink("https://app.proovra.com/reset-password?token=abc.def");
  assert.equal(r.family, "reset-password");
  assert.equal(r.route, "/(stack)/reset-password?token=abc.def");
});

test("invite link carries the token as a path segment", () => {
  const r = parseCredentialDeepLink("https://app.proovra.com/invite/inv-77");
  assert.equal(r.family, "invite");
  assert.equal(r.token, "inv-77");
  assert.equal(r.route, "/(stack)/invite/inv-77");
});

test("the proovra:// scheme resolves the same families", () => {
  assert.equal(parseCredentialDeepLink("proovra://verify-email?token=t1").family, "verify-email");
  assert.equal(parseCredentialDeepLink("proovra://invite/t2").token, "t2");
});

test("tokens are percent-encoded into the route (no injection of extra params)", () => {
  const r = parseCredentialDeepLink("https://app.proovra.com/reset-password?token=a%26b=c");
  assert.equal(r.token, "a&b=c");
  assert.equal(r.route, "/(stack)/reset-password?token=a%26b%3Dc");
});

test("a credential family with no token is refused", () => {
  assert.equal(parseCredentialDeepLink("https://app.proovra.com/reset-password"), null);
  assert.equal(parseCredentialDeepLink("https://app.proovra.com/invite"), null);
});

test("unknown families, schemes and malformed input fail safe", () => {
  assert.equal(parseCredentialDeepLink("https://app.proovra.com/admin/panel?token=x"), null);
  assert.equal(parseCredentialDeepLink("http://app.proovra.com/invite/x"), null);
  assert.equal(parseCredentialDeepLink("not a url"), null);
});

test("credential links stay OUT of the tenant-resource family", () => {
  // They must never reach POST /v1/deep-link/resolve: there is no session yet
  // and they address no tenant resource.
  assert.equal(parseCanonicalMobileDeepLink("https://app.proovra.com/invite/inv-77"), null);
  assert.equal(parseCanonicalMobileDeepLink("https://app.proovra.com/reset-password?token=t"), null);
});

test("tenant resources stay OUT of the credential family", () => {
  assert.equal(parseCredentialDeepLink("https://app.proovra.com/evidence/ev-1"), null);
  assert.equal(parseCredentialDeepLink("https://app.proovra.com/cases/c-1"), null);
});
