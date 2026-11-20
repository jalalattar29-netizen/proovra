/**
 * PRO-G1-02 — the Worker opens the lifecycle signing secret the API wrapped
 * (same AUTH_JWT_SECRET-derived key), still reads a legacy raw row, and fails
 * closed on an envelope it cannot authenticate.
 *
 * ROLLOUT-HANDOFF D5 — the key is resolved through the SHARED secrets
 * authority (hydrated bundle, then the trimmed environment), the order the
 * API's getSecret uses, never from process.env alone.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapWebhookSigningSecret } from "@proovra/shared-runtime/outbound";
import {
  initSecretsAuthority,
  recordingSecretsProvider,
  resetRecordingSecretsProvider,
  resetSecretsAuthority,
  scriptSecretsProvider,
  setSecretsProvider,
  stopSecretsAuthority,
} from "@proovra/shared-runtime";

vi.mock("../src/db.js", () => ({ prisma: {} }));

import { readLifecycleSigningSecret } from "../src/webhook-dispatcher.js";

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

/** Hydrate the shared authority from a scripted bundle — the production loader, a recording transport. */
async function hydrateBundle(values: Record<string, string>): Promise<void> {
  setSecretsProvider(recordingSecretsProvider);
  process.env.AWS_SECRETS_MODE = "optional";
  process.env.AWS_SECRET_NAME = "proovra/test/bundle";
  process.env.AWS_SECRETS_REGION = "eu-north-1";
  scriptSecretsProvider([{ kind: "secret", payload: values }]);
  await initSecretsAuthority(silent);
}

describe("PRO-G1-02 — worker lifecycle signing secret", () => {
  it("opens an API-wrapped e3.3 envelope with the shared key", () => {
    process.env.AUTH_JWT_SECRET = "worker-test-secret-0123456789abcdef";
    const env = wrapWebhookSigningSecret("c2VjcmV0LWJ5dGVz", "worker-test-secret-0123456789abcdef", "lifecycle-webhook");
    expect(readLifecycleSigningSecret(env)).toBe("c2VjcmV0LWJ5dGVz");
  });

  it("reads a legacy raw row as is", () => {
    expect(readLifecycleSigningSecret("cmF3LWxlZ2FjeQ==")).toBe("cmF3LWxlZ2FjeQ==");
  });

  it("fails closed with the wrong key, a missing key, or the wrong channel", () => {
    const env = wrapWebhookSigningSecret("c2VjcmV0", "key-a-0123456789abcdef0123456789", "lifecycle-webhook");
    process.env.AUTH_JWT_SECRET = "key-b-0123456789abcdef0123456789";
    expect(readLifecycleSigningSecret(env)).toBeNull();
    delete process.env.AUTH_JWT_SECRET;
    expect(readLifecycleSigningSecret(env)).toBeNull();
    process.env.AUTH_JWT_SECRET = "key-a-0123456789abcdef0123456789";
    const other = wrapWebhookSigningSecret("c2VjcmV0", "key-a-0123456789abcdef0123456789", "automation-webhook");
    expect(readLifecycleSigningSecret(other)).toBeNull();
  });
});

describe("D5 — the worker resolves AUTH_JWT_SECRET like the API (bundle, then trimmed env)", () => {
  it("a key held ONLY in the hydrated secrets bundle opens the envelope (env absent)", async () => {
    delete process.env.AUTH_JWT_SECRET;
    await hydrateBundle({ AUTH_JWT_SECRET: "bundle-key-0123456789abcdef012345" });
    const env = wrapWebhookSigningSecret("YnVuZGxl", "bundle-key-0123456789abcdef012345", "lifecycle-webhook");
    expect(readLifecycleSigningSecret(env)).toBe("YnVuZGxl");
  });

  it("the bundle OUTRANKS a different env value, as in the API", async () => {
    process.env.AUTH_JWT_SECRET = "stale-env-key-0123456789abcdef0123";
    await hydrateBundle({ AUTH_JWT_SECRET: "bundle-key-0123456789abcdef012345" });
    const byBundle = wrapWebhookSigningSecret("YnVuZGxl", "bundle-key-0123456789abcdef012345", "lifecycle-webhook");
    const byEnv = wrapWebhookSigningSecret("ZW52", "stale-env-key-0123456789abcdef0123", "lifecycle-webhook");
    expect(readLifecycleSigningSecret(byBundle)).toBe("YnVuZGxl");
    expect(readLifecycleSigningSecret(byEnv)).toBeNull();
  });

  it("a bundle without the key falls back to the environment", async () => {
    process.env.AUTH_JWT_SECRET = "env-key-0123456789abcdef0123456789";
    await hydrateBundle({ OTHER: "x" });
    const env = wrapWebhookSigningSecret("ZW52", "env-key-0123456789abcdef0123456789", "lifecycle-webhook");
    expect(readLifecycleSigningSecret(env)).toBe("ZW52");
  });

  it("the env value is trimmed, as the API trims it", () => {
    process.env.AUTH_JWT_SECRET = "  padded-key-0123456789abcdef0123  \n";
    const env = wrapWebhookSigningSecret("cGFk", "padded-key-0123456789abcdef0123", "lifecycle-webhook");
    expect(readLifecycleSigningSecret(env)).toBe("cGFk");
  });

  it("the dispatcher no longer reads AUTH_JWT_SECRET from process.env directly", () => {
    const src = readFileSync(new URL("../src/webhook-dispatcher.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/process\.env(\[["']AUTH_JWT_SECRET["']\]|\.AUTH_JWT_SECRET)/);
    expect(src).toContain('resolveSharedSecretValue("AUTH_JWT_SECRET")');
  });
});
