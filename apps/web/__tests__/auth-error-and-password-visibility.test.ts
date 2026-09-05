/**
 * AUTH SCREENS — the error contract and the password visibility control.
 *
 * Two things are pinned here, because both were reported as the same symptom:
 * a sign-in that fails without telling you anything useful, on a form where
 * you cannot check what you typed.
 *
 * 1. A CREDENTIAL FAILURE IS NOT A SESSION EXPIRY. The API answers unknown
 *    email and wrong password with one identical 401 — deliberately, so the
 *    form cannot be used to discover who has an account. The web client used
 *    to bucket that by HTTP status and render "your session may have expired",
 *    on the sign-in page, to someone who was signing in.
 *
 * 2. THE TOGGLE IS ONE COMPONENT. Register and Reset password each had their
 *    own copy of the eye button; Sign in had none. Sign in and Register now
 *    consume the shared control, which is where the accessibility contract
 *    lives so there is exactly one place for it to be right.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const LOGIN = read("apps/web/app/login/page.tsx");
const REGISTER = read("apps/web/app/register/page.tsx");
const TOGGLE = read("apps/web/components/auth/PasswordVisibilityToggle.tsx");
const SAFE = read("apps/web/lib/feedback/toSafeUserError.ts");
const AUTH_ROUTES = read("services/api/src/routes/auth.routes.ts");

// ===========================================================================
// 1. The auth error contract
// ===========================================================================

test("the API answers a bad sign-in with the canonical bounded envelope", () => {
  const login = AUTH_ROUTES.slice(
    AUTH_ROUTES.indexOf('app.post("/v1/auth/email/login"'),
    AUTH_ROUTES.indexOf('app.post("/v1/auth/password-reset/request"'),
  );
  // A code the client can recognise, rather than a bare `message` that leaves
  // it guessing from the status.
  assert.match(login, /code: "INVALID_CREDENTIALS"/);
  assert.match(login, /message:\s*\n?\s*"Email or password is incorrect\."/);
  // The rate limit is bounded the same way.
  assert.match(login, /code: "RATE_LIMITED"/);
});

test("unknown email and wrong password remain indistinguishable", () => {
  const login = AUTH_ROUTES.slice(
    AUTH_ROUTES.indexOf('app.post("/v1/auth/email/login"'),
    AUTH_ROUTES.indexOf('app.post("/v1/auth/password-reset/request"'),
  );
  // One 401 exit for the whole handler. A second is how a well-meant
  // "that email isn't registered" would arrive.
  assert.equal((login.match(/reply\.code\(401\)/g) ?? []).length, 1);
  assert.doesNotMatch(login, /user_not_found|no_such_user|EMAIL_NOT_FOUND/);
});

test("the sign-in page maps that code to a message about credentials", () => {
  const entry = SAFE.slice(
    SAFE.indexOf("  INVALID_CREDENTIALS: {"),
    SAFE.indexOf("  UNAUTHORIZED: {"),
  );
  assert.ok(entry.length > 0, "INVALID_CREDENTIALS must be in the CODE_MAP");
  assert.match(entry, /Email or password is incorrect/);
  // The defect, in one assertion.
  assert.doesNotMatch(entry, /session/i);
  // And it must not resolve the ambiguity the API preserved.
  assert.doesNotMatch(entry, /not registered|no account|unknown email/i);
});

test("the sign-in page does not prefix its own provider name onto that", () => {
  /*
   * "Email sign-in failed: Email or password is incorrect" says it twice. The
   * prefix earns its place for Google and Apple, where several sign-in paths
   * exist and naming the one that failed is information.
   */
  assert.match(
    LOGIN,
    /provider === "guest" \|\| provider === "email"\s*\?\s*""/,
  );
});

