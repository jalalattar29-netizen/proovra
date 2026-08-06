/**
 * PHASE 12 — POINT 8 PART C: the Staging credential preflight, as a command.
 *
 * The mandate forbids running any live gate until the preflight is green, so it
 * has to be a step a deployment can FAIL on, not a document. This wraps the
 * Point-8 census/preflight so `deploy-staging.yml` can gate on it.
 *
 * It reads `STAGING_*` variables from the environment the workflow's `staging`
 * GitHub environment supplies, and it never prints a value — only the eight
 * booleans and a count.
 *
 * Exit codes:
 *   0  preflight green
 *   9  preflight not green (with --require-green)
 *  10  a required staging input is missing
 */
import { preflight } from "../test/point8/staging-census.mjs";

/**
 * The variables a Staging deployment must supply. Names only — a missing one is
 * reported by NAME so the owner knows what to add, and a present one is never
 * echoed.
 */
export const REQUIRED_STAGING_INPUTS = [
  "STAGING_DATABASE_URL",
  "STAGING_REDIS_URL",
  "STAGING_S3_ENDPOINT",
  "STAGING_S3_BUCKET",
  "STAGING_S3_ACCESS_KEY",
  "STAGING_S3_SECRET_KEY",
  "STAGING_STRIPE_SECRET_KEY",
  "STAGING_PAYPAL_API_BASE",
  "STAGING_EMAIL_TRANSPORT",
  "STAGING_TEST_MAILBOX",
  "STAGING_WEBHOOK_RECEIVER",
];

/**
 * Map the STAGING_-prefixed inputs onto the names the preflight reasons about.
 * The prefix is the whole point: a staging deployment can never accidentally
 * resolve `DATABASE_URL` from an ambient production environment, because it
 * does not look at that name.
 */
export function selectionFromEnv(env = process.env) {
  const out = {};
  for (const name of REQUIRED_STAGING_INPUTS) {
    const v = env[name];
    if (v === undefined || v === "") continue;
    out[name.replace(/^STAGING_/, "")] = v;
  }
  // The preflight judges the email audience by transport and mailbox.
  if (env.STAGING_EMAIL_TRANSPORT) out.EMAIL_TRANSPORT = env.STAGING_EMAIL_TRANSPORT;
  if (env.STAGING_TEST_MAILBOX) out.STAGING_TEST_MAILBOX = env.STAGING_TEST_MAILBOX;
  if (env.STAGING_WEBHOOK_RECEIVER) out.OPS_ALERT_WEBHOOK_URL = env.STAGING_WEBHOOK_RECEIVER;
  return out;
}

export function runPreflight(env = process.env) {
  const missing = REQUIRED_STAGING_INPUTS.filter((n) => !env[n]);
  const selection = selectionFromEnv(env);
  // Unknown-credential counting is about the SUPPLIED selection, not about the
  // developer machine's env files, so an empty census is passed deliberately.
  //
  // `sandboxOrStagingVerified` is the count of required STAGING_* inputs the
  // operator actually supplied. That — never the machine's env files — is this
  // command's evidence that a Staging environment exists at all, and it is what
  // stops an empty environment from satisfying a preflight built out of
  // refusals: with nothing supplied there is nothing to refuse, and "green"
  // would otherwise mean "we looked at nothing and found nothing wrong".
  const result = preflight(selection, {
    metrics: {
      unknownCredentialSelections: missing.length,
      sandboxOrStagingVerified: REQUIRED_STAGING_INPUTS.length - missing.length,
    },
  });
  return { missing, checks: result.checks, green: result.green && missing.length === 0 };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const r = runPreflight();
  // Names and booleans only.
  console.log(JSON.stringify({ checks: r.checks, missing: r.missing, green: r.green }, null, 2));
  if (r.missing.length > 0) {
    console.error(`staging preflight: ${r.missing.length} required input(s) absent: ${r.missing.join(", ")}`);
    if (process.argv.includes("--require-green")) process.exit(10);
  }
  if (!r.green && process.argv.includes("--require-green")) {
    console.error("staging preflight is NOT green — refusing to deploy.");
    process.exit(9);
  }
}
