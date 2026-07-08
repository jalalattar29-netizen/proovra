/**
 * saml-authn-request.service.ts
 *
 * Phase R8.2 — Real SAML Service Provider Activation
 *
 * Builds a SAML AuthnRequest XML document and encodes it for the HTTP-Redirect
 * binding (RFC-compliant: deflateRaw → base64 → URL-encode).
 *
 * This module is intentionally pure (synchronous, no I/O, no DB, no logging).
 * It depends only on Node.js built-ins: node:crypto and node:zlib.
 */

import { createSign, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input required to build a SAML AuthnRequest. */
export type SamlAuthnRequestInput = {
  /** Internal connection identifier; used for RelayState scoping if desired. */
  connectionId: string;
  /** Our SP entityID (issuer). */
  spEntityId: string;
  /** Our Assertion Consumer Service URL (ACS URL). */
  acsUrl: string;
  /** IdP SSO URL — the redirect destination. */
  idpSsoUrl: string;
  /**
   * NameIDFormat to request.
   * Defaults to `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`.
   */
  nameIdFormat?: string;
  /** Whether to set ForceAuthn="true". Defaults to false. */
  forceAuthn?: boolean;
  /**
   * Phase 3 — SP AuthnRequest signing.
   *
   * When provided, the AuthnRequest is signed for the HTTP-Redirect binding
   * per SAML 2.0 Bindings §3.4.4.1: the signature is computed over the
   * URL-encoded query string `SAMLRequest=…&RelayState=…&SigAlg=…` and
   * appended as an additional `Signature` query parameter (NOT an embedded
   * XMLDSig — that form is only used for the HTTP-POST binding).
   *
   * `spPrivateKeyPem` is a PEM-encoded RSA private key (PKCS#8 or PKCS#1).
   * When absent, the request is left UNSIGNED and no Signature/SigAlg params
   * are emitted — preserving the pre-Phase-3 behaviour exactly.
   */
  spPrivateKeyPem?: string | null;
};

/** RSA-SHA256 SigAlg identifier used for HTTP-Redirect binding signatures. */
const SIG_ALG_RSA_SHA256 =
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

/** Result of building a SAML AuthnRequest. */
export type SamlAuthnRequestResult = {
  /**
   * The XML ID attribute of the AuthnRequest (e.g. `_a3f9...`).
   * Store this to validate InResponseTo in the IdP's response.
   */
  requestId: string;
  /**
   * Fully-built redirect URL containing SAMLRequest and RelayState query params.
   * Redirect the user's browser to this URL to initiate SSO.
   */
  redirectUrl: string;
  /** The RelayState value (base64url-encoded random bytes). */
  relayState: string;
  /**
   * True when the redirect URL carries a Signature (and SigAlg) query
   * parameter — i.e. the AuthnRequest was signed. False when unsigned.
   */
  signed: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_NAME_ID_FORMAT =
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const BINDING_HTTP_POST =
  "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generates a SAML-compliant request ID.
 * SAML 2.0 §1.3.4: ID values must be valid XML NCName; IDs starting with a
 * digit are not valid, so we prefix with an underscore.
 *
 * @returns `_` followed by 32 random hex bytes (65 chars total).
 */
function generateRequestId(): string {
  return `_${randomBytes(32).toString("hex")}`;
}

/**
 * Escapes the minimal set of XML special characters needed for attribute values
 * and element text content. Sufficient for URLs, URNs, and ISO timestamps.
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Serialises the AuthnRequest as a compact (no indentation) XML string.
 * No external XML library is used; the structure is fixed and well-known,
 * so manual construction is safe and avoids an additional dependency.
 */
function buildAuthnRequestXml(
  requestId: string,
  issuedAt: string,
  spEntityId: string,
  acsUrl: string,
  nameIdFormat: string,
  forceAuthn: boolean,
): string {
  const forceAuthnAttr = forceAuthn ? "true" : "false";

  // prettier-ignore
  return (
    `<samlp:AuthnRequest` +
      ` xmlns:samlp="${SAML_PROTOCOL_NS}"` +
      ` xmlns:saml="${SAML_ASSERTION_NS}"` +
      ` ID="${xmlEscape(requestId)}"` +
      ` Version="2.0"` +
      ` IssueInstant="${xmlEscape(issuedAt)}"` +
      ` AssertionConsumerServiceURL="${xmlEscape(acsUrl)}"` +
      ` ProtocolBinding="${BINDING_HTTP_POST}"` +
      ` ForceAuthn="${forceAuthnAttr}"` +
      ` IsPassive="false">` +
    `<saml:Issuer>${xmlEscape(spEntityId)}</saml:Issuer>` +
    `<samlp:NameIDPolicy` +
      ` AllowCreate="true"` +
      ` Format="${xmlEscape(nameIdFormat)}" />` +
    `</samlp:AuthnRequest>`
  );
}

// ---------------------------------------------------------------------------
// buildSamlAuthnRequest
// ---------------------------------------------------------------------------

/**
 * Builds a SAML 2.0 AuthnRequest and encodes it for the HTTP-Redirect binding.
 *
 * Encoding steps (per SAML 2.0 Bindings §3.4.4.1):
 *  1. Serialize AuthnRequest XML to a UTF-8 string.
 *  2. Deflate without a zlib wrapper (`deflateRawSync`).
 *  3. Base64-encode the deflated bytes (standard alphabet).
 *  4. URL-encode the base64 string.
 *  5. Append as `SAMLRequest` query parameter plus `RelayState`.
 *
 * @param input - SP/IdP configuration and request options.
 * @returns `{ requestId, redirectUrl, relayState }`.
 */
export function buildSamlAuthnRequest(
  input: SamlAuthnRequestInput,
): SamlAuthnRequestResult {
  const {
    spEntityId,
    acsUrl,
    idpSsoUrl,
    nameIdFormat = DEFAULT_NAME_ID_FORMAT,
    forceAuthn = false,
    spPrivateKeyPem = null,
  } = input;

  // Step 1: Generate stable identifiers for this request
  const requestId = generateRequestId();
  const issuedAt = new Date().toISOString();

  // Step 2: Build RelayState — 16 cryptographically random bytes, base64url-encoded
  const relayState = randomBytes(16).toString("base64url");

  // Step 3: Serialize AuthnRequest XML
  const xmlString = buildAuthnRequestXml(
    requestId,
    issuedAt,
    spEntityId,
    acsUrl,
    nameIdFormat,
    forceAuthn,
  );

  // Step 4: Deflate (raw, no zlib header) the UTF-8 encoded XML
  const deflated = deflateRawSync(Buffer.from(xmlString, "utf-8"));

  // Step 5: Base64-encode the deflated bytes (standard base64 alphabet)
  const base64Encoded = deflated.toString("base64");

  // Step 6: Build the redirect URL.
  // Both SAMLRequest and RelayState must be URL-encoded per the binding spec.
  const samlRequestParam = `SAMLRequest=${encodeURIComponent(base64Encoded)}`;
  const relayStateParam = `RelayState=${encodeURIComponent(relayState)}`;

  // Step 7: Sign the query string when an SP private key is supplied.
  //
  // SAML 2.0 Bindings §3.4.4.1 — for the HTTP-Redirect binding the signature
  // is NOT an embedded XMLDSig. It is computed over the octet string formed by
  // concatenating the URL-encoded query components in this exact order:
  //     SAMLRequest=<value>&RelayState=<value>&SigAlg=<value>
  // and the resulting signature is base64-encoded and appended as `Signature`.
  let signed = false;
  let signatureParams = "";
  if (spPrivateKeyPem && spPrivateKeyPem.trim().length > 0) {
    const sigAlgParam = `SigAlg=${encodeURIComponent(SIG_ALG_RSA_SHA256)}`;
    // Signing input: the exact octet string the IdP will reconstruct and verify.
    const signingInput = `${samlRequestParam}&${relayStateParam}&${sigAlgParam}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput, "utf-8");
    const signatureB64 = signer.sign(spPrivateKeyPem, "base64");
    signatureParams =
      `&${sigAlgParam}` +
      `&Signature=${encodeURIComponent(signatureB64)}`;
    signed = true;
  }

  const redirectUrl =
    `${idpSsoUrl}` +
    `?${samlRequestParam}` +
    `&${relayStateParam}` +
    signatureParams;

  return {
    requestId,
    redirectUrl,
    relayState,
    signed,
  };
}
