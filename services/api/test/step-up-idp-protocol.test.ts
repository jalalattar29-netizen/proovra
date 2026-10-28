/**
 * 2026-10-28 — IDP_REAUTH step-up: the protocol pieces, without a database.
 *
 *   - the PRODUCTION SAML validator extracts AuthnInstant (and refuses to
 *     guess one that is absent or malformed);
 *   - an AuthnRequest asks for RequestedAuthnContext Comparison="exact" only
 *     when contexts are given, and ForceAuthn only when asked;
 *   - the Organization policy projection coerces and normalises the four
 *     step-up fields (unknown assurance fails toward the stronger level).
 */
import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { validateSamlResponse } from "../src/services/security/saml-assertion.service.js";
import { buildSamlAuthnRequest } from "../src/services/security/saml-authn-request.service.js";
import {
  coerceSecurityPolicy,
  defaultSecurityPolicy,
  normaliseIdpStepUpContexts,
} from "../src/services/identity/enterprise-security-policy.policy.js";
import {
  ACS_URL,
  buildSignedSamlResponse,
  IDP_CERT_B64,
  IDP_ISSUER,
  SP_ENTITY_ID,
} from "./_fixtures/saml-signed-fixture.js";

function validate(b64: string) {
  return validateSamlResponse({
    samlResponseBase64: b64,
    idpCertificate: IDP_CERT_B64,
    idpCertificateNext: null,
    spEntityId: SP_ENTITY_ID,
    expectedInResponseTo: "authn-req-1",
    allowedClockSkewSeconds: 60,
    expectedIdpEntityId: IDP_ISSUER,
    requireAudience: true,
    expectedAcsUrl: ACS_URL,
    requireRecipientDestination: true,
  });
}

function requestXml(redirectUrl: string): string {
  const u = new URL(redirectUrl);
  return inflateRawSync(Buffer.from(u.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
}

describe("SAML AuthnInstant extraction", () => {
  it("returns the signed AuthnInstant and the context class", () => {
    const at = new Date("2026-10-28T10:11:12.345Z");
    const a = validate(buildSignedSamlResponse({ authnInstant: at, authnContextClassRef: "urn:ctx:x509" }));
    expect(a.authnInstant?.toISOString()).toBe(at.toISOString());
    expect(a.authnContextClassRef).toBe("urn:ctx:x509");
  });

  it("is null when the IdP sent none (never substituted with IssueInstant)", () => {
    const a = validate(buildSignedSamlResponse({ authnInstant: null }));
    expect(a.authnInstant).toBeNull();
  });

  it("the default fixture still validates exactly as before", () => {
    const a = validate(buildSignedSamlResponse());
    expect(a.nameId).toBe("user@example.com");
    expect(a.authnContextClassRef).toBe("urn:oasis:names:tc:SAML:2.0:ac:classes:Password");
    expect(a.authnInstant).not.toBeNull();
  });
});

describe("AuthnRequest — forced reauthentication + requested context", () => {
  const base = {
    connectionId: "conn-1",
    spEntityId: SP_ENTITY_ID,
    acsUrl: ACS_URL,
    idpSsoUrl: "https://idp.example.com/sso",
  };

  it("ordinary sign-in: ForceAuthn false, no RequestedAuthnContext (unchanged)", () => {
    const xml = requestXml(buildSamlAuthnRequest(base).redirectUrl);
    expect(xml).toContain('ForceAuthn="false"');
    expect(xml).not.toContain("RequestedAuthnContext");
  });

  it("step-up: ForceAuthn true and Comparison=exact listing every accepted context, escaped", () => {
    const xml = requestXml(
      buildSamlAuthnRequest({
        ...base,
        forceAuthn: true,
        requestedAuthnContextClassRefs: ["urn:a", "urn:b&c"],
      }).redirectUrl,
    );
    expect(xml).toContain('ForceAuthn="true"');
    expect(xml).toContain(
      '<samlp:RequestedAuthnContext Comparison="exact"><saml:AuthnContextClassRef>urn:a</saml:AuthnContextClassRef><saml:AuthnContextClassRef>urn:b&amp;c</saml:AuthnContextClassRef></samlp:RequestedAuthnContext></samlp:AuthnRequest>',
    );
    // Schema order: NameIDPolicy precedes RequestedAuthnContext.
    expect(xml.indexOf("NameIDPolicy")).toBeLessThan(xml.indexOf("RequestedAuthnContext"));
  });
});

describe("Organization policy — step-up fields", () => {
  it("defaults: STANDARD, SMS allowed, no contexts, 300 s", () => {
    const d = defaultSecurityPolicy("t", "o");
    expect(d.stepUpAssurance).toBe("STANDARD");
    expect(d.stepUpSmsAllowed).toBe(true);
    expect(d.idpStepUpAcceptedContexts).toEqual([]);
    expect(d.idpStepUpMaxAgeSeconds).toBe(300);
  });

  it("coerces a stored row; an unknown assurance fails toward PHISHING_RESISTANT; age is clamped", () => {
    const p = coerceSecurityPolicy("t", "o", {
      stepUpAssurance: "SOMETHING_NEW",
      stepUpSmsAllowed: false,
      idpStepUpAcceptedContexts: [" a ", "a", "", "b"],
      idpStepUpMaxAgeSeconds: 99999,
    });
    expect(p.stepUpAssurance).toBe("PHISHING_RESISTANT");
    expect(p.stepUpSmsAllowed).toBe(false);
    expect(p.idpStepUpAcceptedContexts).toEqual(["a", "b"]);
    expect(p.idpStepUpMaxAgeSeconds).toBe(3600);
  });

  it("normalises contexts: trimmed, blanks dropped, first occurrence kept", () => {
    expect(normaliseIdpStepUpContexts(["  x ", "y", "x", "   "])).toEqual(["x", "y"]);
  });
});
