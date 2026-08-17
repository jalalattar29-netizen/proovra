/**
 * PHASE 12 — POINT 7: the canonical TEST-PROCESS BOOTSTRAP.
 *
 * WHY A `--import` PRELOAD AND NOT A SETUP FILE
 * ---------------------------------------------------------------------------
 * The previous corrective pass put the environment scrub in a vitest
 * `setupFile`. That runs before the TEST module, which sounded early enough and
 * was not: module-level code in the application graph — a Prisma client, an
 * ioredis client, the Sentry SDK, the AWS SDK, the OTLP exporter — captures
 * `process.env` when it is first imported, and several of those imports happen
 * as a side effect of resolving the test module itself. The outbound guard then
 * caught what the scrub had missed: a client already holding the machine's
 * Upstash URL, dialling it.
 *
 * A `--import` preload is the earliest hook Node offers short of patching the
 * runtime. It runs before the entry module is even resolved, so nothing in the
 * application graph can have observed the environment before this file has
 * finished rewriting it.
 *
 * WHAT THIS FILE GUARANTEES
 * ---------------------------------------------------------------------------
 *   1. Every credential-shaped variable inherited from the machine is removed.
 *   2. `DOTENV_CONFIG_PATH` points at nothing, so any surviving
 *      `import "dotenv/config"` loads no file.
 *   3. Deterministic local values exist for every REQUIRED core variable, so
 *      startup validation is exercised rather than weakened.
 *   4. A process-level outbound guard is installed across every egress path.
 *
 * It is plain `.mjs` on purpose: a preload cannot depend on a TypeScript
 * loader, because the loader is one of the things that must not run first.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

// ===========================================================================
// 1. Environment classification
// ===========================================================================

/**
 * Keys whose VALUE is a live credential or a remote endpoint.
 *
 * Matched as case-insensitive substrings so one entry covers a family:
 * "SENTRY" catches `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`; "AWS" catches
 * the access key, the secret and the region overrides.
 */
const CREDENTIAL_KEY_FRAGMENTS = [
  "SENTRY", "DSN", "UPSTASH", "REDIS", "STRIPE", "PAYPAL", "RESEND", "SMTP",
  "TWILIO", "OPENAI", "DEEPGRAM", "AZURE", "AWS", "KMS", "S3_", "R2_",
  "GOOGLE_", "APPLE_", "SAML", "SCIM", "SSO_", "WEBHOOK_URL", "API_KEY",
  "SECRET", "TOKEN", "PASSWORD", "CREDENTIAL", "DATABASE_URL", "DIRECT_URL",
  "SHADOW_DATABASE_URL", "NEXT_PUBLIC_API", "API_BASE", "OTEL_EXPORTER",
];

/** Keys the harness itself owns; removing them would remove the mechanism. */
const HARNESS_OWNED = new Set([
  "AUTH_JWT_SECRET",
  "TEST_DATABASE_URL",
  "RUN_LIVE_INTEGRATION",
  "RUN_LIVE_INTEGRATION_DB_OK",
  "RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS",
  "POINT5_RUN_ID",
  "POINT7_RUN_ID",
  "P7_ALLOWED_HOSTS",
  "P7_NETWORK_LEDGER",
  "P7_SCENARIO",
  "P7_PROCESS",
  "P7_TEST_REDIS_URL",
  "P7_TEST_DATABASE_URL",
  "P7_GUARD_STACKS",
  "P7_CANARY_LIVE_ENV",
  "E2E_AUTH_BYPASS_SECRET",
]);

/**
 * PHASE 13 (NEW-073) — KEYS THE HARNESS OWNS *ONLY* IN THE POINT-7 API PROCESS.
 *
 * `HARNESS_OWNED` above is unconditional: those keys are the mechanism, in every
 * process. This is a second, narrower category — a key that must be scrubbed
 * everywhere EXCEPT the one long-lived API process the Point-7 browser runner
 * spawns, identified by the `P7_PROCESS=api` marker the runner sets and
 * `HARNESS_OWNED` already protects.
 *
 * `WORKFLOW_INTAKE_TOKEN_SECRET` is the case. It is deliberately unconfigured
 * for in-process suites — a harness-supplied secret made `issueIntakeToken()` /
 * `hmacForIntake()` return live values in runs where the intake feature is off,
 * silently changing what those suites measure, and they mint their own through
 * `__testing.withSecret` when they need one. But it is caught twice on the way
 * out: the generic credential scrub matches it on BOTH the `SECRET` and `TOKEN`
 * fragments, and it is also listed in `EXPLICITLY_UNCONFIGURED`.
 *
 * The browser layer has no in-process seam — its API is a separate process — and
 * with the secret gone `workflowIntakeFeatureDisabledReason()` answers
 * `"secret_missing"`, so `GET /v1/workflow/intake-links` returns 503 to the
 * authenticated shell, which reads that list on every page. That 503 is correct
 * behaviour for an unconfigured feature and it was landing inside browser
 * scenarios' "no console errors" assertions.
 *
 * Gating on the process marker keeps every vitest worker, every other spawned
 * process and every non-Point-7 run hermetic and fail-closed. Production never
 * loads this module at all. The VALUE is supplied by the focused runner and is
 * never read, logged or asserted on here.
 */
