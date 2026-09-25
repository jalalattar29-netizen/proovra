/**
 * The external reviewer's emailed-code step on `portal/[token].tsx` — the port
 * of apps/web/components/external-portal/PortalMfaCodeStep.tsx — rendered for
 * real against the SERVER's contract (ledger NEW:PORTAL-MFA-RESEND):
 *
 *   POST /v1/portal/auth   external-portal.routes.ts:827, body PortalAuthBody
 *                          (:122). A refusal answers
 *                            429 { denial: "RATE_LIMITED" }                 (:848-850)
 *                            503 { denial: "MFA_UNAVAILABLE" | ... }        (:851-853)
 *                            401 { denial, ...(sess.mfa ?? {}) }            (:854)
 *                          where `mfa` is (portal-session.service.ts:261-291)
 *                            { codeSent, destination, resendAvailableInSeconds,
 *                              attemptsRemaining }
 *                          — MFA_REQUIRED + codeSent + masked destination +
 *                          cooldown after issuing (or reusing) a code;
 *                          MFA_INVALID / MFA_CODE_EXHAUSTED with codeSent:false
 *                          and attemptsRemaining (portal-mfa-challenge.service.ts:
 *                          5 tries, 60s resend cooldown, 5 codes / 15 min).
 *
 * "Send a new code" is NOT a separate route: the web re-sends the token
 * exchange with no `mfaToken` (PortalMfaCodeStep.tsx resend → authenticate
 * ({ token, existingSessionId })), and a code-less exchange issues a code
 * (issueMfaCode: true, external-portal.routes.ts:842).
 *
 * THE DEFECT these tests pin: native threw the MFA detail away and had no
 * resend, so the masked address, the cooldown and the tries left were never
 * shown, and after MFA_CODE_EXHAUSTED the only way on was to reopen the link.
 */
import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { EXTERNAL_PORTAL_LIMITATIONS, externalPortalCapabilitiesForRole } from "@proovra/shared";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const TOKEN = "a3f9".repeat(16);
const SESSION = "0123456789abcdef0123456789abcdef";
const MASKED = "r***@counsel.example"; // maskEmail's shape: the full address never leaves the server

/**
 * PortalAuthBody, verbatim from external-portal.routes.ts:122-126. The route
 * module cannot be imported here (it boots Prisma), so the SOURCE is read and
 * the declaration pinned below: an edit to the server schema fails this file.
 */
const PORTAL_AUTH_BODY_SOURCE = `const PortalAuthBody = z.object({
  token: z.string().min(8).max(256),
  mfaToken: z.string().min(1).max(16).optional(),
  existingSessionId: z.string().max(80).optional(),
});`;
const PortalAuthBody = z
  .object({
    token: z.string().min(8).max(256),
    mfaToken: z.string().min(1).max(16).optional(),
    existingSessionId: z.string().max(80).optional(),
  })
  .strict(); // strict here so an invented key is caught, not silently stripped

let Portal;
let requests = [];
let authReplies = [];

const send = (b, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const OK_AUTH = {
  status: 200,
  body: { sessionId: SESSION, newLogin: true, reviewerEmail: "rae@counsel.example", role: "EXTERNAL_REVIEWER", expiresAtUtc: "2026-12-01T00:00:00.000Z" },
};
/** portal-session.service.ts:275-285 — a code issued (or reused) by a code-less exchange. */
const codeSent = (resendAvailableInSeconds = 60) => ({
  status: 401,
  body: { denial: "MFA_REQUIRED", codeSent: true, destination: MASKED, resendAvailableInSeconds, attemptsRemaining: null },
});
/** portal-session.service.ts:299-307 — verifyPortalMfaCode refused the code. */
const refused = (denial, attemptsRemaining) => ({
  status: 401,
  body: { denial, codeSent: false, destination: null, resendAvailableInSeconds: null, attemptsRemaining },
});

function dashboard() {
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
    assigned: [],
    completedCount: 0,
    pendingCount: 0,
    totalCount: 0,
    watermark: { policy: "NEVER", signedToken: null },
    session: { sessionId: SESSION, inactivityTimeoutMs: 900000, maxSessionMs: 28800000 },
    limitations: EXTERNAL_PORTAL_LIMITATIONS,
  };
}

before(async () => {
  Portal = await loadModule("app/(stack)/portal/[token].tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/portal/portal-session.ts",
  ]);
});

