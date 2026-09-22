/**
 * Account-security projections — behavioural, over real API-shaped payloads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/account-security.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const A = await import(`data:text/javascript,${encodeURIComponent(js)}`);

/* ----------------------------------------------------------- sign-in methods */

test("sign-in methods project password and linked providers together", () => {
  const m = A.parseSignInMethods({
    passwordConfigured: true,
    usableMethods: 2,
    links: [{ provider: "GOOGLE", linkedAtUtc: "2026-01-02T03:04:05.000Z" }],
    legacyProvider: null,
  });
  assert.deepEqual(m.methods.map((x) => x.provider), ["PASSWORD", "GOOGLE"]);
  assert.equal(m.methods[1].linkedAtIso, "2026-01-02T03:04:05.000Z");
});

test("the only way into an account is never offered as removable", () => {
  const m = A.parseSignInMethods({
    passwordConfigured: false,
    usableMethods: 1,
    links: [{ provider: "APPLE", linkedAtUtc: "2026-01-01T00:00:00.000Z" }],
  });
  assert.equal(m.methods.length, 1);
  assert.equal(m.methods[0].removable, false, "removing the last method would lock the account out");
});

test("a legacy OAuth pair with no link row is surfaced read-only", () => {
  const m = A.parseSignInMethods({
    passwordConfigured: false,
    usableMethods: 1,
    links: [],
    legacyProvider: "GOOGLE",
  });
  assert.equal(m.methods.length, 1);
  assert.equal(m.methods[0].provider, "GOOGLE");
  assert.equal(m.methods[0].removable, false);
});

test("an unknown provider is dropped rather than rendered as a sign-in method", () => {
  const m = A.parseSignInMethods({ passwordConfigured: false, usableMethods: 1, links: [{ provider: "FACEBOOK" }] });
  assert.deepEqual(m.methods, []);
});

test("a malformed payload degrades instead of throwing on a security screen", () => {
  assert.deepEqual(A.parseSignInMethods(null).methods, []);
  assert.deepEqual(A.parseSignInMethods({ links: "nope" }).methods, []);
  assert.deepEqual(A.parseSessions(undefined).sessions, []);
  assert.deepEqual(A.parseMfaStatus(undefined).factors, []);
  assert.deepEqual(A.parseSecurityEvents(undefined), []);
});

/* -------------------------------------------------------------------- risk */

test("the headline names the state a lost device compromises outright", () => {
  const single = A.parseSignInMethods({ passwordConfigured: true, usableMethods: 1, links: [] });
  const noMfa = A.parseMfaStatus({ hasMfa: false, factors: [], recoveryCodesRemaining: 0 });
  assert.deepEqual(A.signInRisk(single, noMfa), {
    label: "One sign-in method, no second factor",
    tone: "risk",
  });

  const several = A.parseSignInMethods({
    passwordConfigured: true,
    usableMethods: 2,
    links: [{ provider: "GOOGLE" }],
  });
  assert.equal(A.signInRisk(several, noMfa).tone, "pending");

  const withMfa = A.parseMfaStatus({ hasMfa: true, factors: [], recoveryCodesRemaining: 8 });
  assert.deepEqual(A.signInRisk(several, withMfa), { label: "Two-factor on", tone: "verified" });
});

/* --------------------------------------------------------------------- MFA */

test("MFA status derives hasMfa from an ACTIVE factor even if the flag is absent", () => {
  const s = A.parseMfaStatus({ factors: [{ id: "f1", label: "Phone", status: "ACTIVE" }] });
  assert.equal(s.hasMfa, true);
});

test("a pending enrolment does not count as having two-factor", () => {
  const s = A.parseMfaStatus({ hasMfa: false, factors: [{ id: "f1", status: "PENDING" }] });
  assert.equal(s.hasMfa, false);
  assert.equal(A.mfaFactorTone("PENDING"), "pending");
  assert.equal(A.mfaFactorTone("ACTIVE"), "verified");
});