const POINT7_API_OWNED = new Set(["WORKFLOW_INTAKE_TOKEN_SECRET"]);

function isPoint7ApiOwned(key) {
  return process.env.P7_PROCESS === "api" && POINT7_API_OWNED.has(key);
}

function isCredentialKey(key) {
  if (HARNESS_OWNED.has(key)) return false;
  if (isPoint7ApiOwned(key)) return false;
  const upper = key.toUpperCase();
  return CREDENTIAL_KEY_FRAGMENTS.some((f) => upper.includes(f));
}

export const SCRUBBED_KEYS = [];

/**
 * REQUIRED CORE variables.
 *
 * The distinction the mandate insists on, made explicit: these are not
 * credentials, they are values the application legitimately requires, and the
 * fix is a deterministic TEST value — never removing the variable and then
 * relaxing the startup check that noticed. `collectStartupViolations T03`
 * failed in the previous pass for exactly that reason.
 */
const REQUIRED_CORE = {
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:3007",
  APP_BASE_URL: "http://127.0.0.1:3007",
  WEB_BASE_URL: "http://127.0.0.1:3007",
  NEXT_PUBLIC_API_BASE: "http://127.0.0.1:8091",
  NEXT_PUBLIC_WEB_BASE: "http://127.0.0.1:3007",
  NEXT_PUBLIC_APP_BASE: "http://127.0.0.1:3007",
  CORS_ORIGINS: "http://127.0.0.1:3007",
  AUTH_JWT_SECRET: "point7-test-only-jwt-secret-0123456789abcdef0123456789",
  IDENTITY_SECURITY_HASH_SECRET: "point7-test-only-identity-hash-secret",
  COMMUNICATIONS_RECIPIENT_HASH_SECRET: "point7-test-only-recipient-hash-secret",
  API_KEY_SECRET: "point7-test-only-api-key-secret",
  // Required BECAUSE `LOCAL_FAKES` binds a Resend key: an email transport that
  // is configured must have an idempotency secret, and `collectStartupViolations`
  // is right to say so. The fix for a startup check that fires is a
  // deterministic test value, never removing the variable it asked for.
  EMAIL_IDEMPOTENCY_SECRET: "point7-test-only-email-idempotency-secret",
  SIGNER_PROVIDER: "local-pem",
  SIGNING_KEY_ID: "point7_test_ed25519",
  SIGNING_KEY_VERSION: "1",
  SIGNING_PRIVATE_KEY_PATH: "keys/signing-private.pem",
  SIGNING_PUBLIC_KEY_PATH: "keys/signing-public.pem",
  PACKAGE_SIGNING_KEY_ID: "point7_test_package_ed25519",
  PACKAGE_SIGNING_KEY_VERSION: "1",
  PACKAGE_SIGNING_PRIVATE_KEY_PATH: "keys/signing-private.pem",
  PACKAGE_SIGNING_PUBLIC_KEY_PATH: "keys/signing-public.pem",
};

/**
 * LOCAL FAKES for genuine external boundaries.
 *
 * Present and pointed at loopback, so the code path that uses them is
 * EXERCISED rather than skipped. An absent value would only move the failure
 * somewhere less honest.
 */
