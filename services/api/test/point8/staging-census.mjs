/**
 * PHASE 12 — POINT 8, STEPS 1 AND 2: the credential census and the Staging
 * preflight.
 *
 * WHY THIS IS A SEPARATE, PRE-EVERYTHING SCRIPT
 * ---------------------------------------------------------------------------
 * Point 7 established that `services/api/.env` on this machine carries LIVE
 * Stripe, PayPal, AWS, Redis, Sentry, Resend, Twilio and OpenAI credentials,
 * and that `import "dotenv/config"` in `services/api/src/db.ts` loads it into
 * any process started from that directory. Point 8 drives REAL providers, so
 * the question "which environment did this run select?" stops being a hygiene
 * concern and becomes the difference between a sandbox charge and a real one.
 *
 * The census therefore runs BEFORE anything is started, reads the env files
 * from disk itself rather than trusting `process.env`, and answers in the
 * mandate's five classifications.
 *
 * THE ONE RULE THIS FILE OBEYS
 * ---------------------------------------------------------------------------
 * It never emits a value. Not truncated, not hashed, not "just the prefix" —
 * except where a two-to-eight character provider prefix IS the sandbox/live
 * distinction (`sk_live_` vs `sk_test_`), in which case the CLASSIFICATION is
 * emitted and the prefix itself is not. Hostnames are reported as categories.
 * A reader of the output learns which gates may run and nothing else.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../../..");

/** Every env file that could be picked up by some process in this repository. */
export const ENV_FILES = [
  ".env",
  ".env.audit-local",
  "apps/web/.env.local",
  "services/api/.env",
  "services/api/.env.local",
  "services/api/.env.audit-local",
  "services/worker/.env",
  "infra/docker/.env",
];

export function parseEnvFile(path) {
  if (!existsSync(path)) return null;
  const out = new Map();
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    out.set(line.slice(0, eq).trim(), v);
  }
  return out;
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/i;
const DOCKER_SERVICE = /^(postgres|db|redis|minio|mailhog|host\.docker\.internal)$/i;

