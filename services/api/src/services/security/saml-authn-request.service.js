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
import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_NAME_ID_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const BINDING_HTTP_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
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
function generateRequestId() {
    return `_${randomBytes(32).toString("hex")}`;
}
/**
 * Escapes the minimal set of XML special characters needed for attribute values
 * and element text content. Sufficient for URLs, URNs, and ISO timestamps.
 */
function xmlEscape(value) {
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
function buildAuthnRequestXml(requestId, issuedAt, spEntityId, acsUrl, nameIdFormat, forceAuthn) {
    const forceAuthnAttr = forceAuthn ? "true" : "false";
    // prettier-ignore
    return (`<samlp:AuthnRequest` +
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
        `</samlp:AuthnRequest>`);
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
export function buildSamlAuthnRequest(input) {
    const { spEntityId, acsUrl, idpSsoUrl, nameIdFormat = DEFAULT_NAME_ID_FORMAT, forceAuthn = false, } = input;
    // Step 1: Generate stable identifiers for this request
    const requestId = generateRequestId();
    const issuedAt = new Date().toISOString();
    // Step 2: Build RelayState — 16 cryptographically random bytes, base64url-encoded
    const relayState = randomBytes(16).toString("base64url");
    // Step 3: Serialize AuthnRequest XML
    const xmlString = buildAuthnRequestXml(requestId, issuedAt, spEntityId, acsUrl, nameIdFormat, forceAuthn);
    // Step 4: Deflate (raw, no zlib header) the UTF-8 encoded XML
    const deflated = deflateRawSync(Buffer.from(xmlString, "utf-8"));
    // Step 5: Base64-encode the deflated bytes (standard base64 alphabet)
    const base64Encoded = deflated.toString("base64");
    // Step 6: Build the redirect URL
    // Both SAMLRequest and RelayState must be URL-encoded per the binding spec.
    const redirectUrl = `${idpSsoUrl}` +
        `?SAMLRequest=${encodeURIComponent(base64Encoded)}` +
        `&RelayState=${encodeURIComponent(relayState)}`;
    return {
        requestId,
        redirectUrl,
        relayState,
    };
}
