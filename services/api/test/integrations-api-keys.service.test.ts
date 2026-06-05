/**
 * Phase 10 — API credentials service unit tests.
 *
 * No DB. Tests the feature-flag / hashing / issuance / scope surface
 * in isolation. CRUD that depends on Prisma lives in DB integration
 * tests, not here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  constantTimeEqualHex,
  filterValidScopes,
  getIntegrationsRuntimeDiagnostics,
  hashIncomingApiKey,
  integrationsFeatureDisabledReason,
  isIntegrationsFeatureEnabled,
  isValidScope,
  issueApiKey,
  scopesGrantPermission,
} from "../src/services/integrations/api-keys.service.js";
import { parseApiKeyShape } from "@proovra/shared";

const TEST_SECRET = "a".repeat(64);

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("api credentials — feature flag", () => {
  let originalFlag: string | undefined;
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.INTEGRATIONS_ENABLED;
    originalSecret = process.env.API_KEY_SECRET;
    delete process.env.INTEGRATIONS_ENABLED;
    delete process.env.API_KEY_SECRET;
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.INTEGRATIONS_ENABLED;
    else process.env.INTEGRATIONS_ENABLED = originalFlag;
    if (originalSecret === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = originalSecret;
  });

  it("disabled when neither flag nor secret is set", () => {
    expect(isIntegrationsFeatureEnabled()).toBe(false);
    expect(integrationsFeatureDisabledReason()).toBe("feature_flag_off");
  });

  it("reports secret_missing when flag is on but secret is short", () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = "tiny";
    expect(isIntegrationsFeatureEnabled()).toBe(true);
    expect(integrationsFeatureDisabledReason()).toBe("secret_missing");
  });

  it("reports enabled when both flag and a 32+ char secret are set", () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = TEST_SECRET;
    expect(integrationsFeatureDisabledReason()).toBeNull();
  });
});

describe("api credentials — issue + verify", () => {
  it("issueApiKey returns null when secret is missing", () => {
    withEnv({ INTEGRATIONS_ENABLED: "true", API_KEY_SECRET: undefined }, () => {
      expect(issueApiKey()).toBeNull();
    });
  });

  it("issueApiKey produces a valid pwk-shaped key + matching hash", () => {
    withEnv(
      { INTEGRATIONS_ENABLED: "true", API_KEY_SECRET: TEST_SECRET },
      () => {
        const issued = issueApiKey();
        expect(issued).not.toBeNull();
        if (!issued) return;
        const shape = parseApiKeyShape(issued.rawKey);
        expect(shape).not.toBeNull();
        expect(issued.keyHash).toMatch(/^[0-9a-f]{64}$/);
        // Hashing the same raw key with our HMAC must reproduce the stored hash.
        const recomputed = hashIncomingApiKey(issued.rawKey);
        expect(recomputed).toBe(issued.keyHash);
      },
    );
  });

  it("issueApiKey produces unique keys / hashes per call", () => {
    withEnv(
      { INTEGRATIONS_ENABLED: "true", API_KEY_SECRET: TEST_SECRET },
      () => {
        const a = issueApiKey();
        const b = issueApiKey();
        expect(a?.rawKey).not.toBe(b?.rawKey);
        expect(a?.keyHash).not.toBe(b?.keyHash);
      },
    );
  });

  it("hashIncomingApiKey returns null for malformed inputs", () => {
    withEnv(
      { INTEGRATIONS_ENABLED: "true", API_KEY_SECRET: TEST_SECRET },
      () => {
        expect(hashIncomingApiKey("not-a-key")).toBeNull();
        expect(hashIncomingApiKey("")).toBeNull();
        expect(hashIncomingApiKey("xyz_v1_short")).toBeNull();
      },
    );
  });

  it("constantTimeEqualHex rejects mismatched / non-hex strings", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(constantTimeEqualHex(a, a)).toBe(true);
    expect(constantTimeEqualHex(a, b)).toBe(false);
    expect(constantTimeEqualHex("nope", "nope")).toBe(false);
    expect(constantTimeEqualHex("a".repeat(63), "a".repeat(63))).toBe(false);
  });
});

describe("api credentials — runtime diagnostics", () => {
  let originalFlag: string | undefined;
  let originalSecret: string | undefined;
  let originalCron: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.INTEGRATIONS_ENABLED;
    originalSecret = process.env.API_KEY_SECRET;
    originalCron = process.env.INTEGRATION_CRON_SECRET;
    delete process.env.INTEGRATIONS_ENABLED;
    delete process.env.API_KEY_SECRET;
    delete process.env.INTEGRATION_CRON_SECRET;
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.INTEGRATIONS_ENABLED;
    else process.env.INTEGRATIONS_ENABLED = originalFlag;
    if (originalSecret === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = originalSecret;
    if (originalCron === undefined) delete process.env.INTEGRATION_CRON_SECRET;
    else process.env.INTEGRATION_CRON_SECRET = originalCron;
  });

  it("reports feature_flag_off + unbound secrets when nothing is set", () => {
    const d = getIntegrationsRuntimeDiagnostics();
    expect(d.enabled).toBe(false);
    expect(d.reason).toBe("feature_flag_off");
    expect(d.apiKeySecretBound).toBe(false);
    expect(d.apiKeySecretLengthValid).toBe(false);
    expect(d.cronSecretBound).toBe(false);
  });

  it("reports secret_missing when flag is on but secret is unset", () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    const d = getIntegrationsRuntimeDiagnostics();
    expect(d.enabled).toBe(false);
    expect(d.reason).toBe("secret_missing");
    expect(d.apiKeySecretBound).toBe(false);
    expect(d.apiKeySecretLengthValid).toBe(false);
  });

  it("reports secret_missing + bound-but-too-short when secret < 32", () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = "tiny";
    const d = getIntegrationsRuntimeDiagnostics();
    expect(d.enabled).toBe(false);
    expect(d.reason).toBe("secret_missing");
    expect(d.apiKeySecretBound).toBe(true);
    expect(d.apiKeySecretLengthValid).toBe(false);
  });

  it("reports enabled=true + all secrets ok when fully configured", () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = TEST_SECRET;
    process.env.INTEGRATION_CRON_SECRET = "c".repeat(40);
    const d = getIntegrationsRuntimeDiagnostics();
    expect(d.enabled).toBe(true);
    expect(d.reason).toBeNull();
    expect(d.apiKeySecretBound).toBe(true);
    expect(d.apiKeySecretLengthValid).toBe(true);
    expect(d.cronSecretBound).toBe(true);
  });

  it("never exposes the secret value or its exact length", () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = TEST_SECRET;
    process.env.INTEGRATION_CRON_SECRET = "c".repeat(40);
    const d = getIntegrationsRuntimeDiagnostics();
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain(TEST_SECRET);
    expect(serialized).not.toContain("c".repeat(40));
    // No numeric length field should be exposed.
    expect(serialized).not.toMatch(/"length"\s*:/);
  });
});

describe("api credentials — scope catalog", () => {
  it("isValidScope accepts known canonical permissions", () => {
    expect(isValidScope("integration.evidence.read")).toBe(true);
    expect(isValidScope("evidence.read")).toBe(true);
  });

  it("isValidScope rejects unknown identifiers", () => {
    expect(isValidScope("not.a.real.scope")).toBe(false);
    expect(isValidScope("")).toBe(false);
  });

  it("filterValidScopes returns only canonical entries, in order", () => {
    const result = filterValidScopes([
      "integration.evidence.read",
      "garbage",
      "integration.intake_link.create",
    ]);
    expect(result).toEqual([
      "integration.evidence.read",
      "integration.intake_link.create",
    ]);
  });

  it("scopesGrantPermission performs exact-match lookup", () => {
    const scopes = [
      "integration.evidence.read",
      "integration.intake_link.create",
    ];
    expect(scopesGrantPermission(scopes, "integration.evidence.read")).toBe(
      true,
    );
    expect(scopesGrantPermission(scopes, "integration.evidence.create")).toBe(
      false,
    );
  });
});
