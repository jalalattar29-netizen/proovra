/**
 * IDENT-012 — the redirect guard, tried with the strings a browser normalises.
 * IDENT-021 — an SP signing key is sealed at rest and still signs.
 * OPS-014 — the ACS URL has one reader of the configured value.
 */
import { afterEach, describe, expect, it } from "vitest";

import { isSafeRedirectAfter, safeIntendedDestination } from "@proovra/shared";

import { oidcRedirectUri, samlAcsUrl, samlSpSigningKey } from "../src/services/access-control/sso-endpoints.js";
import { isSealedText, openSealedText, sealText } from "../src/services/security/sealed-text.js";

describe("isSafeRedirectAfter", () => {
  const offSite = [
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "/\\/evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
  ];
  for (const value of offSite) {
    it(`refuses ${JSON.stringify(value)}, which a browser would take off the site`, () => {
      expect(isSafeRedirectAfter(value)).toBe(false);
      expect(safeIntendedDestination(value)).toBe("/");
    });
  }

  const inApp = ["/home", "/evidence/abc?tab=1#x", "/a/b/c", "/search?q=a%2Fb"];
  for (const value of inApp) {
    it(`keeps ${value}`, () => {
      expect(isSafeRedirectAfter(value)).toBe(true);
      expect(safeIntendedDestination(value)).toBe(value);
    });
  }

  it("an allowed origin still passes, and only that one", () => {
    expect(isSafeRedirectAfter("https://app.example/x", ["https://app.example"])).toBe(true);
    expect(isSafeRedirectAfter("https://other.example/x", ["https://app.example"])).toBe(false);
  });
});

describe("sealed text", () => {
  it("round-trips, and the stored form holds no plaintext", () => {
    const sealed = sealText("client-secret-value");
    expect(isSealedText(sealed)).toBe(true);
    expect(sealed).not.toContain("client-secret-value");
    expect(openSealedText(sealed)).toBe("client-secret-value");
    expect(sealText("client-secret-value")).not.toBe(sealed);
  });

  it("refuses a tampered envelope rather than returning garbage", () => {
    const sealed = sealText("client-secret-value");
    const last = sealed.slice(-2);
    const tampered = sealed.slice(0, -2) + (last === "AA" ? "BB" : "AA");
    expect(() => openSealedText(tampered)).toThrow();
    expect(() => openSealedText("not sealed")).toThrow();
  });

  it("a sealed SP key signs, and one stored before sealing is read as it is", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    expect(samlSpSigningKey(sealText(pem))).toBe(pem);
    expect(samlSpSigningKey(pem)).toBe(pem);
  });
});

describe("the ACS URL", () => {
  const saved = { sp: process.env["SAML_SP_ACS_URL"], acs: process.env["SAML_ACS_URL"] };
  afterEach(() => {
    if (saved.sp === undefined) delete process.env["SAML_SP_ACS_URL"];
    else process.env["SAML_SP_ACS_URL"] = saved.sp;
    if (saved.acs === undefined) delete process.env["SAML_ACS_URL"];
    else process.env["SAML_ACS_URL"] = saved.acs;
  });
  const req = { headers: { host: "api.example.test", "x-forwarded-proto": "https" } } as never;

  it("is the value the boot guard validates", () => {
    process.env["SAML_SP_ACS_URL"] = "https://sp.example.test/acs";
    process.env["SAML_ACS_URL"] = "https://legacy.example.test/acs";
    expect(samlAcsUrl(req)).toBe("https://sp.example.test/acs");
  });

  it("falls back to the older name, then to the configured API origin, never the Host header (PRO-036)", () => {
    const savedBase = process.env["API_BASE_URL"];
    try {
      delete process.env["SAML_SP_ACS_URL"];
      process.env["SAML_ACS_URL"] = "https://legacy.example.test/acs";
      expect(samlAcsUrl(req)).toBe("https://legacy.example.test/acs");
      delete process.env["SAML_ACS_URL"];
      process.env["API_BASE_URL"] = "https://api.configured.test/";
      expect(samlAcsUrl(req)).toBe("https://api.configured.test/v1/auth/saml/acs");
      const hostile = { headers: { host: "evil.invalid", "x-forwarded-proto": "http" } } as never;
      expect(samlAcsUrl(hostile)).toBe("https://api.configured.test/v1/auth/saml/acs");
    } finally {
      if (savedBase === undefined) delete process.env["API_BASE_URL"];
      else process.env["API_BASE_URL"] = savedBase;
    }
  });

  it("the OIDC redirect_uri is never taken from the Host header (PRO-036)", () => {
    const saved2 = { base: process.env["API_BASE_URL"], cb: process.env["SSO_CALLBACK_REDIRECT_URI"] };
    try {
      delete process.env["SSO_CALLBACK_REDIRECT_URI"];
      process.env["API_BASE_URL"] = "https://api.configured.test";
      const hostile = { headers: { host: "evil.invalid" } } as never;
      expect(oidcRedirectUri(hostile)).toBe("https://api.configured.test/v1/auth/sso/callback");
      process.env["SSO_CALLBACK_REDIRECT_URI"] = "https://api.explicit.test/v1/auth/sso/callback";
      expect(oidcRedirectUri(hostile)).toBe("https://api.explicit.test/v1/auth/sso/callback");
    } finally {
      for (const [k, v] of [["API_BASE_URL", saved2.base], ["SSO_CALLBACK_REDIRECT_URI", saved2.cb]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