const LOCAL_FAKES = {
  S3_ENDPOINT: "http://127.0.0.1:59000",
  S3_REGION: "auto",
  S3_ACCESS_KEY: "point7-local-minio",
  S3_SECRET_KEY: "point7-local-minio-secret",
  S3_BUCKET: "point7-local-bucket",
  S3_ALLOW_INSECURE: "true",
  S3_FORCE_PATH_STYLE: "true",
  S3_OBJECT_LOCK_ENABLED: "false",
  OBJECT_LOCK_VERIFICATION_BYPASS: "true",
  // The email boundary is served by the LOCAL RECORDING PROVIDER, selected
  // here — before a single application module is imported.
  //
  // The previous pass configured a fake Resend key and let the transport try to
  // reach `api.resend.com`. The guard blocked all eighteen attempts, so nothing
  // left the machine, but the boundary was never exercised: every send came
  // back `ambiguous` from a refused socket. Containment is not a provider
  // proof. `EMAIL_TRANSPORT=recording` makes the send land in a real
  // implementation of the transport contract that acknowledges, stores, and
  // collapses duplicates on the idempotency key.
  //
  // The key stays bound because `collectStartupViolations` legitimately treats
  // a configured transport as requiring one, and because a run in which the
  // email subsystem reads as UNCONFIGURED skips the delivery state machine
  // rather than proving it. The recorder never receives it.
  EMAIL_TRANSPORT: "recording",
  RESEND_API_KEY: "re_point7_local_fake_not_a_credential",
  EMAIL_FROM: "point7-local@test.proovra.local",
  EMAIL_FROM_NAME: "Proovra Point7 Local",
  // PHASE 13 — the MESSAGING boundary, on exactly the same terms as email.
  //
  // The SMS/WhatsApp boundary was in a worse state than the email one, because
  // containment there was not even reachable. `requireStepUpForSensitiveAction`
  // — the gate on publishing and unpublishing evidence to public verify — is
  // satisfied only by an APPROVED challenge, and a challenge is approved only
  // by a one-time code that Twilio Verify GENERATES ON ITS OWN SIDE and never
  // returns. So there was nothing local to read back: the send was refused at
  // the socket by the outbound guard, the challenge stayed PENDING, and the
  // journey was skipped rather than exercised. A refused socket is containment,
  // not a provider proof — the same lesson as the eighteen blocked Resend
  // attempts above, one step further along, because here even the fake credential
  // could not have produced a completable journey.
  //
  // NOTE that the scrub in section 1 removes every key containing "TWILIO", so
  // in this run the Twilio provider reads as UNCONFIGURED by construction and
  // `readTwilioConfigFromEnv()` returns a reason rather than a config. That is
  // deliberate and it is also why `MESSAGING_TRANSPORT` is the only thing that
  // can put a working provider in that slot.
  //
  // `MESSAGING_TRANSPORT=recording` selects a REAL implementation of the
  // messaging contract that accepts, stores what it accepted, collapses a
  // duplicate on the caller's `externalId`, and — the part Twilio cannot do —
  // mints the one-time code locally and writes it to `MESSAGING_RECORDER_FILE`
  // so the separate browser process can read it back and complete the challenge
  // the way a user does. It CANNOT be selected in production: the resolver and
  // the class both refuse under NODE_ENV=production.
  //
  // Naming the transport is SUFFICIENT, on exactly the terms `EMAIL_TRANSPORT`
  // established: `COMMUNICATIONS_ENABLED` says whether a VENDOR boundary is
  // wired for a deployment, and naming the recorder is the stronger and more
  // specific statement that this process's messaging boundary IS the local
  // recorder. A suite that means to assert on the Twilio/Noop table names the
  // transport it wants — see `communications.test.ts`.
  MESSAGING_TRANSPORT: "recording",
  MESSAGING_RECORDER_FILE: ".p7tmp/recorded-messages.jsonl",
};

/**
 * Providers that must read as EXPLICITLY NOT CONFIGURED.
 *
 * The Point-5 `provider-not-configured` family is entirely about this state,
 * so it is declared rather than left to whatever the machine happens to have.
 * Deleting the keys is the mechanism; listing them here is the intent.
 */
const EXPLICITLY_UNCONFIGURED = [
  "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
  "AZURE_DOCUMENT_INTELLIGENCE_KEY",
  "DEEPGRAM_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_AI_ENABLED",
  "STRIPE_SECRET_KEY",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_SECRET",
  // Binding this made `issueIntakeToken()` and `hmacForIntake()` return live
  // values in a run where the intake feature is off, which is not a state any
  // suite asked for. `workflow-intake-token.service.test.ts` proves what those
  // functions do when the feature is disabled; a harness-supplied secret was
  // silently changing the answer. Suites that need it mint their own through
  // `__testing.withSecret`.
  "WORKFLOW_INTAKE_TOKEN_SECRET",
];

/** Subsystems that reach a remote by design and have no business in a test. */
const DISABLED_SUBSYSTEMS = {
  OBSERVABILITY_TRANSPORT: "recording",
  SENTRY_ENABLED: "false",
  AWS_SECRETS_ENABLED: "false",
  OTEL_ENABLED: "false",
  // TOOLING telemetry, not product behaviour: the Prisma CLI spawns a child
  // that polls `checkpoint.prisma.io` for engine/version news. Twenty-three
  // refused attempts from `child.js:check` sat in the product ledger of the
  // first clean run — invisible until the duplicate-guard entries stopped
  // drowning them. No product behaviour consults it; `CHECKPOINT_DISABLE` is
  // the documented switch, and the alternative (allowlisting the host) would
  // trade a real signal for a green ledger.
  CHECKPOINT_DISABLE: "1",
  PRISMA_HIDE_UPDATE_MESSAGE: "true",
  // The same class from Next's toolchain, for any process that spawns it.
  NEXT_TELEMETRY_DISABLED: "1",
};

