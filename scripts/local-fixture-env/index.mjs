/**
 * THE ONE PLACE A LOCAL FIXTURE PROCESS GETS ITS ENVIRONMENT.
 *
 * =============================================================================
 * THE PROBLEM
 * =============================================================================
 * `services/api/.env` is a developer's own file holding live values — AWS/S3,
 * Stripe, PayPal, Twilio, Resend, OpenAI, Sentry, OTEL, TSA, SAML, and a
 * production database URL. It is NOT tracked by git (verified: only five
 * `.env.example` files are, and none carries a real value), so the exposure is
 * local rather than published. That is the only reassuring part.
 *
 * Twenty-five files in this repository load an env file, and one of them is
 * `services/api/src/db.ts` — which practically everything imports. So "run the
 * API locally with DATABASE_URL overridden" produces a process holding every
 * production credential in that file, and it behaves accordingly:
 *
 *     phase=startup.object_lock mode=verified
 *     bucket=proovra-evidence-prod-eu defaultMode=COMPLIANCE retainDays=2920
 *
 * That line is a SUCCESSFUL AUTHENTICATED READ of a private production bucket.
 * It read configuration and wrote nothing, but it could only have succeeded
 * with a production-capable credential and endpoint, and any description of
 * that run as using no production credential is wrong.
 *
 * =============================================================================
 * WHY ALLOWLIST, NOT DENY-LIST
 * =============================================================================
 * The first attempt at this was a deny-list inside one launcher: name the
 * variables to blank, blank them. It failed twice in the same hour.
 *
 *   * Its own first honest run found six variables the list had missed —
 *     EMAIL_LOGO_URL, two OAuth redirect URIs, two SAML endpoints, an IdP
 *     entity id — all still pointing at proovra.com.
 *
 *   * It could only ever cover integrations that existed the day it was
 *     written. The integration added next month is not on it.
 *
 * A deny-list is a list of mistakes someone already made. An allowlist is a
 * statement of what the process is allowed to reach, and everything else is
 * absent by construction rather than by remembering.
 *
 * So: the child environment is BUILT from an explicit allowlist. Nothing is
 * inherited except a small OS baseline the process cannot run without. A
 * variable that is not named here does not reach the child at all.
 *
 * =============================================================================
 * AND THEN IT IS STILL SCANNED
 * =============================================================================
 * Building from an allowlist makes leaks unlikely, not impossible: a fixture
 * value can be wrong, and `LOCAL` below is hand-written. So the final child
 * environment — the actual object handed to spawn, not the parent — is scanned
 * before any process starts, and construction throws if anything resolves off
 * this machine or looks like a live credential.
 *
 * The scan runs BEFORE spawn, so it fails before any network stack is
 * initialised. It reports names and reasons, never values.
 *
 * =============================================================================
 * A PUBLIC URL IS NOT A SECRET
 * =============================================================================
 * `findEnvironmentLeaks` is the RUNTIME question — "can this process reach
 * Production?" — and there a production hostname is disqualifying whether or
 * not it is secret.
 *
 * `findCredentialShapes` is the narrower question, for auditing files that are
 * SUPPOSED to name Production: `apps/mobile/.env.example` documents
 * https://api.proovra.com, which is correct, published, and not a secret.
 * Refusing it would teach people that this guard cries wolf. What such a file
 * may never contain is a credential.
 */

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEFAULTS = Object.freeze({
  webPort: "3311",
  apiPort: "8191",
  // The name must read as disposable. seed-admin-fixture.ts refuses to write
  // to a database whose name does not contain test/fixture/local/dev, which is
  // a guard worth satisfying rather than arguing with: the seeder truncates.
  databaseUrl: "postgresql://pv:pv@localhost:55533/proovra_admin_cp_fixture",
  redisUrl: "redis://localhost:56479/0",
});

/**
 * The only inherited variables.
 *
 * Everything here is something the Node process or the OS needs in order to
 * run at all. None of it can address a network service.
 */
