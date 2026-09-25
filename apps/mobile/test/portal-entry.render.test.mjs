/**
 * Portal entry (`portal/index.tsx`) and the token exchange + dashboard
 * (`portal/[token].tsx`), rendered for real against the SERVER's contract:
 *
 *   POST /v1/portal/auth       external-portal.routes.ts:827 — PortalAuthBody
 *                              (:122) { token 8..256, mfaToken? 1..16,
 *                              existingSessionId? }; 200 { sessionId, newLogin,
 *                              reviewerEmail, role, expiresAtUtc } (:863);
 *                              429 RATE_LIMITED, 503 MFA_/SESSION_UNAVAILABLE,
 *                              else 401 { denial, ...mfa } (:848-854).
 *   GET  /v1/portal/dashboard  :897 — Bearer token + x-portal-session
 *                              (resolvePortalSession :387-388); 200 { portal }
 *                              (portal-projection.service.ts ExternalPortalProjection).
 *   POST /v1/portal/logout     :875 — same headers; 200 { ok: true }.
 *
 * Denial vocabulary: portal-session.service.ts (TOKEN_INVALID / TOKEN_EXPIRED /
 * TOKEN_REVOKED, MFA_REQUIRED, and verifyPortalMfaCode's MFA_INVALID /
 * MFA_CODE_EXHAUSTED).
 *
 * DEFECTS these tests pin (fixed in src/product/portal.ts and portal/index.tsx):
 *   - a wrong emailed code answers 401 MFA_INVALID; native only knew the
 *     invented MFA_CODE_INVALID, so one typo dead-ended the reviewer on
 *     "could not be opened" with no way back to the code step;
 *   - 401 TOKEN_INVALID fell through to UNKNOWN instead of "this link is not
 *     valid";
 *   - the entry screen accepted tokens up to 512 chars while PortalAuthBody
 *     caps the token at 256, so a long paste was sent only to be rejected.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_PORTAL_LIMITATIONS,
  externalPortalCapabilitiesForRole,
} from "@proovra/shared";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const TOKEN = "a3f9".repeat(16); // 64 hex, the shape the grant service mints
const SESSION = "0123456789abcdef0123456789abcdef"; // PORTAL_SESSION_ID_PATTERN: 32 hex
const WF_OPEN = "3f0c2a1e-0000-4000-8000-00000000000a";
const WF_DONE = "3f0c2a1e-0000-4000-8000-00000000000b";

let Entry;
let Portal;
let requests = [];
let authReplies = [];
let dashboard;

const send = (b, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** The real projection shape (portal-projection.service.ts:96-137). */
function projection({ assigned }) {
  return {
    schemaVersion: 1,
    generatedAtUtc: "2026-09-24T09:00:00.000Z",
    reviewer: {
      grantId: "9b1f0000-0000-4000-8000-000000000001",
      email: "rae@counsel.example",
      displayName: "Rae Counsel",
      organization: "Counsel LLP",
      role: "EXTERNAL_REVIEWER",
      capabilities: Array.from(externalPortalCapabilitiesForRole("EXTERNAL_REVIEWER")),
    },
    scope: { kind: "CASE", label: "Case 7c2e91aa…", expiresAtUtc: "2026-12-01T00:00:00.000Z" },
    assigned,
    completedCount: assigned.filter((a) => a.submittedDecisionAtUtc).length,
    pendingCount: assigned.filter((a) => !a.submittedDecisionAtUtc).length,
    totalCount: assigned.length,
    watermark: { policy: "NEVER", signedToken: null },
    session: { sessionId: SESSION, inactivityTimeoutMs: 900000, maxSessionMs: 28800000 },
    limitations: EXTERNAL_PORTAL_LIMITATIONS,
  };
}

/** PortalAuthBody (external-portal.routes.ts:122), checked by hand. */
function assertValidAuthBody(body) {
  for (const k of Object.keys(body)) {
    assert.ok(["token", "mfaToken", "existingSessionId"].includes(k), `PortalAuthBody has no "${k}"`);
  }
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length >= 8 && body.token.length <= 256, "token outside 8..256");
  if ("mfaToken" in body) assert.ok(body.mfaToken.length >= 1 && body.mfaToken.length <= 16);
  if ("existingSessionId" in body) assert.ok(body.existingSessionId.length <= 80);
}

before(async () => {
  Entry = await loadModule("app/(stack)/portal/index.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  Portal = await loadModule("app/(stack)/portal/[token].tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/portal/portal-session.ts",
  ]);
});

