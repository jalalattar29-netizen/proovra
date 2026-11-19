/**
 * WS-SHELL — pure web rules.
 *
 *   PRO-PW-11  one return-path rule: a long extension continuation survives;
 *              unsafe values never do.
 *   PRO-R2Z-06 reviewer refusals are read from the fields apiFetch sets.
 *   PRO-R2-14  every wire shape of the review plan refusal is recognised.
 *   PRO-PW-10  English-only public pages are recognised.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isPlanRefusal } from "../lib/feedback/plan-refusal";
import { isEnglishOnlyPublicPath } from "../lib/i18n-english-only";
import { safeReturnPath } from "../lib/navigation/safe-return-path";
import { reviewerDenialFromError } from "../lib/reviewer-workspace/reviewer-denial";

test("PRO-PW-11: a 900-character extension continuation is kept; other long paths and unsafe values fall back", () => {
  const cont = `/auth/extension/continue?state=${"s".repeat(256)}&scope=${"c".repeat(256)}&code_challenge=${"x".repeat(128)}&redirect_uri=${encodeURIComponent("https://ext.example/cb")}`;
  assert.ok(cont.length > 512);
  assert.equal(safeReturnPath(cont), cont);
  assert.equal(safeReturnPath(`/settings?x=${"a".repeat(600)}`), "/home");
  assert.equal(safeReturnPath("//evil.example"), "/home");
  assert.equal(safeReturnPath("/\\evil.example"), "/home");
  assert.equal(safeReturnPath("/billing?workspace=personal&plan=PRO"), "/billing?workspace=personal&plan=PRO");
});

test("PRO-R2Z-06: refusals are read from err.details / err.body.error, and only a 429 is rate limiting", () => {
  assert.equal(
    reviewerDenialFromError({ statusCode: 409, code: "QC_REVIEWER_NOT_INDEPENDENT", details: { denial: "QC_REVIEWER_NOT_INDEPENDENT" } }),
    "QC_REVIEWER_NOT_INDEPENDENT",
  );
  assert.equal(reviewerDenialFromError({ statusCode: 403, body: { error: { denial: "NOT_PERMITTED" } } }), "NOT_PERMITTED");
  assert.equal(reviewerDenialFromError({ statusCode: 403 }), "NOT_PERMITTED");
  assert.equal(reviewerDenialFromError({ statusCode: 429 }), "RATE_LIMITED");
  assert.equal(reviewerDenialFromError({ code: "NETWORK_ERROR" }), "NETWORK_ERROR");
  assert.equal(reviewerDenialFromError({ statusCode: 400, code: "VALIDATION_FAILED" }), "VALIDATION_FAILED");
});

test("PRO-R2-14: the three historic plan-refusal shapes and the unified one are all plan refusals; a permission refusal is not", () => {
  assert.equal(isPlanRefusal({ statusCode: 403, code: "ENTITLEMENT_REQUIRED" }), true);
  assert.equal(isPlanRefusal({ statusCode: 404, code: "reviewer_operations_not_included" }), true);
  assert.equal(isPlanRefusal({ statusCode: 403, details: { denial: "ENTITLEMENT_REQUIRED" } }), true);
  assert.equal(isPlanRefusal({ statusCode: 403, body: { error: { reason: "reviewer_operations_not_included" } } }), true);
  assert.equal(isPlanRefusal({ statusCode: 403, code: "permission_denied" }), false);
  assert.equal(isPlanRefusal(null), false);
});

test("PRO-PW-10: English-only public pages are recognised; the app and translated pages are not", () => {
  for (const p of ["/", "/about", "/platform/x", "/pricing", "/for-lawyers", "/legal/privacy"]) {
    assert.equal(isEnglishOnlyPublicPath(p), true, p);
  }
  for (const p of ["/support", "/home", "/evidence/1", "/aboutx", null]) {
    assert.equal(isEnglishOnlyPublicPath(p), false, String(p));
  }
});
