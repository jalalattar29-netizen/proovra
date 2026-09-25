/**
 * Credential deep links (verify-email / reset-password / invite).
 *
 * Behavioural: drives the real parser and asserts the destination it produces.
 * These three screens existed but nothing navigated to them — every emailed
 * account-recovery link dead-ended — so these cases pin the entry points.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

/* --------------------------------------------------- MFA recovery verification */

/**
 * The recovery link is the one credential link that addresses a REQUEST as
 * well as carrying a token, and its web path ends in a literal "verify"
 * segment. Both halves must come from the query, or a link with no ?token=
 * would post the word "verify" as the token and burn a single-use attempt.
 */
test("an MFA recovery link carries both its request id and its token", () => {
  const parsed = parseCredentialDeepLink(
    "https://www.proovra.com/auth/mfa-recovery/verify?id=req-1&token=abc123",
  );
  assert.ok(parsed, "the recovery link was not recognised");
  assert.equal(parsed.family, "mfa-recovery");
  assert.equal(parsed.token, "abc123");
  assert.match(parsed.route, /^\/\(stack\)\/mfa-recovery-verify\?id=req-1&token=abc123$/);
});

test("a recovery link missing either half is ignored, never half-attempted", () => {
  for (const url of [
    "https://www.proovra.com/auth/mfa-recovery/verify?id=req-1",
    "https://www.proovra.com/auth/mfa-recovery/verify?token=abc123",
    "https://www.proovra.com/auth/mfa-recovery/verify",
  ]) {
    assert.equal(parseCredentialDeepLink(url), null, url);
  }
});

test("the recovery screen exists and is reachable", () => {
  assert.ok(
    existsSync(resolve(HERE, "../app/(stack)/mfa-recovery-verify.tsx")),
    "mfa-recovery-verify screen is missing",
  );
});

/* ------------------------------------------------- organization invitations */

/**
 * The organization invite is a SEPARATE token namespace from the
 * collaboration-group invite. Its web path is /org-invites/<token>/accept, so
 * the token is a path segment with a trailing verb — joining the remainder
 * would post "<token>/accept", a token that does not exist, and the user would
 * be told their invitation was invalid.
 */
test("an organization invite link resolves to its own screen and endpoint family", () => {
  const parsed = parseCredentialDeepLink(
    "https://www.proovra.com/org-invites/tok-123/accept",
  );
  assert.ok(parsed, "the org invite link was not recognised");
  assert.equal(parsed.family, "org-invite");
  assert.equal(parsed.token, "tok-123");
  assert.equal(parsed.route, "/(stack)/org-invite/tok-123");
});

test("organization and collaboration invites do not claim each other's links", () => {
  const org = parseCredentialDeepLink("https://www.proovra.com/org-invites/tok-1/accept");
  const collab = parseCredentialDeepLink("https://www.proovra.com/invite/tok-1");
  assert.equal(org.family, "org-invite");
  assert.equal(collab.family, "invite");
  assert.notEqual(org.route, collab.route);
});

test("an organization invite with no token is ignored", () => {
  for (const url of [
    "https://www.proovra.com/org-invites/accept",
    "https://www.proovra.com/org-invites/",
  ]) {
    assert.equal(parseCredentialDeepLink(url), null, url);
  }
});

test("the organization invite screen exists", () => {
  assert.ok(
    existsSync(resolve(HERE, "../app/(stack)/org-invite/[token].tsx")),
    "org-invite screen is missing",
  );
});

/* ------------------------------------------------- the recovery CREATE leg */

const R = await (async () => {
  const ts = (await import("typescript")).default;
  const s = readFileSync(resolve(HERE, "../src/product/mfa-recovery.ts"), "utf8");
  const js = ts.transpileModule(s, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
})();

test("a 409 yields the in-flight request id rather than an error", () => {
  // This is the ONLY route to the resend control for a user whose
  // verification email never arrived. Dropping it leaves them blocked.
  assert.equal(
    R.inFlightRequestIdFrom({ statusCode: 409, details: { requestId: "req-7" } }),
    "req-7",
  );
  assert.equal(R.inFlightRequestIdFrom({ statusCode: 400, details: { requestId: "x" } }), null);
  assert.equal(R.inFlightRequestIdFrom({ statusCode: 409, details: {} }), null);
});

test("the reason bounds are the route's, and the hint says what is missing", () => {
  assert.equal(R.isValidRecoveryReason("too short"), false);
  assert.equal(R.isValidRecoveryReason("lost my phone in a river"), true);
  assert.equal(R.isValidRecoveryReason("x".repeat(401)), false);
  // Whitespace is trimmed before measuring, as the route does.
  assert.equal(R.isValidRecoveryReason("   " + "a".repeat(9) + "   "), false);

  assert.match(R.recoveryReasonHint(""), /at least 10/);
  assert.match(R.recoveryReasonHint("short"), /5 more character/);
  assert.equal(R.recoveryReasonHint("lost my phone in a river"), null);
});

test("each create failure is told apart, and none leaks a raw error", () => {
  assert.equal(R.classifyCreateFailure({ statusCode: 401 }), "not_eligible");
  assert.equal(R.classifyCreateFailure({ statusCode: 400 }), "invalid_reason");
  assert.equal(R.classifyCreateFailure({ statusCode: 403 }), "not_a_member");
  assert.equal(R.classifyCreateFailure({ statusCode: 429 }), "throttled");
  assert.equal(R.classifyCreateFailure(new Error("boom")), "unknown");

  for (const kind of ["not_eligible", "invalid_reason", "not_a_member", "throttled", "unknown"]) {
    const msg = R.createFailureMessage(kind);
    assert.ok(msg.length > 0, kind);
    assert.doesNotMatch(msg, /statusCode|Error:|undefined/, kind);
  }
});

test("the verification boundary is stated, not implied", () => {
  // A user who thinks this signed them in will wait for an app that is never
  // going to let them in.
  assert.match(R.MFA_RECOVERY_BOUNDARY, /did NOT log you in/);
  assert.match(R.MFA_RECOVERY_BOUNDARY, /did NOT change your two-factor/);
  assert.match(R.MFA_RECOVERY_BOUNDARY, /once an admin approves your reset/);
});
