/**
 * PHASE 8 §11.2 (2026-07-22) — REAL signed-SAML behavioral test.
 *
 * A statically-generated self-signed RSA keypair signs an Assertion with
 * xml-crypto (the SAME library the production validator uses), and the
 * resulting base64 SAMLResponse is fed through the PRODUCTION
 * `validateSamlResponse` path. Positive case proves a well-formed signed
 * assertion validates; negative variants prove each §11.2 control fails
 * CLOSED: tampered signature, wrong issuer, missing/mismatched audience
 * (mandatory), expired conditions, InResponseTo mismatch.
 *
 * This is not a source-string pin — it exercises signature verification,
 * signature-binding, conditions, and audience against real XML.
 */

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  validateSamlResponse,
  SamlAssertionError,
} from "../src/services/security/saml-assertion.service.js";

// PHASE 13 — the keypair, certificate and builder MOVED to the shared
// fixture so the validator suite (this file) and the ACS ROUTE suite
// (phase13-final-002-saml-authorization.integration.test.ts) cannot drift.
import {
  ACS_URL,
  buildSignedSamlResponse,
  IDP_CERT_B64,
  IDP_ISSUER,
  SP_ENTITY_ID,
} from "./_fixtures/saml-signed-fixture.js";

function run(base64: string, over: Partial<Parameters<typeof validateSamlResponse>[0]> = {}) {
  return validateSamlResponse({
    samlResponseBase64: base64,
    idpCertificate: IDP_CERT_B64,
    idpCertificateNext: null,
    spEntityId: SP_ENTITY_ID,
    expectedInResponseTo: "authn-req-1",
    allowedClockSkewSeconds: 60,
    expectedIdpEntityId: IDP_ISSUER,
    requireAudience: true,
    expectedAcsUrl: ACS_URL,
    requireRecipientDestination: true,
    ...over,
  });
}

describe("Phase 8 §11.2 — signed SAML through the production validator", () => {
  it("POSITIVE: a well-formed signed assertion with correct audience validates", () => {
    const assertion = run(buildSignedSamlResponse());
    expect(assertion.issuer).toBe(IDP_ISSUER);
    expect(assertion.audienceRestriction).toContain(SP_ENTITY_ID);
    expect(assertion.inResponseTo).toBe("authn-req-1");
  });

  it("NEGATIVE: tampered signed bytes fail signature verification", () => {
    const good = Buffer.from(buildSignedSamlResponse(), "base64").toString("utf8");
    // Flip a byte in the NameID (content covered by the signed digest).
    const tampered = good.replace("user@example.com", "attacker@evil.com");
    const b64 = Buffer.from(tampered, "utf8").toString("base64");
    expect(() => run(b64)).toThrow(SamlAssertionError);
  });

  it("NEGATIVE: mandatory audience — assertion with NO AudienceRestriction is rejected", () => {
    expect(() => run(buildSignedSamlResponse({ audience: null }))).toThrow(
      /SAML_AUDIENCE_MISMATCH|audience/i,
    );
  });

  it("NEGATIVE: audience present but not our SP entityID is rejected", () => {
    expect(() =>
      run(buildSignedSamlResponse({ audience: "https://other-sp.example.com" })),
    ).toThrow(SamlAssertionError);
  });

  it("NEGATIVE: expired assertion (NotOnOrAfter in the past) is rejected", () => {
    expect(() =>
      run(
        buildSignedSamlResponse({
          notBefore: new Date(Date.now() - 600_000),
          notOnOrAfter: new Date(Date.now() - 300_000),
        }),
      ),
    ).toThrow(SamlAssertionError);
  });

  it("NEGATIVE: InResponseTo mismatch is rejected", () => {
    expect(() =>
      run(buildSignedSamlResponse({ inResponseTo: "different-req" })),
    ).toThrow(SamlAssertionError);
  });

  it("NEGATIVE: issuer mismatch (expectedIdpEntityId) is rejected", () => {
    expect(() =>
      run(buildSignedSamlResponse({ issuer: "https://evil-idp.example.com/entity" })),
    ).toThrow(SamlAssertionError);
  });

  // §11.2 row 6 — Recipient/Destination bound to THIS SP's ACS URL.
  it("NEGATIVE: missing Destination is rejected when required", () => {
    expect(() => run(buildSignedSamlResponse({ destination: null }))).toThrow(
      /SAML_RECIPIENT_DESTINATION_MISMATCH|Destination/i,
    );
  });

  it("NEGATIVE: missing Recipient is rejected when required", () => {
    expect(() => run(buildSignedSamlResponse({ recipient: null }))).toThrow(
      SamlAssertionError,
    );
  });

  it("NEGATIVE: alternate-tenant ACS URL (mismatched Destination) is rejected", () => {
    expect(() =>
      run(
        buildSignedSamlResponse({
          destination: "https://app.proovra.com/v1/auth/saml/acs/OTHER-TENANT",
        }),
      ),
    ).toThrow(SamlAssertionError);
  });

  it("NEGATIVE: mismatched Recipient is rejected", () => {
    expect(() =>
      run(buildSignedSamlResponse({ recipient: "https://evil.example.com/acs" })),
    ).toThrow(SamlAssertionError);
  });
});
