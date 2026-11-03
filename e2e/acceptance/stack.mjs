#!/usr/bin/env node
/**
 * THE FRESH-ENTERPRISE ACCEPTANCE STACK.
 *
 * One isolated stack for e2e/acceptance. Every process gets its environment from
 * the repository's allowlist builder (scripts/local-fixture-env), so nothing is
 * inherited and no .env file is read. Containers, ports, volumes and database are
 * dedicated: this never shares anything with another local stack.
 *
 *   node e2e/acceptance/stack.mjs infra-up | infra-down
 *   node e2e/acceptance/stack.mjs migrate | seed-operator
 *   node e2e/acceptance/stack.mjs build | web-build
 *   node e2e/acceptance/stack.mjs api | worker | web
 *   node e2e/acceptance/stack.mjs isolation      (exit 1 unless /health proves it)
 *
 * production-controls.json holds production's non-secret controls (flags and
 * limits only), so the fixture is not silently a smaller product. It never holds
 * an endpoint or a credential, and the builder scans the final environment anyway.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const { buildLocalFixtureEnv, describeLocalFixtureEnv } = await import(
  pathToFileURL(resolve(ROOT, "scripts/local-fixture-env/index.mjs")).href
);

const PORTS = { api: "8391", web: "3511", postgres: "55733", redis: "56679", minio: "59300" };
const DB_NAME = "proovra_acceptance_fixture";
const BUCKET = "proovra-acceptance-fixture";
const MINIO_USER = "fixture-local-only";
const MINIO_SECRET = "fixture-local-only-secret";
const CRON = "fixture-local-only-acceptance-cron-secret-00000000";
const C = { postgres: "acc-postgres", redis: "acc-redis", minio: "acc-minio" };
const MINIO_IMAGE = "pgsty/minio:RELEASE.2026-08-04T00-00-00Z";

const controls = JSON.parse(readFileSync(resolve(HERE, "production-controls.json"), "utf8"));

const env = buildLocalFixtureEnv({
  apiPort: PORTS.api,
  webPort: PORTS.web,
  databaseUrl: `postgresql://pv:pv@localhost:${PORTS.postgres}/${DB_NAME}`,
  redisUrl: `redis://localhost:${PORTS.redis}/0`,
  extra: {
    ...controls,
    PROOVRA_TEST_STACK: "1",
    DESTRUCTION_EXECUTION_ENABLED: "true",
    OPENAI_AI_ENABLED: "false",
    IMMUTABLE_STORAGE_RECONCILIATION_ENABLED: "false",
    IMMUTABLE_STORAGE_DRIFT_ALERTS_ENABLED: "false",
    ADAPTIVE_AUTH_ENABLED: "true",
    ADAPTIVE_AUTH_RUNTIME_ENABLED: "true",
    SAML_ENABLED: "true",
    SAML_TEST_MODE_ENABLED: "false",
    SAML_REQUIRE_SIGNED_ASSERTIONS: "true",
    SSO_ALLOWED_REDIRECT_HOSTS: "localhost",
    COMMUNICATIONS_ENABLED: "true",
    EVIDENCE_REQUESTS_ENABLED: "true",
    INTEGRATIONS_ENABLED: "true",
    REVIEWER_OPS_CRON_SECRET: CRON,
    INTERNAL_API_KEY: CRON,
    INTEGRATION_CRON_SECRET: CRON,
    NOTIFICATION_CRON_SECRET: CRON,
    IDENTITY_SECURITY_CRON_SECRET: CRON,
    IDENTITY_RECONCILE_CRON_SECRET: CRON,
    COMMUNICATIONS_WEBHOOK_SECRET: CRON,
    S3_ENDPOINT: `http://localhost:${PORTS.minio}`,
    S3_PUBLIC_BASE_URL: "",
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY: MINIO_USER,
    S3_SECRET_KEY: MINIO_SECRET,
    S3_OBJECT_LOCK_ENABLED: "true",
    S3_OBJECT_LOCK_MODE: "COMPLIANCE",
    S3_OBJECT_LOCK_RETAIN_DAYS: "1",
    PUPPETEER_EXECUTABLE_PATH: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED: "true",
    NEXT_PUBLIC_STORAGE_ORIGIN: `http://localhost:${PORTS.minio}`,
    // Capacity profiling attributes statements to one route at a time. The API's
    // in-process sweeps share its pool, so they are measured on their own instead.
    ...(process.env.ACCEPTANCE_QUIET_SWEEPS === "1"
      ? {
          OPERATIONS_RECONCILER_ENABLED: "false",
          BILLING_ADDON_RETRY_ENABLED: "false",
          BILLING_RECONCILER_ENABLED: "false",
          PLATFORM_MAINTENANCE_RECONCILER_ENABLED: "false",
        }
      : {}),
  },
});

const WEB_ENV = {
  ...env,
  NODE_ENV: "production",
  NEXT_DIST_DIR: "node_modules/.cache/acceptance-next-prod",
  NEXT_STANDALONE: "false",
  CSP_RELAXED: "false",
};

function run(cwd, command, args, childEnv = env) {
  const c = spawn(command, args, { cwd, shell: true, stdio: "inherit", env: childEnv });
  c.on("exit", (code) => process.exit(code ?? 0));
}

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function infraUp() {
  docker("run", "-d", "--name", C.postgres, "-p", `127.0.0.1:${PORTS.postgres}:5432`,
    "-e", "POSTGRES_USER=pv", "-e", "POSTGRES_PASSWORD=pv", "-e", `POSTGRES_DB=${DB_NAME}`, "pgvector/pgvector:pg16");
  docker("run", "-d", "--name", C.redis, "-p", `127.0.0.1:${PORTS.redis}:6379`, "redis:7-alpine");
  docker("run", "-d", "--name", C.minio, "-p", `127.0.0.1:${PORTS.minio}:9000`,
    "-e", `MINIO_ROOT_USER=${MINIO_USER}`, "-e", `MINIO_ROOT_PASSWORD=${MINIO_SECRET}`,
    MINIO_IMAGE, "server", "/data");
  for (let i = 0; i < 40; i += 1) {
    try {
      docker("run", "--rm", "--network", `container:${C.minio}`, "--entrypoint", "sh",
        "pgsty/mc:RELEASE.2026-09-16T00-00-00Z", "-c",
        `mc alias set loc http://127.0.0.1:9000 ${MINIO_USER} ${MINIO_SECRET} >/dev/null && mc mb --with-lock --ignore-existing loc/${BUCKET}`);
      console.log(`bucket ${BUCKET} ready (object lock on)`);
      return;
    } catch {
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1500)"]);
    }
  }
  throw new Error("minio bucket could not be created");
}

function infraDown() {
  for (const name of Object.values(C)) {
    try { docker("rm", "-f", "-v", name); } catch { /* already gone */ }
  }
}

