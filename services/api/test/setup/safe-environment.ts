/**
 * PHASE 12 — POINT 7 CORRECTIVE PASS: the test environment authority.
 *
 * Runs as a vitest `setupFile`, which executes BEFORE the test module is
 * imported — and therefore before `services/api/src/db.ts` runs its
 * `import "dotenv/config"`.
 *
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * `dotenv` does not overwrite a variable that is already set. That is a good
 * default and it is also why the first Point-7 run leaked: safety depended on
 * having remembered to pre-set every dangerous key, and `SENTRY_DSN`,
 * `SENTRY_ENABLED`, the AWS credentials and the production bucket were not on
 * the list. The API booted inside the test process, initialised Sentry with the
 * production DSN, and its startup object-lock verifier read the production
 * evidence bucket with production credentials.
 *
 * TWO MECHANISMS, DELIBERATELY
 * ---------------------------------------------------------------------------
 *   1. DENY-BY-DEFAULT env. Every key matching a credential/endpoint shape is
 *      DELETED, then a small set of safe local values is written. Deleting is
 *      what lets `dotenv` be harmless: it can only fill blanks, and after this
 *      the blanks are the safe ones.
 *   2. `DOTENV_CONFIG_PATH` is pointed at a file that does not exist, so
 *      `import "dotenv/config"` loads nothing at all. Mechanism 1 would be
 *      sufficient if the deny-list were complete; this makes completeness
 *      unnecessary.
 *
 * The outbound socket guard is the third, and it is the one that actually
 * PROVES the property — see `outbound-guard.mjs`.
 */

import { resolve } from "node:path";

import { beforeEach } from "vitest";

/**
 * Keys whose VALUE is a credential or an endpoint. Matched case-insensitively
 * as substrings, so `STRIPE_SECRET_KEY`, `AWS_SECRET_ACCESS_KEY` and
 * `NEXT_PUBLIC_SENTRY_DSN` are all covered by three entries.
 */
const DANGEROUS_KEY_FRAGMENTS = [
  "SENTRY",
  "DSN",
  "UPSTASH",
  "REDIS",
  "STRIPE",
  "PAYPAL",
  "RESEND",
  "SMTP",
  "TWILIO",
  "OPENAI",
  "DEEPGRAM",
  "AZURE",
  "AWS",
  "KMS",
  "S3_",
  "R2_",
  "GOOGLE_",
  "APPLE_",
  "SAML",
  "SCIM",
  "SSO_",
  "WEBHOOK_URL",
  "API_KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "CREDENTIAL",
  "DATABASE_URL",
  "DIRECT_URL",
  "SHADOW_DATABASE_URL",
  "NEXT_PUBLIC_API",
  "API_BASE",
];

/**
 * Keys the harness itself supplies and must NOT strip.
 *
 * `AUTH_JWT_SECRET` contains "SECRET" and is a test-only value minted by the
 * vitest config; `TEST_DATABASE_URL` contains "DATABASE_URL" and is how the
 * operator points the run at a disposable database. Both are the mechanism,
 * not the leak.
 */
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
  "P7_SENTRY_LEDGER",
  "P7_SCENARIO",
  "P7_PROCESS",
  "P7_TEST_REDIS_URL",
  "E2E_AUTH_BYPASS_SECRET",
  "IDENTITY_SECURITY_HASH_SECRET",
  "COMMUNICATIONS_RECIPIENT_HASH_SECRET",
  "WORKFLOW_INTAKE_TOKEN_SECRET",
]);

function isDangerous(key: string): boolean {
  if (HARNESS_OWNED.has(key)) return false;
  const upper = key.toUpperCase();
  return DANGEROUS_KEY_FRAGMENTS.some((fragment) => upper.includes(fragment));
}

/** The keys this setup removed. Asserted on by the isolation gate. */
export const SCRUBBED_KEYS: string[] = [];

/**
 * Answers "did this value come from the machine?" — installed on `globalThis`
 * by the `--import` preload, which fingerprinted the inherited environment and
 * the `.env` files before scrubbing them. Absent only if this file is loaded
 * without the preload, in which case the conservative behaviour (scrub
 * everything dangerous, every pass) is the right fallback.
 */
type ValueOriginOracle = (key: string, value: string) => boolean;

function machineValueOracle(): ValueOriginOracle | null {
  const fn = (globalThis as { __P7_IS_MACHINE_SUPPLIED_VALUE__?: unknown })
    .__P7_IS_MACHINE_SUPPLIED_VALUE__;
  return typeof fn === "function" ? (fn as ValueOriginOracle) : null;
}

/**
 * `mode: "boundary"` — the first pass. Everything credential-shaped goes,
 * because at that point nothing in the run has had a chance to set anything and
 * every dangerous value present is by definition inherited.
 *
 * `mode: "re-assert"` — every later pass. Only values the MACHINE supplies are
 * removed. A suite that sets `INTERNAL_SERVICE_TOKEN` to a test literal in
 * `beforeAll` keeps it: deleting that was the harness manufacturing a `401`
 * and, downstream, a generic `extraction_failed` in place of the bounded
 * refusal the suite was written to prove.
 */
