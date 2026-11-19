/**
 * PRO-G1-02 — webhook signing secrets at rest.
 *
 * At the base the automation envelope XOR-ed every tenant's secret with ONE
 * keystream derived from AUTH_JWT_SECRET: knowing one tenant's revealed secret
 * and its envelope recovered every other tenant's secret, and a tampered
 * envelope still "decrypted". These cases fail on that implementation.
 */
import { describe, expect, it } from "vitest";
import {
  unwrapWebhookSigningSecret,
  wrapWebhookSigningSecret,
} from "@proovra/shared-runtime/outbound";

import {
  createDestinationSecret,
  decryptLegacyXorEnvelope,
  decryptStoredSecret,
} from "../src/services/automation/automation-webhook.service.js";

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(Math.min(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}
const body = (envelope: string) => Buffer.from(envelope.slice(envelope.indexOf(":") + 1), "base64");

describe("PRO-G1-02 — automation destination secrets", () => {
  it("one tenant's known plaintext does not reveal another tenant's secret", () => {
    const a = createDestinationSecret();
    const b = createDestinationSecret();
    const keystreamGuess = xor(body(a.storedEnvelope), Buffer.from(a.plaintext, "utf8"));
    const recovered = xor(body(b.storedEnvelope), keystreamGuess).toString("utf8");
    expect(recovered).not.toBe(b.plaintext);
    expect(b.storedEnvelope).not.toContain(b.plaintext);
  });

  it("the same plaintext wraps to different envelopes (fresh nonce) and both open", () => {
    const one = wrapWebhookSigningSecret("same-secret-value-1234567890", "k", "automation-webhook");
    const two = wrapWebhookSigningSecret("same-secret-value-1234567890", "k", "automation-webhook");
    expect(one).not.toBe(two);
    expect(unwrapWebhookSigningSecret(one, ["k"], "automation-webhook")).toBe("same-secret-value-1234567890");
    expect(unwrapWebhookSigningSecret(two, ["k"], "automation-webhook")).toBe("same-secret-value-1234567890");
  });

  it("round-trips the revealed secret and fails closed on a tampered envelope", () => {
    const s = createDestinationSecret();
    expect(s.storedEnvelope.startsWith("e3.3:")).toBe(true);
    expect(decryptStoredSecret(s.storedEnvelope)).toBe(s.plaintext);
    const raw = body(s.storedEnvelope);
    raw[raw.length - 20]! ^= 0x01;
    expect(decryptStoredSecret(`e3.3:${raw.toString("base64")}`)).toBeNull();
  });

  it("an envelope is bound to its channel and its key", () => {
    const env = wrapWebhookSigningSecret("secret-abc-0123456789", "k1", "automation-webhook");
    expect(unwrapWebhookSigningSecret(env, ["k1"], "lifecycle-webhook")).toBeNull();
    expect(unwrapWebhookSigningSecret(env, ["k2"], "automation-webhook")).toBeNull();
    expect(unwrapWebhookSigningSecret(env, ["k2", "k1"], "automation-webhook")).toBe("secret-abc-0123456789");
  });

  it("a legacy e3.2 row still signs until it is re-wrapped", () => {
    const legacy = `e3.2:${Buffer.from("legacy-envelope-bytes-0123456789abcdefghijk").toString("base64")}`;
    const legacyPlain = decryptLegacyXorEnvelope(legacy);
    expect(legacyPlain).not.toBeNull();
    expect(decryptStoredSecret(legacy)).toBe(legacyPlain);
  });
});
