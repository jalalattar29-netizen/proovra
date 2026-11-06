/**
 * T-14 — Settings › Privacy (web PrivacySection + LegalAcceptanceStatusCard).
 * Native had export + closure only, in its own words. Now: the web's export
 * scope and outcomes (Checksum, failed), closure consequences and blockers
 * with the disabled control, Policies & consent (status, accept with the
 * server's schema, history with its legal classification) and the references.
 * Every payload is the route's own reply shape.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let posts = [];
let requests = [];
let status;

before(async () => {
  M = await loadModule("app/(stack)/settings/privacy.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  posts = [];
  requests = [];
  status = { requiresReacceptance: true, missingPolicies: ["terms"], acceptedVersions: { terms: "2026-01" }, requiredVersions: { terms: "2026-09", privacy: "2026-08" } };
  routes = {
    ...authenticatedRoutes(),
    "/v1/identity/data-export": () => ({
      requests: [
        { id: "x1", status: "READY", requestedAtUtc: "2026-09-20T10:00:00Z", completedAtUtc: "2026-09-20T10:05:00Z", expiresAtUtc: "2026-09-27T10:05:00Z", failureCode: null, packageSha256: "0123456789abcdef0123", downloadCount: 0 },
        { id: "x2", status: "FAILED", requestedAtUtc: "2026-09-10T10:00:00Z", completedAtUtc: null, expiresAtUtc: null, failureCode: "EXPORT_BUILD_FAILED", packageSha256: null, downloadCount: 0 },
      ],
    }),
    "/v1/identity/account-closure": () => ({ request: null, blockers: [{ code: "SOLE_OWNER", message: "You are the only owner of a workspace." }], coolingOffDays: 14, confirmationPhrase: "close my account" }),
    "/v1/users/legal-status": () => status,
    "/v1/users/cookie-consent/latest": () => ({ record: { id: "c1", consentVersion: "3", necessary: true, preferences: false, analytics: true, marketing: false, createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T10:00:00Z" } }),
    "/v1/users/legal-acceptance": (init) => {
      if (init.method === "POST") {
        posts.push(JSON.parse(init.body));
        status = { requiresReacceptance: false, missingPolicies: [], acceptedVersions: { terms: "2026-09" }, requiredVersions: status.requiredVersions };
        return { items: [] };
      }
      return {
        items: [
          { id: "a1", policyKey: "terms", policyVersion: "2026-01", acceptedAt: "2026-01-02T10:00:00Z", source: "register" },
          { id: "a2", policyKey: "privacy", policyVersion: "2026-08", acceptedAt: "2026-08-02T10:00:00Z", source: "login" },
        ],
      };
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).filter((p) => path === p || path.startsWith(p + "?") || path.startsWith(p + "/")).sort((a, b) => b.length - a.length)[0] ?? (routes[path] ? path : undefined);
    requests.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(init.body) : null });
    const res = key ? routes[key](init, path) : undefined;
    if (res instanceof Response) return res;
    return new Response(JSON.stringify(res ?? {}), { status: res === undefined ? 404 : 200, headers: { "content-type": "application/json" } });
  };
  globalThis.__WRITTEN__ = {};
  globalThis.__SHARED__ = [];
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};

test("exports state their scope, a ready package's checksum, and a failed one in the web's words", async () => {
  const r = await render();
  assert.ok(r.texts().some((t) => t.startsWith("Request a copy of your personal account data — profile, login methods")));
  assert.ok(r.hasText("Checksum (SHA-256): 0123456789abcdef…"));
  assert.ok(r.hasText("The export could not be generated. You can request a new one below."));
  assert.ok(!r.texts().some((t) => t.includes("EXPORT_BUILD_FAILED")), "a raw failure code was shown");
});

test("closure states its consequences, lists blockers, and keeps the control visible but disabled", async () => {
  const r = await render();
  assert.ok(r.hasText("Closing your account signs you out everywhere, removes your login methods, and anonymizes your personal details after a 14-day cancellation window. Evidence is never deleted by account closure — it stays governed by retention and legal-hold rules."));
  assert.ok(r.hasText("These must be resolved before your account can close:"));
  assert.ok(r.hasText("• You are the only owner of a workspace."));
  const ctl = r.byLabel("Close my account… Resolve the items above first.").find((n) => "disabled" in n.props || n.props.accessibilityState);
  assert.ok(ctl, "no disabled closure control");
  assert.equal(ctl.props.disabled ?? ctl.props.accessibilityState?.disabled, true);
  assert.ok(r.hasText("Resolve the items above to enable account closure."));
});

test("Policies & consent: an owed policy is named with its versions, and accepting posts the server's schema then re-reads", async () => {
  const r = await render();
  assert.equal(r.byTestId("legal-status-action-required").length, 1);
  assert.ok(r.hasText("Some parts of the product — including billing and checkout — stay locked until these are accepted."));
  assert.ok(r.hasText("You accepted v2026-01 · v2026-09 is now required"));
  await r.press("Read the Terms of Service →");
  assert.equal(M.calls.push.at(-1), "/legal/terms");
  const accept = r.byLabel("I have read and accept these").find((n) => n.props.onPress);
  await act(async () => { await accept.props.onPress(); });
  await settle();
  assert.deepEqual(posts.at(-1), { source: "settings", acceptances: [{ policyKey: "terms", policyVersion: "2026-09" }] });
  assert.equal(r.byTestId("legal-status-current").length, 1, "the status was not re-read");
  assert.ok(r.hasText("Your account has accepted every policy version currently required."));
});

test("the acceptance history keeps consent, contract acceptance and acknowledgement apart", async () => {
  const r = await render();
  await r.press("View acceptance history (2)");
  assert.ok(r.hasText("Records are written only when you explicitly accept — viewing a policy is never recorded as consent."));
  assert.ok(r.hasText("Terms of Service accepted") && r.hasText("Privacy notice acknowledged"));
  assert.ok(r.texts().some((t) => t.startsWith("Contract acceptance · v2026-01")));
  assert.ok(r.texts().some((t) => t.startsWith("Acknowledgement · v2026-08")));
});

test("the references open the in-app reader", async () => {
  const r = await render();
  await r.press("Submit a privacy request");
  assert.equal(M.calls.push.at(-1), "/legal/privacy-requests");
  assert.ok(r.texts().some((t) => t.startsWith("The full legal library (DPA, subprocessors, retention, disclosure policies")));
});

/* ------------------------------------------------ PRO-114 / MOBILE-02 ---- */

