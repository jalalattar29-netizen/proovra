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
