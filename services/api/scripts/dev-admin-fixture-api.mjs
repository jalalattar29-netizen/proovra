#!/usr/bin/env node
/**
 * RUN THE API AGAINST THE LOCAL FIXTURE, WITH NOTHING POINTED AT PRODUCTION.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * `apps/web/scripts/dev-admin-fixture.mjs` keeps the BROWSER off Production. It
 * has no say over the API, and the API is the half that holds credentials.
 *
 * `services/api/.env` is a developer's own file with live values in it — S3 and
 * AWS, Stripe, PayPal, Twilio, Resend, OpenAI, Sentry, OTEL, TSA, SAML. dotenv
 * loads it on every boot, so starting the API "locally" with only DATABASE_URL
 * overridden produces a process that can reach all of them.
 *
 * That is not hypothetical. During the admin-console verification the API was
 * started that way and logged, at startup:
 *
 *     phase=startup.object_lock mode=verified
 *     bucket=proovra-evidence-prod-eu defaultMode=COMPLIANCE retainDays=2920
 *
 * — a real GetObjectLockConfiguration read against the production bucket. It
 * read configuration, not objects, and wrote nothing. It should still not have
 * happened, and nothing in the repository stopped it.
 *
 * =============================================================================
 * TWO LAYERS, BECAUSE A DENY-LIST IS NOT A GUARANTEE
 * =============================================================================
 * 1. NEUTRALISE — every integration this file knows about is blanked or
 *    disabled before the child starts.
 *
 * 2. REFUSE — the resulting environment is then SCANNED, and the API is not
 *    started if anything still looks like it points off this machine: a
 *    non-localhost http(s) URL, or a value shaped like a live credential.
 *
 * Layer 2 is the one that matters. Layer 1 can only cover integrations that
 * existed when it was written; the scan catches the one added next month by
 * somebody who never read this file. It names what it found, so the fix is to
 * add the variable to the neutralise list rather than to guess.
 *
 * =============================================================================
 * USAGE
 * =============================================================================
 *   node services/api/scripts/dev-admin-fixture-api.mjs
 *   node services/api/scripts/dev-admin-fixture-api.mjs --port=8081 \
 *     --database-url=postgresql://pv:pv@localhost:55433/proovra_admin_fixture
 *
 * `--allow=NAME,NAME` permits named variables through the scan, for a value
 * that is genuinely remote and genuinely needed. Nothing is allowed by default.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const PORT = arg("port", "8081");
const DATABASE_URL = arg(
  "database-url",
  "postgresql://pv:pv@localhost:55433/proovra_admin_fixture",
);
const REDIS_URL = arg("redis-url", "redis://localhost:56379");
const ALLOW = new Set(
  arg("allow", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// ---------------------------------------------------------------------------
// The database must be local. Everything else is downstream of this.
// ---------------------------------------------------------------------------
for (const [label, url] of [
  ["--database-url", DATABASE_URL],
  ["--redis-url", REDIS_URL],
]) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error(`dev-admin-fixture-api: ${label} is not a URL.`);
    process.exit(2);
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    console.error(
      `dev-admin-fixture-api: REFUSED — ${label} must be local, got "${host}".`,
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// LAYER 1 — neutralise.
// ---------------------------------------------------------------------------

/** Feature flags that gate an outbound call. Off means the call is not made. */
const DISABLE_FLAGS = [
  "AWS_SECRETS_ENABLED",
  "COMMUNICATIONS_ENABLED",
  "CONTACT_SALES_AUTO_REPLY_ENABLED",
  "DEMO_FOLLOW_UP_ENABLED",
  "DEMO_REQUEST_AUTO_REPLY_ENABLED",
  "GEO_INTELLIGENCE_ENABLED",
  "IMMUTABLE_STORAGE_DRIFT_ALERTS_ENABLED",
  "IMMUTABLE_STORAGE_RECONCILIATION_ENABLED",
  "INTEGRATIONS_ENABLED",
  "OPENAI_AI_ENABLED",
  "OTEL_ENABLED",
  "OTS_ENABLED",
  "S3_OBJECT_LOCK_ENABLED",
  "SAML_LIVE_IDP_VALIDATION_ENABLED",
  "SENTRY_ENABLED",
  "TSA_ENABLED",
];