const OS_BASELINE = Object.freeze([
  "PATH", "Path", "PATHEXT",
  "SystemRoot", "SystemDrive", "windir", "COMSPEC", "ComSpec",
  "TEMP", "TMP", "TMPDIR",
  "HOME", "HOMEDRIVE", "HOMEPATH", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramData",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "LANG", "LC_ALL", "TZ", "SHELL", "USER", "LOGNAME",
  // Node's own knobs. NODE_OPTIONS is inherited because a debugger or a
  // memory limit set by the operator has to survive; it cannot name a remote
  // service, and the scan below would catch a URL in it anyway.
  "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_V8_COVERAGE",
  // The connection recorder writes here. A local FILE PATH; it cannot
  // address a network service, and the scan below would catch a URL in it.
  // Without it the recorder loads in the child and silently does nothing —
  // which is what happened on the first attempt, and is the allowlist
  // behaving exactly as designed.
  "PROOVRA_CONNECTION_LOG",
]);

/**
 * Hostnames and resources that are Production, named so a mistake is refused
 * loudly rather than merely being off the allowlist.
 *
 * This is deliberately NOT the mechanism — the allowlist is. It exists so that
 * a fixture value edited to a production host by hand is rejected with a
 * sentence that says which one, instead of quietly working.
 */
const FORBIDDEN_SUBSTRINGS = Object.freeze([
  "proovra.com",
  "proovra-evidence-prod",
  "amazonaws.com",
  "neon.tech",
  "api.stripe.com",
  "api.paypal.com",
  "api.twilio.com",
  "api.resend.com",
  "api.openai.com",
  "sentry.io",
  "freetsa.org",
  "digicert.com",
]);

/** Value shapes that are credentials regardless of which variable holds them. */
const CREDENTIAL_SHAPES = Object.freeze([
  { name: "AWS access key id", re: /(^|[^A-Z0-9])(AKIA|ASIA)[0-9A-Z]{16}([^A-Z0-9]|$)/ },
  { name: "Stripe key", re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/ },
  { name: "Resend key", re: /\bre_[A-Za-z0-9]{16,}/ },
  { name: "OpenAI key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "Twilio account sid", re: /\bAC[0-9a-f]{32}\b/i },
  { name: "Sentry DSN", re: /^https?:\/\/[0-9a-f]{16,}@/i },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
]);

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal|minio|postgres|redis)$/i;

/**
 * THE FIXTURE'S OWN SIGNING KEY.
 *
 * Evidence cannot be completed without one — the signer refuses at the moment
 * it would produce a signature — so a fixture with no key can create an intake
 * link and upload bytes and then fail at submit, which is exactly the shape of
 * the gap this closes.
 *
 * It is GENERATED, never committed. `assertNotCommittedFixture` in
 * services/api/src/signing/signer.ts refuses a key that ships in the
 * repository, and it is right to: a signature made with a key everyone has is
 * indistinguishable from a real one to a downstream verifier. So the pair is
 * written on first use into a gitignored directory, unique to this machine,
 * and the key id says out loud what it is.
 */
const FIXTURE_KEY_DIR = resolve(REPO_ROOT, ".local-fixture-keys");

function ensureFixtureSigningKeys() {
  const privatePath = resolve(FIXTURE_KEY_DIR, "signing-private.pem");
  const publicPath = resolve(FIXTURE_KEY_DIR, "signing-public.pem");

  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    mkdirSync(FIXTURE_KEY_DIR, { recursive: true });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }));
    writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }));
  }

  return { privatePath, publicPath };
}

/**
 * Every value the fixture actually runs on.
 *
 * Anything an integration needs is here as a LOCAL or INERT value rather than
 * being omitted, because several of these are read at import time and the
 * process will not boot without them. `services/api/src/storage.ts` throws on
 * a missing `S3_ACCESS_KEY` before any route is registered, so S3 points at a
 * local address nothing is listening on: a storage call then fails loudly and
 * locally, which is the honest outcome for a fixture that has no storage.
 */