beforeEach(() => {
  requests = [];
  authReplies = [];
  dashboard = projection({
    assigned: [
      // The server never sends a title (portal-projection.service.ts:73).
      { workflowId: WF_DONE, evidenceId: "e-1", title: null, dueAt: "2026-09-20T00:00:00.000Z", submittedDecisionAtUtc: "2026-09-21T10:00:00.000Z" },
      { workflowId: WF_OPEN, evidenceId: "e-2", title: null, dueAt: "2026-10-05T00:00:00.000Z", submittedDecisionAtUtc: null },
    ],
  });
  Entry.calls.reset();
  Portal.calls.reset();
  Portal.clearPortalSession();
  globalThis.__EXPO_PARAMS__ = { token: TOKEN };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path, method, headers, body });
    if (path === "/v1/portal/auth" && method === "POST") {
      assertValidAuthBody(body);
      const next = authReplies.shift();
      if (next) return send(next.body, next.status);
      return send({ sessionId: SESSION, newLogin: true, reviewerEmail: "rae@counsel.example", role: "EXTERNAL_REVIEWER", expiresAtUtc: "2026-12-01T00:00:00.000Z" });
    }
    if (path === "/v1/portal/dashboard" && method === "GET") {
      if (headers.get("authorization") !== `Bearer ${TOKEN}`) return send({ denial: "TOKEN_INVALID" }, 401);
      return send({ portal: dashboard });
    }
    if (path === "/v1/portal/logout" && method === "POST") return send({ ok: true });
    return send({ message: "unstubbed" }, 500);
  };
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const renderPortal = async () => {
  const r = await renderComponent(h(Portal.TestProviders, null, h(Portal.default, {})));
  await settle();
  return r;
};
const renderEntry = async () => {
  const r = await renderComponent(h(Entry.TestProviders, null, h(Entry.default, {})));
  await settle();
  return r;
};
const isDisabled = (r, label) => {
  const n = r.byLabel(label).find((x) => x.props.onPress);
  return Boolean(n.props.disabled ?? n.props.accessibilityState?.disabled);
};

// ----------------------------------------------------------------- entry

test("entry: a pasted token opens /portal/<token>; too short is refused", async () => {
  const r = await renderEntry();
  assert.ok(r.hasText("Paste the access token from your invitation email."));
  assert.equal(isDisabled(r, "Open my reviews"), true, "empty token must not submit");
  await r.type("Access token", "short");
  assert.equal(isDisabled(r, "Open my reviews"), true, "a 5-char token is not a token");
  await r.type("Access token", `  ${TOKEN}  `);
  assert.equal(isDisabled(r, "Open my reviews"), false);
  await r.press("Open my reviews");
  assert.deepEqual(Entry.calls.push, [`/portal/${TOKEN}`], "the trimmed token is handed to the ONE exchange screen");
  assert.equal(requests.length, 0, "the entry screen authenticates nothing itself");
});

test("entry: a token longer than PortalAuthBody's 256 cap is refused before it is sent", async () => {
  const r = await renderEntry();
  await r.type("Access token", "a".repeat(257));
  assert.equal(isDisabled(r, "Open my reviews"), true, "the server would reject a 257-char token (external-portal.routes.ts:123)");
  await r.type("Access token", "a".repeat(256));
  assert.equal(isDisabled(r, "Open my reviews"), false);
});

// ----------------------------------------------------------- [token]: happy

test("portal: the token is exchanged, then the dashboard is read with the portal's own credential", async () => {
  const r = await renderPortal();
  const auth = requests.find((q) => q.path === "/v1/portal/auth");
  assert.deepEqual(auth.body, { token: TOKEN }, "a first exchange sends neither a code nor a session");
  assert.equal(auth.headers.get("authorization"), `Bearer ${TOKEN}`);
  const dash = requests.find((q) => q.path === "/v1/portal/dashboard");
  assert.equal(dash.method, "GET");
  assert.equal(dash.headers.get("authorization"), `Bearer ${TOKEN}`, "the portal bearer, never the app's authToken");
  assert.equal(dash.headers.get("x-portal-session"), SESSION, "the session id the exchange returned");

  assert.ok(r.hasText("Rae Counsel"));
  assert.ok(r.hasText("Counsel LLP · EXTERNAL_REVIEWER"));
  assert.ok(r.hasText("rae@counsel.example"));
  assert.ok(r.hasText("Case 7c2e91aa…"));
  assert.ok(r.texts().some((t) => t.startsWith("Access ends ")));
  assert.ok(r.hasText("What this review does not establish"));
  for (const l of EXTERNAL_PORTAL_LIMITATIONS) assert.ok(r.hasText(`• ${l}`), `limitation missing: ${l}`);

  // Server titles are null: each row still reads as a review, outstanding first.
  const texts = r.texts();
  const due = texts.findIndex((t) => t.startsWith("Due "));
  const decided = texts.findIndex((t) => t.startsWith("Decided "));
  assert.ok(due >= 0 && decided >= 0 && due < decided, "the outstanding review sorts above the decided one");
  assert.ok(r.hasText("To review"));
  assert.ok(r.hasText("Done"));
  assert.ok(r.hasText("Untitled review"));
});