/** Credentials and endpoints. Blanked outright. */
const BLANK = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECRET_NAME",
  "AWS_REGION",
  "AWS_SECRETS_REGION",
  "KMS_KEY_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_SECRET",
  "PAYPAL_API_BASE",
  "PAYPAL_WEBHOOK_ID",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY",
  "TWILIO_API_SECRET",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_VERIFY_SERVICE_SID",
  "TWILIO_WHATSAPP_NUMBER",
  "TWILIO_SMS_FROM_NUMBER",
  "TWILIO_WHATSAPP_TEMPLATE_URL_FORMAT",
  "RESEND_API_KEY",
  "OPENAI_API_KEY",
  "SENTRY_DSN",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "TSA_URL",
  "TSA_USERNAME",
  "TSA_PASSWORD",
  "OTS_CALENDAR_URL",
  "OPS_ALERT_WEBHOOK_URL",
  "CONTACT_SALES_WEBHOOK_URL",
  "DEMO_REQUEST_WEBHOOK_URL",
  "SAML_IDP_SSO_URL",
  "SAML_METADATA_URL",
  "SAML_IDP_CERT",
  "GOOGLE_CLIENT_SECRET",
  "APPLE_PRIVATE_KEY",
  "ANCHOR_PUBLIC_BASE_URL",
  "INTERNAL_API_KEY",
  // Found by the scan itself, on its first honest run against .env. Two are
  // identifiers rather than endpoints (SAML entity ids are URNs that happen
  // to be URLs) and would never be fetched — they are blanked anyway,
  // because a guard that starts making exceptions for values it judges
  // harmless is a guard that stops being read.
  "EMAIL_LOGO_URL",
  "SAML_IDP_ENTITY_ID",
];

/** Values that must be LOCAL rather than absent. */
const LOCAL = {
  NODE_ENV: "development",
  PORT,
  DATABASE_URL,
  DIRECT_URL: DATABASE_URL,
  REDIS_URL,
  APP_BASE_URL: "http://localhost:3200",
  APP_URL: "http://localhost:3200",
  WEB_BASE_URL: "http://localhost:3200",
  ADMIN_BASE_URL: "http://localhost:3200",
  NEXT_PUBLIC_API_BASE: `http://localhost:${PORT}`,
  NEXT_PUBLIC_APP_BASE: "http://localhost:3200",
  NEXT_PUBLIC_WEB_BASE: "http://localhost:3200",
  INTERNAL_API_BASE_URL: `http://localhost:${PORT}`,
  REPORT_APP_BASE_URL: "http://localhost:3200",
  REPORT_VERIFY_BASE_URL: "http://localhost:3200/verify",
  SSO_CALLBACK_REDIRECT_URI: "http://localhost:3200",
  GOOGLE_REDIRECT_URI: "http://localhost:3200",
  APPLE_REDIRECT_URI: "http://localhost:3200",
  CORS_ORIGINS: "http://localhost:3200",
  NEXT_PUBLIC_GOOGLE_REDIRECT_URI: "http://localhost:3200",
  NEXT_PUBLIC_APPLE_REDIRECT_URI: "http://localhost:3200",
  SAML_SP_ENTITY_ID: "http://localhost:8081/saml",
  SAML_SP_ACS_URL: "http://localhost:8081/saml/acs",
  // Stable on purpose. The JWT secret is otherwise per-process, so every API
  // restart invalidated the fixture session mid-verification and forced a
  // fresh sign-in — which is how a verification run quietly turns into a
  // debugging run.
  AUTH_JWT_SECRET: "fixture-local-only-jwt-secret-not-a-real-secret",
  SIGNER_PROVIDER: "local-pem",
  // S3 points at a DEAD LOCAL endpoint rather than being blanked.
  //
  // storage.ts throws at import time when S3_ACCESS_KEY is missing, so the
  // API will not boot without something here. A local address that nothing
  // is listening on is the honest choice: any storage call fails loudly and
  // locally, where blanking would not start and the real values would reach
  // the production bucket — which is the whole reason this file exists.
  S3_ENDPOINT: "http://localhost:59000",
  S3_PUBLIC_BASE_URL: "http://localhost:59000",
  S3_BUCKET: "proovra-admin-fixture",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY: "fixture-local-only",
  S3_SECRET_KEY: "fixture-local-only",
  S3_FORCE_PATH_STYLE: "true",
  S3_ALLOW_INSECURE: "true",
};

