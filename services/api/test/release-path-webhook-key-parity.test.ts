/**
 * ROLLOUT-HANDOFF D5 — the API, the Worker and the re-wrap script derive the
 * lifecycle/automation webhook wrap key from ONE resolution of AUTH_JWT_SECRET.
 *
 * The API reads it through `getSecret` (hydrated Secrets Manager bundle, then
 * the trimmed environment). The Worker read `process.env` only, and the re-wrap
 * script never hydrated the bundle — so a deployment holding the key in
 * Secrets Manager (or with a padded env value) wrapped secrets on one side
 * that the other could not open, and every delivery failed closed.
 *
 * The Worker now reads through `resolveSharedSecretValue` (proven in
 * services/worker/test/ws-msg-lifecycle-signing-secret.test.ts); this file
 * proves the API's resolution is the same function of the same state, and that
 * an envelope the API wraps opens under the key the Worker resolves.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  initSecretsAuthority,
  recordingSecretsProvider,
  resetRecordingSecretsProvider,
  resetSecretsAuthority,
  resolveSharedSecretValue,
  scriptSecretsProvider,
  setSecretsProvider,
  stopSecretsAuthority,
} from "@proovra/shared-runtime";
import { unwrapWebhookSigningSecret } from "@proovra/shared-runtime/outbound";
import { getSecret } from "../src/config/runtime-secrets.js";
import { wrapLifecycleSigningSecret } from "../src/services/packaging/webhooks/webhook-platform.service.js";

const SAVED_KEYS = ["AUTH_JWT_SECRET", "AWS_SECRETS_MODE", "AWS_SECRETS_ENABLED", "AWS_SECRET_NAME", "AWS_SECRETS_REGION"] as const;
const saved: Record<string, string | undefined> = Object.fromEntries(SAVED_KEYS.map((k) => [k, process.env[k]]));
const silent = { info: () => {}, warn: () => {} };

afterEach(() => {
  stopSecretsAuthority();
  resetSecretsAuthority();
  resetRecordingSecretsProvider();
  setSecretsProvider(null);
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function hydrateBundle(values: Record<string, string>): Promise<void> {
  setSecretsProvider(recordingSecretsProvider);
  process.env.AWS_SECRETS_MODE = "optional";
  process.env.AWS_SECRET_NAME = "proovra/test/bundle";
  process.env.AWS_SECRETS_REGION = "eu-north-1";
  scriptSecretsProvider([{ kind: "secret", payload: values }]);
  await initSecretsAuthority(silent);
}

describe("D5 — one resolution of AUTH_JWT_SECRET for API and Worker", () => {
  const cases: Array<[string, () => Promise<void>]> = [
    ["bundle only", async () => {
      delete process.env.AUTH_JWT_SECRET;
      await hydrateBundle({ AUTH_JWT_SECRET: "bundle-key-0123456789abcdef012345" });
    }],
    ["bundle and a different env value", async () => {
      process.env.AUTH_JWT_SECRET = "stale-env-key-0123456789abcdef0123";
      await hydrateBundle({ AUTH_JWT_SECRET: "bundle-key-0123456789abcdef012345" });
    }],
    ["bundle without the key, env set", async () => {
      process.env.AUTH_JWT_SECRET = "env-key-0123456789abcdef0123456789";
      await hydrateBundle({ OTHER: "x" });
    }],
    ["env only, padded", async () => {
      process.env.AUTH_JWT_SECRET = "  padded-key-0123456789abcdef0123 \n";
    }],
    ["nothing", async () => {
      delete process.env.AUTH_JWT_SECRET;
    }],
  ];

  it.each(cases)("%s: getSecret (API) === resolveSharedSecretValue (Worker)", async (_name, arrange) => {
    await arrange();
    expect(resolveSharedSecretValue("AUTH_JWT_SECRET")).toBe(getSecret("AUTH_JWT_SECRET"));
  });

  it("an envelope the API wraps under a bundle-only key opens under the key the Worker resolves", async () => {
    delete process.env.AUTH_JWT_SECRET;
    await hydrateBundle({ AUTH_JWT_SECRET: "bundle-key-0123456789abcdef012345" });
    const stored = wrapLifecycleSigningSecret("c2lnbmluZy1zZWNyZXQ=");
    const workerKey = resolveSharedSecretValue("AUTH_JWT_SECRET");
    expect(workerKey).not.toBeNull();
    expect(unwrapWebhookSigningSecret(stored, [workerKey!], "lifecycle-webhook")).toBe("c2lnbmluZy1zZWNyZXQ=");
  });
});

describe("D5 — the re-wrap script hydrates the secrets authority before it reads the key", () => {
  const src = readFileSync(new URL("../scripts/rewrap-webhook-signing-secrets.ts", import.meta.url), "utf8");
  const main = src.slice(src.indexOf("async function main()"));

  it("main() awaits the hydration before the first key read", () => {
    const hydrate = main.indexOf("await initSecretsManager(");
    const firstKeyRead = main.indexOf("keyMaterial()");
    expect(hydrate).toBeGreaterThan(-1);
    expect(firstKeyRead).toBeGreaterThan(hydrate);
  });

  it("the key is read through getSecret and the refresh timer is stopped on exit", () => {
    expect(src).toMatch(/getSecret\("AUTH_JWT_SECRET"\)/);
    expect(src).not.toMatch(/process\.env(\[["']AUTH_JWT_SECRET["']\]|\.AUTH_JWT_SECRET)/);
    expect(main.slice(main.indexOf(".finally("))).toContain("stopSecretsAuthority()");
  });
});
