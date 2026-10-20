/**
 * AUD-52 (2026-10-20) — A WEB CAPTURE IS OF A WEB PAGE, AND ITS FRAGMENT IS NOT
 * RECORDED. Characterization (before): the validator accepted file:, chrome:
 * and similar addresses, and the recorded facts kept the #fragment, which can
 * carry access tokens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isWebPageUrl, withoutUrlFragment, validateWebCaptureManifest } from "../dist/index.js";

test("only http(s) addresses are web pages", () => {
  for (const ok of ["https://example.com/a", "http://example.com/"]) assert.equal(isWebPageUrl(ok), true, ok);
  for (const no of ["file:///C:/secret.html", "chrome://settings", "about:blank", "data:text/html,x", "javascript:alert(1)", "not a url"]) {
    assert.equal(isWebPageUrl(no), false, no);
  }
});

test("the fragment is dropped, the query kept", () => {
  assert.equal(withoutUrlFragment("https://example.com/p?x=1#access_token=abc"), "https://example.com/p?x=1");
  assert.equal(withoutUrlFragment("https://example.com/p"), "https://example.com/p");
});

test("the manifest validator refuses a non-web page address", () => {
  const now = Date.now();
  const r = validateWebCaptureManifest({
    schemaVersion: "PROOVRA_WEB_CAPTURE_MANIFEST_V1",
    captureMode: "VIEWPORT",
    captureSessionId: "11111111-1111-4111-8111-111111111111",
    captureStartedAtUtc: new Date(now - 4000).toISOString(),
    captureEndedAtUtc: new Date(now - 2000).toISOString(),
    page: { domain: "localhost", sourceUrlPrivate: "file:///C:/Users/me/secret.html", title: "secret" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /not an http\(s\) page address/);
});