function buildLocalValues({ webPort, apiPort, databaseUrl, redisUrl }) {
  const web = `http://localhost:${webPort}`;
  const api = `http://localhost:${apiPort}`;
  const signingKeys = ensureFixtureSigningKeys();

  return {
    NODE_ENV: "development",

    /**
     * The canonical build identity, so a fixture worker publishes the same
     * kind of value a deployed one does. A literal marks it as a fixture
     * rather than borrowing the host git state, which would make the proof
     * depend on the checkout.
     */
    APP_RELEASE_SHA: "fixture0000000000000000000000000000000f",

    PORT: apiPort,
    WORKER_PORT: String(Number(apiPort) + 1),

    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    REDIS_URL: redisUrl,

    APP_BASE_URL: web,
    APP_URL: web,
    WEB_BASE_URL: web,
    ADMIN_BASE_URL: web,
    INTERNAL_API_BASE_URL: api,
    REPORT_APP_BASE_URL: web,
    REPORT_VERIFY_BASE_URL: `${web}/verify`,
    CORS_ORIGINS: web,
    NEXT_PUBLIC_API_BASE: api,
    NEXT_PUBLIC_APP_BASE: web,
    NEXT_PUBLIC_WEB_BASE: web,

    // Stable across restarts ON PURPOSE. A per-process JWT secret invalidated
    // the fixture session on every API restart and turned a verification run
    // into a debugging run.
    /**
     * Neutralise dotenv outright.
     *
     * Borrowed from services/api/test/setup/safe-environment.ts, which solved
     * the SAME incident for test processes after a Point-7 run booted the API
     * in-process, initialised Sentry with the production DSN, and read the
     * production evidence bucket. Its note is worth repeating: an allowlist is
     * sufficient only if it is COMPLETE, and this makes completeness
     * unnecessary.
     *
     * `import "dotenv/config"` honours DOTENV_CONFIG_PATH. Pointed at a file
     * that does not exist, it loads nothing — so services/api/.env cannot fill
     * a variable this allowlist happens not to set. Belt and braces, and the
     * braces are the ones that were already proven here.
     */
    DOTENV_CONFIG_PATH: "scripts/local-fixture-env/no-such-env-file",

    AUTH_JWT_SECRET: "fixture-local-only-jwt-secret-not-a-real-secret",
    API_KEY_SECRET: "fixture-local-only-api-key-secret",
    IDENTITY_SECURITY_HASH_SECRET: "fixture-local-only-identity-hash-secret",
    COMMUNICATIONS_RECIPIENT_HASH_SECRET: "fixture-local-only-recipient-hash",
    WORKFLOW_INTAKE_TOKEN_SECRET: "fixture-local-only-intake-secret",
    // The secret alone is not enough: intake-link routes answer 503
    // FEATURE_DISABLED unless the flag is also "true", and that 503 surfaced
    // as console noise on every personal-role page load during the browser
    // matrix. Production has the feature on; the fixture should look like it.
    WORKFLOW_INTAKE_LINKS_ENABLED: "true",
    MFA_SECRET_KEK_BASE64: Buffer.alloc(32, 7).toString("base64"),

    // Storage: a local address with nothing behind it. See the note above.
    S3_ENDPOINT: "http://localhost:59900",
    S3_PUBLIC_BASE_URL: "http://localhost:59900",
    S3_BUCKET: "proovra-local-fixture",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY: "fixture-local-only",
    S3_SECRET_KEY: "fixture-local-only",
    S3_FORCE_PATH_STYLE: "true",
    S3_ALLOW_INSECURE: "true",

    // Signing — a locally generated pair, so a fixture can actually finish an
    // upload. Paths, not PEM: the credential scan below rejects a private key
    // sitting in an environment value, and it should.
    SIGNING_KEY_ID: "fixture-local-only-signing-key",
    SIGNING_KEY_VERSION: "1",
    SIGNING_PRIVATE_KEY_PATH: signingKeys.privatePath,
    SIGNING_PUBLIC_KEY_PATH: signingKeys.publicPath,
    PACKAGE_SIGNING_KEY_ID: "fixture-local-only-package-key",
    PACKAGE_SIGNING_KEY_VERSION: "1",
    PACKAGE_SIGNING_PRIVATE_KEY_PATH: signingKeys.privatePath,
    PACKAGE_SIGNING_PUBLIC_KEY_PATH: signingKeys.publicPath,
    S3_OBJECT_LOCK_ENABLED: "false",
    S3_OBJECT_LOCK_LEGAL_HOLD: "false",

    SIGNER_PROVIDER: "local-pem",

    // Outbound integrations, off.
    AWS_SECRETS_ENABLED: "false",
    COMMUNICATIONS_ENABLED: "false",
    CONTACT_SALES_AUTO_REPLY_ENABLED: "false",
    DEMO_FOLLOW_UP_ENABLED: "false",
    DEMO_REQUEST_AUTO_REPLY_ENABLED: "false",
    GEO_INTELLIGENCE_ENABLED: "false",
    IMMUTABLE_STORAGE_DRIFT_ALERTS_ENABLED: "false",
    IMMUTABLE_STORAGE_RECONCILIATION_ENABLED: "false",
    INTEGRATIONS_ENABLED: "false",
    OPENAI_AI_ENABLED: "false",
    OTEL_ENABLED: "false",
    OTS_ENABLED: "false",
    SAML_LIVE_IDP_VALIDATION_ENABLED: "false",
    SENTRY_ENABLED: "false",
    TSA_ENABLED: "false",

    // Identifiers that are URLs but are never fetched. Local anyway: a guard
    // that starts making exceptions for values it judges harmless stops being
    // read.
    SAML_SP_ENTITY_ID: `${api}/saml`,
    SAML_SP_ACS_URL: `${api}/saml/acs`,
    GOOGLE_REDIRECT_URI: web,
    APPLE_REDIRECT_URI: web,
    NEXT_PUBLIC_GOOGLE_REDIRECT_URI: web,
    NEXT_PUBLIC_APPLE_REDIRECT_URI: web,
    SSO_CALLBACK_REDIRECT_URI: web,
    /**
     * THE OUTBOUND BOUNDARY IS THE LOCAL RECORDER.
     *
     * Naming the recorder is the whole statement: the resolver refuses
     * `recording` anywhere but a non-production process, so this cannot switch
     * a vendor on, and with no transport named at all the fixture had no
     * outbound boundary — an invitation email went nowhere and left no trace,
     * so a browser journey could not follow the link a real recipient would
     * receive.
     *
     * The files are the ones the Point-7 browser harness reads, so the local
     * stack can host the E2E suites instead of needing a second one.
     */
    EMAIL_TRANSPORT: "recording",
    MESSAGING_TRANSPORT: "recording",
    /*
     * ABSOLUTE, because the reader and the writer have different working
     * directories. The API child runs with its cwd at `services/api`, and the
     * browser harness reads the repository root — so a relative path here puts
     * the mailbox somewhere nobody looks, and the symptom is an invitation
     * journey that fails with "no acknowledged message" while the email was in
     * fact recorded perfectly well one directory down.
     */
    EMAIL_RECORDER_FILE: recorderFile("recorded-emails.jsonl"),
    MESSAGING_RECORDER_FILE: recorderFile("recorded-messages.jsonl"),
    EMAIL_FROM: "fixture@localhost",
    EMAIL_FROM_NAME: "PROOVRA Fixture",
    EMAIL_BRAND_NAME: "PROOVRA Fixture",
    SUPPORT_EMAIL: "fixture@localhost",
  };
}