// The server's own answers (account-step-up.service.ts deny(), the routes' 201s).
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stepUpRequired = () => json(401, { error: { code: "STEP_UP_REQUIRED", methods: ["password"], message: "" } });
const posted = (suffix) => requests.filter((q) => q.method === "POST" && q.path.endsWith(suffix)).map((q) => q.body);
const answerStepUp = async (r, password = "correct horse") => {
  await settle();
  assert.ok(r.hasText("This action needs one more proof that it is you. Nothing has been changed yet."), "the step-up sheet did not open");
  await r.type("Your password", password);
  await r.press("Confirm");
  await settle();
};

test("PRO-114: an export request answers its step-up challenge and re-sends the SAME request with the proof", async () => {
  let exportRows = [];
  routes["/v1/identity/data-export"] = (init) => {
    if (init.method === "POST") {
      const b = JSON.parse(init.body);
      if (!b.stepUp) return stepUpRequired();
      exportRows = [{ id: "x9", status: "REQUESTED", requestedAtUtc: "2026-09-22T10:00:00Z", completedAtUtc: null, expiresAtUtc: null, failureCode: null, packageSha256: null, downloadCount: 0 }];
      return json(201, { request: { id: "x9", status: "REQUESTED", requestedAtUtc: "2026-09-22T10:00:00Z" } });
    }
    return { requests: exportRows };
  };
  const r = await render();
  await r.press("Request a data export");
  await answerStepUp(r);
  assert.deepEqual(posted("/v1/identity/data-export"), [{}, { stepUp: { method: "password", currentPassword: "correct horse" } }]);
  assert.ok(r.hasText("Requested — queued for generation"), "the new request was not re-read");
  assert.ok(r.hasText("An export is already being prepared."));
});

