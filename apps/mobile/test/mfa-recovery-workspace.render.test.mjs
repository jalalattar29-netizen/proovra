/**
 * Native defect found by the T-13 adjudication: the MFA challenge renders the
 * recovery panel with `teamId={null}` (app/(stack)/mfa.tsx:80), and the panel
 * never resolved a workspace — so "File recovery request" could NEVER be
 * enabled there. A user who lost their authenticator could not file a request
 * on the device. The web panel loads GET /v1/teams and asks for the workspace
 * (MfaRecoveryRequestPanel.tsx:330-378, 489-524).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

before(async () => {
  M = await loadModule("src/ui/mfa-recovery-request.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  requests = [];
  routes = {
    "/v1/auth/session-light": () => ({ authenticated: true }),
    "/v1/teams": () => ({ teams: [{ id: "t-a", name: "Acme Claims" }, { id: "t-b", name: "Beta Legal" }] }),
    "/v1/identity/mfa-admin/recovery-requests": () => ({ request: { id: "rr-1" } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const res = routes[path.split("?")[0]]?.();
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async (teamId = null) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.MfaRecoveryRequestPanel, { teamId })));
  await settle();
  return r;
};
const fileBtn = (r) => r.byLabel("File recovery request")[0];
const REASON = "My phone was stolen and the authenticator app went with it.";

test("with no active workspace, the caller's workspaces are offered and the request can be FILED", async () => {
  const r = await render(null);
  assert.ok(requests.some((q) => q.path === "/v1/teams"), "the caller's workspaces were never resolved");
  assert.ok(r.byLabel("Workspace: Acme Claims").length === 1);
  await r.press("Workspace: Beta Legal");
  await r.type("What happened", REASON);
  assert.ok(!fileBtn(r).props.accessibilityState?.disabled, "File recovery request is still impossible to enable");
  await r.press("File recovery request");
  await settle();
  const post = requests.find((q) => q.method === "POST");
  assert.equal(post.path, "/v1/identity/mfa-admin/recovery-requests");
  assert.equal(post.body.teamId, "t-b");
});

test("no workspace membership says why instead of offering a dead form", async () => {
  routes["/v1/teams"] = () => ({ teams: [] });
  const r = await render(null);
  assert.ok(r.hasText("No workspace membership was found for this account"));
  assert.equal(r.byLabel("File recovery request").length, 0);
});

test("no session: stated, and no workspace read is attempted", async () => {
  routes["/v1/auth/session-light"] = () => ({ authenticated: false });
  const r = await render(null);
  assert.ok(r.hasText("needs a signed-in session"));
  assert.ok(!requests.some((q) => q.path === "/v1/teams"));
});

test("an authenticated surface that passes its workspace is not asked again", async () => {
  const r = await render("t-active");
  assert.equal(r.byLabel("Workspace: Acme Claims").length, 0);
  assert.ok(!requests.some((q) => q.path === "/v1/teams"));
  await r.type("What happened", REASON);
  await r.press("File recovery request");
  await settle();
  assert.equal(requests.find((q) => q.method === "POST").body.teamId, "t-active");
});

/* ---------------------------------------------------- the filed request's status */

const fileOne = async (r) => {
  await r.type("What happened", REASON);
  await r.press("File recovery request");
  await settle();
};
let detail;
const withDetail = () => {
  detail = { id: "rr-1", status: "EMAIL_VERIFICATION_PENDING", emailVerified: false, emailResendCount: 1, expiresAt: "2026-10-01T12:00:00Z" };
  routes["/v1/identity/mfa-admin/recovery-requests/detail/rr-1"] = () => ({ detail });
};

test("after filing, the request is READ BACK: status sentence and expiry", async () => {
  withDetail();
  const r = await render("t-active");
  await fileOne(r);
  assert.ok(requests.some((q) => q.path === "/v1/identity/mfa-admin/recovery-requests/detail/rr-1"), "the filed request was never read back");
  assert.ok(r.hasText("Your recovery request"));
  assert.ok(r.hasText("Waiting for you to confirm the link we emailed you."));
  assert.ok(r.hasText("Expires"));
});

test("Resend is withheld with the reason once the email is confirmed; Cancel only while waiting", async () => {
  withDetail();
  detail = { ...detail, status: "PENDING_ADMIN_REVIEW", emailVerified: true };
  const r = await render("t-active");
  await fileOne(r);
  assert.ok(r.byLabel("Resend verification email")[0].props.accessibilityState.disabled);
  assert.ok(r.hasText("Your email is already confirmed, so no new link is needed."));
  assert.ok(!r.byLabel("Cancel request")[0].props.accessibilityState?.disabled, "a request under review could not be cancelled");
});

test("a request no longer waiting (approved) offers neither Resend nor Cancel, and says why", async () => {
  withDetail();
  detail = { ...detail, status: "APPROVED", emailVerified: true };
  const r = await render("t-active");
  await fileOne(r);
  assert.ok(r.hasText("Approved. Sign in and enroll a new second factor."));
  assert.ok(r.byLabel("Cancel request")[0].props.accessibilityState.disabled);
  assert.ok(r.hasText("Only a request that is still waiting can be cancelled."));
});

test("cancel asks first and is announced only when the reread shows CANCELLED", async () => {
  withDetail();
  routes["/v1/identity/mfa/recovery-requests/rr-1/cancel"] = () => {
    detail = { ...detail, status: "CANCELLED" };
    return {};
  };
  const r = await render("t-active");
  await fileOne(r);
  await r.press("Cancel request");
  assert.ok(r.hasText("Cancel this recovery request?"));
  const confirm = r.byLabel("Cancel request").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.ok(requests.some((q) => q.method === "POST" && q.path === "/v1/identity/mfa/recovery-requests/rr-1/cancel"));
  assert.ok(r.hasText("Your recovery request was cancelled. You can file a new one below."));
  assert.equal(r.byLabel("File recovery request").length, 1, "the form did not come back after a confirmed cancel");
});

test("a cancel the server refuses (already approved) says so in the web's words", async () => {
  withDetail();
  routes["/v1/identity/mfa/recovery-requests/rr-1/cancel"] = () => ({ __status: 409 });
  const r = await render("t-active");
  await fileOne(r);
  await r.press("Cancel request");
  const confirm = r.byLabel("Cancel request").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.ok(r.hasText("This request was already approved, so it cannot be cancelled."));
});

test("a rate-limited resend names when another is allowed", async () => {
  withDetail();
  routes["/v1/identity/mfa/recovery-requests/rr-1/resend-email"] = () => ({ __status: 429 });
  const r = await render("t-active");
  await fileOne(r);
  await r.press("Resend verification email");
  await settle();
  assert.ok(r.hasText("A verification email was sent recently."));
});