/**
 * Everything wrong with a candidate environment, as sentences.
 *
 * Exported so a test can assert on it without spawning anything, which is what
 * makes the previously-missed leaks regression-testable.
 */
export function findCredentialShapes(env, { allow = [] } = {}) {
  const allowed = new Set(allow);
  const found = [];
  for (const [name, raw] of Object.entries(env)) {
    if (allowed.has(name)) continue;
    const value = typeof raw === "string" ? raw : "";
    if (value.trim() === "") continue;
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.re.test(value)) {
        found.push(`${name} → looks like a ${shape.name}`);
        break;
      }
    }
  }
  return [...new Set(found)].sort();
}

export function findEnvironmentLeaks(env, { allow = [] } = {}) {
  const allowed = new Set(allow);
  const leaks = [];

  for (const [name, raw] of Object.entries(env)) {
    if (allowed.has(name)) continue;
    const value = typeof raw === "string" ? raw : "";
    if (value.trim() === "") continue;

    const lowered = value.toLowerCase();
    for (const bad of FORBIDDEN_SUBSTRINGS) {
      if (lowered.includes(bad)) {
        leaks.push(`${name} → names ${bad}`);
        break;
      }
    }

    for (const url of value.match(/https?:\/\/[^\s,;"'<>]+/g) ?? []) {
      let host;
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      if (!LOCAL_HOSTS.test(host)) {
        leaks.push(`${name} → resolves to ${host}`);
        break;
      }
    }

    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.re.test(value)) {
        leaks.push(`${name} → looks like a ${shape.name}`);
        break;
      }
    }
  }

  // Stable order, no duplicates: this text ends up in CI output.
  return [...new Set(leaks)].sort();
}

