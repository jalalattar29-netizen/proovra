/**
 * EXTERNAL FLOWS — intake and the reviewer portal.
 *
 * These were recorded as blocked on a hosted association file. That was a
 * category error: the missing file governs whether an https link REACHES the
 * app, not whether the product surface behind it exists. The screens, parsers,
 * API calls and states are all repository work, and they are done.
 *
 * What these pin:
 *   - the link shapes the API actually mints are parsed, and nothing else is;
 *   - a half-formed acceptance link is ignored rather than half-attempted,
 *     because posting an empty token spends the one attempt a valid grant has;
 *   - neither family passes through the tenant resolve gate or the credential
 *     family — the reader has no PROOVRA account for either to be about;
 *   - the app's own session is never attached to these calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = async (rel, strip) => {
  let src = readFileSync(resolve(HERE, rel), "utf8");
  if (strip) src = src.replace(/^import type .*$/m, "");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
};

const D = await load("../src/deep-link.ts", false);
const P = await load("../src/product/portal.ts", true);
const I = await load("../src/product/external-intake.ts", true);

/* ------------------------------------------------------------- link shapes */

test("every link shape the API mints resolves to a native route", () => {
  const cases = [
    ["https://www.proovra.com/intake/tok-1", "/intake/tok-1"],
    ["proovra://intake/tok-1", "/intake/tok-1"],
    ["https://www.proovra.com/portal", "/portal"],
    ["https://www.proovra.com/portal/ptok-1", "/portal/ptok-1"],
    [
      "https://www.proovra.com/portal/accept/grant-1?token=gt-1",
      "/portal/accept/grant-1?token=gt-1",
    ],
  ];
  for (const [url, route] of cases) {
    const parsed = D.parseExternalFlowDeepLink(url);
    assert.ok(parsed, `${url} was not recognised`);
    assert.equal(parsed.route, route, url);
  }
});

test("an acceptance link missing either half is ignored", () => {
  // Posting an empty token would spend the one attempt a valid grant has and
  // then report the reader's own good link as already handled.
  for (const url of [
    "https://www.proovra.com/portal/accept/grant-1",
    "https://www.proovra.com/portal/accept?token=gt-1",
    "https://www.proovra.com/portal/accept",
  ]) {
    assert.equal(D.parseExternalFlowDeepLink(url), null, url);
  }
});

test("the capture step is not a link target of its own", () => {
  // It needs a session the intake screen has not opened yet, so a link
  // straight to it would arrive without one.
  assert.equal(D.parseExternalFlowDeepLink("https://www.proovra.com/intake/capture"), null);
});

test("the SSO callback is left to the browser", () => {
  // Claiming it would break the web SSO round-trip by bouncing the callback
  // into an app that cannot complete it.
  assert.equal(D.parseExternalFlowDeepLink("https://www.proovra.com/portal/sso/callback"), null);
});

test("external flows stay out of the tenant and credential families", () => {
  for (const url of [
    "https://www.proovra.com/intake/tok-1",
    "https://www.proovra.com/portal/ptok-1",
  ]) {
    assert.equal(D.parseCanonicalMobileDeepLink(url), null, url);
    assert.equal(D.parseCredentialDeepLink(url), null, url);
    assert.equal(D.parsePublicDocumentDeepLink(url), null, url);
  }
});

/* ------------------------------------------------------------------ portal */

test("portal paths and credential carry the portal's OWN bearer", () => {
  assert.equal(P.PORTAL_AUTH_PATH, "/v1/portal/auth");
  assert.equal(P.PORTAL_DASHBOARD_PATH, "/v1/portal/dashboard");
  assert.equal(P.buildPortalViewPath("w1"), "/v1/portal/work/w1/view");
  assert.equal(P.buildPortalDecisionPath("w1"), "/v1/portal/work/w1/decision");

  const cred = P.portalCredential("ptok", "sess-1");
  assert.equal(cred.bearer, "ptok");
  assert.equal(cred.headers["x-portal-session"], "sess-1");
  // No session id yet means no header, rather than an empty one.
  assert.deepEqual(P.portalCredential("ptok", null).headers, {});
});