test("PRO-114: closure posts the route's `confirmation` field, then the proof the challenge asked for", async () => {
  let closureRequest = null;
  routes["/v1/identity/account-closure"] = (init) => {
    if (init.method === "POST") {
      const b = JSON.parse(init.body);
      // The route's zod schema: `confirmation` is required.
      if (typeof b.confirmation !== "string") return json(400, { error: { code: "INVALID_INPUT", message: "confirmation: Required" } });
      if (!b.stepUp) return stepUpRequired();
      closureRequest = { id: "c1", status: "COOLING_OFF", reason: b.reason ?? null, requestedAtUtc: "2026-09-22T10:00:00Z", coolingOffEndsAtUtc: "2099-01-01T00:00:00Z", cancelledAtUtc: null, completedAtUtc: null, failureCode: null };
      return json(201, { request: closureRequest });
    }
    return { request: closureRequest, blockers: [], consequences: [], coolingOffDays: 7, confirmationPhrase: "close my account" };
  };
  const r = await render();
  await r.type("Confirmation phrase", "close my account");
  await r.type("Reason for closing", "testing");
  await r.press("Request account closure");
  await answerStepUp(r);
  const bodies = posted("/v1/identity/account-closure");
  assert.deepEqual(bodies, [
    { confirmation: "close my account", reason: "testing" },
    { confirmation: "close my account", reason: "testing", stepUp: { method: "password", currentPassword: "correct horse" } },
  ]);
  assert.ok(!bodies.some((b) => "confirmationPhrase" in b), "the app sent a field the route does not read");
  assert.ok(r.hasText("Scheduled — cancellation window open"), "the open request was not shown");
  assert.equal(r.byLabel("Cancel closure request").length > 0, true);
});

test("PRO-114: a wrong password is said in the server's words and nothing is requested", async () => {
  routes["/v1/identity/account-closure"] = (init) => {
    if (init.method === "POST") {
      const b = JSON.parse(init.body);
      if (!b.stepUp) return stepUpRequired();
      return json(401, { error: { code: "STEP_UP_INVALID", methods: ["password"], message: "The current password is incorrect." } });
    }
    return { request: null, blockers: [], consequences: [], coolingOffDays: 7, confirmationPhrase: "close my account" };
  };
  const r = await render();
  await r.type("Confirmation phrase", "close my account");
  await r.press("Request account closure");
  await answerStepUp(r, "wrong");
  assert.ok(r.hasText("The current password is incorrect."));
  assert.equal(r.byLabel("Cancel closure request").length, 0, "a refused request is shown as open");
});

test("PRO-114: Download is the route's POST with the proof; the package is saved to the export folder and shared, no URL is opened", async () => {
  const pkg = { schemaVersion: 1, user: { id: "user-1" } };
  routes["/v1/identity/data-export"] = (init, path) => {
    if (path.endsWith("/download")) {
      if (init.method !== "POST") return json(404, { error: { code: "ROUTE_NOT_FOUND" } });
      const b = JSON.parse(init.body);
      return b.stepUp ? json(200, pkg) : stepUpRequired();
    }
    return { requests: [{ id: "x1", status: "READY", requestedAtUtc: "2026-09-20T10:00:00Z", completedAtUtc: "2026-09-20T10:05:00Z", expiresAtUtc: "2099-01-01T00:00:00Z", failureCode: null, packageSha256: "0123456789abcdef0123", downloadCount: 0 }] };
  };
  M.calls.reset();
  const r = await render();
  await r.press("Download");
  await answerStepUp(r);
  assert.deepEqual(posted("/v1/identity/data-export/x1/download"), [{}, { stepUp: { method: "password", currentPassword: "correct horse" } }]);
  assert.equal(requests.filter((q) => q.method === "GET" && q.path.endsWith("/download")).length, 0, "a GET was made to the POST-only route");
  assert.deepEqual(M.calls.openURL, [], "the download was opened in a browser without the session");
  const file = "file:///cache/proovra-exports/proovra-account-export-x1.json";
  assert.deepEqual(JSON.parse(globalThis.__WRITTEN__[file]), pkg);
  assert.equal(globalThis.__SHARED__.at(-1)?.uri, file);
});

test("PRO-114 control: an export in flight disables a second request instead of producing the server's refusal", async () => {
  routes["/v1/identity/data-export"] = () => ({ requests: [{ id: "x1", status: "PROCESSING", requestedAtUtc: "2026-09-20T10:00:00Z" }] });
  const r = await render();
  await r.press("Request a data export");
  assert.equal(posted("/v1/identity/data-export").length, 0);
});

test("the recorded cookie consent is shown read-only, with its categories (PrivacySection :933/:941/:947)", async () => {
  const r = await render();
  assert.equal(r.byTestId("cookie-consent-record").length, 1);
  assert.ok(r.hasText("Consent version · v3"));
  assert.ok(r.hasText("Allowed categories · Necessary, Analytics"));
  r.unmount();
  routes["/v1/users/cookie-consent/latest"] = () => ({ record: null });
  const r2 = await render();
  assert.ok(r2.hasText("No cookie consent recorded on this account yet."));
});
