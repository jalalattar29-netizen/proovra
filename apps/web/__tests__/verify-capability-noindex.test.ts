/**
 * ET-PKG-13 — a public Verify URL is a capability to the record.
 *
 * On a40ca76f there was no robots control of any kind for /verify/[token]
 * (no noindex meta, no X-Robots-Tag), and the page's error path sent the token
 * itself to Sentry as context.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { isPublicVerifyCapabilityPath } from "../middleware";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("ET-PKG-13: /verify/<token> paths are capability paths; the landing page and others are not", () => {
  assert.equal(isPublicVerifyCapabilityPath("/verify/3f2a9c"), true);
  assert.equal(isPublicVerifyCapabilityPath("/verify/3f2a9c/extra"), true);
  assert.equal(isPublicVerifyCapabilityPath("/verify"), false);
  assert.equal(isPublicVerifyCapabilityPath("/verifyx/1"), false);
  assert.equal(isPublicVerifyCapabilityPath("/evidence/1"), false);
});

test("ET-PKG-13: every response the middleware secures carries X-Robots-Tag on a capability path", () => {
  const src = read("middleware.ts");
  assert.match(src, /if \(isPublicVerifyCapabilityPath\(pathname\)\) \{\s*response\.headers\.set\("X-Robots-Tag", "noindex, nofollow, noarchive"\);/);
  const calls = src.match(/applySecurityHeaders\([^)]*\)/g) ?? [];
  const sites = calls.filter((c) => !c.includes("response: NextResponse"));
  assert.ok(sites.length >= 9, `expected every call site, saw ${sites.length}`);
  for (const c of sites) assert.match(c, /, pathname\)$/, c);
});

test("ET-PKG-13: the token layout declares noindex/nofollow for every environment", () => {
  const layout = read("app/verify/[token]/layout.tsx");
  assert.match(layout, /robots: \{ index: false, follow: false,/);
});

test("ET-PKG-13: the Verify page never hands the token to Sentry", () => {
  const page = read("app/verify/[token]/page.tsx");
  for (const m of page.matchAll(/capture(?:Exception|Message)\([^;]*\);/g)) {
    assert.doesNotMatch(m[0], /token/, m[0]);
  }
});

test("AUD-48 (2026-10-20): security headers are not production-only, the failure path never fails open, and the preview frame is allowed only for storage", () => {
  const src = read("middleware.ts");
  assert.ok(!src.includes("if (isProd) applySecurityHeaders("));
  const failurePath = src.slice(src.lastIndexOf("} catch {"));
  assert.ok(failurePath.includes("applyStaticSecurityHeaders(res, req.nextUrl.pathname);"), "the failure path applies the static headers");
  assert.ok(src.includes('"Strict-Transport-Security", "max-age=63072000; includeSubDomains"'));
  assert.ok(src.includes("frame-src 'self' https://accounts.google.com https://appleid.apple.com ${R2_HOST}"));
  const preview = read("app/verify/[token]/VerifyContentReview.tsx");
  assert.match(preview, /<iframe\s+src=\{item\.viewUrl\}\s+title=\{item\.label\}\s+referrerPolicy="no-referrer"/);
});

test("AUD-47 (2026-10-20): the rule-breaking verify-v2 tone helpers stay deleted", () => {
  const helpers = read("components/verify-v2/_helpers.ts");
  assert.ok(!helpers.includes("export function statusTone("));
  assert.ok(!helpers.includes("export function timestampTone("));
});
