#!/usr/bin/env node
/**
 * READ-ONLY check of the AWS Secrets Manager authority, run INSIDE the API or
 * worker container (it uses that container's credentials and settings):
 *
 *   docker exec -i <container> node - < /opt/proovra/app/scripts/ops/secrets-authority-check.cjs
 *
 * Prints the mode, region, secret id, the outcome (ok / access_denied /
 * not_found / network / unknown, plus the AWS error NAME), the number of keys,
 * and for each secret the services read: whether AWS holds it, whether the
 * environment holds it, and whether the two agree. Never a value, never a key
 * that is not on the list below (secrets-authority.ts logs only a count).
 * One GetSecretValue call; nothing is written anywhere.
 */
const { createRequire } = require("node:module");

const DEPENDENCIES = [
  "AUTH_JWT_SECRET", "OPENAI_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PAYPAL_SECRET",
  "PAYPAL_CLIENT_ID", "PAYPAL_WEBHOOK_ID", "RESEND_API_KEY", "EMAIL_IDEMPOTENCY_SECRET", "DEEPGRAM_API_KEY",
  "AZURE_DOCUMENT_INTELLIGENCE_KEY", "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT", "OTS_BITCOIN_RPC_PASSWORD",
];

function loadSdk() {
  for (const base of ["/app/packages/shared-runtime/", "/app/services/api/", "/app/services/worker/", "/app/", `${process.cwd()}/`]) {
    try {
      return createRequire(base)("@aws-sdk/client-secrets-manager");
    } catch {
      /* try the next workspace */
    }
  }
  return null;
}

(async () => {
  const legacy = (process.env.AWS_SECRETS_ENABLED ?? "").trim().toLowerCase();
  const mode = (process.env.AWS_SECRETS_MODE ?? "").trim().toLowerCase() || (legacy === "true" ? "optional (legacy AWS_SECRETS_ENABLED=true)" : "disabled");
  const region = (process.env.AWS_SECRETS_REGION ?? "").trim() || (process.env.AWS_REGION ?? "").trim() || "us-east-1";
  const secretId = (process.env.AWS_SECRET_NAME ?? "").trim() || "proovra/prod/app-secrets";
  console.log(`mode=${mode} region=${region} secret_id=${secretId} credentials=${process.env.AWS_ACCESS_KEY_ID ? "env key" : "default chain"}`);
  const sdk = loadSdk();
  if (!sdk) {
    console.log("outcome=unknown sdk=missing");
    process.exit(2);
  }
  let values = null;
  try {
    const res = await new sdk.SecretsManagerClient({ region }).send(new sdk.GetSecretValueCommand({ SecretId: secretId }));
    const parsed = JSON.parse(res.SecretString ?? "");
    values = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    console.log(values ? `outcome=ok key_count=${Object.keys(values).length}` : "outcome=unknown reason=not_a_json_object");
  } catch (err) {
    const name = String((err && (err.name || err.Code || err.code)) || "Error").slice(0, 60);
    const lower = name.toLowerCase();
    const code = lower.includes("accessdenied") || lower.includes("unauthorized") ? "access_denied" : lower.includes("notfound") ? "not_found" : lower.includes("network") || lower.includes("timeout") || lower.includes("econn") ? "network" : "unknown";
    console.log(`outcome=${code} aws_error=${name}`);
  }
  for (const k of DEPENDENCIES) {
    const inAws = Boolean(values && typeof values[k] === "string" && values[k].length > 0);
    const env = (process.env[k] ?? "").trim();
    const agree = inAws && env ? String(values[k]) === env : null;
    console.log(`${k}: aws=${values ? (inAws ? "present" : "absent") : "unreadable"} env=${env ? "present" : "absent"}${agree === null ? "" : ` agree=${agree}`}`);
  }
})().catch((e) => {
  console.log(`outcome=unknown error=${String((e && e.name) || "Error").slice(0, 60)}`);
  process.exit(1);
});
