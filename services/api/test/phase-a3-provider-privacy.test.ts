/**
 * Phase A3 — Provider privacy / No-training enforcement (behavioral).
 *
 * Proves: store:false is the default request posture; project/org binding is
 * derived from env; startup validation warns/blocks correctly; and the
 * Responses call actually passes the `store` option.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  getProviderPrivacyStatus,
  openAiClientPrivacyOptions,
  openAiRequestStore,
  resolveOpenAiPrivacyConfig,
  validateProviderPrivacyConfig,
} from "../src/services/ai/provider-privacy.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const OPENAI_PROVIDER = readSource(
  "../../../services/api/src/services/ai/openai-provider.ts",
);

const SAVE = {
  OPENAI_STORE: process.env.OPENAI_STORE,
  OPENAI_PROJECT: process.env.OPENAI_PROJECT,
  OPENAI_ORG: process.env.OPENAI_ORG,
  OPENAI_DATA_USE_MODE: process.env.OPENAI_DATA_USE_MODE,
  AI_REQUIRE_PROVIDER_PRIVACY: process.env.AI_REQUIRE_PROVIDER_PRIVACY,
  NODE_ENV: process.env.NODE_ENV,
};

afterEach(() => {
  for (const [k, v] of Object.entries(SAVE)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("Phase A3 — request storage posture", () => {
  it("store defaults to FALSE (no-training posture)", () => {
    delete process.env.OPENAI_STORE;
    expect(openAiRequestStore()).toBe(false);
    expect(resolveOpenAiPrivacyConfig().requestStorageDisabled).toBe(true);
  });
  it("operator can override to store:true (weakens posture, flagged)", () => {
    process.env.OPENAI_STORE = "true";
    expect(openAiRequestStore()).toBe(true);
    const v = validateProviderPrivacyConfig();
    expect(v.ok).toBe(false);
    expect(v.code).toBe("PRIVACY_STORAGE_ENABLED");
  });
  it("Responses request actually passes the store option", () => {
    expect(OPENAI_PROVIDER).toMatch(/store:\s*openAiRequestStore\(\)/);
  });
});

describe("Phase A3 — project/org binding + validation", () => {
  it("binds project/org from env", () => {
    delete process.env.OPENAI_PROJECT;
    delete process.env.OPENAI_ORG;
    expect(openAiClientPrivacyOptions()).toEqual({});
    process.env.OPENAI_PROJECT = "proj_test";
    expect(openAiClientPrivacyOptions().project).toBe("proj_test");
  });
  it("production + unknown data-use mode warns; strict mode blocks", () => {
    process.env.NODE_ENV = "production";
    delete process.env.OPENAI_STORE;
    delete process.env.OPENAI_DATA_USE_MODE;
    delete process.env.AI_REQUIRE_PROVIDER_PRIVACY;
    let v = validateProviderPrivacyConfig();
    expect(v.code).toBe("PRIVACY_MODE_UNKNOWN");
    expect(v.severity).toBe("warn");
    process.env.AI_REQUIRE_PROVIDER_PRIVACY = "true";
    v = validateProviderPrivacyConfig();
    expect(v.severity).toBe("block");
  });
  it("declared NO_TRAINING mode + store:false → OK", () => {
    process.env.NODE_ENV = "production";
    delete process.env.OPENAI_STORE;
    process.env.OPENAI_DATA_USE_MODE = "NO_TRAINING";
    const v = validateProviderPrivacyConfig();
    expect(v.ok).toBe(true);
    expect(v.code).toBe("PRIVACY_CONFIG_OK");
  });
  it("status projection carries no secrets", () => {
    const status = getProviderPrivacyStatus();
    const json = JSON.stringify(status);
    expect(json).not.toMatch(/sk-|apiKey|OPENAI_API_KEY/);
    expect(status).toHaveProperty("requestStorageDisabled");
    expect(status).toHaveProperty("dataUseMode");
  });
});