test("each portal denial is told apart and says what to do", () => {
  assert.equal(P.classifyPortalDenial({ code: "MFA_CODE_REQUIRED" }), "MFA");
  assert.equal(P.classifyPortalDenial({ code: "GRANT_EXPIRED" }), "EXPIRED");
  assert.equal(P.classifyPortalDenial({ code: "GRANT_REVOKED" }), "REVOKED");
  assert.equal(P.classifyPortalDenial({ statusCode: 429 }), "THROTTLED");
  assert.equal(P.classifyPortalDenial({ statusCode: 503 }), "UNAVAILABLE");
  assert.equal(P.classifyPortalDenial({ statusCode: 404 }), "NOT_FOUND");

  for (const d of [
    "MFA",
    "EXPIRED",
    "REVOKED",
    "NOT_FOUND",
    "THROTTLED",
    "UNAVAILABLE",
    "UNKNOWN",
  ]) {
    const msg = P.portalDenialMessage(d);
    assert.ok(msg.length > 0, d);
    // "Something went wrong" sends a reviewer to email somebody to find out
    // which of four things happened.
    assert.doesNotMatch(msg, /something went wrong/i, d);
  }
});

test("the dashboard reads reviewer, scope, assignments and limitations", () => {
  const dash = P.parsePortalDashboard({
    portal: {
      reviewer: {
        email: "r@x.test",
        displayName: "Rae",
        role: "REVIEWER",
        capabilities: ["COMMENT"],
      },
      scope: { kind: "CASE", label: "Claim 42", expiresAtUtc: "2026-10-01T00:00:00.000Z" },
      assigned: [
        { workflowId: "w2", title: "Second", dueAt: "2026-09-30T00:00:00.000Z" },
        { workflowId: "w1", title: "Done", submittedDecisionAtUtc: "2026-09-20T00:00:00.000Z" },
        { title: "no id" },
      ],
      limitations: ["This review does not establish authorship."],
    },
  });

  assert.equal(dash.reviewerName, "Rae");
  assert.equal(dash.scopeLabel, "Claim 42");
  assert.equal(dash.assigned.length, 2);
  assert.equal(dash.limitations.length, 1);
  assert.equal(P.hasPortalCapability(dash, "COMMENT"), true);
  assert.equal(P.hasPortalCapability(dash, "DECIDE"), false);
});

test("outstanding reviews sort above finished ones", () => {
  const sorted = P.sortAssignments([
    { workflowId: "done", submittedDecisionAtIso: "2026-09-20T00:00:00.000Z", dueAtIso: null },
    { workflowId: "due-late", submittedDecisionAtIso: null, dueAtIso: "2026-12-01T00:00:00.000Z" },
    { workflowId: "due-soon", submittedDecisionAtIso: null, dueAtIso: "2026-09-25T00:00:00.000Z" },
  ]);
  assert.deepEqual(
    sorted.map((a) => a.workflowId),
    ["due-soon", "due-late", "done"],
  );
});

test("the decision vocabulary makes no claim about truth", () => {
  assert.deepEqual([...P.PORTAL_DECISIONS], ["APPROVED", "REJECTED", "NEEDS_MORE_INFO"]);
  for (const d of P.PORTAL_DECISIONS) {
    assert.doesNotMatch(P.portalDecisionLabel(d), /verified|authentic|admissible|true/i, d);
  }
  // An empty note is omitted, not sent as an empty string.
  assert.deepEqual(P.buildPortalDecisionBody({ decision: "APPROVED", note: "  " }), {
    decision: "APPROVED",
  });
});

/* ------------------------------------------------------------------ intake */

test("intake paths are the canonical public ones", () => {
  assert.equal(I.buildIntakeValidatePath("t1"), "/v1/external-intake/t1");
  assert.equal(I.buildIntakeConsentPath("t1", "s1"), "/v1/external-intake/t1/sessions/s1/consent");
  assert.equal(I.buildIntakePartsPath("t1", "s1"), "/v1/external-intake/t1/sessions/s1/parts");
  assert.equal(I.buildIntakeSubmitPath("t1", "s1"), "/v1/external-intake/t1/sessions/s1/submit");
});

