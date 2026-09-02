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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * ===========================================================================
 * EVERY LAUNCHER IS GUARDED — BY ONE OF EXACTLY TWO MECHANISMS
 * ===========================================================================
 * There are two, and that is deliberate rather than an oversight:
 *
 *   scripts/local-fixture-env  builds the environment for a SPAWNED SERVER
 *                              (the API and the web dev server).
 *
 *   services/api/test/setup/   scrubs the environment of a TEST PROCESS via a
 *   test-bootstrap.mjs         --import preload, and guards its sockets.
 *
 * They cannot be merged: a vitest setupFile cannot configure a `next dev` that
 * a launcher spawns, and a preload cannot run in a process it does not start.
 * What matters is that no launcher is guarded by NEITHER — which is what this
 * asserts, by enumerating them from the tree rather than from a list.
 */
test("no process-spawning script is unguarded", () => {
  const roots = [
    "apps/web/scripts",
    "services/api/scripts",
    "services/worker/scripts",
    "scripts",
  ];

  const spawners = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(mjs|js|ts)$/.test(e.name)) continue;
      const src = readFileSync(p, "utf8");
      // A script that spawns a long-lived child with an environment.
      if (!/\bspawn\s*\(|\bspawnSync\s*\(/.test(src)) continue;
      if (!/\benv\s*:/.test(src)) continue;
      spawners.push({ path: p, src });
    }
  };
  for (const r of roots) walk(r);

  assert.ok(spawners.length > 0, "found no spawning scripts at all — the walk is broken");

  /**
   * Tooling that is SUPPOSED to reach the database it is handed.
   *
   * The rule above is about fixture launchers — scripts that start an
   * application server which must never touch Production. Deployment and
   * migration tooling is the opposite case: talking to a real database IS the
   * job, and forcing a fixture environment on them would make them useless.
   *
   * The exemption is EARNED, not granted. Each entry names the guard that
   * makes it safe and the guard is asserted, because an exemption that
   * outlives its guard is a hole with a comment next to it.
   *
   * Both were found by this test, not by the manual audit that preceded it —
   * that audit grepped for `spawn(` and these use `spawnSync`.
   */
  const EARNED_EXEMPTIONS = {
    "services/api/scripts/deploy-safe.mjs": {
      why: "the deployment orchestrator; refusing a real host would defeat it",
      guard: /refuses non-local hosts/,
    },
    "services/api/scripts/migration-rehearsal.mjs": {
      why: "rehearses migrations against a disposable database it is pointed at",
      guard: /function assertLoopback/,
    },
  };

  for (const [p, { guard, why }] of Object.entries(EARNED_EXEMPTIONS)) {
    const hit = spawners.find((s) => s.path === p);
    if (!hit) continue;
    assert.match(
      hit.src,
      guard,
      `${p} is exempt because ${why} — but the guard that earns it is gone`,
    );
  }

  const unguarded = spawners
    .filter(({ path, src }) => {
      if (path in EARNED_EXEMPTIONS) return false;
      if (/local-fixture-env/.test(src)) return false;
      // The Point-7 --import bootstrap is the other sanctioned mechanism.
      if (/test-bootstrap|NODE_OPTIONS/.test(src)) return false;
      // A script that never spreads the ambient environment is not a leak
      // path: it hands the child exactly what it names.
      if (!/...process.env/.test(src)) return false;
      return true;
    })
    .map(({ path }) => path);

  assert.deepEqual(
    unguarded,
    [],
    "each of these spreads process.env into a child without using either " +
      "scripts/local-fixture-env or the Point-7 --import bootstrap",
  );
});

test("dotenv cannot fill a gap the allowlist leaves", () => {
  // The technique is borrowed from services/api/test/setup/safe-environment.ts,
  // which fixed the same incident for test processes. An allowlist is
  // sufficient only if COMPLETE; pointing DOTENV_CONFIG_PATH at a file that
  // does not exist makes completeness unnecessary.
  const env = buildLocalFixtureEnv();
  assert.match(env.DOTENV_CONFIG_PATH, /no-such-env-file$/);
  assert.equal(
    existsSync(resolve(process.cwd(), env.DOTENV_CONFIG_PATH)),
    false,
    "the path must NOT exist — that is the entire mechanism",
  );
});