/**
 * A connection URL is KEPT only when it points at loopback.
 *
 * This is the one place the bootstrap trusts an inherited value, and it trusts
 * it for a narrow reason: a caller that has explicitly named a LOCAL database
 * or Redis is doing something the bootstrap has no business overriding. A
 * remote host — Upstash, a managed Postgres, anything at all off-loopback — is
 * replaced without exception.
 */
function keepIfLocal(url) {
  if (typeof url !== "string" || url.trim() === "") return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const local =
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "localhost" ||
      host.endsWith(".localhost");
    return local ? url : null;
  } catch {
    return null;
  }
}

// ===========================================================================
// 1b. Machine-value fingerprints — telling "the leak came back" apart from
//     "a test set its own value"
// ===========================================================================

/**
 * The scrub above is a boundary: it runs once, at preload, and removes
 * everything credential-shaped. The re-assert hook in `safe-environment.ts`
 * then repeats it before every test, because something downstream (vitest's
 * own `.env` handling is the likeliest author) puts the machine's values back.
 *
 * Repeating an UNCONDITIONAL scrub was too blunt, and it broke real suites.
 * `provider-not-configured.integration.test.ts` sets
 * `INTERNAL_SERVICE_TOKEN` to a test-local literal in `beforeAll`; the
 * re-assert saw a key containing "TOKEN" and deleted it, so the internal route
 * answered `401 Internal service token not configured` and the worker recorded
 * the generic `extraction_failed` instead of the bounded
 * `provider_not_configured:<PROVIDER>` refusal the suite exists to prove. The
 * harness was manufacturing the failure it then reported.
 *
 * So the re-assert is made VALUE-aware. A dangerous key is removed on a later
 * pass only when its value is one the MACHINE supplies — a value that came
 * from the inherited environment or from a `.env` file on disk. A value a test
 * chose is left alone.
 *
 * Only SHA-256 fingerprints are kept. No secret is copied into a new variable,
 * written to a file, or logged — the digests exist solely to answer
 * "is this string the one that was already here?".
 */
const MACHINE_VALUE_HASHES = new Map();

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function rememberMachineValue(key, value) {
  if (typeof value !== "string" || value.length === 0) return;
  const set = MACHINE_VALUE_HASHES.get(key) ?? new Set();
  set.add(fingerprint(value));
  MACHINE_VALUE_HASHES.set(key, set);
}

/** Candidate env files, in the order a tool would find them. */
const ENV_FILE_CANDIDATES = (() => {
  const setupDir = dirname(fileURLToPath(import.meta.url));
  const apiDir = resolve(setupDir, "..", "..");
  const repoRoot = resolve(apiDir, "..", "..");
  const names = [".env", ".env.local", ".env.development", ".env.production"];
  const dirs = [
    repoRoot,
    apiDir,
    resolve(repoRoot, "services", "worker"),
    resolve(repoRoot, "apps", "web"),
  ];
  return dirs.flatMap((d) => names.map((n) => resolve(d, n)));
})();

/**
 * Read the machine's env files for FINGERPRINTS ONLY.
 *
 * The files are never loaded into `process.env` by this function and their
 * contents never leave it. Parsing is deliberately minimal — `KEY=VALUE`, with
 * surrounding quotes stripped — because the goal is only to recognise a value
 * if it reappears.
 */
function collectMachineFingerprints() {
  for (const [key, value] of Object.entries(process.env)) {
    rememberMachineValue(key, value);
  }
  for (const path of ENV_FILE_CANDIDATES) {
    if (!existsSync(path)) continue;
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      rememberMachineValue(key, value);
    }
  }
}

/**
 * True when `value` is a string this machine already had for `key`.
 *
 * A key that was never seen with any value is treated as NOT machine-supplied:
 * on a later pass it can only have been set by the run itself.
 */
export function isMachineSuppliedValue(key, value) {
  const set = MACHINE_VALUE_HASHES.get(key);
  if (!set || typeof value !== "string" || value.length === 0) return false;
  return set.has(fingerprint(value));
}

