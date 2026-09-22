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

/* ---------------------------------------------------------- public documents */

/**
 * PUBLIC DOCUMENTS — the third family, added with the canonical legal
 * delivery. A legal link addresses no tenant and carries no credential, so it
 * neither passes the server resolve gate nor waits behind the auth gateway: a
 * user asked to accept terms before signing in must be able to read them.
 */
const legalMod = await (async () => {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(dl, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
})();

test("legal links resolve to the native reader, from web and app schemes", () => {
  const cases = [
    ["https://www.proovra.com/legal/dpa", "dpa"],
    ["https://www.proovra.com/settings/legal/dpa", "dpa"],
    ["proovra://legal/privacy", "privacy"],
    ["https://www.proovra.com/privacy", "privacy"],
    ["https://www.proovra.com/terms", "terms"],
    ["https://www.proovra.com/subprocessors", "subprocessors"],
    ["https://www.proovra.com/data-retention", "data-retention"],
    ["https://www.proovra.com/abuse-reporting", "abuse-reporting"],
    ["https://www.proovra.com/security-overview", "security"],
  ];

  for (const [url, slug] of cases) {
    const parsed = legalMod.parsePublicDocumentDeepLink(url);
    assert.ok(parsed, `${url} was not recognised`);
    assert.equal(parsed.slug, slug, url);
    assert.equal(parsed.route, `/legal/${slug}`, url);
  }
});

test("a public document link never reaches the tenant resolve gate", () => {
  // The two gated families must not claim a legal path, or a legal document
  // would be sent for workspace re-derivation it has no business in.
  for (const url of ["https://www.proovra.com/legal/dpa", "proovra://legal/terms"]) {
    assert.equal(legalMod.parseCanonicalMobileDeepLink(url), null, url);
    assert.equal(legalMod.parseCredentialDeepLink(url), null, url);
  }
});

test("the client holds no copy of the legal slug allow-list", () => {
  // `GET /v1/legal/:slug` owns which documents exist. A second list here is
  // the duplicate truth the canonical delivery removed; the reader shows its
  // "no such document" state for an unknown slug instead.
  assert.ok(legalMod.parsePublicDocumentDeepLink("https://www.proovra.com/legal/not-a-real-doc"));
  for (const bad of [
    "https://www.proovra.com/legal/",
    "https://www.proovra.com/legal/a/b",
    "https://www.proovra.com/legal/Upper",
    "https://www.proovra.com/home",
    "ftp://www.proovra.com/legal/dpa",
  ]) {
    assert.equal(legalMod.parsePublicDocumentDeepLink(bad), null, bad);
  }
});

test("the gate dispatches public documents before the session branch", () => {
  const gate = readFileSync(resolve(HERE, "../src/DeepLinkGate.tsx"), "utf8");
  const docAt = gate.indexOf("parsePublicDocumentDeepLink(url)");
  const sessionAt = gate.indexOf("if (!getAuthToken())");
  assert.ok(docAt > 0, "the gate does not handle public documents");
  assert.ok(
    docAt < sessionAt,
    "a legal link is deferred behind the auth gateway, so it is silently dropped",
  );
});