/**
 * The child's environment is BUILT, not inherited.
 *
 * A first version started from `process.env` and scanned that. It refused to
 * run — correctly by its own rule, uselessly in practice — because the
 * developer's shell carries variables that have nothing to do with this API
 * (the first refusal named ANTHROPIC_BASE_URL). A guard that fires on
 * variables the program never reads is a guard people switch off.
 *
 * So the child gets: an OS baseline it cannot run without, plus this API's own
 * configuration, and nothing else. The scan then covers exactly what the child
 * will see — which is the only set worth scanning.
 */
const OS_BASELINE = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir",
  "COMSPEC", "ComSpec", "TEMP", "TMP", "HOME", "HOMEDRIVE", "HOMEPATH",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramData",
  "ProgramFiles(x86)", "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE",
  "LANG", "LC_ALL", "TZ", "SHELL", "USER", "LOGNAME",
];

/**
 * `.env` is READ so the scan can see what dotenv will load — never modified,
 * and never printed. Values already present in the child environment win,
 * because dotenv does not overwrite what is already set; that is what makes
 * BLANK effective rather than decorative.
 */
function parseDotEnv(file) {
  const out = {};
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = {};
for (const k of OS_BASELINE) {
  if (process.env[k] !== undefined) env[k] = process.env[k];
}
// What dotenv would load, so the scan judges the real effective environment.
Object.assign(env, parseDotEnv(resolve(API_ROOT, ".env")));
for (const k of DISABLE_FLAGS) env[k] = "false";
for (const k of BLANK) env[k] = "";
Object.assign(env, LOCAL);

// ---------------------------------------------------------------------------
// LAYER 2 — refuse anything still pointing off this machine.
// ---------------------------------------------------------------------------
const LOCAL_HOST =
  /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$/i;

/** Credential shapes worth naming even when they are not URLs. */
const LIVE_CREDENTIAL = [
  { name: "AWS access key id", re: /^(AKIA|ASIA)[0-9A-Z]{16}$/ },
  { name: "Stripe key", re: /^(sk|rk)_(live|test)_/ },
  { name: "Resend key", re: /^re_[A-Za-z0-9]/ },
  { name: "OpenAI key", re: /^sk-[A-Za-z0-9_-]{16,}/ },
  { name: "Twilio account sid", re: /^AC[0-9a-f]{32}$/i },
];

const problems = [];
for (const [name, raw] of Object.entries(env)) {
  if (ALLOW.has(name)) continue;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") continue;

  const urls = value.match(/https?:\/\/[^\s,;"']+/g) ?? [];
  for (const u of urls) {
    let host;
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    if (!LOCAL_HOST.test(host)) {
      problems.push(`${name} → ${host}`);
      break;
    }
  }

  for (const c of LIVE_CREDENTIAL) {
    if (c.re.test(value)) {
      // The VALUE is never printed. Naming the variable is enough to fix it.
      problems.push(`${name} → looks like a ${c.name}`);
      break;
    }
  }
}

if (problems.length > 0) {
  console.error(
    [
      "dev-admin-fixture-api: REFUSED — the environment still reaches off this machine.",
      "",
      ...problems.map((p) => `  ${p}`),
      "",
      "  Add each to BLANK / DISABLE_FLAGS in this script, or pass",
      "  --allow=NAME,NAME if it is genuinely remote and genuinely needed.",
      "  (Values are never printed here. Only names.)",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const TSX = resolve(API_ROOT, "node_modules/.bin/tsx");
if (!existsSync(TSX) && !existsSync(`${TSX}.cmd`)) {
  console.error(`dev-admin-fixture-api: tsx not found at ${TSX}`);
  process.exit(2);
}

console.log(
  [
    "dev-admin-fixture-api",
    `  api       http://localhost:${PORT}`,
    `  database  ${DATABASE_URL}`,
    `  redis     ${REDIS_URL}`,
    `  outbound  ${BLANK.length} credentials blanked, ${DISABLE_FLAGS.length} integrations disabled`,
    "  scanned   no remaining non-local endpoint or live-credential shape",
    "",
    "  services/api/.env is neither modified nor relied upon for these values.",
    "",
  ].join("\n"),
);

const child = spawn(TSX, ["src/index.ts"], {
  cwd: API_ROOT,
  shell: true,
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