export function applySafeTestEnvironment(
  mode: "boundary" | "re-assert" = "boundary",
): void {
  const isMachineValue = mode === "re-assert" ? machineValueOracle() : null;
  for (const key of Object.keys(process.env)) {
    if (!isDangerous(key)) continue;
    if (isMachineValue && !isMachineValue(key, process.env[key] ?? "")) {
      // Set by this run, not inherited. Leave it.
      continue;
    }
    SCRUBBED_KEYS.push(key);
    delete process.env[key];
  }

  // `import "dotenv/config"` honours DOTENV_CONFIG_PATH. Pointing it at a
  // path that does not exist makes the import a no-op rather than a second
  // chance for the machine's `.env` to reintroduce what was just removed.
  process.env.DOTENV_CONFIG_PATH = resolve(
    process.cwd(),
    ".env.point7-intentionally-absent",
  );

  // Safe local defaults for everything the app reads at boot.
  process.env.NODE_ENV = "test";
  process.env.OBSERVABILITY_TRANSPORT = "recording";
  process.env.SENTRY_ENABLED = "false";
  // Object Lock is a genuine external boundary; the local run declares it off
  // rather than reaching a bucket to ask.
  process.env.S3_OBJECT_LOCK_ENABLED = "false";
  process.env.OBJECT_LOCK_VERIFICATION_BYPASS = "true";
  // Object storage is a genuine external boundary, so it is replaced with a
  // LOCAL one rather than removed: `storage.ts` requires these at module load,
  // and an absent value would only move the failure. The endpoint is loopback,
  // so anything that does try to upload fails visibly against the disposable
  // MinIO instead of silently succeeding against the production bucket — which
  // is what the first run's startup verifier did with the real credentials.
  process.env.S3_ENDPOINT = "http://127.0.0.1:59000";
  process.env.S3_REGION = "auto";
  process.env.S3_ACCESS_KEY = "point7-local-minio";
  process.env.S3_SECRET_KEY = "point7-local-minio-secret";
  process.env.S3_BUCKET = "point7-local-bucket";
  process.env.S3_ALLOW_INSECURE = "true";
  process.env.S3_FORCE_PATH_STYLE = "true";
  process.env.SIGNER_PROVIDER = "local-pem";
  process.env.SIGNING_KEY_ID = "point7_test_ed25519";
  process.env.SIGNING_KEY_VERSION = "1";
  process.env.SIGNING_PRIVATE_KEY_PATH = "keys/signing-private.pem";
  process.env.SIGNING_PUBLIC_KEY_PATH = "keys/signing-public.pem";
  process.env.PACKAGE_SIGNING_KEY_ID = "point7_test_package_ed25519";
  process.env.PACKAGE_SIGNING_KEY_VERSION = "1";
  process.env.PACKAGE_SIGNING_PRIVATE_KEY_PATH = "keys/signing-private.pem";
  process.env.PACKAGE_SIGNING_PUBLIC_KEY_PATH = "keys/signing-public.pem";
  // A LOCAL AI provider configuration — configured, but not a real credential.
  //
  // The AI-disclosure suite asserts that with no workspace the fail-closed
  // default is DISABLED_BY_WORKSPACE_POLICY. That distinction only exists when
  // the PLATFORM is configured; before this, the suite was satisfied by the
  // machine's real `OPENAI_API_KEY` arriving through `dotenv`. It was passing
  // because a production credential was in scope, which is precisely the
  // dependency this pass exists to remove. The key is obviously fake and the
  // outbound guard would refuse the provider host regardless.
  // The two subsystems the outbound guard caught reaching production during
  // the corrective pass: AWS Secrets Manager hydration and the OTLP exporter
  // aimed at the PRODUCTION Grafana gateway. Both are off in a test process.
  process.env.AWS_SECRETS_ENABLED = "false";
  process.env.OTEL_ENABLED = "false";
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // NO global AI provider configuration.
  //
  // A local fake was tried here and had to be withdrawn: OCR and transcript
  // extraction fall back to OpenAI when Azure and Deepgram are absent, so
  // configuring it globally made `provider-not-configured` — the Point-5 suite
  // whose entire subject is an UNCONFIGURED provider producing a bounded
  // refusal — see a configured one, get past the config check, and fail at
  // storage with `extraction_failed` instead.
  //
  // Two suites want opposite global states, so neither gets to own the global:
  // the AI-disclosure suite sets what it needs for itself, which is where a
  // per-suite premise belongs.
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_AI_ENABLED;
  // A LOCAL email provider configuration — CONFIGURED, but not a credential.
  //
  // The Point-5 delivery suites distinguish "the provider refused / must
  // retry" from "there is no provider, so this send is SKIPPED", and that
  // distinction only exists when one is configured. Removing `RESEND_API_KEY`
  // outright turned forty-one of those assertions into `SKIPPED`, which looked
  // like a Point-5 regression and was really the harness withdrawing a
  // boundary the suites need. Replacing it with a local fake is what the
  // external-boundary rule actually asks for; the key is obviously not real,
  // and the outbound guard refuses the provider host regardless.
  // The LOCAL RECORDING email provider — see the same selection in
  // `test-bootstrap.mjs`, which sets it before any import. Repeated here so a
  // process that reaches this file without the preload still never constructs
  // a real provider request.
  process.env.EMAIL_TRANSPORT =
    process.env.EMAIL_TRANSPORT ?? "recording";
  process.env.RESEND_API_KEY = "re_point7_local_fake_not_a_credential";
  process.env.EMAIL_FROM = "point7-local@test.proovra.local";
  process.env.EMAIL_FROM_NAME = "Proovra Point7 Local";
  // Configuring an email transport (line above) makes
  // `EMAIL_IDEMPOTENCY_SECRET` genuinely required, and
  // `collectStartupViolations` said so — `phase-r8-c-consolidation T03` failed
  // on a violation the harness itself had created by binding a provider key and
  // then scrubbing the secret that provider needs. The fix is the value, not a
  // softer check.
  process.env.EMAIL_IDEMPOTENCY_SECRET =
    process.env.EMAIL_IDEMPOTENCY_SECRET ??
    "point7-test-only-email-idempotency-secret";
  process.env.AUTH_JWT_SECRET =
    process.env.AUTH_JWT_SECRET ??
    "point7-integration-only-secret-0123456789abcdef";
  process.env.IDENTITY_SECURITY_HASH_SECRET =
    process.env.IDENTITY_SECURITY_HASH_SECRET ?? "point7-test-identity-hash-secret";
  // The DISPOSABLE Redis, not the machine's.
  //
  // Deleting `REDIS_URL` outright was the first attempt, on the reasoning that
  // the limiter falls back to an in-memory store. That is true of the limiter
  // and false of the queue suites: the Point-5 retention/destruction and
  // provider families need a real Redis, and with the variable gone they went
  // looking for one — at which point the outbound guard caught them dialling
  // `harmless-lark-138859.upstash.io`, the machine's hosted instance.
  //
  // Those suites were reaching production Redis before this pass and nothing
  // said so. A LOCAL boundary is the answer, exactly as for object storage and
  // email: `P7_TEST_REDIS_URL` when the operator started one, otherwise the
  // conventional disposable port. Never inherited.
  process.env.REDIS_URL =
    process.env.P7_TEST_REDIS_URL ?? "redis://127.0.0.1:56379";

  // A syntactically valid, obviously-fake DATABASE_URL so `db.ts` can build
  // its lazy Pool without throwing at import time.
  //
  // Before this, a unit test that imported anything reaching `db.ts` was
  // handed the PRODUCTION connection string by `dotenv`. It never connected —
  // the Pool is lazy and unit tests do not query — but "it happened not to
  // dial" is not a safety property. The integration harness overwrites this
  // with its disposable container URL before importing anything.
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://point7:point7@127.0.0.1:1/point7_no_such_database";
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  // The client-library API base, pointed at loopback.
  //
  // `NEXT_PUBLIC_API_BASE` is scrubbed above (it carried
  // `https://api.proovra.com`), and `apps/web/lib/api.ts` falls back to that
  // same production host when the variable is absent — so a web-library unit
  // test that issues a request would aim at production either way. Pointing it
  // at loopback means such a test fails locally and visibly instead.
  process.env.NEXT_PUBLIC_API_BASE = "http://127.0.0.1:8091";
  process.env.API_BASE_URL = "http://127.0.0.1:8091";
  process.env.P7_PROCESS = process.env.P7_PROCESS ?? "vitest";
}

applySafeTestEnvironment();

/**
 * Re-assert before every test.
 *
 * The outbound guard caught an `ioredis` client dialling the machine's Upstash
 * endpoint from inside a worker whose environment had already been scrubbed —
 * so something re-populates `REDIS_URL` after this file runs. Vitest's own
 * `.env` handling is the likely author, and chasing which layer does it is
 * less useful than making the scrub idempotent and continuous: this hook costs
 * nothing and closes the window regardless of who reopens it.
 *
 * The guard remains the authority. This only stops the attempt being made.
 */
beforeEach(() => {
  applySafeTestEnvironment("re-assert");
});

// The socket guard goes on AFTER the environment is safe, so its ledger
// records the run rather than the scrubbing.
await import("./outbound-guard.mjs");

// Expose the observability module to the proof recorder.
//
// A global is not elegant. The alternative is for the manifest — which is also
// imported by the Playwright side, where the API's `src/` is not loaded — to
// import an API module directly, and that trades a global for a hard
// dependency in the wrong direction. What the recorder needs is one process's
// runtime observation, and this is the narrowest way to hand it over.
{
  const observability = await import(
    "../../src/observability/observability-environment.js"
  );
  (globalThis as unknown as Record<string, unknown>).__point7Observability =
    observability;
}