test("recovery codes are flagged low before the user runs out", () => {
  const low = A.parseMfaStatus({ hasMfa: true, factors: [], recoveryCodesRemaining: 2 });
  assert.equal(low.recoveryCodesLow, true);
  const fine = A.parseMfaStatus({ hasMfa: true, factors: [], recoveryCodesRemaining: 8 });
  assert.equal(fine.recoveryCodesLow, false);
});

test("recovery codes are not flagged low when there is no second factor at all", () => {
  // Zero codes with no MFA is not a warning — it is simply not configured.
  const none = A.parseMfaStatus({ hasMfa: false, factors: [], recoveryCodesRemaining: 0 });
  assert.equal(none.recoveryCodesLow, false);
});

/* ---------------------------------------------------------------- sessions */

test("sessions surface only what the server disclosed, and put this device first", () => {
  const inv = A.parseSessions({
    sessions: [
      { id: "s1", isCurrent: false, uaPreview: "Firefox on Windows", ipPreview: "198.51.100.x", countryCode: "DE", lastSeenAtUtc: "2026-02-01T00:00:00.000Z" },
      { id: "s2", isCurrent: true, uaPreview: "PROOVRA iOS", lastSeenAtUtc: "2026-02-02T00:00:00.000Z" },
    ],
  });
  assert.equal(inv.sessions[0].id, "s2", "the current session anchors the list");
  assert.equal(inv.sessions[1].deviceLabel, "Firefox on Windows · 198.51.100.x · DE");
  assert.equal(inv.otherCount, 1, "this is what 'sign out others' acts on");
});

test("a session the server described with nothing still renders identifiably", () => {
  const inv = A.parseSessions({ sessions: [{ id: "s1" }] });
  assert.equal(inv.sessions[0].deviceLabel, "Unrecognised device");
});

test("quarantined and SSO sessions are distinguished", () => {
  const inv = A.parseSessions({
    sessions: [
      { id: "s1", quarantined: true },
      { id: "s2", ssoConnectionId: "conn_1" },
    ],
  });
  assert.equal(inv.quarantinedCount, 1);
  assert.equal(inv.sessions.find((s) => s.id === "s2").viaSso, true);
});

/* ------------------------------------------------------------- activity */

test("known security events get their product wording and tone", () => {
  const e = A.parseSecurityEvents({
    events: [
      { id: "1", eventType: "MFA_REMOVED", atUtc: "2026-03-01T00:00:00.000Z" },
      { id: "2", eventType: "PASSWORD_CHANGED" },
    ],
  });
  assert.equal(e[0].label, "Two-factor removed");
  assert.equal(e[0].tone, "risk", "removing a factor is a risk event, not an informational one");
  assert.equal(e[1].label, "Password changed");
});

test("an unknown event type is shown, humanised — never silently dropped", () => {
  const e = A.parseSecurityEvents({ events: [{ id: "9", eventType: "SOME_NEW_SECURITY_THING" }] });
  assert.equal(e.length, 1, "a security log that hides unknown events is worse than a plain label");
  assert.equal(e[0].label, "Some New Security Thing");
  assert.equal(e[0].tone, "neutral");
});

test("either envelope key is accepted", () => {
  assert.equal(A.parseSecurityEvents({ items: [{ id: "1", type: "LOGIN_SUCCEEDED" }] }).length, 1);
});

/* ------------------------------------------------------------- password */

test("password checks report each requirement independently", () => {
  const weak = A.passwordChecks("abc");
  assert.deepEqual(weak.map((c) => c.met), [false, true, false, false]);
  const strong = A.passwordChecks("CorrectHorse9Battery");
  assert.ok(strong.every((c) => c.met));
  assert.equal(A.passwordMeetsPolicy("CorrectHorse9Battery"), true);
  assert.equal(A.passwordMeetsPolicy("short1A"), false);
});

test("the form says WHY it cannot be submitted, in priority order", () => {
  assert.match(A.passwordFormBlocker({ current: "", next: "", confirm: "" }), /current password/i);
  assert.match(
    A.passwordFormBlocker({ current: "old", next: "weak", confirm: "weak" }),
    /requirements/i,
  );
  assert.match(
    A.passwordFormBlocker({ current: "old", next: "CorrectHorse9Battery", confirm: "Different9Battery" }),
    /do not match/i,
  );
  assert.equal(
    A.passwordFormBlocker({ current: "old", next: "CorrectHorse9Battery", confirm: "CorrectHorse9Battery" }),
    null,
  );
});

