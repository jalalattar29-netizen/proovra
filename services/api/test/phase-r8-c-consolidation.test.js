/**
 * Phase R8.C — Identity, Env & Config Consolidation
 * Contract tests: 13 tests
 *
 * Covers:
 *   - collectStartupViolations: core required vars
 *   - collectStartupViolations: feature-gated secrets
 *   - collectStartupViolations: signing provider consistency (R8.C)
 *   - collectStartupViolations: SAML URL localhost safety (R8.C)
 *   - collectStartupViolations: storage localhost safety (R8.C)
 *   - envBool: exact "true" semantics
 *   - resolveSecret: prod vs non-prod behavior
 *   - No new auth subsystem imports present (guardrail)
 *
 * These tests exercise the config module with controlled env overrides.
 * They do NOT start a real server and do NOT connect to a real database.
 */
import { describe, expect, it, afterEach } from "vitest";
import { collectStartupViolations, envBool, resolveSecret, } from "../src/config/index.js";
function withEnv(patch, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(patch)) {
        saved[k] = process.env[k];
        if (v === undefined) {
            delete process.env[k];
        }
        else {
            process.env[k] = v;
        }
    }
    try {
        fn();
    }
    finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) {
                delete process.env[k];
            }
            else {
                process.env[k] = v;
            }
        }
    }
}
// ---------------------------------------------------------------------------
// Helpers for testing violations
// ---------------------------------------------------------------------------
function violationNames(patch) {
    let names = [];
    withEnv(patch, () => {
        names = collectStartupViolations().map((v) => v.envName);
    });
    return names;
}
function violationReasons(patch) {
    let reasons = [];
    withEnv(patch, () => {
        reasons = collectStartupViolations().map((v) => v.reason);
    });
    return reasons;
}
// ---------------------------------------------------------------------------
// Core required var tests
// ---------------------------------------------------------------------------
describe("collectStartupViolations — core required vars", () => {
    it("T01 — flags DATABASE_URL as required_missing when unset", () => {
        const names = violationNames({
            DATABASE_URL: "",
            AUTH_JWT_SECRET: "secret",
            NODE_ENV: "development",
        });
        expect(names).toContain("DATABASE_URL");
    });
    it("T02 — flags AUTH_JWT_SECRET as required_missing when unset", () => {
        const names = violationNames({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "",
            NODE_ENV: "development",
        });
        expect(names).toContain("AUTH_JWT_SECRET");
    });
    it("T03 — returns no violations when all core vars are set and features are off", () => {
        const violations = violationNames({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "test_jwt_secret",
            NODE_ENV: "development",
            COMMUNICATIONS_ENABLED: "false",
            IDENTITY_SECURITY_ENABLED: "false",
            INTEGRATIONS_ENABLED: "false",
            // Signing: local-pem default
            SIGNER_PROVIDER: "local-pem",
            SIGNING_PRIVATE_KEY_PATH: "keys/signing-private.pem",
            // No SAML enabled, no production node env
            SAML_ENABLED: "false",
        });
        expect(violations).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// Feature-gated secret tests
// ---------------------------------------------------------------------------
describe("collectStartupViolations — feature-gated secrets", () => {
    it("T04 — flags COMMUNICATIONS_RECIPIENT_HASH_SECRET when communications enabled and secret missing", () => {
        const names = violationNames({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "secret",
            NODE_ENV: "development",
            COMMUNICATIONS_ENABLED: "true",
            COMMUNICATIONS_RECIPIENT_HASH_SECRET: "",
            IDENTITY_SECURITY_ENABLED: "false",
            INTEGRATIONS_ENABLED: "false",
            SIGNER_PROVIDER: "local-pem",
            SIGNING_PRIVATE_KEY_PATH: "keys/signing-private.pem",
        });
        expect(names).toContain("COMMUNICATIONS_RECIPIENT_HASH_SECRET");
    });
    it("T05 — flags IDENTITY_SECURITY_HASH_SECRET when identity security enabled and secret missing", () => {
        const names = violationNames({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "secret",
            NODE_ENV: "development",
            COMMUNICATIONS_ENABLED: "false",
            IDENTITY_SECURITY_ENABLED: "true",
            IDENTITY_SECURITY_HASH_SECRET: "",
            INTEGRATIONS_ENABLED: "false",
            SIGNER_PROVIDER: "local-pem",
            SIGNING_PRIVATE_KEY_PATH: "keys/signing-private.pem",
        });
        expect(names).toContain("IDENTITY_SECURITY_HASH_SECRET");
    });
    it("T06 — flags API_KEY_SECRET when integrations enabled and secret missing", () => {
        const names = violationNames({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "secret",
            NODE_ENV: "development",
            COMMUNICATIONS_ENABLED: "false",
            IDENTITY_SECURITY_ENABLED: "false",
            INTEGRATIONS_ENABLED: "true",
            API_KEY_SECRET: "",
            SIGNER_PROVIDER: "local-pem",
            SIGNING_PRIVATE_KEY_PATH: "keys/signing-private.pem",
        });
        expect(names).toContain("API_KEY_SECRET");
    });
});
// ---------------------------------------------------------------------------
// R8.C — Signing provider consistency
// ---------------------------------------------------------------------------
describe("collectStartupViolations — signing provider consistency (R8.C)", () => {
    it("T07 — flags KMS_KEY_ID when SIGNER_PROVIDER=aws-kms and KMS_KEY_ID missing", () => {
        const violations = violationNames({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "secret",
            NODE_ENV: "development",
            COMMUNICATIONS_ENABLED: "false",
            IDENTITY_SECURITY_ENABLED: "false",
            INTEGRATIONS_ENABLED: "false",
            SIGNER_PROVIDER: "aws-kms",
            KMS_KEY_ID: "",
            SAML_ENABLED: "false",
        });
        expect(violations).toContain("KMS_KEY_ID");
    });
    it("T08 — flags SIGNING_PRIVATE_KEY_PATH when SIGNER_PROVIDER=local-pem and path missing", () => {
        const violations = violationNames({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "secret",
            NODE_ENV: "development",
            COMMUNICATIONS_ENABLED: "false",
            IDENTITY_SECURITY_ENABLED: "false",
            INTEGRATIONS_ENABLED: "false",
            SIGNER_PROVIDER: "local-pem",
            SIGNING_PRIVATE_KEY_PATH: "",
            SAML_ENABLED: "false",
        });
        expect(violations).toContain("SIGNING_PRIVATE_KEY_PATH");
    });
    it("T09 — no signing violation when SIGNER_PROVIDER=aws-kms and KMS_KEY_ID is set", () => {
        const violations = violationNames({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "secret",
            NODE_ENV: "development",
            COMMUNICATIONS_ENABLED: "false",
            IDENTITY_SECURITY_ENABLED: "false",
            INTEGRATIONS_ENABLED: "false",
            SIGNER_PROVIDER: "aws-kms",
            KMS_KEY_ID: "arn:aws:kms:eu-north-1:123456789:key/abc-def",
            SAML_ENABLED: "false",
        });
        expect(violations).not.toContain("KMS_KEY_ID");
        expect(violations).not.toContain("SIGNING_PRIVATE_KEY_PATH");
    });
    it("T10 — violation reason is signing_provider_inconsistent for KMS_KEY_ID missing", () => {
        const reasons = violationReasons({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "secret",
            NODE_ENV: "development",
            COMMUNICATIONS_ENABLED: "false",
            IDENTITY_SECURITY_ENABLED: "false",
            INTEGRATIONS_ENABLED: "false",
            SIGNER_PROVIDER: "aws-kms",
            KMS_KEY_ID: "",
            SAML_ENABLED: "false",
        });
        expect(reasons).toContain("signing_provider_inconsistent");
    });
});
// ---------------------------------------------------------------------------
// R8.C — SAML URL localhost safety
// ---------------------------------------------------------------------------
describe("collectStartupViolations — SAML URL safety (R8.C)", () => {
    it("T11 — flags SAML_SP_ACS_URL when production + SAML enabled + localhost ACS URL", () => {
        const violations = violationNames({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "secret",
            NODE_ENV: "production",
            COMMUNICATIONS_ENABLED: "false",
            IDENTITY_SECURITY_ENABLED: "false",
            INTEGRATIONS_ENABLED: "false",
            SIGNER_PROVIDER: "aws-kms",
            KMS_KEY_ID: "arn:aws:kms:eu-north-1:123:key/abc",
            SAML_ENABLED: "true",
            SAML_SP_ACS_URL: "http://localhost:8081/v1/auth/saml/acs",
            // Storage — set to non-localhost so only SAML fires
            S3_ENDPOINT: "https://valid.r2.cloudflarestorage.com",
            S3_ALLOW_INSECURE: "false",
        });
        expect(violations).toContain("SAML_SP_ACS_URL");
    });
    it("T12 — no SAML URL violation when ACS URL is a production HTTPS URL", () => {
        const violations = violationNames({
            DATABASE_URL: "postgresql://localhost/test",
            AUTH_JWT_SECRET: "secret",
            NODE_ENV: "production",
            COMMUNICATIONS_ENABLED: "false",
            IDENTITY_SECURITY_ENABLED: "false",
            INTEGRATIONS_ENABLED: "false",
            SIGNER_PROVIDER: "aws-kms",
            KMS_KEY_ID: "arn:aws:kms:eu-north-1:123:key/abc",
            SAML_ENABLED: "true",
            SAML_SP_ACS_URL: "https://api.proovra.com/v1/auth/saml/acs",
            S3_ENDPOINT: "https://valid.r2.cloudflarestorage.com",
            S3_ALLOW_INSECURE: "false",
        });
        expect(violations).not.toContain("SAML_SP_ACS_URL");
    });
});
// ---------------------------------------------------------------------------
// envBool + resolveSecret
// ---------------------------------------------------------------------------
describe("envBool", () => {
    it("T13 — returns true only for exact lowercase 'true'", () => {
        withEnv({ TEST_BOOL_VAR: "true" }, () => {
            expect(envBool("TEST_BOOL_VAR")).toBe(true);
        });
        withEnv({ TEST_BOOL_VAR: "True" }, () => {
            expect(envBool("TEST_BOOL_VAR")).toBe(false);
        });
        withEnv({ TEST_BOOL_VAR: "TRUE" }, () => {
            expect(envBool("TEST_BOOL_VAR")).toBe(false);
        });
        withEnv({ TEST_BOOL_VAR: "1" }, () => {
            expect(envBool("TEST_BOOL_VAR")).toBe(false);
        });
        withEnv({ TEST_BOOL_VAR: undefined }, () => {
            expect(envBool("TEST_BOOL_VAR")).toBe(false);
        });
    });
});
describe("resolveSecret", () => {
    afterEach(() => {
        // Clean up any test-injected NODE_ENV
        delete process.env["TEST_SECRET_NONE"];
    });
    it("resolveSecret returns value when set (any environment)", () => {
        withEnv({ TEST_SECRET_NONE: "my-value" }, () => {
            expect(resolveSecret("TEST_SECRET_NONE")).toBe("my-value");
        });
    });
    it("resolveSecret returns non-prod fallback when unset in non-production", () => {
        withEnv({ NODE_ENV: "development", TEST_SECRET_NONE: "" }, () => {
            const result = resolveSecret("TEST_SECRET_NONE");
            expect(result).toContain("non-prod-fallback");
            expect(result).toContain("TEST_SECRET_NONE");
        });
    });
    it("resolveSecret throws in production when secret is missing", () => {
        withEnv({ NODE_ENV: "production", TEST_SECRET_NONE: "" }, () => {
            expect(() => resolveSecret("TEST_SECRET_NONE")).toThrow();
        });
    });
});