export function applySafeTestEnvironment() {
  // Fingerprint first: the scrub below is what removes the evidence.
  collectMachineFingerprints();

  // Captured BEFORE the scrub, which is what removes them.
  const inheritedDatabaseUrl = process.env.DATABASE_URL;
  const inheritedDirectUrl = process.env.DIRECT_URL;
  const inheritedDriftCheckUrl = process.env.DRIFT_CHECK_DATABASE_URL;
  const inheritedInternalApiBase = process.env.INTERNAL_API_BASE_URL;

  for (const key of Object.keys(process.env)) {
    if (isCredentialKey(key)) {
      SCRUBBED_KEYS.push(key);
      delete process.env[key];
    }
  }

  // Any surviving `import "dotenv/config"` now loads a file that is not there.
  process.env.DOTENV_CONFIG_PATH = "./.env.point7-intentionally-absent";
  process.env.DOTENV_CONFIG_QUIET = "true";

  for (const [k, v] of Object.entries(REQUIRED_CORE)) process.env[k] = v;
  /**
   * PHASE 13 (NEW-076) — THE RECORDER PATHS ARE THE RUNNER'S TO CHOOSE.
   *
   * `LOCAL_FAKES` selects the RECORDING transports, which is exactly right — a
   * real implementation of the same contract, never a remote one — and it also
   * pinned WHERE they write. Pinning the destination is a different decision from
   * pinning the transport, and it broke the seam it exists to create: the Point-7
   * runner passed its own absolute recorder paths to the API process, the
   * bootstrap silently replaced them with relative defaults, and the browser
   * fixture then polled the runner's path — an empty file. The step-up journeys
   * reported "no verification_start entry for that recipient" while the API was
   * dutifully recording every code somewhere else.
   *
   * A silent override of a caller-supplied path can only ever produce that class
   * of bug, so an explicitly-supplied path now wins. The default is unchanged for
   * every process that does not supply one, and the TRANSPORT choice stays
   * non-negotiable: only the destination is the caller's.
   */
  const RUNNER_OWNED_PATHS = new Set([
    "EMAIL_RECORDER_FILE",
    "MESSAGING_RECORDER_FILE",
  ]);
  for (const [k, v] of Object.entries(LOCAL_FAKES)) {
    if (RUNNER_OWNED_PATHS.has(k) && (process.env[k] ?? "").trim().length > 0) {
      continue;
    }
    process.env[k] = v;
  }
  for (const [k, v] of Object.entries(DISABLED_SUBSYSTEMS)) process.env[k] = v;
  // The same one-process exception as the credential scrub above, expressed
  // through the same predicate so the intent lives in exactly one place.
  for (const k of EXPLICITLY_UNCONFIGURED) {
    if (isPoint7ApiOwned(k)) continue;
    delete process.env[k];
  }

  // Disposable infrastructure. `P7_TEST_*` is how an operator points the run at
  // the containers they started; never inherited from the machine.
  //
  // A URL the CALLER supplied is KEPT when it already points at loopback.
  // NODE_OPTIONS propagates to child processes, so this bootstrap also runs
  // inside scripts a test spawns — and the drift-check suite spawns
  // `drift-check.mjs` with a deliberately-crafted local target to prove the
  // resolver honours it. Overwriting that unconditionally made the bootstrap
  // rewrite the very thing under test. The safety property is unchanged and
  // stated precisely: a REMOTE database or Redis URL is always replaced; a
  // local one is the caller's business.
  process.env.REDIS_URL = keepIfLocal(process.env.REDIS_URL)
    ?? process.env.P7_TEST_REDIS_URL
    ?? "redis://127.0.0.1:56379";
  process.env.DATABASE_URL =
    keepIfLocal(inheritedDatabaseUrl) ??
    process.env.TEST_DATABASE_URL ??
    process.env.P7_TEST_DATABASE_URL ??
    "postgresql://point7:point7@127.0.0.1:1/point7_no_such_database";
  process.env.DIRECT_URL = keepIfLocal(inheritedDirectUrl) ?? process.env.DATABASE_URL;

  /**
   * THE WORKER'S VIEW OF THE API — loopback, or nothing at all.
   *
   * `INTERNAL_API_BASE_URL` matches the `API_BASE` credential fragment, so the
   * scrub removed it and the worker fell back to its compose default,
   * `http://proovra-api:8080`. The outbound guard did its job and refused the
   * connection twenty-three times — and every refusal was written into the
   * PRODUCT ledger as an attempt on an unknown external host, which is exactly
   * the shape of record the closure gate must treat as a real egress attempt.
   * A harness-caused entry in the evidence the harness produces is worse than
   * useless: it either fails a clean run or teaches the reader to ignore the
   * one line that matters.
   *
   * Same rule as the database and Redis above: a REMOTE value is always
   * discarded, a LOOPBACK one the caller supplied is the caller's business.
   */
  const localInternalApi = keepIfLocal(inheritedInternalApiBase);
  if (localInternalApi) process.env.INTERNAL_API_BASE_URL = localInternalApi;
  if (inheritedDriftCheckUrl && keepIfLocal(inheritedDriftCheckUrl)) {
    process.env.DRIFT_CHECK_DATABASE_URL = inheritedDriftCheckUrl;
  }
  process.env.P7_PROCESS = process.env.P7_PROCESS ?? "test";

  // The marker the ENTRYPOINT loaders honour. Configuration for this process
  // has been established deliberately, so  and the worker loader
  // must not refill anything the scrub removed — which is exactly what they
  // were doing, silently, after the scrub had run.
  process.env.PROOVRA_ENV_BOOTSTRAPPED = "1";
}