test("re-submitting the current password is refused", () => {
  const same = "CorrectHorse9Battery";
  assert.match(A.passwordFormBlocker({ current: same, next: same, confirm: same }), /have not used/i);
});

/* --------------------------------------------------------------- step-up */


/* ------------------------------------------------------- TOTP enrolment */

test("the enrolment paths are the canonical ones", () => {
  assert.equal(A.MFA_ENROLL_START_PATH, "/v1/identity/mfa/enroll/start");
  assert.equal(A.MFA_ENROLL_VERIFY_PATH, "/v1/identity/mfa/enroll/verify");
});

test("start never sends a kind, because SMS here is an explicit refusal", () => {
  // The route answers MFA_ENROLL_WRONG_ROUTE for a phone factor; this route
  // enrols an authenticator and nothing else.
  assert.deepEqual(A.buildEnrollStartBody(), {});
  assert.deepEqual(A.buildEnrollStartBody("  "), {});
  assert.deepEqual(A.buildEnrollStartBody(" Personal phone "), { label: "Personal phone" });
  assert.equal("kind" in A.buildEnrollStartBody("x"), false);
});

test("the enrolment carries what an authenticator needs, both ways", () => {
  const e = A.parseTotpEnrollment({
    factorId: "f1",
    otpauthUri: "otpauth://totp/PROOVRA:a@b?secret=ABC",
    secretBase32: "ABC",
  });
  // The URI is handed to an installed app; the key is for a phone with none.
  assert.equal(e.otpauthUri, "otpauth://totp/PROOVRA:a@b?secret=ABC");
  assert.equal(e.secretBase32, "ABC");
});

test("an enrolment with no factor id is not an enrolment", () => {
  assert.equal(A.parseTotpEnrollment({ otpauthUri: "otpauth://x" }), null);
  assert.equal(A.parseTotpEnrollment(null), null);
});

test("a short code is refused before the request", () => {
  assert.match(A.validateTotpCode("123"), /6-digit/);
  assert.match(A.validateTotpCode("12345678901"), /too long/);
  assert.equal(A.validateTotpCode(" 123456 "), null);
  assert.deepEqual(A.buildEnrollVerifyBody("f1", " 123456 "), {
    factorId: "f1",
    code: "123456",
  });
});

test("the recovery codes are read from the one response that carries them", () => {
  // The route: "Recovery codes returned ONCE here ... we never return them
  // again." A surface that lost them would lose the only copy.
  assert.deepEqual(A.parseRecoveryCodes({ recoveryCodes: ["aaa", "bbb", 7, null] }), [
    "aaa",
    "bbb",
  ]);
  assert.deepEqual(A.parseRecoveryCodes({}), []);
});

test("the recovery warning says they cannot be shown again", () => {
  assert.match(A.RECOVERY_CODES_WARNING, /once/i);
  assert.match(A.RECOVERY_CODES_WARNING, /cannot be shown again/i);
});

test("a wrong code and an expired enrolment are told apart", () => {
  // "Try again" is right for one and wrong for the other.
  assert.equal(A.classifyEnrollFailure({ statusCode: 400 }), "CODE_INVALID");
  assert.equal(A.classifyEnrollFailure({ statusCode: 404 }), "NOT_FOUND");
  assert.equal(A.classifyEnrollFailure({ statusCode: 429 }), "RATE_LIMITED");
  assert.equal(
    A.classifyEnrollFailure({ statusCode: 429, body: { error: "rate_limited" } }),
    "RATE_LIMITED",
  );
  assert.equal(A.classifyEnrollFailure({ statusCode: 500 }), "UNKNOWN");
});

test("each enrolment failure names its own next step", () => {
  assert.match(A.enrollFailureMessage("CODE_INVALID"), /30 seconds/);
  assert.match(A.enrollFailureMessage("NOT_FOUND"), /Start again/);
  assert.match(A.enrollFailureMessage("RATE_LIMITED"), /Wait/);
});
