/**
 * Phase P2.0 — AWS Secrets Manager integration contract suite.
 *
 * Runtime tests against the loader + accessor:
 *
 *   1. AWS disabled → loader is a no-op, env fallback works.
 *   2. AWS enabled + hydration succeeds → AWS values take precedence.
 *   3. AWS enabled + hydration fails → app continues; env fallback.
 *   4. Missing secret → resolver returns `missing`, requireSecret throws.
 *   5. `getSecretsHealth()` never exposes values.
 *   6. `getMigratedSecretsAudit()` reports source per name without values.
 *
 * Source-contract assertions:
 *   7. The route file registers `/v1/runtime/secrets-health`.
 *   8. The migrated secret allowlist is exactly the documented 5.
 *   9. The bounded metric registry carries the 4 secrets keys.
 *   10. Server bootstrap calls `initSecretsManager` BEFORE
 *       `runStartupConfigValidation`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedSecret, getSecretsHealth, __resetSecretsManagerForTests, initSecretsManager, } from "../src/config/secrets-manager.js";
import { getMigratedSecretsAudit, getSecret, MIGRATED_SECRETS, requireSecret, resolveRuntimeSecret, } from "../src/config/runtime-secrets.js";
function readSource(rel) {
    const url = new URL(rel, import.meta.url);
    return readFileSync(fileURLToPath(url), "utf8");
}
const noopLog = {
    info: () => undefined,
    warn: () => undefined,
};
describe("Phase P2.0 — Secrets Manager runtime behaviour", () => {
    beforeEach(() => {
        __resetSecretsManagerForTests();
        delete process.env.AWS_SECRETS_ENABLED;
        delete process.env.AWS_SECRET_NAME;
        delete process.env.AWS_REGION;
        delete process.env.OPENAI_API_KEY;
        delete process.env.AUTH_JWT_SECRET;
        delete process.env.STRIPE_SECRET_KEY;
        delete process.env.PAYPAL_SECRET;
        delete process.env.RESEND_API_KEY;
        vi.restoreAllMocks();
    });
    it("is a no-op when AWS_SECRETS_ENABLED is not set", async () => {
        process.env.OPENAI_API_KEY = "env-openai-key";
        await initSecretsManager(noopLog);
        const h = getSecretsHealth();
        expect(h.awsEnabled).toBe(false);
        expect(h.fallbackMode).toBe("env_only");
        expect(h.cacheLoaded).toBe(false);
        expect(h.cachedKeyCount).toBe(0);
        expect(getCachedSecret("OPENAI_API_KEY")).toBeNull();
        // Accessor still returns the env value.
        expect(getSecret("OPENAI_API_KEY")).toBe("env-openai-key");
    });
    it("resolves via env when AWS is enabled but not connected", async () => {
        process.env.AWS_SECRETS_ENABLED = "true";
        process.env.AWS_SECRET_NAME = "proovra/test/missing";
        process.env.AWS_REGION = "us-east-1";
        process.env.AUTH_JWT_SECRET = "env-jwt-secret";
        // Mock the AWS client to throw a network-class error.
        const mod = await import("@aws-sdk/client-secrets-manager");
        vi.spyOn(mod.SecretsManagerClient.prototype, "send").mockRejectedValue(Object.assign(new Error("network unavailable"), { name: "TimeoutError" }));
        await initSecretsManager(noopLog);
        const h = getSecretsHealth();
        expect(h.awsEnabled).toBe(true);
        expect(h.awsConnected).toBe(false);
        expect(h.fallbackMode).toBe("env_only");
        expect(h.lastErrorCode).toBe("network");
        expect(h.degraded).toBe(true);
        expect(getSecret("AUTH_JWT_SECRET")).toBe("env-jwt-secret");
    });
    it("prefers AWS when hydration succeeds with a JSON string body", async () => {
        process.env.AWS_SECRETS_ENABLED = "true";
        process.env.AUTH_JWT_SECRET = "env-jwt-secret"; // should be overridden
        const mod = await import("@aws-sdk/client-secrets-manager");
        vi.spyOn(mod.SecretsManagerClient.prototype, "send").mockResolvedValue({
            SecretString: JSON.stringify({
                AUTH_JWT_SECRET: "aws-jwt-secret",
                STRIPE_SECRET_KEY: "sk_live_aws_value",
            }),
        });
        await initSecretsManager(noopLog);
        const h = getSecretsHealth();
        expect(h.awsConnected).toBe(true);
        expect(h.cacheLoaded).toBe(true);
        expect(h.fallbackMode).toBe("aws_primary");
        expect(h.cachedKeyCount).toBe(2);
        expect(h.degraded).toBe(false);
        // AWS wins over env.
        expect(getSecret("AUTH_JWT_SECRET")).toBe("aws-jwt-secret");
        expect(resolveRuntimeSecret("AUTH_JWT_SECRET").source).toBe("aws");
        expect(resolveRuntimeSecret("STRIPE_SECRET_KEY").source).toBe("aws");
    });
    it("returns missing when neither AWS nor env has the secret", async () => {
        await initSecretsManager(noopLog);
        expect(resolveRuntimeSecret("OPENAI_API_KEY").source).toBe("missing");
        expect(getSecret("OPENAI_API_KEY")).toBeNull();
        expect(() => requireSecret("OPENAI_API_KEY")).toThrow(/Required secret "OPENAI_API_KEY"/);
    });
    it("classifies AWS access-denied error to a bounded code", async () => {
        process.env.AWS_SECRETS_ENABLED = "true";
        const mod = await import("@aws-sdk/client-secrets-manager");
        vi.spyOn(mod.SecretsManagerClient.prototype, "send").mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
        await initSecretsManager(noopLog);
        expect(getSecretsHealth().lastErrorCode).toBe("access_denied");
    });
    it("classifies AWS resource-not-found to `not_found`", async () => {
        process.env.AWS_SECRETS_ENABLED = "true";
        const mod = await import("@aws-sdk/client-secrets-manager");
        vi.spyOn(mod.SecretsManagerClient.prototype, "send").mockRejectedValue(Object.assign(new Error("missing"), { name: "ResourceNotFoundException" }));
        await initSecretsManager(noopLog);
        expect(getSecretsHealth().lastErrorCode).toBe("not_found");
    });
    it("classifies a non-JSON secret body to `decode`", async () => {
        process.env.AWS_SECRETS_ENABLED = "true";
        const mod = await import("@aws-sdk/client-secrets-manager");
        vi.spyOn(mod.SecretsManagerClient.prototype, "send").mockResolvedValue({
            SecretString: "not json",
        });
        await initSecretsManager(noopLog);
        expect(getSecretsHealth().lastErrorCode).toBe("decode");
    });
    it("getSecretsHealth NEVER includes secret values", async () => {
        process.env.AWS_SECRETS_ENABLED = "true";
        const mod = await import("@aws-sdk/client-secrets-manager");
        vi.spyOn(mod.SecretsManagerClient.prototype, "send").mockResolvedValue({
            SecretString: JSON.stringify({ AUTH_JWT_SECRET: "very-secret-value" }),
        });
        await initSecretsManager(noopLog);
        const h = getSecretsHealth();
        const serialised = JSON.stringify(h);
        expect(serialised).not.toContain("very-secret-value");
        // The cache count is allowed; the names are NOT.
        expect(serialised).not.toContain("AUTH_JWT_SECRET");
    });
    it("getMigratedSecretsAudit reports source per name without values", async () => {
        process.env.AWS_SECRETS_ENABLED = "true";
        process.env.AUTH_JWT_SECRET = "env-only-jwt";
        const mod = await import("@aws-sdk/client-secrets-manager");
        vi.spyOn(mod.SecretsManagerClient.prototype, "send").mockResolvedValue({
            SecretString: JSON.stringify({ STRIPE_SECRET_KEY: "sk_live_aws" }),
        });
        await initSecretsManager(noopLog);
        const audit = getMigratedSecretsAudit();
        const stripeRow = audit.find((r) => r.name === "STRIPE_SECRET_KEY");
        const jwtRow = audit.find((r) => r.name === "AUTH_JWT_SECRET");
        const openaiRow = audit.find((r) => r.name === "OPENAI_API_KEY");
        expect(stripeRow?.source).toBe("aws");
        expect(jwtRow?.source).toBe("env");
        expect(openaiRow?.source).toBe("missing");
        // No `value` field anywhere.
        const serialised = JSON.stringify(audit);
        expect(serialised).not.toContain("sk_live_aws");
        expect(serialised).not.toContain("env-only-jwt");
    });
});
describe("Phase P2.0 — Source-contract assertions", () => {
    it("MIGRATED_SECRETS includes the P2.0 first-wave set as a subset", () => {
        // The exact membership (including the P2.0B second wave) is
        // asserted in `phase-p2-0b-observability-wiring.test.ts`.
        for (const name of [
            "OPENAI_API_KEY",
            "AUTH_JWT_SECRET",
            "STRIPE_SECRET_KEY",
            "PAYPAL_SECRET",
            "RESEND_API_KEY",
        ]) {
            expect(MIGRATED_SECRETS.includes(name)).toBe(true);
        }
    });
    it("/v1/runtime/secrets-health route exists and is registered", () => {
        const routes = readSource("../src/routes/runtime-secrets-health.routes.ts");
        expect(routes).toContain('"/v1/runtime/secrets-health"');
        expect(routes).toContain("runtimeSecretsHealthRoutes");
        const server = readSource("../src/server.ts");
        expect(server).toContain("runtimeSecretsHealthRoutes");
        expect(server).toMatch(/app\.register\(\s*runtimeSecretsHealthRoutes/);
    });
    it("server bootstrap calls initSecretsManager BEFORE runStartupConfigValidation", () => {
        const server = readSource("../src/server.ts");
        const initIdx = server.indexOf("await initSecretsManager(");
        const validateIdx = server.indexOf("runStartupConfigValidation(");
        expect(initIdx).toBeGreaterThan(-1);
        expect(validateIdx).toBeGreaterThan(-1);
        expect(initIdx).toBeLessThan(validateIdx);
    });
    it("bounded metric registry carries the 4 secrets keys", () => {
        const m = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");
        expect(m).toContain('"secrets_fetch_success_total"');
        expect(m).toContain('"secrets_fetch_failure_total"');
        expect(m).toContain('"secrets_cache_refresh_total"');
        expect(m).toContain('"secrets_fallback_total"');
    });
    it("the secrets-manager loader never logs secret values", () => {
        const src = readSource("../src/config/secrets-manager.ts");
        // The loader's logged keys are restricted to:
        //   secretName / region (operator-safe), keyCount (size only),
        //   code / reason (bounded enums).
        // We scan EACH log.* call's argument object for forbidden field
        // names (`values`, `secretString`, `value`, `raw`). The regex
        // matches `log.info({...}, "...")` / `log.warn({...}, "...")`.
        const re = /log\.(info|warn)\(\s*\{([^}]*)\}/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            const body = m[2];
            expect(body).not.toContain("values");
            expect(body).not.toContain("secretString");
            expect(body).not.toMatch(/\bvalue\b/);
            expect(body).not.toMatch(/\braw\b/);
        }
    });
    it("the migrated call-sites import from runtime-secrets, not env directly", () => {
        const sites = [
            {
                file: "../src/middleware/auth.ts",
                importPath: "../config/runtime-secrets.js",
                banned: ["process.env.AUTH_JWT_SECRET"],
            },
            {
                file: "../src/services/ai/ai-provider.ts",
                importPath: "../../config/runtime-secrets.js",
                banned: ["process.env.OPENAI_API_KEY?"],
            },
            {
                file: "../src/services/stripe.service.ts",
                importPath: "../config/runtime-secrets.js",
                banned: [],
            },
            {
                file: "../src/services/paypal.service.ts",
                importPath: "../config/runtime-secrets.js",
                banned: [],
            },
        ];
        for (const { file, importPath, banned } of sites) {
            const src = readSource(file);
            expect(src).toContain(`"${importPath}"`);
            for (const b of banned) {
                expect(src).not.toContain(b);
            }
        }
    });
});
