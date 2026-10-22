/**
 * TEST-STACK ISOLATION — a process that runs automated tests must not be able
 * to reach a live external service, whatever its environment happens to hold.
 *
 * INCIDENT (2026-10-22). A local mirror of the `playwright-e2e` stack started
 * `services/api` from the repository. `services/api/src/env.ts` loads the
 * repo-root `.env`, which on a developer machine holds LIVE credentials, and it
 * fills every variable the stack had not set. The stack set the database,
 * storage and PayPal to local values but said nothing about email, so the API
 * inherited the real `RESEND_API_KEY`; `EMAIL_TRANSPORT` was unset, which meant
 * "resend"; and every E2E registration sent a real verification email to an
 * `@example.test` address through PROOVRA's Resend account. It also made live
 * RFC 3161 timestamp calls and asked AWS Secrets Manager for production secrets
 * (refused). CI was safe only because its checkout has no `.env`.
 *
 * Safety by omission is not safety. This module states ONE fact — "this
 * process is an isolated test stack" — from markers only a test stack carries,
 * and the egress points read it and fail closed:
 *
 *   - `.env` files are not loaded (services/api env.ts, services/worker env-loader)
 *   - email can only go to the recording provider (email-transport)
 *   - AWS Secrets Manager is never contacted (secrets-authority)
 *   - the API reports the facts on /health so an E2E run can refuse to start
 *
 * MARKERS (any one is sufficient):
 *   - `E2E_AUTH_BYPASS_SECRET` set — an authentication bypass exists only in a
 *     test stack; a deployed process carrying it is already a deployment-safety
 *     violation (ops/deployment-safety.ts), and refusing live email is the
 *     safer way for that violation to fail.
 *   - `PROOVRA_TEST_STACK` = 1 / true / yes — the explicit declaration.
 *   - `PROOVRA_ENV` (or APP_ENV / DEPLOY_ENV) DECLARING `test`.
 *
 * NOT a marker: `NODE_ENV=test` on its own. Unit-test processes are already
 * sealed by their own bootstrap (scrubbed environment, recording transports,
 * a process-level outbound guard) and some of them deliberately exercise the
 * live code paths against stubs; this lock is for long-running stack processes.
 */
import { resolveDeploymentEnvironment } from "./deployment-environment.js";

type Env = Record<string, string | undefined>;

export type TestStackIsolation = {
  isolated: boolean;
  /** Which markers were found — variable NAMES only, never values. */
  reasons: string[];
};

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

export function resolveTestStackIsolation(env: Env = process.env): TestStackIsolation {
  const reasons: string[] = [];
  if ((env.E2E_AUTH_BYPASS_SECRET ?? "").trim().length > 0) reasons.push("E2E_AUTH_BYPASS_SECRET");
  if (truthy(env.PROOVRA_TEST_STACK)) reasons.push("PROOVRA_TEST_STACK");
  const d = resolveDeploymentEnvironment(env);
  if (d.basis === "DECLARED" && d.kind === "test") reasons.push("PROOVRA_ENV=test");
  return { isolated: reasons.length > 0, reasons };
}

/**
 * Credentials for services a test stack must never reach. Their PRESENCE in an
 * isolated stack is reported (names only) so a run can refuse to start; the
 * egress points above fail closed whether or not they are present.
 */
export const LIVE_SERVICE_CREDENTIALS = [
  "RESEND_API_KEY",
  "TSA_URL",
  "TSA_USERNAME",
  "TSA_PASSWORD",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY",
  "TWILIO_API_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SENTRY_DSN",
  "OPS_ALERT_WEBHOOK_URL",
  "GOOGLE_CLIENT_SECRET",
  "APPLE_PRIVATE_KEY",
] as const;

/**
 * Entries above that are ENDPOINTS, not secrets. An endpoint is live only if it
 * leaves the stack: the updated-report journey runs a local openssl TSA at
 * `http://tsa:8318/` on purpose, and reporting that as a live credential made
 * the preflight refuse a stack that could reach nothing.
 */
const LIVE_SERVICE_ENDPOINTS: ReadonlySet<string> = new Set(["TSA_URL", "OPS_ALERT_WEBHOOK_URL"]);

/**
 * True only for a URL whose host cannot be a public service: loopback,
 * `*.localhost`, the reserved `*.test` TLD, or a single-label name (a container
 * on the stack's own network — every public service has a dotted name).
 * Anything unparseable is NOT local: fail closed.
 */
export function isStackLocalEndpoint(value: string): boolean {
  let host: string;
  try {
    host = new URL(value.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".test")) return true;
  if (host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return /^[a-z0-9-]+$/.test(host) && !/^\d+$/.test(host);
}

/** Names of live-service credentials present (non-empty) in `env`. Never values. */
export function presentLiveCredentialNames(env: Env = process.env): string[] {
  return LIVE_SERVICE_CREDENTIALS.filter((name) => {
    const value = (env[name] ?? "").trim();
    if (value.length === 0) return false;
    return !(LIVE_SERVICE_ENDPOINTS.has(name) && isStackLocalEndpoint(value));
  });
}

/**
 * The variables that can make a process send LIVE email: the key itself, and
 * everything that decides whether an unset transport means "resend".
 */
export const LIVE_EMAIL_DECIDING_KEYS = [
  "RESEND_API_KEY",
  "EMAIL_TRANSPORT",
  "NODE_ENV",
  "PROOVRA_ENV",
  "APP_ENV",
  "DEPLOY_ENV",
] as const;

/**
 * A `.env` FILE NEVER TURNS LIVE EMAIL ON.
 *
 * Deployed processes receive their configuration as real environment
 * variables (docker-compose `env_file:` injects them; the images carry no
 * `.env`), so the API and worker loaders read no file in production. A file is
 * how a DEVELOPER machine is configured — and on this one the repo-root `.env`
 * carries `NODE_ENV=production` beside a live Resend key, so any unmarked
 * process started from the repository root would classify itself as a
 * production deployment and email real people.
 *
 * Called by the loaders after they fill `env` from files: when any variable in
 * LIVE_EMAIL_DECIDING_KEYS came from a file, the transport is pinned to the
 * recorder — unless the REAL environment (captured before any file was read)
 * explicitly asked for `resend`. Returns the reason (variable names only), or
 * null when nothing was refused.
 */
export function refuseFileSourcedLiveEmail(
  env: Env,
  filledFromFiles: ReadonlySet<string>,
  realEmailTransport: string | undefined,
): string | null {
  const fromFiles = LIVE_EMAIL_DECIDING_KEYS.filter((name) => filledFromFiles.has(name));
  if (fromFiles.length === 0) return null;
  if ((realEmailTransport ?? "").trim().toLowerCase() === "resend") return null;
  env.EMAIL_TRANSPORT = "recording";
  return `${fromFiles.join(", ")} came from a .env file`;
}
