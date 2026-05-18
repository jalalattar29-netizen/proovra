/**
 * Phase 10.5 — Receiver-side signature verification proof.
 *
 * The webhook scheme MUST be implementable by a third-party receiver
 * using only:
 *   - the raw secret PROOVRA disclosed once
 *   - the four request headers
 *   - the raw request body bytes
 *
 * If a recipient cannot replicate the signature, the scheme is broken.
 * This file plays the role of an external receiver and verifies the
 * signature produced by our service.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decryptWebhookSecret,
  issueWebhookSecret,
  signWebhookPayload,
} from "../src/services/integrations/webhooks.service.js";
import {
  WEBHOOK_HEADER_EVENT,
  WEBHOOK_HEADER_EVENT_ID,
  WEBHOOK_HEADER_SIGNATURE,
  WEBHOOK_HEADER_TIMESTAMP,
  buildWebhookSignatureBase,
} from "@proovra/shared";

const TEST_SECRET = "a".repeat(64);

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * Receiver-side verification, written ENTIRELY in terms of the public
 * scheme. Returns true on success.
 */
function receiverVerifySignature(input: {
  rawSecret: string;
  signatureHeader: string;
  timestampHeader: string;
  body: string;
}): boolean {
  if (!input.signatureHeader.startsWith("v1=")) return false;
  const received = input.signatureHeader.slice(3);
  const base = buildWebhookSignatureBase(
    Number.parseInt(input.timestampHeader, 10),
    input.body,
  );
  const expected = createHmac("sha256", input.rawSecret)
    .update(base, "utf8")
    .digest("hex");
  return constantTimeEqual(received, expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

describe("webhook signing — receiver verification", () => {
  it("a receiver with the raw secret recomputes the signature", () => {
    withEnv({ API_KEY_SECRET: TEST_SECRET }, () => {
      const issued = issueWebhookSecret();
      expect(issued).not.toBeNull();
      if (!issued) return;

      const timestamp = 1700000000123;
      const body = JSON.stringify({
        event: "evidence.completed",
        eventId: "00000000-0000-4000-8000-000000000001",
        data: { evidenceId: "abc" },
      });
      const signature = signWebhookPayload(issued.rawSecret, timestamp, body);

      const ok = receiverVerifySignature({
        rawSecret: issued.rawSecret,
        signatureHeader: signature,
        timestampHeader: String(timestamp),
        body,
      });
      expect(ok).toBe(true);
    });
  });

  it("a wrong secret fails verification", () => {
    withEnv({ API_KEY_SECRET: TEST_SECRET }, () => {
      const issued = issueWebhookSecret();
      if (!issued) return;
      const sig = signWebhookPayload(issued.rawSecret, 1, "body");
      const ok = receiverVerifySignature({
        rawSecret: "wrong-secret",
        signatureHeader: sig,
        timestampHeader: "1",
        body: "body",
      });
      expect(ok).toBe(false);
    });
  });

  it("a tampered body fails verification", () => {
    withEnv({ API_KEY_SECRET: TEST_SECRET }, () => {
      const issued = issueWebhookSecret();
      if (!issued) return;
      const sig = signWebhookPayload(issued.rawSecret, 1, "ok");
      const ok = receiverVerifySignature({
        rawSecret: issued.rawSecret,
        signatureHeader: sig,
        timestampHeader: "1",
        body: "tampered",
      });
      expect(ok).toBe(false);
    });
  });

  it("the ciphertext stored server-side decrypts to the same value the receiver uses", () => {
    withEnv({ API_KEY_SECRET: TEST_SECRET }, () => {
      const issued = issueWebhookSecret();
      if (!issued) return;
      const recovered = decryptWebhookSecret(issued.secretCiphertext);
      expect(recovered).toBe(issued.rawSecret);

      // And signing with the recovered (server-side) value matches what
      // the receiver computes locally with their stored copy.
      const timestamp = 9000000000000;
      const body = "{}";
      expect(recovered).not.toBeNull();
      if (!recovered) return;
      const serverSig = signWebhookPayload(recovered, timestamp, body);
      const receiverOk = receiverVerifySignature({
        rawSecret: issued.rawSecret,
        signatureHeader: serverSig,
        timestampHeader: String(timestamp),
        body,
      });
      expect(receiverOk).toBe(true);
    });
  });
});

describe("webhook header contract", () => {
  it("header names are canonical (lowercase, x-proovra-* family)", () => {
    expect(WEBHOOK_HEADER_EVENT).toBe("x-proovra-event");
    expect(WEBHOOK_HEADER_EVENT_ID).toBe("x-proovra-event-id");
    expect(WEBHOOK_HEADER_TIMESTAMP).toBe("x-proovra-timestamp");
    expect(WEBHOOK_HEADER_SIGNATURE).toBe("x-proovra-signature");
  });
});