beforeEach(() => {
  requests = [];
  authReplies = [];
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
      const parsed = PortalAuthBody.safeParse(body);
      assert.ok(parsed.success, `PortalAuthBody rejects ${JSON.stringify(body)}: ${parsed.error?.message}`);
      const next = authReplies.shift() ?? OK_AUTH;
      return send(next.body, next.status);
    }
    if (path === "/v1/portal/dashboard" && method === "GET") return send({ portal: dashboard() });
    return send({ message: "unstubbed" }, 500);
  };
});

let mounted = [];
afterEach(() => {
  // Unmount while the clock is still mocked, so no countdown outlives its test.
  for (const r of mounted) r.unmount();
  mounted = [];
  mock.timers.reset();
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const renderPortal = async () => {
  const r = await renderComponent(h(Portal.TestProviders, null, h(Portal.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
const isDisabled = (r, label) => {
  const n = r.byLabel(label).find((x) => x.props.onPress);
  assert.ok(n, `no pressable labelled "${label}" — got: ${r.texts().join(" | ")}`);
  return Boolean(n.props.disabled ?? n.props.accessibilityState?.disabled);
};
const auths = () => requests.filter((q) => q.path === "/v1/portal/auth");
/** Advance the mocked clock (Date + setInterval only; settle's setTimeout stays real). */
const tick = async (ms) => {
  await act(async () => { mock.timers.tick(ms); });
  await settle();
};
const useClock = () => mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.parse("2026-09-25T09:00:00.000Z") });

// ----------------------------------------------------------------- contract

test("contract: the PortalAuthBody pinned here is the server's declaration, character for character", () => {
  const src = readFileSync(new URL("../../../services/api/src/routes/external-portal.routes.ts", import.meta.url), "utf8");
  assert.ok(src.includes(PORTAL_AUTH_BODY_SOURCE), "external-portal.routes.ts PortalAuthBody changed — update this test's schema");
  assert.ok(src.includes("reply.code(401).send({ denial: sess.denial, ...(sess.mfa ?? {}) })"), "the 401 MFA detail is spread at the top level");
});

// ------------------------------------------------------ what the step says

test("MFA_REQUIRED: the step names the masked address and counts down to when a new code may be asked for", async () => {
  useClock();
  authReplies = [codeSent(60)];
  const r = await renderPortal();

  assert.ok(r.hasText("Confirm it is you"));
  assert.ok(r.hasText("Enter your sign-in code"));
  assert.ok(r.hasText(`We emailed a six-digit code to ${MASKED}. It expires in 10 minutes and works once.`));
  assert.ok(r.hasText("Check your inbox and spam folder. Only the newest code works."));
  assert.ok(!r.hasText("Enter the six-digit code from your email to open the portal."), "MFA_REQUIRED opens the step without a problem banner");

  assert.equal(isDisabled(r, "Send a new code"), true, "the server's cooldown is still running");
  assert.ok(r.hasText("You can ask for a new code in 60 seconds."));
  await tick(1000);
  assert.ok(r.hasText("You can ask for a new code in 59 seconds."), `countdown did not tick: ${r.texts().join(" | ")}`);
  await tick(59000);
  assert.ok(!r.texts().some((t) => t.startsWith("You can ask for a new code")));
  assert.equal(isDisabled(r, "Send a new code"), false, "the cooldown is over");
});

test("the server's REMAINING cooldown is honoured (a reused code answers less than 60s)", async () => {
  useClock();
  authReplies = [codeSent(17)];
  const r = await renderPortal();
  assert.ok(r.hasText("You can ask for a new code in 17 seconds."));
});

test("the code field keeps six digits only; Verify is disabled until there are six", async () => {
  authReplies = [codeSent(60)];
  const r = await renderPortal();
  assert.equal(isDisabled(r, "Verify code"), true);
  await r.type("Six-digit code", "12-3 45");
  assert.equal(r.byLabel("Six-digit code").find((n) => n.props.onChangeText).props.value, "12345");
  assert.equal(isDisabled(r, "Verify code"), true);
  await r.type("Six-digit code", "1234567");
  assert.equal(r.byLabel("Six-digit code").find((n) => n.props.onChangeText).props.value, "123456");
  assert.equal(isDisabled(r, "Verify code"), false);
});

// ------------------------------------------------------------ wrong codes

test("MFA_INVALID says how many tries remain, clears the field, and stays on the step", async () => {
  authReplies = [codeSent(60), refused("MFA_INVALID", 4), refused("MFA_INVALID", 1)];
  const r = await renderPortal();

  await r.type("Six-digit code", "111111");
  await r.press("Verify code");
  await settle();
  assert.deepEqual(auths()[1].body, { token: TOKEN, mfaToken: "111111" });
  assert.ok(r.hasText("That code is not correct. You have 4 tries left."), r.texts().join(" | "));
  assert.equal(r.byLabel("Six-digit code").find((n) => n.props.onChangeText).props.value, "", "the wrong code is cleared");
  assert.ok(r.hasText(`We emailed a six-digit code to ${MASKED}.`), "the live code's address is still shown");

  await r.type("Six-digit code", "222222");
  await r.press("Verify code");
  await settle();
  assert.ok(r.hasText("That code is not correct. You have 1 try left."));
});

test("MFA_CODE_EXHAUSTED: the old email is worthless, and 'Send a code' re-sends the exchange with NO code", async () => {
  useClock();
  authReplies = [
    codeSent(60),
    refused("MFA_CODE_EXHAUSTED", 0),
    codeSent(60), // the resend: a fresh code is issued
    OK_AUTH, // the fresh code verifies
  ];
  const r = await renderPortal();
  await r.type("Six-digit code", "999999");
  await r.press("Verify code");
  await settle();

  assert.ok(r.hasText("Too many incorrect codes. That code no longer works. Send a new code to try again."));
  assert.ok(r.hasText("This invitation needs a six-digit code sent to the invited email address."), "no longer claims a code is live");
  assert.ok(!r.texts().some((t) => t.startsWith("You can ask for a new code")), "the destroyed challenge's cooldown is cleared");
  assert.equal(isDisabled(r, "Send a code"), false, "the reviewer can recover without reopening the link");

  await r.press("Send a code");
  await settle();
  const resend = auths()[2];
  assert.deepEqual(resend.body, { token: TOKEN }, "a resend is the token exchange without mfaToken — what the web sends");
  assert.equal(resend.headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.ok(r.hasText(`We emailed a six-digit code to ${MASKED}. It expires in 10 minutes and works once.`));
  assert.ok(!r.hasText("Too many incorrect codes."), "a fresh code on its way is not a problem");
  assert.equal(isDisabled(r, "Send a new code"), true);
  assert.ok(r.hasText("You can ask for a new code in 60 seconds."));

  await r.type("Six-digit code", "424242");
  await r.press("Verify code");
  await settle();
  assert.deepEqual(auths()[3].body, { token: TOKEN, mfaToken: "424242" });
  assert.ok(r.hasText("Rae Counsel"), "the fresh code opens the portal");
});

// ------------------------------------------------------ resend refusals

test("a resend refused with 429 RATE_LIMITED says to wait 15 minutes, on the step", async () => {
  useClock();
  authReplies = [codeSent(1), { status: 429, body: { denial: "RATE_LIMITED" } }];
  const r = await renderPortal();
  await tick(1000);
  await r.press("Send a new code");
  await settle();
  assert.deepEqual(auths()[1].body, { token: TOKEN });
  assert.ok(r.hasText("Too many codes were requested for this invitation. Wait 15 minutes, then send a new code."), r.texts().join(" | "));
  assert.ok(r.byLabel("Six-digit code").length > 0);
  assert.ok(!r.hasText("This review access is not open"));
});

test("503 MFA_UNAVAILABLE on opening lands on the step with the web's message, and nothing claims a code was sent", async () => {
  authReplies = [{ status: 503, body: { denial: "MFA_UNAVAILABLE" } }];
  const r = await renderPortal();
  assert.ok(r.hasText("We can't send or check sign-in codes right now, so the portal stays closed. Try again in a few minutes."), r.texts().join(" | "));
  assert.ok(r.hasText("This invitation needs a six-digit code sent to the invited email address."));
  assert.equal(isDisabled(r, "Send a code"), false);
});

test("a resend answered 200 (satisfied meanwhile) opens the portal, carrying the held session id", async () => {
  useClock();
  Portal.setPortalSessionId(SESSION); // a lapsed MFA satisfaction on a live session
  authReplies = [codeSent(1), OK_AUTH];
  const r = await renderPortal();
  assert.deepEqual(auths()[0].body, { token: TOKEN, existingSessionId: SESSION });
  await tick(1000);
  await r.press("Send a new code");
  await settle();
  assert.deepEqual(auths()[1].body, { token: TOKEN, existingSessionId: SESSION });
  assert.ok(r.hasText("Rae Counsel"));
});
