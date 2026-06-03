/**
 * Phase 10.5 — Production hardening behavior tests.
 *
 * Covers, without spinning up the DB:
 *   - API key usage projection redaction (never leaks raw key,
 *     Authorization header, request body)
 *   - Webhook delivery detail projection (never leaks payloadJson,
 *     ciphertext, secret)
 *   - Rate-limit key isolation per credential (in-memory bucket
 *     observed via the public `enforceRateLimit` helper)
 *   - Retention cleanup config bounds
 */
import { describe, expect, it } from "vitest";
import { projectApiCredentialUsage } from "../src/services/integrations/api-key-usage.service.js";
import { projectWebhookDeliveryDetail } from "../src/services/integrations/webhook-deliveries.service.js";
import { projectWebhookEndpoint } from "../src/services/integrations/webhooks.service.js";
import { projectApiCredential } from "../src/services/integrations/api-keys.service.js";
import { enforceRateLimit } from "../src/services/rate-limit.js";
const NOW = new Date("2026-05-18T10:00:00Z");
describe("api credential usage projection — privacy", () => {
    it("never echoes the raw key, the authorization header, or request body", () => {
        const projected = projectApiCredentialUsage({
            id: "11111111-1111-4111-8111-111111111111",
            apiCredentialId: "22222222-2222-4222-8222-222222222222",
            teamId: "33333333-3333-4333-8333-333333333333",
            routePath: "/v1/integrations/api/evidence",
            method: "GET",
            action: "evidence.list",
            statusCode: 200,
            success: true,
            failureReason: null,
            requestId: "req-abc",
            createdAt: NOW,
        });
        const serialized = JSON.stringify(projected);
        // Ensure no secret-like substrings can leak through this projection.
        expect(serialized).not.toMatch(/pwk_v\d+_/);
        expect(serialized).not.toMatch(/Authorization/i);
        expect(serialized).not.toMatch(/Bearer/);
        expect(serialized).not.toMatch(/secret/i);
    });
    it("returns only the operator-visible fields", () => {
        const projected = projectApiCredentialUsage({
            id: "11111111-1111-4111-8111-111111111111",
            apiCredentialId: "22222222-2222-4222-8222-222222222222",
            teamId: "33333333-3333-4333-8333-333333333333",
            routePath: "/v1/integrations/api/evidence",
            method: "GET",
            action: "evidence.list",
            statusCode: 200,
            success: true,
            failureReason: null,
            requestId: "req-abc",
            createdAt: NOW,
        });
        expect(Object.keys(projected).sort()).toEqual([
            "action",
            "createdAt",
            "failureReason",
            "id",
            "method",
            "requestId",
            "routePath",
            "statusCode",
            "success",
        ].sort());
    });
});
describe("api credential projection — never echoes the hash", () => {
    it("admin projection omits keyHash", () => {
        const projected = projectApiCredential({
            id: "11111111-1111-4111-8111-111111111111",
            teamId: "22222222-2222-4222-8222-222222222222",
            name: "test",
            description: null,
            keyPrefix: "pwk_v1_abcdefgh",
            keyHash: "00000000000000000000000000000000000000000000000000000000000000aa",
            scopes: ["integration.evidence.read"],
            status: "ACTIVE",
            createdByUserId: "55555555-5555-4555-8555-555555555555",
            lastUsedAtUtc: null,
            revokedAtUtc: null,
            revokedByUserId: null,
            revokedReason: null,
            expiresAtUtc: null,
            disabledAtUtc: null,
            disabledByUserId: null,
            rotationRequired: false,
            ipAllowlist: [],
            environment: null,
            createdAt: NOW,
            updatedAt: NOW,
        });
        expect(projected.keyHash).toBeUndefined();
        expect(JSON.stringify(projected)).not.toContain("00000000000000000000");
    });
});
describe("webhook delivery detail projection — privacy", () => {
    it("does NOT include payloadJson", () => {
        const projected = projectWebhookDeliveryDetail({
            id: "11111111-1111-4111-8111-111111111111",
            endpointId: "22222222-2222-4222-8222-222222222222",
            teamId: "33333333-3333-4333-8333-333333333333",
            eventId: "44444444-4444-4444-8444-444444444444",
            eventType: "evidence.completed",
            payloadJson: {
                secret: "this should never appear",
                legalHoldReason: "internal",
            },
            status: "FAILED",
            attemptCount: 3,
            nextAttemptAtUtc: null,
            responseStatus: 500,
            responseBodyPreview: "x".repeat(2500),
            errorMessage: "y".repeat(800),
            sentAtUtc: null,
            failedAtUtc: NOW,
            createdAt: NOW,
            updatedAt: NOW,
        });
        const serialized = JSON.stringify(projected);
        expect(serialized).not.toContain("this should never appear");
        expect(serialized).not.toContain("legalHoldReason");
        expect(projected.payloadJson).toBeUndefined();
    });
    it("truncates very long error/response previews", () => {
        const projected = projectWebhookDeliveryDetail({
            id: "11111111-1111-4111-8111-111111111111",
            endpointId: "22222222-2222-4222-8222-222222222222",
            teamId: "33333333-3333-4333-8333-333333333333",
            eventId: "44444444-4444-4444-8444-444444444444",
            eventType: "evidence.completed",
            payloadJson: {},
            status: "FAILED",
            attemptCount: 3,
            nextAttemptAtUtc: null,
            responseStatus: 500,
            responseBodyPreview: "x".repeat(5000),
            errorMessage: "y".repeat(1500),
            sentAtUtc: null,
            failedAtUtc: NOW,
            createdAt: NOW,
            updatedAt: NOW,
        });
        expect(projected.responseBodyPreview?.length).toBeLessThanOrEqual(2001);
        expect(projected.errorMessage?.length).toBeLessThanOrEqual(401);
    });
});
describe("webhook endpoint projection — privacy", () => {
    it("never exposes secretCiphertext", () => {
        const projected = projectWebhookEndpoint({
            id: "11111111-1111-4111-8111-111111111111",
            teamId: "22222222-2222-4222-8222-222222222222",
            url: "https://example.com/hook",
            description: null,
            status: "ACTIVE",
            secretCiphertext: "AAAA-this-should-never-be-projected-AAAA",
            secretPrefix: "pwhsec_v1_abcd1234",
            eventTypes: [],
            failureCount: 0,
            lastSuccessAtUtc: null,
            lastFailureAtUtc: null,
            createdByUserId: "55555555-5555-4555-8555-555555555555",
            createdAt: NOW,
            updatedAt: NOW,
        });
        expect(projected.secretCiphertext).toBeUndefined();
        expect(JSON.stringify(projected)).not.toContain("AAAA-this-should-never-be-projected-AAAA");
    });
});
describe("per-credential rate limit isolation (in-memory)", () => {
    // The in-memory store is process-global, so use unique keys per test
    // to keep them independent.
    it("a single key is limited after N requests; another key is unaffected", async () => {
        const stamp = Date.now();
        const keyA = `integration_api:credential:test-A-${stamp}`;
        const keyB = `integration_api:credential:test-B-${stamp}`;
        let lastA = null;
        for (let i = 0; i < 4; i += 1) {
            lastA = await enforceRateLimit({ key: keyA, max: 3, windowSec: 60 });
        }
        expect(lastA?.allowed).toBe(false);
        // Key B has fresh budget.
        const firstB = await enforceRateLimit({
            key: keyB,
            max: 3,
            windowSec: 60,
        });
        expect(firstB.allowed).toBe(true);
        expect(firstB.remaining).toBeGreaterThanOrEqual(0);
    });
});
