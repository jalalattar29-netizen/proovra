/**
 * IDENT-012 — the redirect guard, tried with the strings a browser normalises.
 * IDENT-021 — an SP signing key is sealed at rest and still signs.
 * OPS-014 — the ACS URL has one reader of the configured value.
 */
import { afterEach, describe, expect, it } from "vitest";

import { isSafeRedirectAfter, safeIntendedDestination } from "@proovra/shared";

import { samlAcsUrl, samlSpSigningKey } from "../src/services/access-control/sso-endpoints.js";
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

  it("falls back to the older name, then to the request", () => {
    delete process.env["SAML_SP_ACS_URL"];
    process.env["SAML_ACS_URL"] = "https://legacy.example.test/acs";
    expect(samlAcsUrl(req)).toBe("https://legacy.example.test/acs");
    delete process.env["SAML_ACS_URL"];
    expect(samlAcsUrl(req)).toBe("https://api.example.test/v1/auth/saml/acs");
  });
});