async function isolation() {
  const h = await (await fetch(`http://localhost:${PORTS.api}/health`)).json();
  console.log(JSON.stringify(h.isolation, null, 2));
  const clean = (f) =>
    f?.isolated === true &&
    f.emailTransport === "recording" &&
    f.envFilesLoaded === 0 &&
    (f.liveCredentialNames ?? []).length === 0;
  const workers = h.isolation?.workers ?? [];
  if (!clean(h.isolation) || workers.length === 0 || !workers.every((w) => clean(w.isolation))) {
    console.error("NOT ISOLATED");
    process.exit(1);
  }
  console.log("isolation proven for the API and every live worker");
}

mkdirSync(resolve(ROOT, ".p7tmp"), { recursive: true });
const api = resolve(ROOT, "services/api");
const worker = resolve(ROOT, "services/worker");
const web = resolve(ROOT, "apps/web");
const cmd = process.argv[2];
switch (cmd) {
  case "describe": console.log(describeLocalFixtureEnv(env)); break;
  case "infra-up": infraUp(); break;
  case "infra-down": infraDown(); break;
  case "isolation": await isolation(); break;
  case "migrate": run(api, "npx", ["prisma", "migrate", "deploy"]); break;
  case "seed-operator": run(api, "npx", ["tsx", "scripts/seed-admin-fixture.ts"]); break;
  case "tsx": run(api, "npx", ["tsx", ...process.argv.slice(3)]); break;
  // tsc directly: the packages' prebuild regenerates Prisma, which fails while a process holds the client.
  case "build-api": run(api, "npx", ["tsc", "-p", "tsconfig.build.json"]); break;
  case "build-worker": run(worker, "npx", ["tsc", "-p", "tsconfig.build.json", "&&", "node", "./scripts/copy-assets.mjs"]); break;
  case "api": run(api, "node", ["--experimental-specifier-resolution=node", "dist/index.js"]); break;
  case "worker": run(worker, "node", ["--experimental-specifier-resolution=node", "dist/index.js"]); break;
  case "web-build": run(web, "npx", ["next", "build"], WEB_ENV); break;
  case "web": run(web, "npx", ["next", "start", "-p", PORTS.web], WEB_ENV); break;
  default:
    console.error("unknown command");
    process.exit(2);
}