test("portal: opening an assignment navigates to its work screen", async () => {
  const r = await renderPortal();
  const rows = r.byLabel("Untitled review").filter((n) => n.props.onPress);
  assert.ok(rows.length >= 1, "assignment rows are pressable");
  await act(async () => { await rows[0].props.onPress(); });
  assert.deepEqual(Portal.calls.push, [`/portal/work/${WF_OPEN}`]);
});

test("portal: nothing assigned says so", async () => {
  dashboard = projection({ assigned: [] });
  const r = await renderPortal();
  assert.ok(r.hasText("Nothing is assigned to you right now."));
});

test("portal: sign out posts /v1/portal/logout with the session and forgets it", async () => {
  const r = await renderPortal();
  assert.equal(Portal.getPortalToken(), TOKEN);
  await r.press("Sign out of the portal");
  await settle();
  const out = requests.find((q) => q.path === "/v1/portal/logout");
  assert.equal(out.method, "POST");
  assert.equal(out.headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(out.headers.get("x-portal-session"), SESSION);
  assert.deepEqual(Portal.calls.replace, ["/"]);
  assert.equal(Portal.getPortalToken(), null);
  assert.equal(Portal.getPortalSessionId(), null);
});

test("portal: leaving the screen forgets the credential", async () => {
  const r = await renderPortal();
  assert.equal(Portal.getPortalSessionId(), SESSION);
  r.unmount();
  assert.equal(Portal.getPortalToken(), null);
  assert.equal(Portal.getPortalSessionId(), null);
});

// ------------------------------------------------------------- [token]: MFA

test("portal: MFA_REQUIRED opens the code step; a wrong code (MFA_INVALID) keeps it; the right one opens the portal", async () => {
  authReplies = [
    // external-portal.routes.ts:854 spreads the PortalMfaDenialDetail at the top level.
    { status: 401, body: { denial: "MFA_REQUIRED", codeSent: true, destination: "r***@counsel.example", resendAvailableInSeconds: 60, attemptsRemaining: null } },
    { status: 401, body: { denial: "MFA_INVALID", codeSent: false, destination: null, resendAvailableInSeconds: null, attemptsRemaining: 4 } },
  ];
  const r = await renderPortal();
  assert.ok(r.hasText("We emailed a six-digit code to r***@counsel.example. It expires in 10 minutes and works once."));
  assert.equal(requests.filter((q) => q.path === "/v1/portal/dashboard").length, 0, "no dashboard before the code");

  await r.type("Six-digit code", "111111");
  await r.press("Verify code");
  await settle();
  const wrong = requests.filter((q) => q.path === "/v1/portal/auth")[1];
  assert.deepEqual(wrong.body, { token: TOKEN, mfaToken: "111111" });
  assert.ok(
    r.byLabel("Six-digit code").length > 0,
    "a mistyped code must leave the reviewer on the code step, not a dead-end denial",
  );
  assert.ok(!r.hasText("This review access is not open"));

  await r.type("Six-digit code", " 222222 ");
  await r.press("Verify code");
  await settle();
  const right = requests.filter((q) => q.path === "/v1/portal/auth")[2];
  assert.deepEqual(right.body, { token: TOKEN, mfaToken: "222222" });
  assert.ok(r.hasText("Rae Counsel"), "the verified code opens the portal");
  const dash = requests.find((q) => q.path === "/v1/portal/dashboard");
  assert.equal(dash.headers.get("x-portal-session"), SESSION);
});

// --------------------------------------------------------- [token]: denials

for (const [name, status, denial, message] of [
  ["expired", 401, "TOKEN_EXPIRED", "This review access has expired. Ask the workspace that invited you for a new link."],
  ["revoked", 401, "TOKEN_REVOKED", "This review access has been withdrawn. Contact the workspace that invited you."],
  ["invalid", 401, "TOKEN_INVALID", "This link is not valid. Open the most recent invitation email and use the link there."],
  ["throttled", 429, "RATE_LIMITED", "Too many attempts. Wait a few minutes and try again."],
  ["unavailable", 503, "SESSION_UNAVAILABLE", "The review portal is temporarily unavailable. Try again shortly."],
]) {
  test(`portal: a ${name} token (${status} ${denial}) is refused with what to do`, async () => {
    authReplies = [{ status, body: { denial } }];
    const r = await renderPortal();
    assert.ok(r.hasText("This review access is not open"));
    assert.ok(r.hasText(message), `expected: ${message}\ngot: ${r.texts().join(" | ")}`);
    assert.equal(requests.filter((q) => q.path === "/v1/portal/dashboard").length, 0);
    assert.equal(r.byLabel("Six-digit code").length, 0);
  });
}

test("portal: no token in the route is refused without calling the server", async () => {
  globalThis.__EXPO_PARAMS__ = {};
  const r = await renderPortal();
  assert.equal(requests.length, 0);
  assert.ok(r.hasText("This link is not valid. Open the most recent invitation email and use the link there."));
});
