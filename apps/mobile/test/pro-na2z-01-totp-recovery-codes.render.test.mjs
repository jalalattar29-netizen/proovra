/**
 * PRO-NA2Z-01 — enabling an authenticator from Settings › Security must show
 * the one-time recovery codes. `TotpEnrolment.verify` used to call
 * `onEnrolled()` in the same continuation that showed the codes; Settings then
 * reloaded behind a spinner, unmounting the component and the only copy of the
 * codes. The parent is now told only after the person acknowledged the codes.
 *
 * The harness reproduces Settings' behaviour: `onEnrolled` unmounts the
 * enrolment component (as `setLoading(true)` does).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let enrolledCalls = 0;
const CODES = ["aaaaa-bbbbb", "ccccc-ddddd", "eeeee-fffff"];

before(async () => {
  M = await loadModule("src/ui/totp-enrolment.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(() => {
  enrolledCalls = 0;
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const body =
      path === "/v1/identity/mfa/enroll/start"
        ? { factorId: "f-1", otpauthUri: "otpauth://totp/x", secretBase32: "ABCDEF" }
        : path === "/v1/identity/mfa/enroll/verify"
          ? { factor: { id: "f-1" }, recoveryCodes: CODES }
          : { message: "unstubbed" };
    const status = body.message === "unstubbed" ? 500 : 200;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

/** Settings' shape: once told "enrolled", the enrolment component is gone. */
function SettingsLike() {
  const [enrolled, setEnrolled] = React.useState(false);
  return enrolled
    ? h("View", null)
    : h(M.TotpEnrolment, {
        onEnrolled: () => {
          enrolledCalls += 1;
          setEnrolled(true);
        },
      });
}

test("the recovery codes stay on screen after a successful enrolment until they are acknowledged", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(SettingsLike)));
  await settle();
  await r.press("Set up two-factor authentication");
  await settle();
  await r.type("Authenticator code", "123456");
  await r.press("Verify & enable");
  await settle();
  assert.equal(enrolledCalls, 0, "the parent was told before the codes were acknowledged");
  for (const c of CODES) assert.ok(r.hasText(c), `recovery code ${c} is not shown`);
  // Done is refused until the person confirms they saved them.
  await r.press("Done");
  assert.equal(enrolledCalls, 0);
  const sw = r.byLabel("I saved these recovery codes in a safe place.")[0];
  await act(async () => { sw.props.onValueChange(true); });
  await r.press("Done");
  await settle();
  assert.equal(enrolledCalls, 1);
});
