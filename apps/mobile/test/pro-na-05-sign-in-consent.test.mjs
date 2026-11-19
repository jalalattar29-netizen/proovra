/**
 * PRO-NA-05 / PRO-NA-10 — the consent ticked on this device reaches the session
 * that completes the sign-in (second-factor and verification paths), bound to
 * what it was ticked for; and only the server's enrolment code reads as
 * "add an authenticator".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

const C = await loadModule("src/auth/pending-sign-in-consent.ts");
const S = await loadModule("src/product/challenge-step-up.ts");

test("a second-factor sign-in keeps the consent for ITS pending token, once", () => {
  C.holdConsentForMfa("pending-A", "login");
  assert.equal(C.takeConsentForMfa("pending-B"), undefined);
  assert.equal(C.takeConsentForMfa("pending-A"), "login");
  assert.equal(C.takeConsentForMfa("pending-A"), undefined);
});

test("no consent ticked: nothing is held", () => {
  C.holdConsentForMfa("pending-C", undefined);
  assert.equal(C.takeConsentForMfa("pending-C"), undefined);
});

test("a registration consent is recorded only for the same address", () => {
  C.holdConsentForRegistration("Person@Example.test ");
  assert.equal(C.takeConsentForRegistration("other@example.test"), undefined);
  assert.equal(C.takeConsentForRegistration("person@example.test"), "register");
  assert.equal(C.takeConsentForRegistration("person@example.test"), undefined);
});

test("PRO-NA-10: only STEP_UP_ENROLLMENT_REQUIRED means enrolment", () => {
  assert.equal(S.isEnrollmentRequired({ code: "STEP_UP_ENROLLMENT_REQUIRED", statusCode: 403 }), true);
  assert.equal(S.isEnrollmentRequired({ code: "permission_denied", statusCode: 403 }), false);
  assert.equal(S.isEnrollmentRequired({ statusCode: 403 }), false);
});