// ===========================================================================
// 2. The outbound guard
// ===========================================================================

const LOOPBACK = new Set([
  "127.0.0.1", "::1", "0.0.0.0", "localhost", "::ffff:127.0.0.1",
]);

/**
 * Destination categories, for the ledger.
 *
 * Recorded so a blocked attempt says WHAT was reached for, not merely that
 * something was. The ledger never holds a credential, a query string, a
 * header or a payload — only the host, the category and the outcome.
 */
const CATEGORIES = [
  [/ingest\..*sentry\.io$|sentry\.io$/i, "sentry"],
  [/upstash\.io$/i, "redis"],
  [/amazonaws\.com$/i, "aws"],
  [/grafana\.net$/i, "otlp"],
  [/proovra\.com$/i, "proovra-production"],
  [/stripe\.com$/i, "payments"],
  [/paypal\.com$/i, "payments"],
  [/resend\.com$/i, "email"],
  [/openai\.com$|deepgram\.com$|cognitiveservices\.azure\.com$/i, "ai-provider"],
  [/accounts\.google\.com$|appleid\.|okta\.com$|auth0\.com$/i, "identity"],
];

function categorize(host) {
  // Loopback is named, not lumped in with "unknown-external". The ledger is
  // evidence, and a run whose 498 disposable-container connections all read
  // "unknown-external" invites exactly the wrong conclusion about where this
  // process was talking.
  const h = String(host ?? "").toLowerCase();
  if (LOOPBACK.has(h) || h.endsWith(".localhost")) return "loopback-disposable";
  // NOT `isLocal`: that also returns true for anything an operator put in
  // `P7_ALLOWED_HOSTS`, and an explicitly allowlisted REMOTE host must keep
  // its own category in the record rather than be filed as loopback.
  for (const [re, name] of CATEGORIES) if (re.test(host)) return name;
  return "unknown-external";
}

