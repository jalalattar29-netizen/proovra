/**
 * Stripe webhook signature — every `v1=` candidate is considered.
 *
 * Stripe signs each event once per active endpoint secret, so during a secret
 * roll the header carries `v1=<old>,v1=<new>` in no guaranteed order. The
 * verifier used to read only the FIRST `v1=` and refused a correctly signed
 * event whenever the matching signature came second.
 */
import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StripeSignatureError, verifyStripeSignature } from "../src/services/stripe.service.js";

const SECRET = "whsec_test_multi_v1";
const OLD_SECRET = "whsec_test_rolled_out";
const mac = (body: string, ts: number, secret: string) =>
  crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

describe("verifyStripeSignature — multiple v1 signatures", () => {
  const original = process.env.STRIPE_WEBHOOK_SECRET;
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = original;
  });

  const body = '{"id":"evt_multi","type":"invoice.paid"}';
  const ts = Math.floor(Date.now() / 1000);

  it("accepts when the matching signature is FIRST", () => {
    const header = `t=${ts},v1=${mac(body, ts, SECRET)},v1=${mac(body, ts, OLD_SECRET)}`;
    expect(verifyStripeSignature(Buffer.from(body), header, { nowMs: ts * 1000 })).toBe(true);
  });

  it("accepts when the matching signature is NOT first (secret roll)", () => {
    const header = `t=${ts},v1=${mac(body, ts, OLD_SECRET)},v1=${mac(body, ts, SECRET)}`;
    expect(verifyStripeSignature(Buffer.from(body), header, { nowMs: ts * 1000 })).toBe(true);
  });

  it("accepts with a v0 scheme and whitespace around the parts", () => {
    const header = `t=${ts}, v0=deadbeef, v1=${"0".repeat(64)}, v1=${mac(body, ts, SECRET)}`;
    expect(verifyStripeSignature(Buffer.from(body), header, { nowMs: ts * 1000 })).toBe(true);
  });

  it("refuses when NO v1 matches — including short and malformed candidates", () => {
    const header = `t=${ts},v1=${mac(body, ts, OLD_SECRET)},v1=abc,v1=${"f".repeat(64)}`;
    expect(() => verifyStripeSignature(Buffer.from(body), header, { nowMs: ts * 1000 })).toThrow(
      StripeSignatureError,
    );
  });

  it("refuses a valid second signature when the timestamp is outside tolerance", () => {
    const stale = ts - 60 * 60;
    const header = `t=${stale},v1=${mac(body, stale, OLD_SECRET)},v1=${mac(body, stale, SECRET)}`;
    try {
      verifyStripeSignature(Buffer.from(body), header, { nowMs: ts * 1000 });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as StripeSignatureError).code).toBe("TIMESTAMP_OUT_OF_TOLERANCE");
    }
  });

  it("refuses a header with only an empty v1", () => {
    try {
      verifyStripeSignature(Buffer.from(body), `t=${ts},v1=`, { nowMs: ts * 1000 });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as StripeSignatureError).code).toBe("MISSING_FIELDS");
    }
  });
});
