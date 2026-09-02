/**
 * A LOCAL FIXTURE PROCESS MUST NOT BE ABLE TO REACH PRODUCTION.
 *
 * ===========================================================================
 * WHAT HAPPENED
 * ===========================================================================
 * Starting the API "locally" with only DATABASE_URL overridden gave the
 * process every value in `services/api/.env` — a developer's own file holding
 * live AWS/S3, Stripe, PayPal, Twilio, Resend, OpenAI, Sentry, OTEL, TSA and
 * SAML credentials. It logged, at startup:
 *
 *     phase=startup.object_lock mode=verified
 *     bucket=proovra-evidence-prod-eu defaultMode=COMPLIANCE retainDays=2920
 *
 * That is a successful AUTHENTICATED read of a private production bucket. It
 * read configuration and wrote nothing, and no data left the machine — but it
 * could only have succeeded with a production-capable credential, and it
 * should not have been possible from a fixture command.
 *
 * ===========================================================================
 * WHAT THESE TESTS PIN
 * ===========================================================================
 * The mechanism is an ALLOWLIST, not a deny-list, and the difference is the
 * whole point. The deny-list version of this failed twice within an hour: its
 * own first honest run found six variables it had missed, all still pointing
 * at proovra.com. Those six are cases here, by name, because a regression that
 * already happened once is the one worth pinning.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const {
  buildLocalFixtureEnv,
  findEnvironmentLeaks,
  findCredentialShapes,
  UnsafeFixtureEnvironmentError,
  LOCAL_FIXTURE_OS_BASELINE,
} = await import(
  "file://" +
    resolve(process.cwd(), "scripts/local-fixture-env/index.mjs").replace(
      /\\/g,
      "/",
    )
);

test("the built environment is clean", () => {
  const env = buildLocalFixtureEnv();
  assert.deepEqual(findEnvironmentLeaks(env), []);
});

test("nothing is inherited except the OS baseline and the allowlist", () => {
  // The actual guarantee. A deny-list can only remove what it was told about;
  // this removes everything it was not told about.
  const before = process.env.PROOVRA_TEST_INHERITED_SECRET;
  process.env.PROOVRA_TEST_INHERITED_SECRET = "sk_live_abcdefghijklmnop";
  try {
    const env = buildLocalFixtureEnv();
    assert.equal(
      env.PROOVRA_TEST_INHERITED_SECRET,
      undefined,
      "an unknown parent variable must not reach the child at all",
    );
  } finally {
    if (before === undefined) delete process.env.PROOVRA_TEST_INHERITED_SECRET;
    else process.env.PROOVRA_TEST_INHERITED_SECRET = before;
  }
});

test("the OS baseline cannot address a network service", () => {
  // If a name here could carry an endpoint, inheriting it would reopen the
  // hole from the other side.
  for (const name of LOCAL_FIXTURE_OS_BASELINE) {
    assert.doesNotMatch(
      name,
      /URL|URI|ENDPOINT|HOST|DSN|TOKEN|SECRET|KEY$/i,
      `${name} does not belong in an inherited baseline`,
    );
  }
});

test("the six leaks the deny-list missed are each caught", () => {
  // Found by the deny-list version's own first honest run, after it had
  // already been described as complete.
  const cases = {
    EMAIL_LOGO_URL: "https://www.proovra.com/logo.png",
    NEXT_PUBLIC_GOOGLE_REDIRECT_URI: "https://www.proovra.com/auth/google",
    NEXT_PUBLIC_APPLE_REDIRECT_URI: "https://www.proovra.com/auth/apple",
    SAML_SP_ENTITY_ID: "https://api.proovra.com/saml",
    SAML_SP_ACS_URL: "https://api.proovra.com/saml/acs",
    SAML_IDP_ENTITY_ID: "https://accounts.google.com/o/saml2",
  };
  for (const [name, value] of Object.entries(cases)) {
    const leaks = findEnvironmentLeaks({ [name]: value });
    assert.ok(leaks.length > 0, `${name} must be reported`);
    assert.match(leaks[0], new RegExp(`^${name} → `));
  }
});

test("the exact production bucket that was read is refused", () => {
  const leaks = findEnvironmentLeaks({
    S3_BUCKET: "proovra-evidence-prod-eu",
  });
  assert.deepEqual(leaks, ["S3_BUCKET → names proovra-evidence-prod"]);
});

test("credential SHAPES are caught whatever the variable is called", () => {
  // A leak does not announce itself by variable name. Somebody putting an AWS
  // key in HARMLESS_SETTING is the case a name-based list cannot see.
  const shapes = {
    "AWS access key id": "AKIAIOSFODNN7EXAMPLE",
    "Stripe key": "sk_live_51H8xKzAbCdEfGhIj",
    "Resend key": "re_abcdefghijklmnopqrst",
    "OpenAI key": "sk-abcdefghijklmnopqrstuvwxyz012345",
    // 32 hex characters after AC. The first version of this line had 30 and
    // the assertion failed — the regex was right and the fixture was wrong,
    // which is the more common way a security test lies to you.
    "Twilio account sid": "AC0123456789abcdef0123456789abcdef",
    "PEM private key": "-----BEGIN RSA PRIVATE KEY-----\nMIIE",
  };
  for (const [label, value] of Object.entries(shapes)) {
    const leaks = findEnvironmentLeaks({ HARMLESS_SETTING: value });
    assert.equal(leaks.length, 1, `${label} was not caught`);
    assert.match(leaks[0], /^HARMLESS_SETTING → looks like a /);
  }
});

test("a non-local database or redis is refused before anything starts", () => {
  assert.throws(
    () => buildLocalFixtureEnv({ databaseUrl: "postgresql://u:p@db.neon.tech/x" }),
    /must be local/,
  );
  assert.throws(
    () => buildLocalFixtureEnv({ redisUrl: "redis://cache.example.com:6379" }),
    /must be local/,
  );
});

test("an unsafe extra value throws instead of being returned", () => {
  // A caller that ignores the return value must still not be able to spawn
  // with a bad environment.
  assert.throws(
    () => buildLocalFixtureEnv({ extra: { TSA_URL: "https://freetsa.org/tsr" } }),
    UnsafeFixtureEnvironmentError,
  );
});

test("allow: is explicit, per-name, and empty by default", () => {
  const unsafe = { SOME_REMOTE: "https://example.com/x" };
  assert.equal(findEnvironmentLeaks(unsafe).length, 1);
  assert.deepEqual(findEnvironmentLeaks(unsafe, { allow: ["SOME_REMOTE"] }), []);
});

test("no value is ever printed in the failure text", () => {
  // The message goes into CI logs. A guard that leaks the secret it caught is
  // worse than the leak it was guarding against.
  const secret = "sk_live_THISMUSTNEVERAPPEAR";
  try {
    buildLocalFixtureEnv({ extra: { SOMETHING: secret } });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof UnsafeFixtureEnvironmentError);
    assert.ok(!err.message.includes(secret), "the value leaked into the message");
    assert.match(err.message, /SOMETHING → looks like a Stripe key/);
  }
});

test("no real .env file is tracked by git", () => {
  // The reassuring half of the incident, kept true. Only `.example` files may
  // be tracked, and none of them may carry a real value.
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((p) => /(^|\/)\.env($|\.)/.test(p));

  for (const p of tracked) {
    assert.match(p, /\.example$/, `${p} is a tracked .env file`);
    // CREDENTIALS, not hostnames. apps/mobile/.env.example names
    // https://api.proovra.com because that IS the production API base: it is
    // published, it is not a secret, and an example file documenting it is
    // doing its job. Refusing it would train people to ignore this test.
    assert.deepEqual(
      findCredentialShapes(parseEnv(readFileSync(p, "utf8"))),
      [],
      `${p} carries a credential`,
    );
  }
});

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