function allowedHosts() {
  return new Set(
    (process.env.P7_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isLocal(host) {
  if (!host) return true;
  const h = String(host).toLowerCase();
  return LOOPBACK.has(h) || h.endsWith(".localhost") || allowedHosts().has(h);
}

const BLOCKED = [];
export function getBlockedDestinations() {
  return BLOCKED.slice();
}

/**
 * Which PHASE of the process an attempt belongs to.
 *
 * The previous ledger recorded host and count and nothing else, which was
 * enough to prove containment and not enough to explain anything. "18 blocked
 * Resend attempts" could equally have been one scenario retrying eighteen
 * times or eighteen scenarios each silently skipping their email boundary, and
 * the record could not tell the difference.
 *
 * `P7_PHASE` is set by the runner: `startup` while a process is booting,
 * `product` once the matrix is driving it, `tooling` for anything a test
 * runner spawns for its own purposes. Product-behaviour credit is only ever
 * derived from `product`.
 */
/**
 * Set while a test is making a DELIBERATE forbidden attempt to prove the guard
 * refuses one. Such an attempt is real and must be recorded — in the CANARY
 * ledger, attributable to the scenario that made it, and never in the product
 * ledger where it would read as the product reaching outside.
 */
let deliberateAttemptScenario = null;

/**
 * Call sites that are the FRAMEWORK'S OWN TOOLING, never the product.
 *
 * Matched on the bounded call site — the caller — not on the destination host,
 * because "who asked" is the question that separates tooling from product and
 * "where to" is not. Allowlisting a host would let any caller reach it; this
 * changes no destination's outcome at all. Every one of these attempts is
 * still REFUSED, still recorded, still attributed; it is simply attributed to
 * the toolchain that made it rather than to the product.
 *
 * The one entry: `next dev`'s hot reloader polls the npm registry for a
 * version banner (`hot-reloader-webpack.js:getVersionInfo`), unconditionally
 * and with no kill switch. It is structurally absent from `next start`, which
 * is what a deployment runs, and no product behaviour consults its result.
 */
const TOOLING_CALL_SITE_FRAGMENTS = ["hot-reloader"];

function isToolingCallSite(callSite) {
  return TOOLING_CALL_SITE_FRAGMENTS.some((f) => callSite.includes(f));
}

function currentPhase() {
  if (deliberateAttemptScenario) return "canary";
  const raw = (process.env.P7_PHASE ?? "").trim().toLowerCase();
  if (raw === "startup" || raw === "product" || raw === "tooling" || raw === "canary") {
    return raw;
  }
  return "startup";
}

/**
 * Run `fn` with its outbound attempts recorded as DELIBERATE.
 *
 * Published on `globalThis` so a suite can reach it without importing the
 * preload. The scenario id is required: an unattributed deliberate attempt is
 * indistinguishable from an accidental one, which is the whole thing this
 * separation exists to prevent.
 */
export function withDeliberateAttempt(scenarioId, fn) {
  if (!scenarioId) throw new Error("withDeliberateAttempt requires a scenario id");
  const previous = deliberateAttemptScenario;
  deliberateAttemptScenario = scenarioId;
  try {
    return fn();
  } finally {
    deliberateAttemptScenario = previous;
  }
}

/**
 * A BOUNDED call-site: the frames' function and module names, nothing else.
 *
 * Deliberately not the raw stack. A stack line carries the absolute path and,
 * for some runtimes, inlined argument previews — which is how a "diagnostic"
 * ends up holding a token or a recipient address. Only the symbol and the
 * basename survive, capped at four frames.
 */
function boundedCallSite() {
  const err = new Error("callsite");
  const frames = String(err.stack ?? "").split("\n").slice(1);
  const out = [];
  for (const line of frames) {
    // The LAST path-like segment ending in a JS/TS extension is the module;
    // anything before it is a directory and is discarded unread.
    const fileMatch = /([\w.@-]+\.(?:m?js|m?ts|cjs))(?::\d+:\d+)?\)?\s*$/.exec(
      line.trim(),
    );
    if (!fileMatch) continue;
    const file = fileMatch[1];
    if (file.includes("test-bootstrap")) continue;

    // A symbol only counts when it looks like an identifier. `at file:///…`
    // has no function name, and the path that follows `at ` must never be
    // mistaken for one — that is how an absolute path (and everything a path
    // can reveal) ends up in a record that promises not to hold it.
    const fnMatch = /^\s*at\s+([A-Za-z_$][\w$.<>]*)\s+\(/.exec(line);
    const fn = fnMatch ? fnMatch[1].split(".").slice(-2).join(".") : "";
    out.push(fn ? `${file}:${fn}` : file);
    if (out.length >= 4) break;
  }
  return out.join(" < ");
}

/**
 * The transport that made the attempt — `fetch`, `http`, `https` or `socket`.
 * Set by each guarded path so the record says HOW the egress was reached, not
 * only that it was.
 */
let activeTransportAuthority = "socket";

/**
 * Cross-process scenario attribution, without a new route and without a line
 * of production code.
 *
 * The browser matrix drives the API over HTTP, so the API process has no idea
 * which scenario a request belongs to — which is why "18 blocked Resend
 * attempts" could not be pinned to anything. The runner tags each request with
 * `x-p7-scenario`, and this preload — which already patches globals and is
 * never loaded by a deployed process — wraps `http.createServer` to carry that
 * tag through the request in an `AsyncLocalStorage`.
 *
 * A test-only ROUTE was the alternative and was rejected: the repository pins
 * a 139-operation route baseline as a conservation guard, and widening the
 * production route surface to improve a test ledger is the wrong trade.
 */
const scenarioStore = new AsyncLocalStorage();

function currentScenario() {
  return scenarioStore.getStore() ?? process.env.P7_SCENARIO ?? "";
}

function installScenarioAttribution() {
  if (globalThis.__point7ScenarioAttributionInstalled) return;
  globalThis.__point7ScenarioAttributionInstalled = true;
  const http = require_("node:http");
  const originalCreateServer = http.createServer;
  http.createServer = function patchedCreateServer(...args) {
    const handlerIndex = args.findIndex((a) => typeof a === "function");
    if (handlerIndex === -1) return originalCreateServer.apply(this, args);
    const handler = args[handlerIndex];
    const wrapped = function scenarioAttributedHandler(req, res) {
      const raw = req?.headers?.["x-p7-scenario"];
      const scenario = typeof raw === "string" ? raw.slice(0, 120) : "";
      if (!scenario) return handler.call(this, req, res);
      return scenarioStore.run(scenario, () => handler.call(this, req, res));
    };
    const next = args.slice();
    next[handlerIndex] = wrapped;
    return originalCreateServer.apply(this, next);
  };
}

function record(outcome, host, port) {
  const callSite = boundedCallSite();
  const entry = {
    runId: process.env.POINT7_RUN_ID ?? "",
    buildId: process.env.POINT7_BUILD_ID ?? "",
    phase: isToolingCallSite(callSite) ? "tooling" : currentPhase(),
    process: process.env.P7_PROCESS ?? "test",
    scenarioId: deliberateAttemptScenario ?? currentScenario(),
    host: String(host),
    category: categorize(String(host)),
    outcome,
    transportAuthority: activeTransportAuthority,
    boundedCallSite: callSite,
    atUtc: new Date().toISOString(),
  };
  if (outcome === "BLOCKED") BLOCKED.push(entry);
  // The deliberate canary attempt has its OWN ledger. Mixing it into the
  // product ledger would mean the closure gate could never say "zero
  // unexpected external attempts" without also excusing a real one.
  const ledger =
    entry.phase === "canary"
      ? (process.env.P7_CANARY_LEDGER ?? process.env.P7_NETWORK_LEDGER)
      : entry.phase === "tooling"
        ? (process.env.P7_TOOLING_LEDGER ?? process.env.P7_NETWORK_LEDGER)
        : process.env.P7_NETWORK_LEDGER;
  if (!ledger) return;
  try {
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Evidence, not a dependency. The DENIAL still happens.
  }
}

/** Run `fn` with the transport authority named, restoring it afterwards. */
function withTransport(name, fn) {
  const previous = activeTransportAuthority;
  activeTransportAuthority = name;
  try {
    return fn();
  } finally {
    activeTransportAuthority = previous;
  }
}

function deny(host, port) {
  record("BLOCKED", host, port);
  const err = new Error(
    `POINT7_OUTBOUND_DENIED: refused a connection to "${host}" ` +
      `(category: ${categorize(String(host))}). A local run may reach loopback ` +
      "and the disposable services named in P7_ALLOWED_HOSTS, nothing else.",
  );
  err.code = "POINT7_OUTBOUND_DENIED";
  return err;
}

/**
 * Guard every egress path.
 *
 * `net.Socket.prototype.connect` catches everything that ends in a socket —
 * pg, ioredis, undici, the AWS SDK, the Sentry transport. `fetch`, `http` and
 * `https` are ALSO guarded, ahead of the socket, so a blocked attempt fails
 * with a clear error at the call site rather than deep inside a client's retry
 * loop, and so DNS is never even asked.
 */
export function installOutboundGuard() {
  if (globalThis.__point7GuardInstalled) return;
  globalThis.__point7GuardInstalled = true;

  // -- fetch / undici -------------------------------------------------------
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = function guardedFetch(input, init) {
      let host = "";
      try {
        const url = typeof input === "string" ? input : (input?.url ?? String(input));
        host = new URL(url).hostname;
      } catch {
        host = "";
      }
      if (host && !isLocal(host)) {
        return Promise.reject(withTransport("fetch", () => deny(host, null)));
      }
      if (host) withTransport("fetch", () => record("ALLOWED", host, null));
      return originalFetch.call(this, input, init);
    };
  }

  // -- http / https ---------------------------------------------------------
  for (const mod of ["node:http", "node:https"]) {
    const lib = require_(mod);
    for (const fn of ["request", "get"]) {
      const original = lib[fn];
      lib[fn] = function guarded(...args) {
        const first = args[0];
        let host = "";
        try {
          if (typeof first === "string") host = new URL(first).hostname;
          else if (first instanceof URL) host = first.hostname;
          else if (first && typeof first === "object") host = first.hostname ?? first.host ?? "";
        } catch {
          host = "";
        }
        if (host && !isLocal(String(host).split(":")[0])) {
          throw withTransport(mod === "node:https" ? "https" : "http", () =>
            deny(String(host).split(":")[0], null),
          );
        }
        return original.apply(this, args);
      };
    }
  }

  // -- raw sockets / TLS ----------------------------------------------------
  const net = require_("node:net");
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let host = null;
    let port = null;
    const first = args[0];
    if (first && typeof first === "object") {
      if (typeof first.path === "string") return originalConnect.apply(this, args);
      host = first.host ?? null;
      port = first.port ?? null;
    } else if (typeof first === "number" || typeof first === "string") {
      port = first;
      host = typeof args[1] === "string" ? args[1] : "localhost";
    }
    if (host && !isLocal(host)) throw deny(host, port);
    if (host) record("ALLOWED", host, port);
    return originalConnect.apply(this, args);
  };
}

// ===========================================================================
// 3. Run, in order. Environment first, so the guard's own ledger path and
//    allowlist are the safe ones; guard second, before anything can dial.
// ===========================================================================

applySafeTestEnvironment();
installOutboundGuard();
installScenarioAttribution();

/**
 * Publish the value-origin oracle for the vitest-side re-assert.
 *
 * `globalThis` rather than an import: this file is loaded by Node as a
 * `--import` preload, while `safe-environment.ts` is loaded through vitest's
 * transform pipeline, and the two paths do not reliably share a module
 * instance. The map itself is never exposed — only the question it can answer.
 */
globalThis.__P7_IS_MACHINE_SUPPLIED_VALUE__ = isMachineSuppliedValue;

/** See {@link withDeliberateAttempt}. Published for the same reason. */
globalThis.__P7_DELIBERATE_ATTEMPT__ = withDeliberateAttempt;
