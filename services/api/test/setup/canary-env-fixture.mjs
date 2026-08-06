/**
 * PHASE 12 — POINT 7: the canary's SELF-CONTAINED hostile environment.
 *
 * The isolation canary used to build its hostile environment solely out of the
 * operator's real `services/api/.env`. That made its first check assert two
 * different things at once: "this machine happens to have a live `.env`" AND
 * "an `.env` cannot override the safe test environment". Only the second is a
 * security property. On a clean checkout — CI, and the release artifact — the
 * first is false, so the check failed while nothing was wrong, and checks 2-12
 * quietly ran against a blank slate: passing because nothing hostile was left
 * to resist, which is the weakest possible reading of a canary.
 *
 * This module makes the hostile environment a property of the CANARY. It lives
 * apart from the canary script so the canary can use it and tests can assert on
 * it without executing twelve child processes — one authority, two readers.
 *
 * Every value here is fake and every host is unroutable by construction
 * (RFC 2606 `.invalid`, or a Sentry-shaped DSN whose ids are all zeros).
 * Nothing here is a credential, and nothing here is ever printed: the checks
 * report only whether a sentinel SURVIVED, never what it was.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Production-SHAPED values that must never survive into a test process. */
export const SENTINEL = Object.freeze({
  SENTRY_DSN: "https://00000000000000000000000000000000@o0.ingest.sentry.io/0",
  REDIS_URL: "rediss://canary:canary@redis.canary-fixture.invalid:6379",
  DATABASE_URL: "postgresql://canary:canary@db.canary-fixture.invalid:5432/prod",
  DIRECT_URL: "postgresql://canary:canary@db.canary-fixture.invalid:5432/prod",
  S3_ENDPOINT: "https://storage.canary-fixture.invalid",
  S3_BUCKET: "canary-production-bucket",
  // AWS's own documented example key id. Still AKIA-shaped, so it exercises
  // the same scrubbing path, but every credential scanner already classifies
  // this exact literal as an example rather than raising it forever.
  S3_ACCESS_KEY: "AKIAIOSFODNN7EXAMPLE",
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  SENTRY_ENABLED: "true",
  NODE_ENV: "production",
});

/** The hosts a sentinel names. Reaching any of them is a failure. */
export const SENTINEL_HOSTS = Object.freeze([
  "redis.canary-fixture.invalid",
  "db.canary-fixture.invalid",
  "storage.canary-fixture.invalid",
  "o0.ingest.sentry.io",
]);

/** The prefix every fixture directory carries, so leaks are identifiable. */
export const FIXTURE_PREFIX = "p7-canary-env-";

/**
 * The environment a probe is started with: the synthetic sentinels ALWAYS, plus
 * any real deployment value the sentinels do not already cover. A machine with
 * a real `.env` is therefore at least as hostile as before; a machine without
 * one is now hostile at all.
 */
export function hostileEnvironment(realDeploymentEnv = {}) {
  return { ...realDeploymentEnv, ...SENTINEL };
}

/**
 * Does the hostile environment actually contain something worth resisting?
 *
 * Asserted rather than assumed: if this were ever false the canary would be
 * vacuous, and a vacuous canary reports PASS for a machine it never tested.
 */
export function hostilePremiseHolds(env) {
  const dsn = env?.SENTRY_DSN;
  const redis = env?.REDIS_URL;
  return (
    typeof dsn === "string" &&
    dsn.includes("sentry.io") &&
    typeof redis === "string" &&
    /rediss?:\/\/(?!127\.0\.0\.1|localhost)/.test(redis)
  );
}

/**
 * Run `fn` with a throwaway directory containing a synthetic `.env` FILE.
 *
 * Environment variables alone would not prove the property: `dotenv/config`
 * reads a FILE from the working directory, so the file is the thing that has to
 * be shown to be inert. It is written somewhere disposable rather than over
 * `services/api/.env`, which must never be touched or read for this purpose.
 *
 * The directory is removed on BOTH paths — a fixture that survives a failure is
 * a fixture that quietly changes the next run.
 */
export function withEnvFileFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  try {
    writeFileSync(
      join(dir, ".env"),
      `${Object.entries(SENTINEL)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
      "utf8",
    );
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
