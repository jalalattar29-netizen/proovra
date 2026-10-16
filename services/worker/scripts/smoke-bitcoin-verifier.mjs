/**
 * IN-IMAGE smoke of the independent Bitcoin verifier's wiring (run by
 * scripts/release/smoke-worker-bitcoin-verifier.mjs inside the production
 * worker image). It resolves the verifier configuration exactly as the worker
 * does — the OTS_BITCOIN_* environment plus the password from the mounted
 * file — and runs ONE readiness probe against the configured node.
 *
 * Prints one JSON line: the configuration kind, its operator-safe description
 * and the readiness. Never the password, never a URL with credentials.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(join(here, "..", "dist", p)).href;

// The worker's config validates these at import; nothing here touches a
// database, queue or bucket, so unset values get inert placeholders. The
// Object Lock contract is stated because the image runs as production.
const INERT_CONFIG = {
  DATABASE_URL: "postgresql://smoke:smoke@127.0.0.1:1/smoke",
  REDIS_URL: "redis://127.0.0.1:1",
  S3_ENDPOINT: "http://127.0.0.1:1",
  S3_ACCESS_KEY: "smoke",
  S3_SECRET_KEY: "smoke",
  S3_BUCKET: "smoke",
  S3_OBJECT_LOCK_ENABLED: "true",
  S3_OBJECT_LOCK_MODE: "COMPLIANCE",
  S3_OBJECT_LOCK_RETAIN_DAYS: "2920",
};
for (const [k, v] of Object.entries(INERT_CONFIG)) process.env[k] ||= v;

const { resolveOtsBitcoinVerifierConfig, describeOtsBitcoinVerifierConfig } = await import(dist("ots-bitcoin-config.js"));
const { probeOtsBitcoinVerifierReadiness } = await import(dist("ots-bitcoin-verifier.js"));

const config = resolveOtsBitcoinVerifierConfig();
const readiness = await probeOtsBitcoinVerifierReadiness({ config });
console.log(
  JSON.stringify({
    nodeEnv: process.env.NODE_ENV ?? null,
    configKind: config.kind,
    config: describeOtsBitcoinVerifierConfig(config),
    passwordFile: config.kind === "enabled" ? config.passwordFile : null,
    passwordFromEnvironmentAllowed: config.kind === "enabled" ? config.passwordFromEnvironmentAllowed : null,
    passwordVariablePresent: typeof process.env.OTS_BITCOIN_RPC_PASSWORD === "string",
    readiness: { enabled: readiness.enabled, ready: readiness.ready, code: readiness.code, chain: readiness.chain, tipHeight: readiness.tipHeight },
  }),
);
