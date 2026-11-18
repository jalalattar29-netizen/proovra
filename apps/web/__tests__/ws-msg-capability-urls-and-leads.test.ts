/**
 * PRO-PW-06 / PRO-PW-07 — capability URLs are kept out of indexes, and the
 * lead proxy admits only this site's own origins.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isCapabilityUrlPath, isPublicVerifyCapabilityPath } from "../middleware";
import { isAllowedHost } from "../app/api/_marketing-leads";

test("every token-bearing page family is a capability path; marketing pages are not", () => {
  for (const p of [
    "/verify/abc",
    "/share/xyz",
    "/intake/tok123",
    "/intake/tok123/capture",
    "/invite/tok",
    "/portal/tok",
    "/portal/accept/g1",
    "/org-invites/tok/accept",
    "/collaboration-teams/invites/tok/accept",
    "/reset-password",
    "/auth/verify-email",
    "/auth/mfa-recovery/verify",
  ]) {
    assert.equal(isCapabilityUrlPath(p), true, p);
  }
  for (const p of ["/", "/pricing", "/trust", "/login", "/contact-sales", "/home"]) {
    assert.equal(isCapabilityUrlPath(p), false, p);
  }
  assert.equal(isPublicVerifyCapabilityPath("/verify/abc"), true);
});

test("the lead proxy admits PROOVRA and local origins, never another site on vercel.app in production", () => {
  assert.equal(isAllowedHost("www.proovra.com"), true);
  assert.equal(isAllowedHost("localhost"), true);
  assert.equal(isAllowedHost("evil.example"), false);
  assert.equal(isAllowedHost("a.b.vercel.app"), false);
  const previous = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    assert.equal(isAllowedHost("evil.vercel.app"), false);
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous;
  }
});
