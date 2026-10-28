#!/usr/bin/env node
/**
 * SECRETS VALUE-CONSISTENCY CHECK — would restoring Secrets Manager change
 * anything this process is running on?
 *
 *   docker exec proovra-api node scripts/secrets-consistency-check.mjs
 *
 * Run it in the API container: that is the environment it compares against.
 * The worker shares the deployment's env file; its one worker-only key
 * (OTS_BITCOIN_RPC_PASSWORD, a mounted file there) reads ENV_ONLY/ABSENT here.
 *
 * WHY THIS EXISTS (2026-10-28). Production runs `optional` (legacy
 * AWS_SECRETS_ENABLED=true) and every hydration is `access_denied`, so both
 * services serve from the environment. Restoring access is NOT neutral: a
 * hydrated value OUTRANKS the environment for every key read through
 * `getSecret()` — AUTH_JWT_SECRET among them, so a different stored value
 * signs every existing session out on the restart that picks it up. This
 * answers, BEFORE that restart, which keys would change.
 *
 * READ ONLY. One GetSecretValue for the configured secret, compared in memory
 * with this process's environment. It never writes, never mutates the running
 * process's cache (a separate client; the running authority stays suspended),
 * and NEVER prints a value, a fingerprint of a value, an ARN, an account id or
 * an endpoint. Output per key is a category:
 *
 *   MATCH        stored and environment values are identical
 *   DIFFERENT    both present, not identical  ← changes on the next restart
 *   STORE_ONLY   stored, not in the environment ← appears on the next restart
 *   ENV_ONLY     in the environment, not stored (unchanged on restart)
 *   ABSENT       in neither
 *
 * Names are printed only for keys the code reads through the store-first path
 * (the list below, held equal to the source by a contract test). Any other key
 * in the bundle is reported as a COUNT per category, never by name.
 *
 * When the call is refused it prints the bounded classification instead: the
 * error NAME, whether the refusal concerns KMS rather than Secrets Manager, and
 * the credential-chain CATEGORY the SDK resolved from (names of variables, never
 * their values).
 *
 * Exit: 0 = compared, no DIFFERENT and no STORE_ONLY among named keys;
 *       3 = compared, at least one named key would change on restart;
 *       4 = the store could not be read (see classification).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Keys resolved store-first. Equal to MIGRATED_SECRETS + the literal getSecret() reads + the worker's RPC password. */
export const STORE_FIRST_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "AUTH_JWT_SECRET",
  "STRIPE_SECRET_KEY",
  "PAYPAL_SECRET",
  "RESEND_API_KEY",
  "EMAIL_IDEMPOTENCY_SECRET",
  "STRIPE_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_WEBHOOK_ID",
  "TWILIO_API_KEY",
  "TWILIO_API_SECRET",
  "TWILIO_AUTH_TOKEN",
  "API_KEY_SECRET",
  "NOTIFICATION_CRON_SECRET",
  "INTEGRATION_CRON_SECRET",
  "REVIEWER_OPS_CRON_SECRET",
  "AWS_REGION",
  "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
  "AZURE_DOCUMENT_INTELLIGENCE_KEY",
  "DEEPGRAM_API_KEY",
  "OTS_BITCOIN_RPC_PASSWORD",
]);

/**
 * Which link of the SDK's default chain supplies credentials, by the chain's
 * own order. Variable NAMES only.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function credentialChainCategory(env, home = homedir()) {
  const set = (k) => (env[k] ?? "").trim().length > 0;
  if (set("AWS_ACCESS_KEY_ID") && set("AWS_SECRET_ACCESS_KEY")) {
    return set("AWS_SESSION_TOKEN") ? "environment_session_keys" : "environment_static_keys";
  }
  if (set("AWS_PROFILE") || existsSync(join(home, ".aws", "credentials")) || existsSync(join(home, ".aws", "config"))) {
    return "shared_config_file";
  }
  if (set("AWS_WEB_IDENTITY_TOKEN_FILE")) return "web_identity";
  if (set("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") || set("AWS_CONTAINER_CREDENTIALS_FULL_URI")) {
    return "container_endpoint";
  }
  return "instance_metadata_or_none";
}

/**
 * The comparison. Pure — values in, categories out.
 *
 * @param {Record<string, unknown>} stored
 * @param {NodeJS.ProcessEnv} env
 */