test("validation failures are placed on the field they belong to", () => {
  assert.match(LOGIN, /fieldErrorsFromApiError\(err, \["email", "password"\]/);
  // Both inputs carry the invalid state and the description link.
  assert.match(LOGIN, /aria-invalid=\{Boolean\(fieldErrors\.email\)\}/);
  assert.match(LOGIN, /aria-invalid=\{Boolean\(fieldErrors\.password\)\}/);
  assert.match(LOGIN, /id="login-email-error"/);
  assert.match(LOGIN, /id="login-password-error"/);
  // The old single-sentence pre-flight is gone.
  assert.doesNotMatch(LOGIN, /"Please enter email and password\."/);
});

test("a credential failure is never attributed to one of the two fields", () => {
  /*
   * Field placement is right for a malformed address and wrong for a rejected
   * credential: marking the password box would tell the person the EMAIL was
   * accepted, which is precisely the fact the API refuses to disclose. The
   * fallbacks map declares copy for `email` only, and only for format.
   */
  const call = LOGIN.slice(
    LOGIN.indexOf("fieldErrorsFromApiError(err,"),
    LOGIN.indexOf("fieldErrorsFromApiError(err,") + 260,
  );
  assert.match(call, /email: "Enter a valid email address\."/);
  assert.doesNotMatch(call, /password:\s*"/);
});

// ===========================================================================
// 2. The password visibility control
// ===========================================================================

test("there is exactly one implementation, and both auth screens use it", () => {
  for (const [name, src] of [
    ["login", LOGIN],
    ["register", REGISTER],
  ] as const) {
    assert.match(
      src,
      /import \{ PasswordVisibilityToggle \}/,
      `${name} must consume the shared control`,
    );
    assert.match(src, /<PasswordVisibilityToggle/, `${name} must render it`);
  }
  // The private copies Register carried are gone; it no longer defines its
  // own eye icons.
  assert.doesNotMatch(REGISTER, /function EyeIcon\(\)/);
  assert.doesNotMatch(REGISTER, /function EyeOffIcon\(\)/);
});

test("register keeps a toggle on BOTH password fields", () => {
  assert.equal((REGISTER.match(/<PasswordVisibilityToggle/g) ?? []).length, 2);
  assert.match(REGISTER, /controls=\{PASSWORD_FIELD_ID\}/);
  assert.match(REGISTER, /controls=\{PASSWORD_CONFIRM_FIELD_ID\}/);
});

test("the password is hidden by default and the toggle only swaps the type", () => {
  // Sign in: state starts false, and the type is derived from it.
  assert.match(LOGIN, /const \[showPassword, setShowPassword\] = useState\(false\)/);
  assert.match(LOGIN, /type=\{showPassword \? "text" : "password"\}/);
  // Register: both fields, both starting hidden.
  assert.match(REGISTER, /useState\(false\)[\s\S]{0,40}?showPwd|showPwd[\s\S]{0,40}?useState\(false\)/);
  assert.match(REGISTER, /type=\{showPwd \? "text" : "password"\}/);
  assert.match(REGISTER, /type=\{showPwd2 \? "text" : "password"\}/);
});

test("the control never touches the value, and never stores it", () => {
  /*
   * The whole security argument for a show/hide toggle is that it is UI and
   * nothing else. The component is not given the password, so it cannot log,
   * transmit or persist one.
   */
  // Assert against the CODE, not the prose: the header comment necessarily
  // uses the very words the code must not.
  const code = TOGGLE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bvalue\b/);
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(code, /fetch\(|analytics|track\(|console\./);
  // Its whole contract is a boolean and a callback.
  assert.match(TOGGLE, /visible: boolean/);
  assert.match(TOGGLE, /onToggle: \(\) => void/);
});

test("autocomplete protections are unchanged", () => {
  // Sign in still declares an existing credential; Register still declares a
  // new one. A visibility toggle is no reason to touch either.
  assert.match(LOGIN, /autoComplete="current-password"/);
  assert.equal((REGISTER.match(/autoComplete="new-password"/g) ?? []).length, 2);
});

// ===========================================================================
// 3. Accessibility
// ===========================================================================

test("the toggle is a real button that cannot submit the form", () => {
  assert.match(TOGGLE, /type="button"/);
  // A bare <button> inside a <form> defaults to submit; an omitted type here
  // would fire a half-typed sign-in on every peek.
  assert.doesNotMatch(TOGGLE, /type="submit"/);
});

test("the toggle announces its state and its action", () => {
  // The label is the ACTION and it changes with the state.
  assert.match(TOGGLE, /const label = visible \? "Hide password" : "Show password"/);
  assert.match(TOGGLE, /aria-label=\{label\}/);
  // aria-pressed carries the toggle state — this is what makes it a toggle
  // button rather than a button that happens to change something.
  assert.match(TOGGLE, /aria-pressed=\{visible\}/);
  // And it is associated with the input it governs.
  assert.match(TOGGLE, /aria-controls=\{controls\}/);
  // The icon is decorative; it must not be announced as a second child.
  assert.equal((TOGGLE.match(/aria-hidden="true"/g) ?? []).length, 2);
});

test("the control has a visible keyboard focus state", () => {
  /*
   * Neither private copy had one — both set `border: 1px solid transparent`
   * and stopped. `:focus-visible` shows the ring on keyboard traversal and
   * keeps it off mouse presses.
   */
  const css = read("apps/web/app/globals.css");
  assert.match(css, /\.auth-password-toggle:focus-visible \{/);
  const rule = css.slice(
    css.indexOf(".auth-password-toggle:focus-visible {"),
    css.indexOf("}", css.indexOf(".auth-password-toggle:focus-visible {")),
  );
  assert.match(rule, /box-shadow:/);
});

test("the control is RTL-safe and leaves room for itself", () => {
  const css = read("apps/web/app/globals.css");
  // Logical properties, so the trailing edge follows the writing direction.
  assert.match(css, /\.auth-password-toggle \{[\s\S]*?inset-inline-end:/);
  assert.doesNotMatch(
    css.slice(
      css.indexOf(".auth-password-toggle {"),
      css.indexOf(".auth-password-toggle:hover"),
    ),
    /\bright:|\bleft:/,
  );
  // The input reserves the space, so the text never runs under the icon.
  assert.match(css, /\.auth-input--with-trailing-action \{\s*padding-inline-end:/);
  assert.match(LOGIN, /auth-input auth-input--with-trailing-action/);
  assert.equal(
    (REGISTER.match(/auth-input auth-input--with-trailing-action/g) ?? []).length,
    2,
  );
});

test("the tap target is not the 28px the private copies used", () => {
  const css = read("apps/web/app/globals.css");
  const rule = css.slice(
    css.indexOf(".auth-password-toggle {"),
    css.indexOf(".auth-password-toggle:hover"),
  );
  const width = rule.match(/width:\s*(\d+)px/);
  assert.ok(width, "the control declares a width");
  assert.ok(
    Number(width![1]) >= 32,
    `expected at least 32px, found ${width![1]}px`,
  );
});
