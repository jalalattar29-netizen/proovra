/**
 * PHASE 37.96 — Integration harness guard tests.
 *
 * The harness module ships safety guards that MUST hold before any live
 * integration test touches a database. These tests verify the guards
 * trigger correctly so a misconfigured env never silently runs against
 * the wrong DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertLiveIntegrationEnv, isLiveIntegrationEnabled, } from "./integration-harness.js";
describe("Phase 37.96 — integration harness env guards", () => {
    const original = {
        RUN_LIVE_INTEGRATION: process.env.RUN_LIVE_INTEGRATION,
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
        RUN_LIVE_INTEGRATION_DB_OK: process.env.RUN_LIVE_INTEGRATION_DB_OK,
        RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS: process.env.RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS,
    };
    beforeEach(() => {
        delete process.env.RUN_LIVE_INTEGRATION;
        delete process.env.TEST_DATABASE_URL;
        delete process.env.RUN_LIVE_INTEGRATION_DB_OK;
        // Phase 37.99 — force-disable testcontainers mode for the guard
        // tests. The default (testcontainers ON) makes the harness accept a
        // missing TEST_DATABASE_URL because it can boot its own Postgres;
        // the strict-mode guards we test below still hold when the operator
        // opts out of testcontainers.
        process.env.RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS = "1";
    });
    afterEach(() => {
        // Restore so the surrounding test environment is untouched.
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
        delete process.env.RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS;
    });
    it("isLiveIntegrationEnabled returns false when the flag is unset", () => {
        expect(isLiveIntegrationEnabled()).toBe(false);
    });
    it("isLiveIntegrationEnabled returns true when RUN_LIVE_INTEGRATION=1", () => {
        process.env.RUN_LIVE_INTEGRATION = "1";
        expect(isLiveIntegrationEnabled()).toBe(true);
    });
    it("assertLiveIntegrationEnv throws when RUN_LIVE_INTEGRATION is unset", () => {
        expect(() => assertLiveIntegrationEnv()).toThrow(/RUN_LIVE_INTEGRATION/);
    });
    it("assertLiveIntegrationEnv throws when TEST_DATABASE_URL is unset", () => {
        process.env.RUN_LIVE_INTEGRATION = "1";
        expect(() => assertLiveIntegrationEnv()).toThrow(/TEST_DATABASE_URL/);
    });
    it("assertLiveIntegrationEnv refuses a DB name that does not contain 'test'", () => {
        process.env.RUN_LIVE_INTEGRATION = "1";
        process.env.TEST_DATABASE_URL =
            "postgres://user:pass@localhost:5432/proovra_production";
        expect(() => assertLiveIntegrationEnv()).toThrow(/Refusing to run/);
    });
    it("assertLiveIntegrationEnv accepts a DB name containing 'test'", () => {
        process.env.RUN_LIVE_INTEGRATION = "1";
        process.env.TEST_DATABASE_URL =
            "postgres://user:pass@localhost:5432/proovra_integration_test";
        expect(() => assertLiveIntegrationEnv()).not.toThrow();
    });
    it("assertLiveIntegrationEnv accepts a non-test DB name only with explicit override", () => {
        process.env.RUN_LIVE_INTEGRATION = "1";
        process.env.TEST_DATABASE_URL =
            "postgres://user:pass@localhost:5432/proovra_sandbox";
        expect(() => assertLiveIntegrationEnv()).toThrow();
        process.env.RUN_LIVE_INTEGRATION_DB_OK = "1";
        expect(() => assertLiveIntegrationEnv()).not.toThrow();
    });
    it("assertLiveIntegrationEnv never reads DATABASE_URL (production safety)", () => {
        process.env.RUN_LIVE_INTEGRATION = "1";
        // Even with DATABASE_URL set to a non-test DB, the harness must NOT
        // pick it up — it only ever reads TEST_DATABASE_URL.
        process.env.DATABASE_URL =
            "postgres://prod:prod@prod-host:5432/proovra_production";
        expect(() => assertLiveIntegrationEnv()).toThrow(/TEST_DATABASE_URL/);
    });
    it("assertLiveIntegrationEnv accepts missing TEST_DATABASE_URL when testcontainers mode is ON", () => {
        // Phase 37.99 — testcontainers default. With TEST_DATABASE_URL
        // unset AND testcontainers NOT explicitly disabled, the harness
        // returns a stub url ("") so bootIntegrationHarness can launch its
        // own Postgres container.
        delete process.env.RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS;
        process.env.RUN_LIVE_INTEGRATION = "1";
        expect(() => assertLiveIntegrationEnv()).not.toThrow();
        // Re-enable the opt-out for subsequent tests in this block.
        process.env.RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS = "1";
    });
});