test("the surface is driven by the template snapshot, with no branch per industry", () => {
  const v = I.parseValidatedIntake({
    link: {
      workflowTemplateName: "Water damage",
      workflowTemplateLocationRequirement: "OPTIONAL",
      intakeMode: "ANONYMOUS",
      isAnonymous: true,
      steps: [{ id: "s1", label: "Photos of the damage", required: true }, {}],
    },
    session: { id: "sess-1", status: "OPEN" },
  });
  assert.equal(v.template.name, "Water damage");
  assert.equal(v.template.steps.length, 2);
  assert.equal(v.template.steps[1].label, "Step 2");
  assert.equal(v.session.id, "sess-1");
});

test("an anonymous link offers a pseudonym and never an email box", () => {
  // Offering one would invite a contributor to type an address that is then
  // discarded, which is worse than not asking.
  assert.deepEqual(I.identityFieldsFor({ isAnonymous: true }), {
    pseudonym: true,
    displayName: false,
    email: false,
  });
  assert.deepEqual(I.identityFieldsFor({ isAnonymous: false }), {
    pseudonym: false,
    displayName: true,
    email: true,
  });
});

test("coordinates never ride along with a refusal", () => {
  const denied = I.buildIntakeSubmitBody({
    location: { consentState: "DENIED", latitude: 51.5, longitude: -0.1 },
  });
  assert.equal(denied.location.consentState, "DENIED");
  assert.equal("latitude" in denied.location, false);

  const granted = I.buildIntakeSubmitBody({
    location: { consentState: "GRANTED", latitude: 51.5, longitude: -0.1 },
  });
  assert.equal(granted.location.latitude, 51.5);

  // No location asked for, nothing sent.
  assert.deepEqual(I.buildIntakeSubmitBody({ location: null }), {});
});

test("a template that never asked for location is not prompted for one", () => {
  assert.equal(I.locationPrompt({ locationRequirement: "REQUIRED" }), "REQUIRED");
  assert.equal(I.locationPrompt({ locationRequirement: "OPTIONAL" }), "OPTIONAL");
  assert.equal(I.locationPrompt({ locationRequirement: "NONE" }), "NONE");
  assert.equal(I.locationPrompt({ locationRequirement: null }), "NONE");
});

test("the part bound is the route's, refused before submitting", () => {
  assert.equal(I.INTAKE_MAX_PARTS, 100);
  assert.equal(I.canAddIntakePart(99), true);
  assert.equal(I.canAddIntakePart(100), false);
});

test("each intake failure is told apart and says what to do", () => {
  assert.equal(I.classifyIntakeFailure({ code: "LINK_EXPIRED" }), "EXPIRED");
  assert.equal(I.classifyIntakeFailure({ code: "LINK_REVOKED" }), "REVOKED");
  assert.equal(I.classifyIntakeFailure({ code: "MAX_USES_REACHED" }), "EXHAUSTED");
  assert.equal(I.classifyIntakeFailure({ statusCode: 404 }), "INVALID");
  for (const f of ["INVALID", "EXPIRED", "REVOKED", "EXHAUSTED", "UNAVAILABLE", "UNKNOWN"]) {
    assert.ok(I.intakeFailureMessage(f).length > 0, f);
  }
});

/* --------------------------------------------- the session is never attached */

test("every external screen uses publicFetch, never apiFetch", () => {
  for (const f of [
    "../app/(stack)/intake/[token].tsx",
    "../app/(stack)/intake/capture.tsx",
    "../app/(stack)/portal/index.tsx",
    "../app/(stack)/portal/[token].tsx",
    "../app/(stack)/portal/work/[workflowId].tsx",
    "../app/(stack)/portal/accept/[grantId].tsx",
  ]) {
    const p = resolve(HERE, f);
    assert.ok(existsSync(p), `${f} does not exist`);
    // An upload or a decision attributed to whoever is signed in on this
    // device is a false custody record.
    assert.doesNotMatch(readFileSync(p, "utf8"), /\bapiFetch\b/, `${f} attaches the session`);
  }
});

test("the portal credential is held in memory only", () => {
  const src = readFileSync(resolve(HERE, "../src/portal/portal-session.ts"), "utf8");
  // A phone that is shared, lost or handed over must not carry access to
  // somebody else's evidence past the moment it is used.
  assert.doesNotMatch(src, /AsyncStorage|SecureStore|localStorage|FileSystem/);
});
