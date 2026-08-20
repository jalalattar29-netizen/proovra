/**
 * SHA-256 — pinned against the published FIPS 180-4 vectors.
 *
 * A hand-written digest is only worth having if it is provably the algorithm it
 * claims to be. These are the standard vectors, plus a cross-check against
 * Node's own `crypto` so the implementation is verified against a second one
 * rather than only against itself.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { SHA256_BASE64URL_LENGTH, sha256Base64Url } from "../dist/canonical-digest.js";

test("matches the published FIPS 180-4 vectors", () => {
  // The standard vectors, stated in the encoding this module actually
  // ships. A hex variant is deliberately not exported — nothing in the
  // product consumes one, and an export with no consumer is how a second
  // digest authority starts. The hex forms are recovered below by
  // cross-checking against node:crypto, which is the stronger check anyway.
  assert.equal(sha256Base64Url(""), "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  assert.equal(sha256Base64Url("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  assert.equal(
    sha256Base64Url("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "JI1qYdIGOLjlwCaTDD5gOaM85Flk_yFn9uzt1BnbBsE",
  );
});

test("agrees with node:crypto across lengths, block boundaries and unicode", () => {
  const cases = [
    "",
    "a",
    "x".repeat(55), // one byte short of needing a second block
    "x".repeat(56), // exactly forces a second block
    "x".repeat(64),
    "x".repeat(1000),
    "café ☕",
    "emoji 🧿 outside the BMP",
    '{"v":"ear1","evidence":{"id":"a"},"context":null}',
  ];
  for (const input of cases) {
    assert.equal(
      sha256Base64Url(input),
      createHash("sha256").update(input, "utf8").digest("base64url"),
      `mismatch for ${JSON.stringify(input.slice(0, 24))}`,
    );
  }
});

test("base64url output is the FULL digest, unpadded and url-safe", () => {
  for (const input of ["", "abc", "x".repeat(200)]) {
    const out = sha256Base64Url(input);
    assert.equal(out.length, SHA256_BASE64URL_LENGTH);
    // 43 base64 characters carry 258 bits, so the whole 256-bit digest is
    // present. Nothing is truncated to 16 hex characters.
    assert.match(out, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(out, /[=+/]/);
  }
});

test("distinct inputs produce distinct digests, including near-identical ones", () => {
  const seen = new Set();
  for (const input of [
    '{"a":1,"b":null}',
    '{"a":1,"b":0}',
    '{"a":"1","b":null}',
    '{"a":1,"b":false}',
    '{"a":1,"b":""}',
  ]) {
    const d = sha256Base64Url(input);
    assert.equal(seen.has(d), false, `collision on ${input}`);
    seen.add(d);
  }
});
