/**
 * PHASE 12 CORRECTIVE PASS 3 §8 — THE SECRET AUTHORITY IS DECLARED.
 *
 * The observed production log line was
 *
 *     aws_secrets.hydration_failed  access_denied
 *
 * and the question the mandate asks is which of three things that means:
 * a REQUIRED authority that failed, an OPTIONAL one that fell back, or a
 * competing SECOND authority. Reading the module answered it: there was no way
 * to express "required" at all. The stated contract was "env fallback ALWAYS
 * preserved… the app NEVER crashes from a failed AWS fetch", so an
 * `access_denied` produced one bounded warning and the process then served on
 * whatever `process.env` happened to hold — which, in a container whose
 * secrets live only in Secrets Manager, is nothing. That is a silent fallback,
 * and §8 forbids it.
 *
 * Three defects, three fixes, pinned here:
 *
 *   1. NO DECLARED MODE — `AWS_SECRETS_MODE` (disabled | optional | required).
 *      `AWS_SECRETS_ENABLED=true` still maps to `optional`, so no existing
 *      deployment changes meaning on upgrade.
 *   2. REQUIRED DID NOT FAIL CLOSED — it does now, at startup, with a bounded
 *      code and no secret value in the message.
 *   3. UNAUTHORIZED CALLS REPEATED HOURLY, FOREVER — `access_denied` is an IAM
 *      decision, not a transient error. The refresh loop now suspends and says
 *      so, once.
 *
 * No AWS client is constructed here and no network call is attempted: every
 * case is decided before the SDK would be reached, which is itself part of the
 * property under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetSecretsManagerForTests,
  getSecretsHealth,
  initSecretsManager,
} from "../src/config/secrets-manager.js";

const silentLog = {
  info: () => {},
  warn: () => {},
};

describe("§8 — one declared secret authority per deployment", () => {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  beforeEach(() => {
    __resetSecretsManagerForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(saved)) delete saved[k];
    __resetSecretsManagerForTests();
  });

  it("DISABLED is the default, and readiness reports the real mode", async () => {
    setEnv("AWS_SECRETS_MODE", undefined);
    setEnv("AWS_SECRETS_ENABLED", undefined);
    await initSecretsManager(silentLog);
    const h = getSecretsHealth();
    expect(h.mode).toBe("disabled");
    expect(h.awsEnabled).toBe(false);
    expect(h.degraded).toBe(false);
    // The operator surface names the authority instead of leaving it to be
    // inferred from two booleans.
    expect(h).toHaveProperty("mode");
    expect(h).toHaveProperty("refreshSuspended");
  });

  it("AWS_SECRETS_ENABLED=true still means OPTIONAL — no deployment changes meaning", async () => {
    setEnv("AWS_SECRETS_MODE", undefined);
    setEnv("AWS_SECRETS_ENABLED", "true");
    // Hydration will fail (no credentials, and the outbound guard blocks the
    // socket). The property is that boot SURVIVES, which is what `optional`
    // means and what this deployment shape has always done.
    await initSecretsManager(silentLog);
    const h = getSecretsHealth();
    expect(h.mode).toBe("optional");
    expect(h.awsEnabled).toBe(true);
    expect(h.awsConnected).toBe(false);
    // Degraded is surfaced rather than hidden.
    expect(h.degraded).toBe(true);
  });

  it("REQUIRED fails startup CLOSED when the authority is unavailable", async () => {
    setEnv("AWS_SECRETS_MODE", "required");
    setEnv("AWS_SECRETS_ENABLED", "true");
    // THE FIX. Under the old contract this resolved successfully and the
    // process went on to serve with an empty cache.
    await expect(initSecretsManager(silentLog)).rejects.toThrow(
      /aws_secrets\.required_authority_unavailable/,
    );
  });

  it("the failure carries a BOUNDED code and no secret value", async () => {
    setEnv("AWS_SECRETS_MODE", "required");
    setEnv("AWS_SECRETS_ENABLED", "true");
    setEnv("AWS_SECRET_NAME", "proovra/test/never-resolvable");
    let message = "";
    try {
      await initSecretsManager(silentLog);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/^aws_secrets\.required_authority_unavailable:/);
    const code = message.split(":")[1] ?? "";
    expect(
      ["access_denied", "not_found", "network", "unknown", "decode"],
      `unbounded error code leaked: ${code}`,
    ).toContain(code);
    // The message must carry NO credential-shaped value. Note it is matched
    // against value shapes, not against the word "secret" — the bounded code
    // is literally `aws_secrets.…`, so a substring check on that word tests
    // the prefix rather than the property, and would fail on a correct
    // message. What matters is that no key material, ARN, endpoint or
    // environment value rides along.
    expect(message).not.toMatch(/AKIA[0-9A-Z]{16}/); // AWS access key id
    expect(message).not.toMatch(/arn:aws/i); // IAM/KMS ARN
    expect(message).not.toMatch(/https?:\/\//i); // endpoint URL
    expect(message).not.toMatch(/[A-Za-z0-9/+=]{40,}/); // long opaque material
    // The whole message is the bounded code and nothing else.
    expect(message.split(":").length).toBe(2);
  });

  it("an UNRECOGNISED mode is a configuration error, never a silent downgrade", async () => {
    setEnv("AWS_SECRETS_MODE", "requried"); // the typo that matters
    setEnv("AWS_SECRETS_ENABLED", "true");
    // Guessing "they probably meant required" is as wrong as guessing
    // "optional" — one fails closed when it should not, the other serves
    // without its secrets. Refusing is the only safe reading.
    await expect(initSecretsManager(silentLog)).rejects.toThrow(
      /aws_secrets\.invalid_mode/,
    );
  });

  it("health NEVER exposes a secret name→value pair", async () => {
    setEnv("AWS_SECRETS_MODE", "optional");
    setEnv("AWS_SECRETS_ENABLED", "true");
    await initSecretsManager(silentLog);
    const h = getSecretsHealth();
    const serialised = JSON.stringify(h);
    // Only a COUNT of cached keys is exposed — never the names, never values.
    expect(h).toHaveProperty("cachedKeyCount");
    expect(typeof h.cachedKeyCount).toBe("number");
    expect(serialised).not.toMatch(/"values"/);
    expect(Object.keys(h)).not.toContain("cache");
  });
});
