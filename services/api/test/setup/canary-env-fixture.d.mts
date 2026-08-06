/**
 * Types for the isolation canary's self-contained hostile environment.
 *
 * The implementation is `.mjs` because the canary runs as a plain Node script
 * before any TypeScript tooling is loaded — it gates the test runner, so it
 * cannot depend on it. This declaration lets the vitest suites assert on the
 * same module without either side importing an untyped `any`.
 */

/** Production-SHAPED values that must never survive into a test process. */
export declare const SENTINEL: Readonly<Record<string, string>>;

/** The hosts a sentinel names. Reaching any of them is a failure. */
export declare const SENTINEL_HOSTS: readonly string[];

/** The prefix every fixture directory carries, so leaks are identifiable. */
export declare const FIXTURE_PREFIX: string;

/**
 * The synthetic sentinels ALWAYS, plus any real deployment value they do not
 * already cover.
 */
export declare function hostileEnvironment(
  realDeploymentEnv?: Record<string, string | undefined>,
): Record<string, string>;

/** Does the hostile environment actually contain something worth resisting? */
export declare function hostilePremiseHolds(
  env: Record<string, string | undefined>,
): boolean;

/**
 * Run `fn` with a throwaway directory containing a synthetic `.env` FILE.
 * The directory is removed on both the success and the failure path.
 */
export declare function withEnvFileFixture<T>(fn: (dir: string) => T): T;
