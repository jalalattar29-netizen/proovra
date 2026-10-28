/**
 * WEBAUTHN RELYING-PARTY CONFIGURATION — boot and readiness (2026-10-28).
 *
 * Every passkey caller treats a config the parser refuses as "passkeys
 * unavailable". That is right for one ceremony and silent for the deployment:
 * a passkey holder's step-up quietly falls to a weaker authenticator. So the
 * SAME parser is now consulted by startup validation, and a refused config is a
 * production config violation — boot refused, `/readyz` 503 — reported as a
 * variable name and a bounded code, never a value.
 *
 * What this does NOT prove: that a browser completes a ceremony against this
 * RP. It proves which RP id and which exact origins the verifier is handed.
 */
import { afterEach, describe, expect, it } from "vitest";

import { collectStartupViolations } from "../src/config/index.js";
import {
  inspectWebauthnConfig,
  resolveWebauthnConfig,
} from "../src/services/identity-security/webauthn-config.js";

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

/** The Production decision of 2026-10-28. */
const DECISION = { WEBAUTHN_RP_ID: "proovra.com", WEBAUTHN_ORIGINS: "https://app.proovra.com" };

/** A production environment with no violation of any kind — the control. */
const CLEAN_PRODUCTION = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://probe:probe@127.0.0.1:1/probe",
  AUTH_JWT_SECRET: "u8Jq2Zr7Kx0bP4mW1sVd9TgHc6NeLfYa3RoXiE5k",
  IDENTITY_SECURITY_HASH_SECRET: "k".repeat(40),
  SIGNING_PRIVATE_KEY_PATH: "/run/signing/key.pem",
  PDF_SIGNING_ENABLED: "true",
  S3_OBJECT_LOCK_ENABLED: "true",
  S3_OBJECT_LOCK_MODE: "COMPLIANCE",
};

const violationsUnder = (env: Record<string, string | undefined>) => {
  process.env = { ...env } as NodeJS.ProcessEnv;
  return collectStartupViolations();
};

describe("the canonical parser — the Production decision", () => {
  it("binds RP id proovra.com and EXACTLY the one origin https://app.proovra.com", () => {
    const config = resolveWebauthnConfig({ ...DECISION, APP_BASE_URL: "https://app.proovra.com" });
    expect(config.rpID).toBe("proovra.com");
    expect(config.origins).toEqual(["https://app.proovra.com"]);
  });

  it("the origin list is exact: the apex, www, other subdomains and look-alikes are not in it", () => {
    // The verifier is handed this array; a ceremony from any origin not in it
    // is refused. Being inside the RP id is necessary, not sufficient.
    const { origins } = resolveWebauthnConfig(DECISION);
    for (const other of [
      "https://proovra.com",
      "https://www.proovra.com",
      "https://admin.proovra.com",
      "http://app.proovra.com",
      "https://app.proovra.com.attacker.example",
      "https://app.proovra.com:8443",
    ]) {
      expect(origins, other).not.toContain(other);
    }
  });

  it("an origin is normalised to URL.origin (default port and path dropped), then de-duplicated", () => {
    const { origins } = resolveWebauthnConfig({
      ...DECISION,
      WEBAUTHN_ORIGINS: "https://app.proovra.com:443/login, https://app.proovra.com",
    });
    expect(origins).toEqual(["https://app.proovra.com"]);
  });

  it("inspection reports where each half came from", () => {
    const explicit = inspectWebauthnConfig(DECISION);
    expect(explicit.ok && explicit.basis).toEqual({ rpID: "explicit", origins: "explicit" });

    const derived = inspectWebauthnConfig({ APP_BASE_URL: "https://app.proovra.com" });
    expect(derived.ok && derived.basis).toEqual({ rpID: "app_base_url", origins: "app_base_url" });
    // The derived RP id is the APP host, not the apex — which is why the
    // Production decision sets it explicitly.
    expect(derived.ok && derived.config.rpID).toBe("app.proovra.com");
  });
});

describe("the canonical parser — malformed configuration is a bounded code naming the variable", () => {
  it.each([
    [{ ...DECISION, WEBAUTHN_RP_ID: "https://proovra.com" }, "WEBAUTHN_RP_ID", "webauthn_rp_not_host"],
    [{ ...DECISION, WEBAUTHN_RP_ID: "proovra.com/" }, "WEBAUTHN_RP_ID", "webauthn_rp_not_host"],
    [{ ...DECISION, WEBAUTHN_ORIGINS: "app.proovra.com" }, "WEBAUTHN_ORIGINS", "webauthn_origin_not_url"],
    [{ ...DECISION, WEBAUTHN_ORIGINS: "http://app.proovra.com" }, "WEBAUTHN_ORIGINS", "webauthn_origin_insecure"],
    [{ ...DECISION, WEBAUTHN_ORIGINS: " , " }, "WEBAUTHN_ORIGINS", "webauthn_origins_empty"],
    [{ ...DECISION, WEBAUTHN_ORIGINS: "https://app.example.net" }, "WEBAUTHN_ORIGINS", "webauthn_origin_outside_rp"],
    [{ APP_BASE_URL: "not a url" }, "APP_BASE_URL", "webauthn_origin_not_url"],
    [{ APP_BASE_URL: "http://203.0.113.7:3000" }, "APP_BASE_URL", "webauthn_origin_insecure"],
  ])("%j → %s / %s", (env, envName, issue) => {
    expect(inspectWebauthnConfig(env)).toEqual({ ok: false, envName, issue });
  });
});

describe("collectStartupViolations — WebAuthn", () => {
  it("production with the decision values: no violation of any kind (the control)", () => {
    expect(violationsUnder({ ...CLEAN_PRODUCTION, ...DECISION })).toEqual([]);
  });

  it("production with neither value set: the documented default parses, so nothing is refused", () => {
    expect(violationsUnder(CLEAN_PRODUCTION)).toEqual([]);
  });

  it("production with a malformed value: exactly one violation, name and code only — never the value", () => {
    const value = "https://app.attacker-controlled.example";
    const violations = violationsUnder({ ...CLEAN_PRODUCTION, ...DECISION, WEBAUTHN_ORIGINS: value });
    expect(violations).toEqual([{ envName: "WEBAUTHN_ORIGINS", reason: "webauthn_origin_outside_rp" }]);
    expect(JSON.stringify(violations)).not.toContain("attacker");
  });

  it("staging is a deployed environment and is judged the same way", () => {
    expect(
      violationsUnder({ ...CLEAN_PRODUCTION, PROOVRA_ENV: "staging", ...DECISION, WEBAUTHN_RP_ID: "https://x" }),
    ).toEqual([{ envName: "WEBAUTHN_RP_ID", reason: "webauthn_rp_not_host" }]);
  });

  it("development and test fixtures are not judged", () => {
    expect(
      violationsUnder({ NODE_ENV: "development", APP_BASE_URL: "http://127.0.0.1:53000" }).filter((v) =>
        v.reason.startsWith("webauthn_"),
      ),
    ).toEqual([]);
  });
});
