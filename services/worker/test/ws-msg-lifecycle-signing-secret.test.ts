/**
 * PRO-G1-02 — the Worker opens the lifecycle signing secret the API wrapped
 * (same AUTH_JWT_SECRET-derived key), still reads a legacy raw row, and fails
 * closed on an envelope it cannot authenticate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapWebhookSigningSecret } from "@proovra/shared-runtime/outbound";

vi.mock("../src/db.js", () => ({ prisma: {} }));

import { readLifecycleSigningSecret } from "../src/webhook-dispatcher.js";

describe("PRO-G1-02 — worker lifecycle signing secret", () => {
  const saved = process.env.AUTH_JWT_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = saved;
  });

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
