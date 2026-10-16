/**
 * The independent Bitcoin verifier is WORKER code; the API must never receive
 * its configuration or credentials.
 *
 * docker-compose.prod.yml once listed every OTS_BITCOIN_* variable under
 * proovra-api (the comment above them even said "the API never receives
 * these"), and both services load the shared /opt/proovra/app/.env through
 * env_file — which injects every key of that file into the container. So the
 * compose fix alone is not enough: a verifier key left in the shared .env still
 * reaches the API. In production the API refuses to start when one does,
 * naming the variable and never its value.
 */
import { afterEach, describe, expect, it } from "vitest";

import { collectStartupViolations } from "../src/config/index.js";

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

function bitcoinViolations(env: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL, ...env };
  for (const k of Object.keys(process.env)) if (/^OTS_BITCOIN_/.test(k) && !(k in env)) delete process.env[k];
  return collectStartupViolations().filter((v) => v.reason === "worker_only_bitcoin_verifier_config");
}

describe("the API refuses worker-only Bitcoin verifier configuration in production", () => {
  it("every OTS_BITCOIN_* variable that reaches the API is a violation, by name", () => {
    const v = bitcoinViolations({
      NODE_ENV: "production",
      OTS_BITCOIN_VERIFY_ENABLED: "true",
      OTS_BITCOIN_RPC_URL: "http://node.internal:8332",
      OTS_BITCOIN_RPC_USERNAME: "verifier",
      OTS_BITCOIN_RPC_PASSWORD: "must-never-be-echoed",
      OTS_BITCOIN_RPC_PASSWORD_FILE: "/run/proovra/bitcoin-rpc/password",
    });
    expect(v.map((x) => x.envName)).toEqual([
      "OTS_BITCOIN_RPC_PASSWORD",
      "OTS_BITCOIN_RPC_PASSWORD_FILE",
      "OTS_BITCOIN_RPC_URL",
      "OTS_BITCOIN_RPC_USERNAME",
      "OTS_BITCOIN_VERIFY_ENABLED",
    ]);
    // The violation carries names only — never a value.
    expect(JSON.stringify(v)).not.toMatch(/must-never-be-echoed|node\.internal|verifier"/);
  });

  it("an API environment without verifier configuration has no such violation", () => {
    expect(bitcoinViolations({ NODE_ENV: "production" })).toEqual([]);
  });

  it("development and test are not refused (the worker's own .env.example documents local values)", () => {
    expect(bitcoinViolations({ NODE_ENV: "development", OTS_BITCOIN_VERIFY_ENABLED: "false" })).toEqual([]);
  });
});
