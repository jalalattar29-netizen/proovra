/**
 * Phase 10 — Webhook service unit tests.
 *
 * Covers issuance + encryption + signing without touching the DB.
 * CRUD against Prisma is exercised by the integration test layer, not
 * here.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptWebhookSecret, filterValidEventTypes, isValidWebhookEventType, issueWebhookSecret, signWebhookPayload, } from "../src/services/integrations/webhooks.service.js";
import { buildWebhookSignatureBase } from "@proovra/shared";
const TEST_SECRET = "a".repeat(64);
function withEnv(vars, fn) {
    const prev = {};
    for (const [k, v] of Object.entries(vars)) {
        prev[k] = process.env[k];
        if (v === undefined)
            delete process.env[k];
        else
            process.env[k] = v;
    }
    try {
        fn();
    }
    finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined)
                delete process.env[k];
            else
                process.env[k] = v;
        }
    }
}
describe("webhook secret — issue + round-trip", () => {
    it("returns null when the wrap key (API_KEY_SECRET) is missing", () => {
        withEnv({ API_KEY_SECRET: undefined }, () => {
            expect(issueWebhookSecret()).toBeNull();
        });
    });
    it("produces a `pwhsec` raw secret and a ciphertext that decrypts back", () => {
        withEnv({ API_KEY_SECRET: TEST_SECRET }, () => {
            const issued = issueWebhookSecret();
            expect(issued).not.toBeNull();
            if (!issued)
                return;
            expect(issued.rawSecret).toMatch(/^pwhsec_v\d+_/);
            expect(issued.secretCiphertext.length).toBeGreaterThan(40);
            const recovered = decryptWebhookSecret(issued.secretCiphertext);
            expect(recovered).toBe(issued.rawSecret);
        });
    });
    it("issued secrets are unique per call", () => {
        withEnv({ API_KEY_SECRET: TEST_SECRET }, () => {
            const a = issueWebhookSecret();
            const b = issueWebhookSecret();
            expect(a?.rawSecret).not.toBe(b?.rawSecret);
            expect(a?.secretCiphertext).not.toBe(b?.secretCiphertext);
        });
    });
    it("decryptWebhookSecret returns null for tampered ciphertext", () => {
        withEnv({ API_KEY_SECRET: TEST_SECRET }, () => {
            const issued = issueWebhookSecret();
            if (!issued)
                return;
            const tampered = issued.secretCiphertext.replace(/A/g, "B");
            // If the tamper produced the same string by chance, skip — but
            // for non-trivial ciphertexts this is essentially never the case.
            if (tampered !== issued.secretCiphertext) {
                expect(decryptWebhookSecret(tampered)).toBeNull();
            }
        });
    });
});
describe("webhook signing", () => {
    it("signWebhookPayload returns HMAC-SHA256 hex with v1= prefix", () => {
        const raw = "pwhsec_v1_test-secret-value";
        const timestamp = 1700000000000;
        const body = '{"hello":"world"}';
        const sig = signWebhookPayload(raw, timestamp, body);
        expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
        // Recompute manually and compare.
        const expected = createHmac("sha256", raw)
            .update(buildWebhookSignatureBase(timestamp, body), "utf8")
            .digest("hex");
        expect(sig).toBe(`v1=${expected}`);
    });
    it("signature changes when the timestamp or body changes", () => {
        const raw = "pwhsec_v1_test";
        const a = signWebhookPayload(raw, 1700000000000, "body");
        const b = signWebhookPayload(raw, 1700000000001, "body");
        const c = signWebhookPayload(raw, 1700000000000, "body!");
        expect(a).not.toBe(b);
        expect(a).not.toBe(c);
    });
});
describe("webhook event type validation", () => {
    it("isValidWebhookEventType accepts known events", () => {
        expect(isValidWebhookEventType("evidence.created")).toBe(true);
        expect(isValidWebhookEventType("governance.legal_hold_placed")).toBe(true);
    });
    it("isValidWebhookEventType rejects unknown events", () => {
        expect(isValidWebhookEventType("not.a.real.event")).toBe(false);
    });
    it("filterValidEventTypes drops unknown entries", () => {
        const out = filterValidEventTypes([
            "evidence.created",
            "nope.invalid",
            "evidence.completed",
        ]);
        expect(out).toEqual(["evidence.created", "evidence.completed"]);
    });
});