export function compareSecretBundle(stored, env) {
  const present = (v) => typeof v === "string" && v.length > 0;
  const category = (key) => {
    const s = stored[key];
    const e = (env[key] ?? "").trim();
    if (present(s) && e.length > 0) return s === e ? "MATCH" : "DIFFERENT";
    if (present(s)) return "STORE_ONLY";
    if (e.length > 0) return "ENV_ONLY";
    return "ABSENT";
  };
  const named = STORE_FIRST_KEYS.map((key) => ({ key, category: category(key) }));
  const otherCounts = { MATCH: 0, DIFFERENT: 0, STORE_ONLY: 0 };
  for (const key of Object.keys(stored)) {
    if (STORE_FIRST_KEYS.includes(key) || !present(stored[key])) continue;
    otherCounts[category(key)] += 1;
  }
  const changesOnRestart = named.some((n) => n.category === "DIFFERENT" || n.category === "STORE_ONLY");
  return { named, otherCounts, changesOnRestart };
}

/** @param {unknown} err */
export function classifyRefusal(err) {
  const e = /** @type {{ name?: unknown, message?: unknown }} */ (err ?? {});
  const name = String(e.name ?? "Error").replace(/[^A-Za-z]/g, "").slice(0, 64);
  const message = String(e.message ?? "");
  // The KIND of principal AWS named — never the ARN or the account.
  const principalKind = /:assumed-role\//.test(message)
    ? "assumed_role"
    : /:user\//.test(message)
      ? "iam_user"
      : /:root\b/.test(message)
        ? "root"
        : "not_stated";
  return {
    errorName: name,
    concernsKms: /\bkms\b|kms:Decrypt|KMS key/i.test(message),
    concernsGetSecretValue: /secretsmanager:GetSecretValue/i.test(message),
    explicitDeny: /explicit deny/i.test(message),
    principalKind,
  };
}

async function main() {
  const secretName = (process.env.AWS_SECRET_NAME ?? "").trim() || "proovra/prod/app-secrets";
  const region =
    (process.env.AWS_SECRETS_REGION ?? "").trim() || (process.env.AWS_REGION ?? "").trim() || "us-east-1";
  const mode = (process.env.AWS_SECRETS_MODE ?? "").trim().toLowerCase() ||
    ((process.env.AWS_SECRETS_ENABLED ?? "").trim().toLowerCase() === "true" ? "optional (legacy AWS_SECRETS_ENABLED)" : "disabled");
  console.log(`declared mode:        ${mode}`);
  console.log(`secret / region:      ${secretName} / ${region}`);
  console.log(`credential category:  ${credentialChainCategory(process.env)}`);

  let secretString;
  try {
    const { GetSecretValueCommand, SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
    const client = new SecretsManagerClient({ region, maxAttempts: 2 });
    secretString = (await client.send(new GetSecretValueCommand({ SecretId: secretName }))).SecretString ?? null;
  } catch (err) {
    const r = classifyRefusal(err);
    console.log(`store read:           REFUSED ${r.errorName}`);
    console.log(`  concerns KMS:                  ${r.concernsKms}`);
    console.log(`  names GetSecretValue:          ${r.concernsGetSecretValue}`);
    console.log(`  explicit deny:                 ${r.explicitDeny}`);
    console.log(`  principal kind:                ${r.principalKind}`);
    process.exit(4);
  }
  let stored;
  try {
    stored = JSON.parse(secretString ?? "");
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    console.log("store read:           OK, but the payload is not a JSON object (decode) — nothing compared");
    process.exit(4);
  }
  const result = compareSecretBundle(stored, process.env);
  console.log("store read:           OK");
  for (const { key, category } of result.named) console.log(`  ${key.padEnd(38)} ${category}`);
  console.log(
    `  other stored keys:                     MATCH=${result.otherCounts.MATCH} DIFFERENT=${result.otherCounts.DIFFERENT} STORE_ONLY=${result.otherCounts.STORE_ONLY}`,
  );
  console.log(
    result.changesOnRestart
      ? "VERDICT: a restart with access restored WOULD change named values (DIFFERENT / STORE_ONLY above)."
      : "VERDICT: a restart with access restored would not change any named value.",
  );
  process.exit(result.changesOnRestart ? 3 : 0);
}

if (process.argv[1]?.endsWith("secrets-consistency-check.mjs")) {
  await main();
}