export class UnsafeFixtureEnvironmentError extends Error {
  constructor(leaks) {
    super(
      [
        "The fixture environment reaches off this machine. Nothing was started.",
        "",
        ...leaks.map((l) => `  ${l}`),
        "",
        "  Fix the value in scripts/local-fixture-env/index.mjs, or pass",
        "  allow: [NAME] if it is genuinely remote and genuinely required.",
        "  (Values are never printed. Only names and reasons.)",
      ].join("\n"),
    );
    this.name = "UnsafeFixtureEnvironmentError";
    this.leaks = leaks;
  }
}

/**
 * Build the environment a local fixture process runs with.
 *
 * Throws before returning if the result is unsafe, so a caller cannot spawn
 * with a bad environment even by ignoring the return value.
 */
/** The repository-root `.p7tmp` mailbox both sides of a browser run share. */
function recorderFile(name) {
  return resolve(REPO_ROOT, ".p7tmp", name);
}

export function buildLocalFixtureEnv(options = {}) {
  const settings = { ...DEFAULTS, ...options };

  for (const [label, url] of [
    ["databaseUrl", settings.databaseUrl],
    ["redisUrl", settings.redisUrl],
  ]) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error(`local-fixture-env: ${label} is not a URL.`);
    }
    if (!LOCAL_HOSTS.test(host)) {
      throw new Error(
        `local-fixture-env: ${label} must be local, got "${host}".`,
      );
    }
  }

  const env = {};
  for (const key of OS_BASELINE) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, buildLocalValues(settings));
  for (const [k, v] of Object.entries(settings.extra ?? {})) env[k] = v;

  const leaks = findEnvironmentLeaks(env, { allow: settings.allow ?? [] });
  if (leaks.length > 0) throw new UnsafeFixtureEnvironmentError(leaks);

  return env;
}

/** One line per fact, for a launcher to print. Never includes a value. */
export function describeLocalFixtureEnv(env) {
  const disabled = Object.entries(env).filter(
    ([k, v]) => k.endsWith("_ENABLED") && v === "false",
  ).length;
  return [
    `  variables   ${Object.keys(env).length} (allowlist only; nothing inherited but an OS baseline)`,
    `  integrations ${disabled} disabled`,
    `  database    ${env.DATABASE_URL}`,
    `  redis       ${env.REDIS_URL}`,
    "  scanned     no non-local endpoint, forbidden host or credential shape",
  ].join("\n");
}

export const LOCAL_FIXTURE_DEFAULTS = DEFAULTS;
export const LOCAL_FIXTURE_OS_BASELINE = OS_BASELINE;
export const LOCAL_FIXTURE_FORBIDDEN = FORBIDDEN_SUBSTRINGS;