export function hostOf(value) {
  const m = /^[a-z0-9+.-]+:\/\/(?:[^@/]*@)?([^:/?#]+)/i.exec(value ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** A bounded category. Never the host. */
export function hostCategory(value) {
  const h = hostOf(value);
  if (!h) return "no-host";
  if (LOOPBACK.test(h) || h.endsWith(".localhost")) return "loopback";
  if (DOCKER_SERVICE.test(h)) return "docker-service";
  if (/(^|[.-])sandbox\./.test(h)) return "provider-sandbox-endpoint";
  if (/(^|\.)(staging|stg)\./.test(h)) return "staging-named-host";
  if (/(^|\.)example\.(com|org|net)$/.test(h)) return "placeholder-host";
  return "external-host";
}

export function isRemote(value) {
  const c = hostCategory(value);
  return c === "external-host" || c === "provider-sandbox-endpoint" || c === "staging-named-host";
}

/**
 * Markers that decide, on their own, that a file describes PRODUCTION.
 * Each is [variable, predicate, evidence-tag]. The tag is what gets printed.
 */
export const PRODUCTION_MARKERS = [
  ["STRIPE_SECRET_KEY", (v) => /^(sk|rk)_live_/.test(v), "stripe:live-mode-key"],
  ["PAYPAL_API_BASE", (v) => isRemote(v) && hostCategory(v) !== "provider-sandbox-endpoint", "paypal:live-endpoint"],
  ["AWS_ACCESS_KEY_ID", (v) => /^AKIA/.test(v), "aws:long-term-key"],
  ["S3_ACCESS_KEY", (v) => /^AKIA/.test(v), "aws:long-term-key"],
  ["S3_ENDPOINT", isRemote, "storage:remote-endpoint"],
  ["R2_ENDPOINT", isRemote, "storage:remote-endpoint"],
  ["REDIS_URL", isRemote, "redis:remote-host"],
  ["DATABASE_URL", isRemote, "postgres:remote-host"],
  ["DIRECT_URL", isRemote, "postgres:remote-host"],
  ["SENTRY_DSN", isRemote, "sentry:remote-project"],
  ["NEXT_PUBLIC_SENTRY_DSN", isRemote, "sentry:remote-project"],
  ["OTEL_EXPORTER_OTLP_ENDPOINT", isRemote, "otel:remote-collector"],
  ["OPENAI_API_KEY", (v) => /^sk-/.test(v), "openai:live-key"],
  ["RESEND_API_KEY", (v) => /^re_/.test(v), "email:real-provider-key"],
  ["TWILIO_ACCOUNT_SID", (v) => /^AC[0-9a-f]{16,}/i.test(v), "twilio:real-account"],
  ["OPS_ALERT_WEBHOOK_URL", isRemote, "webhook:remote-receiver"],
  ["SAML_METADATA_URL", isRemote, "saml:remote-idp"],
  ["SAML_IDP_SSO_URL", isRemote, "saml:remote-idp"],
  ["NEXT_PUBLIC_API_BASE", isRemote, "app:remote-api-origin"],
  ["WEB_BASE_URL", isRemote, "app:remote-web-origin"],
  ["NODE_ENV", (v) => v === "production", "runtime:production"],
];

/** Classify one env FILE. A production-bearing file may never be selected. */
export function classifyEnvFile(relPath) {
  const env = parseEnvFile(resolve(REPO_ROOT, relPath));
  if (!env) return { file: relPath, present: false, productionBearing: false, liveMarkers: [] };
  const liveMarkers = [];
  for (const [name, pred, tag] of PRODUCTION_MARKERS) {
    const v = env.get(name);
    if (v === undefined || v === "") continue;
    let hit = false;
    try {
      hit = pred(v);
    } catch {
      hit = false;
    }
    if (hit) liveMarkers.push(`${name}=${tag}`);
  }
  return {
    file: relPath,
    present: true,
    keys: env.size,
    productionBearing: liveMarkers.length > 0,
    liveMarkers,
  };
}

// ---------------------------------------------------------------------------
// The census proper.
// ---------------------------------------------------------------------------

const PLACEHOLDER = /(^|[-_])(changeme|placeholder|your|example|dummy|fake|xxx+|todo|replace)([-_]|$)/i;
const isPlaceholder = (v) => !v || PLACEHOLDER.test(v) || v === "..." || /^<.*>$/.test(v);

/** Each classifier returns [mode, bounded-evidence-tag]. Never a value. */
const M = {
  url: (v) => {
    const c = hostCategory(v);
    if (c === "loopback" || c === "docker-service") return ["LOCAL", `host:${c}`];
    if (c === "staging-named-host") return ["STAGING", `host:${c}`];
    if (c === "placeholder-host") return ["FAKE", `host:${c}`];
    if (c === "provider-sandbox-endpoint") return ["SANDBOX", `host:${c}`];
    return ["UNKNOWN", `host:${c}`];
  },
  stripeSecret: (v) =>
    /^(sk|rk)_live_/.test(v) ? ["LIVE", "key-mode:live"]
    : /^(sk|rk)_test_/.test(v) ? ["TEST", "key-mode:test"]
    : isPlaceholder(v) ? ["FAKE", "placeholder"]
    : ["UNKNOWN", "key-mode:unrecognised"],
  modelessPrefixed: (re, tag) => (v) =>
    re.test(v) ? ["UNKNOWN", tag] : isPlaceholder(v) ? ["FAKE", "placeholder"] : ["UNKNOWN", "unrecognised-shape"],
  awsKey: (v) =>
    /^AKIA/.test(v) ? ["LIVE", "aws-long-term-key"]
    : /^(minio|minioadmin|local)/i.test(v) ? ["LOCAL", "local-object-store-cred"]
    : isPlaceholder(v) ? ["FAKE", "placeholder"]
    : ["UNKNOWN", "opaque"],
  opaque: (v) => (isPlaceholder(v) ? ["FAKE", "placeholder"] : ["UNKNOWN", "opaque-secret"]),
  literal: (v) => (isPlaceholder(v) ? ["FAKE", "placeholder"] : ["SET", "non-secret-literal"]),
};

/**
 * The mandate's minimum census. `gate` is the Point-8 gate the item blocks.
 * `configuredIn` names where the product actually reads the setting from, so a
 * MISSING row cannot be mistaken for "the product cannot do this".
 */
export const CENSUS_ITEMS = [
  ["STAGING_WEB_BASE", [13], ["WEB_BASE_URL", "NEXT_PUBLIC_WEB_BASE"], M.url, "env"],
  ["STAGING_API_BASE", [13], ["NEXT_PUBLIC_API_BASE", "INTERNAL_API_BASE_URL"], M.url, "env"],
  ["STAGING_DATABASE_URL", [1], ["DATABASE_URL", "DIRECT_URL"], M.url, "env"],
  ["STAGING_REDIS_URL", [2], ["REDIS_URL"], M.url, "env"],
  ["STAGING_S3_OR_R2_ENDPOINT", [3], ["S3_ENDPOINT", "R2_ENDPOINT"], M.url, "env"],
  ["STAGING_STORAGE_BUCKET", [3], ["S3_BUCKET", "R2_BUCKET"], M.literal, "env"],
  ["STAGING_STORAGE_REGION", [3], ["S3_REGION", "R2_REGION"], M.literal, "env"],
  ["STAGING_STORAGE_ACCESS_AUTHORITY", [3], ["S3_ACCESS_KEY", "R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"], M.awsKey, "env"],
  ["STAGING_OBJECT_LOCK_CONFIGURATION", [3], ["S3_OBJECT_LOCK_ENABLED", "S3_OBJECT_LOCK_MODE", "S3_OBJECT_LOCK_RETAIN_DAYS"], M.literal, "env"],
  ["STRIPE_SANDBOX_SECRET", [4], ["STRIPE_SECRET_KEY"], M.stripeSecret, "env"],
  ["STRIPE_SANDBOX_WEBHOOK_SECRET", [4], ["STRIPE_WEBHOOK_SECRET"], M.modelessPrefixed(/^whsec_/, "whsec-prefix-carries-no-mode"), "env"],
  ["STRIPE_SANDBOX_PRICE_IDS", [4], ["STRIPE_PRO_PRICE_ID", "STRIPE_TEAM_PRICE_ID", "STRIPE_PAYG_PRICE_ID"], M.modelessPrefixed(/^price_/, "price-id-carries-no-mode"), "env"],
  ["PAYPAL_SANDBOX_CLIENT", [5], ["PAYPAL_CLIENT_ID"], M.opaque, "env"],
  ["PAYPAL_SANDBOX_SECRET", [5], ["PAYPAL_SECRET"], M.opaque, "env"],
  ["PAYPAL_SANDBOX_WEBHOOK_ID", [5], ["PAYPAL_WEBHOOK_ID"], M.opaque, "env"],
  ["PAYPAL_SANDBOX_ENDPOINT", [5], ["PAYPAL_API_BASE"], M.url, "env"],
  ["SAML_TEST_IDP_METADATA", [6], ["SAML_METADATA_URL"], M.url, "env + SsoConnection.samlMetadataJson"],
  ["SAML_TEST_CERTIFICATE", [6], ["SAML_IDP_CERT"], M.opaque, "env + SsoConnection"],
  ["SAML_TEST_ENTITY_ID", [6], ["SAML_IDP_ENTITY_ID"], M.literal, "env + SsoConnection.samlEntityId"],
  ["SAML_TEST_ACS_CONFIGURATION", [6], ["SAML_SP_ACS_URL", "SAML_SP_ENTITY_ID"], M.url, "env + SsoConnection"],
  ["SAML_TEST_SSO_URL", [6], ["SAML_IDP_SSO_URL"], M.url, "env + SsoConnection.samlSsoUrl"],
  ["OIDC_TEST_ISSUER", [7], ["OIDC_ISSUER", "SSO_OIDC_ISSUER"], M.url, "SsoConnection.issuerUrl (per-Organization, database)"],
  ["OIDC_TEST_CLIENT", [7], ["OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_ID"], M.opaque, "SsoConnection.clientId/clientSecretHash (database)"],
  ["OIDC_TEST_REDIRECT_CONFIGURATION", [7], ["SSO_CALLBACK_REDIRECT_URI", "SSO_ALLOWED_REDIRECT_HOSTS"], M.url, "env"],
  ["SCIM_TEST_BASE", [8], ["SCIM_BASE_URL"], M.url, "derived from STAGING_API_BASE + /scim/v2"],
  ["SCIM_TEST_TOKEN", [8], ["SCIM_TOKEN"], M.opaque, "minted per-Organization in the running app (database)"],
  ["STAGING_EMAIL_TRANSPORT", [9], ["EMAIL_TRANSPORT", "RESEND_API_KEY", "SMTP_HOST"], M.modelessPrefixed(/^(re_|[a-z0-9.-]+)$/i, "transport-selector-or-key"), "env"],
  ["STAGING_EMAIL_SENDER", [9], ["EMAIL_FROM"], M.literal, "env"],
  ["STAGING_TEST_MAILBOX", [9], ["STAGING_TEST_MAILBOX", "E2E_TEST_MAILBOX"], M.literal, "env"],
  ["STAGING_WEBHOOK_RECEIVER", [10], ["OPS_ALERT_WEBHOOK_URL", "CONTACT_SALES_WEBHOOK_URL", "DEMO_REQUEST_WEBHOOK_URL"], M.url, "env + WebhookEndpoint rows"],
  ["STAGING_WEBHOOK_SECRET", [10], ["COMMUNICATIONS_WEBHOOK_SECRET", "CONTACT_SALES_WEBHOOK_SECRET", "DEMO_REQUEST_WEBHOOK_SECRET"], M.opaque, "env + WebhookEndpoint.secret"],
];

/** Roll the observed modes into the mandate's five classifications. */
export function rollUp(modes) {
  const real = modes.filter((m) => m !== "EMPTY");
  if (real.length === 0) return "MISSING";
  if (real.includes("LIVE")) return "PRODUCTION_FORBIDDEN";
  if (real.every((m) => m === "FAKE" || m === "LOCAL")) return "LOCAL_FAKE_ONLY";
  if (real.every((m) => m === "SANDBOX" || m === "TEST" || m === "STAGING"))
    return "SANDBOX_OR_STAGING_VERIFIED";
  return "CONFIGURED_BUT_UNKNOWN";
}

export function runCensus() {
  const files = ENV_FILES.map(classifyEnvFile);
  const loaded = new Map(ENV_FILES.map((f) => [f, parseEnvFile(resolve(REPO_ROOT, f))]));

  const items = CENSUS_ITEMS.map(([required, gates, vars, fn, configuredIn]) => {
    const observations = [];
    for (const [file, env] of loaded) {
      if (!env) continue;
      for (const v of vars) {
        if (!env.has(v)) continue;
        const raw = env.get(v);
        if (raw === "") {
          observations.push({ file, variable: v, mode: "EMPTY", evidence: "empty" });
          continue;
        }
        const [mode, evidence] = fn(raw);
        observations.push({ file, variable: v, mode, evidence });
      }
    }
    return {
      required,
      gates,
      configuredIn,
      classification: rollUp(observations.map((o) => o.mode)),
      // Deduplicated so the artifact is stable and small; still names every
      // variable/mode pair that was actually observed.
      evidence: [...new Set(observations.map((o) => `${o.variable}[${o.mode}:${o.evidence}]`))].sort(),
      observedInFiles: [...new Set(observations.map((o) => o.file))].sort(),
    };
  });

  const byClassification = {};
  for (const i of items) byClassification[i.classification] = (byClassification[i.classification] ?? 0) + 1;

  return {
    files,
    items,
    metrics: {
      censusItems: items.length,
      byClassification,
      productionBearingEnvFiles: files.filter((f) => f.productionBearing).map((f) => f.file),
      sandboxOrStagingVerified: items.filter((i) => i.classification === "SANDBOX_OR_STAGING_VERIFIED").length,
      unknownCredentialSelections: items.filter((i) => i.classification === "CONFIGURED_BUT_UNKNOWN").length,
    },
  };
}

// ---------------------------------------------------------------------------
// STEP C1 — reclassify what the first census could only call UNKNOWN.
// ---------------------------------------------------------------------------

/**
 * The first census reported 23 items as `CONFIGURED_BUT_UNKNOWN`. That was
 * honest but not actionable: it conflated two different situations, and an
 * owner reading it could not tell which action each row needed.
 *
 * The distinction that resolves them is the one Part B introduced. A Staging
 * deployment reads `STAGING_*` names ONLY, so:
 *
 *   * the STAGING input either exists or it does not — no judgement needed;
 *   * the currently-configured UNPREFIXED value is not a staging candidate at
 *     all. It is production material, or material of indeterminate tenancy
 *     that only the owner can classify.
 *
 * So every row resolves to exactly one of four, and none of them is a guess:
 *
 *   SANDBOX_OR_STAGING_VERIFIED   a STAGING_* input exists and its bounded
 *                                 evidence says sandbox/staging
 *   PRODUCTION_FORBIDDEN          a live marker is present under this name
 *   MISSING                       no STAGING_* input exists
 *   OWNER_CONFIRMATION_REQUIRED   configured, no live marker, tenancy cannot
 *                                 be established from bounded evidence
 *
 * `OWNER_CONFIRMATION_REQUIRED` is deliberately NOT a soft pass. It blocks the
 * preflight exactly as `CONFIGURED_BUT_UNKNOWN` did; it just says who can
 * resolve it.
 */
export function reclassifyForStaging(censusResult = runCensus(), env = process.env) {
  const rows = censusResult.items.map((item) => {
    const stagingName = `STAGING_${item.required.replace(/^STAGING_/, "")}`;
    const stagingValue = env[stagingName] ?? env[item.required];

    if (stagingValue) {
      // A supplied staging input is judged on its own evidence, not on what
      // the repository's env files happen to hold.
      const live =
        /^(sk|rk)_live_/.test(stagingValue) ||
        /^AKIA/.test(stagingValue) ||
        (isRemote(stagingValue) &&
          hostCategory(stagingValue) !== "provider-sandbox-endpoint" &&
          hostCategory(stagingValue) !== "staging-named-host");
      if (live) {
        return { ...item, stagingClassification: "PRODUCTION_FORBIDDEN", stagingEvidence: "supplied staging input carries a live marker" };
      }
      return {
        ...item,
        stagingClassification: "SANDBOX_OR_STAGING_VERIFIED",
        stagingEvidence: `supplied as ${stagingName}`,
      };
    }

    // No staging input. What is configured under the unprefixed name decides
    // whether this is merely absent or actively dangerous.
    if (item.classification === "PRODUCTION_FORBIDDEN") {
      return {
        ...item,
        stagingClassification: "PRODUCTION_FORBIDDEN",
        stagingEvidence: "no staging input; the configured value carries a live provider marker",
      };
    }
    if (item.classification === "MISSING") {
      return { ...item, stagingClassification: "MISSING", stagingEvidence: "not configured anywhere" };
    }
    // CONFIGURED_BUT_UNKNOWN / LOCAL_FAKE_ONLY with no staging input.
    const remoteEvidence = item.evidence.some((e) => e.includes("host:external-host"));
    return {
      ...item,
      stagingClassification: remoteEvidence ? "OWNER_CONFIRMATION_REQUIRED" : "MISSING",
      stagingEvidence: remoteEvidence
        ? "no staging input; the configured value names a remote host whose tenancy cannot be established from bounded evidence"
        : "no staging input; only loopback/local values are configured, which cannot serve a Staging gate",
    };
  });

  const by = {};
  for (const r of rows) by[r.stagingClassification] = (by[r.stagingClassification] ?? 0) + 1;

  return {
    rows,
    metrics: {
      items: rows.length,
      byStagingClassification: by,
      VerifiedStagingCredentials: by.SANDBOX_OR_STAGING_VERIFIED ?? 0,
      ConfiguredButUnknown: 0, // every row is now resolved into one of the four
      ProductionForbiddenSelected: 0, // nothing is SELECTED — see the preflight
      MissingRequiredStagingInputs: (by.MISSING ?? 0) + (by.OWNER_CONFIRMATION_REQUIRED ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// STEP 2 — the preflight.
// ---------------------------------------------------------------------------

/**
 * The eight booleans the mandate requires green before ANY gate runs, computed
 * from a proposed Staging selection rather than from whatever happens to be in
 * `process.env`. `selection` is the env map a Staging run intends to use.
 *
 * `allowlist` is derived, not declared: it is exactly the set of hosts the
 * verified selection names. A destination not named by a verified credential
 * is not reachable, which is what makes "the outbound guard must fail on any
 * known Production destination" true by construction rather than by list
 * maintenance.
 */
/**
 * A mailbox this run controls: a staging/test-named domain, or a disposable
 * inbox service. Anything else is a real audience.
 */
export function isControlledTestMailbox(address) {
  if (!address || typeof address !== "string" || !address.includes("@")) return false;
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return (
    /(^|\.)(staging|stg|test|sandbox)\./.test(domain) ||
    /^(staging|stg|test|sandbox)-/.test(domain) ||
    /(^|\.)(mailhog|mailpit|inbucket)(\.|$)/.test(domain) ||
    /(^|\.)example\.(com|org|net)$/.test(domain)
  );
}

export function preflight(selection, censusResult = runCensus()) {
  const get = (k) => selection?.[k] ?? undefined;
  const marked = (k, pred) => {
    const v = get(k);
    if (v === undefined || v === "") return false;
    try {
      return pred(v);
    } catch {
      return false;
    }
  };

  const checks = {
    ProductionDatabaseSelected:
      marked("DATABASE_URL", isRemote) && hostCategory(get("DATABASE_URL")) !== "staging-named-host",
    ProductionRedisSelected:
      marked("REDIS_URL", isRemote) && hostCategory(get("REDIS_URL")) !== "staging-named-host",
    ProductionStorageSelected:
      (marked("S3_ENDPOINT", isRemote) && hostCategory(get("S3_ENDPOINT")) !== "staging-named-host") ||
      marked("S3_ACCESS_KEY", (v) => /^AKIA/.test(v)) ||
      marked("AWS_ACCESS_KEY_ID", (v) => /^AKIA/.test(v)),
    ProductionPaymentModeSelected:
      marked("STRIPE_SECRET_KEY", (v) => /^(sk|rk)_live_/.test(v)) ||
      marked("PAYPAL_API_BASE", (v) => isRemote(v) && hostCategory(v) !== "provider-sandbox-endpoint"),
    ProductionIdentityTenantSelected:
      marked("SAML_METADATA_URL", isRemote) && hostCategory(get("SAML_METADATA_URL")) !== "staging-named-host",
    // A real transport is only safe when every recipient is a mailbox this run
    // controls. `STAGING_TEST_MAILBOX` is an ADDRESS, not a URL, so it is
    // judged by its domain — the Point-7 email correction is the reason this
    // is checked at all: a send can be "delivered" to somewhere real.
    ProductionEmailAudienceSelected:
      (marked("RESEND_API_KEY", (v) => /^re_/.test(v)) || marked("SMTP_HOST", isRemote)) &&
      get("EMAIL_TRANSPORT") !== "recording" &&
      !isControlledTestMailbox(get("STAGING_TEST_MAILBOX")),
    ProductionWebhookReceiverSelected:
      marked("OPS_ALERT_WEBHOOK_URL", isRemote) &&
      hostCategory(get("OPS_ALERT_WEBHOOK_URL")) !== "staging-named-host",
    UnknownCredentialSelections: censusResult.metrics.unknownCredentialSelections,
    // How many required inputs are actually VERIFIED as sandbox/staging.
    // Reported as a check in its own right so the report shows WHY an empty
    // environment is refused, rather than showing seven silent falses.
    SandboxOrStagingVerified: censusResult.metrics.sandboxOrStagingVerified ?? 0,
  };

  // The derived allowlist: every host a VERIFIED sandbox/staging credential
  // names. Categories only in the report; the raw hosts stay internal.
  const allowlistCategories = [...new Set(
    Object.values(selection ?? {})
      .filter((v) => typeof v === "string" && hostOf(v))
      .map((v) => hostCategory(v)),
  )].sort();

  const green =
    checks.ProductionDatabaseSelected === false &&
    checks.ProductionRedisSelected === false &&
    checks.ProductionStorageSelected === false &&
    checks.ProductionPaymentModeSelected === false &&
    checks.ProductionIdentityTenantSelected === false &&
    checks.ProductionEmailAudienceSelected === false &&
    checks.ProductionWebhookReceiverSelected === false &&
    checks.UnknownCredentialSelections === 0 &&
    // …and a Staging environment must actually EXIST.
    //
    // Every check above is a refusal: it can only turn green OFF. With no env
    // files at all — a clean CI checkout, which is the exact case this gate
    // exists to protect — nothing is selected, every refusal is trivially
    // false, and the preflight reported GREEN for an environment that does not
    // exist. "No production destination was chosen" is not "a staging
    // destination was chosen"; absence must classify as MISSING, never as
    // ready. Requiring at least one VERIFIED sandbox/staging credential makes
    // the empty case deterministic and keeps `--require-green` non-zero until
    // the owner supplies real Staging inputs.
    checks.SandboxOrStagingVerified > 0;

  return { checks, green, allowlistCategories };
}

// Run as a script: emit the census. Imported: expose the functions.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify(runCensus(), null, 2));
}
