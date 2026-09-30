/**
 * Types for the pure, exported helpers of the UC-1 Windows acceptance harness
 * that the regression test imports. The harness itself is plain ESM (.mjs); only
 * these two helpers are consumed as typed API.
 */
export interface Uc1ServiceChildSpec {
  name: string;
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

export function planServiceChildren(input: {
  fixtureEnv: Record<string, string>;
  config: {
    apiPort: string;
    webPort: string;
    fixturePort: string;
    skipWeb: boolean;
  };
}): Uc1ServiceChildSpec[];

export function s3FixtureOverrides(config: {
  s3Endpoint: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
}): Record<string, string>;

/** UC-TQ-007 — the fixture-environment options the acceptance stack boots with. */
export function acceptanceFixtureEnvOptions(
  config: {
    apiPort: string;
    webPort: string;
    dbUrl: string;
    redisUrl: string;
    s3Endpoint: string;
    s3Bucket: string;
    s3AccessKey: string;
    s3SecretKey: string;
  },
  opts: { chromiumPath: string },
): {
  apiPort: string;
  webPort: string;
  databaseUrl: string;
  redisUrl: string;
  extra: Record<string, string>;
  redirectAllowLists: Record<string, string[]>;
};

/** Every TCP port the acceptance stack listens on. */
export function acceptancePorts(config: {
  apiPort: string;
  webPort: string;
  fixturePort: string;
  skipWeb: boolean;
}): number[];
