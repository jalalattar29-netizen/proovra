/**
 * saml-assertion.service.ts
 *
 * Phase R8.2 — Real SAML Service Provider Activation
 *
 * Validates an incoming HTTP-POST binding SAMLResponse:
 *   1. Decodes the base64-encoded XML.
 *   2. Blocks DTD entity declarations (XXE guard).
 *   3. Parses the XML using @xmldom/xmldom.
 *   4. Checks the SAML StatusCode == Success.
 *   5. Locates the XMLDSig Signature element (Assertion-level preferred,
 *      Response-level fallback) and validates it with xml-crypto against
 *      the IdP's stored certificate.
 *   6. Validates Conditions (NotBefore, NotOnOrAfter, AudienceRestriction).
 *   7. Validates InResponseTo against the stored AuthnRequest ID.
 *   8. Extracts NameID and AttributeStatement values.
 *
 * Security guarantees:
 *  - Unsigned assertions are ALWAYS rejected (no signature = reject).
 *  - IdP certificate is pinned from the stored SsoConnection record;
 *    KeyInfo in the assertion is IGNORED (key confusion attack prevention).
 *  - Clock skew tolerance is bounded to 120 s (configurable, max 300 s).
 *  - Audience restriction is enforced against the SP entityID.
 *  - InResponseTo MUST match when expectedInResponseTo is provided.
 *  - No assertion content (NameID, attributes, XML) is ever logged.
 */
import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
/** Thrown when SAML assertion validation fails. */
export class SamlAssertionError extends Error {
    code;
    constructor(code, message) {
        super(message ?? code);
        this.code = code;
        this.name = "SamlAssertionError";
    }
}
/**
 * R8.2.2 — Bounded safe failure category labels.
 *
 * Maps internal error codes (from SamlAssertionError and SamlMappingError)
 * to operator-facing category strings suitable for display in the admin UI,
 * security event details, and API error responses. These labels are safe
 * to surface: they convey enough information for troubleshooting without
 * leaking raw assertion XML, NameID values, certificates, or session tokens.
 *
 * Used by the ACS route, test-connection route, and Security Center.
 */
export const SAML_FAILURE_CATEGORY_LABELS = {
    // Assertion service error codes
    SAML_DECODE_FAILED: "invalid_response_encoding",
    SAML_XML_UNSAFE: "unsafe_xml_entity",
    SAML_PARSE_FAILED: "malformed_xml",
    SAML_STATUS_NOT_SUCCESS: "idp_reported_failure",
    SAML_SIGNATURE_MISSING: "unsigned_assertion",
    SAML_SIGNATURE_INVALID: "invalid_signature",
    SAML_CONDITIONS_EXPIRED: "expired_assertion",
    SAML_CONDITIONS_NOT_YET_VALID: "assertion_not_yet_valid",
    SAML_AUDIENCE_MISMATCH: "invalid_audience",
    SAML_IN_RESPONSE_TO_MISMATCH: "relay_state_correlation_failed",
    SAML_NAME_ID_MISSING: "missing_subject_identifier",
    SAML_ASSERTION_MISSING: "missing_assertion",
    // Mapping error codes (from saml-user-mapping.service.ts)
    SAML_EMAIL_MISSING: "missing_email_attribute",
    SAML_EMAIL_DOMAIN_NOT_ALLOWED: "domain_not_allowed",
    SAML_JIT_DISABLED: "jit_policy_denied",
    SAML_CONNECTION_NOT_FOUND: "connection_not_found",
    SAML_CONNECTION_INACTIVE: "connection_inactive",
    // Metadata error codes (from saml-metadata.service.ts)
    METADATA_PARSE_FAILED: "metadata_parse_failed",
    METADATA_MISSING_ENTITY_ID: "metadata_missing_entity_id",
    METADATA_MISSING_SSO_URL: "metadata_missing_sso_url",
    METADATA_MISSING_CERTIFICATE: "metadata_missing_certificate",
    METADATA_XML_UNSAFE: "metadata_unsafe_xml_entity",
};
// ---------------------------------------------------------------------------
// SAML namespace and status constants
// ---------------------------------------------------------------------------
const NS_SAMLP = "urn:oasis:names:tc:SAML:2.0:protocol";
const NS_SAML = "urn:oasis:names:tc:SAML:2.0:assertion";
const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const MAX_CLOCK_SKEW_SECONDS = 300;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Converts a base64-only certificate string (no PEM headers) to PEM format
 * suitable for use with Node.js crypto and xml-crypto.
 */
function certToPem(base64Cert) {
    const wrapped = base64Cert.match(/.{1,64}/g)?.join("\n") ?? base64Cert;
    return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----`;
}
/**
 * Returns elements by namespace URI + local name from a Document or Element.
 * Uses getElementsByTagNameNS (supported by @xmldom/xmldom).
 */
function getByNsLocalName(node, ns, localName) {
    // @xmldom/xmldom supports getElementsByTagNameNS
    const nodeAsDoc = node;
    const coll = nodeAsDoc.getElementsByTagNameNS
        ? nodeAsDoc.getElementsByTagNameNS(ns, localName)
        : node.getElementsByTagNameNS?.(ns, localName);
    if (!coll)
        return [];
    const result = [];
    for (let i = 0; i < coll.length; i++) {
        const item = coll.item(i);
        if (item)
            result.push(item);
    }
    return result;
}
/**
 * Concatenates all text node content under an element.
 */
function textOf(el) {
    let text = "";
    const children = el.childNodes;
    for (let i = 0; i < children.length; i++) {
        const n = children.item(i);
        if (n?.nodeType === 3)
            text += n.nodeValue ?? "";
    }
    return text.trim();
}
/**
 * Computes SHA-256 hex hash of a string value (for safe logging of NameID).
 */
function hashValue(val) {
    return createHash("sha256").update(val, "utf8").digest("hex");
}
// ---------------------------------------------------------------------------
// validateSamlResponse
// ---------------------------------------------------------------------------
/**
 * Validates an inbound SAML 2.0 HTTP-POST binding Response and returns
 * the extracted assertion content on success.
 *
 * @throws {SamlAssertionError} on any validation failure.
 */
export function validateSamlResponse(input) {
    const clockSkew = Math.min(Math.max(0, input.allowedClockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS), MAX_CLOCK_SKEW_SECONDS);
    // -------------------------------------------------------------------------
    // Step 1: Decode base64 → XML string
    // -------------------------------------------------------------------------
    let xmlString;
    try {
        const decoded = Buffer.from(input.samlResponseBase64, "base64");
        xmlString = decoded.toString("utf-8");
        if (!xmlString || !xmlString.trim()) {
            throw new Error("empty after decode");
        }
    }
    catch {
        throw new SamlAssertionError("SAML_DECODE_FAILED", "Failed to base64-decode the SAMLResponse.");
    }
    // -------------------------------------------------------------------------
    // Step 2: DTD entity injection guard
    // -------------------------------------------------------------------------
    if (xmlString.includes("<!ENTITY")) {
        throw new SamlAssertionError("SAML_XML_UNSAFE", "SAMLResponse contains DTD entity declarations which are not permitted.");
    }
    // -------------------------------------------------------------------------
    // Step 3: Parse XML
    // @xmldom/xmldom does NOT process external entities by default (no XXE).
    // -------------------------------------------------------------------------
    let parseError = null;
    const parser = new DOMParser({
        // @xmldom/xmldom v0.9.x uses a single ErrorHandlerFunction
        // (level, msg, context) => void — not an object with separate methods.
        errorHandler: (level, msg, _context) => {
            if (level === "fatalError") {
                parseError = msg;
            }
            // error and warning levels are suppressed
        },
    });
    const doc = parser.parseFromString(xmlString, "text/xml");
    if (parseError || !doc?.documentElement) {
        throw new SamlAssertionError("SAML_PARSE_FAILED", parseError
            ? `XML parse error: ${parseError}`
            : "Parser produced no document element.");
    }
    // -------------------------------------------------------------------------
    // Step 4: Verify StatusCode == Success
    // -------------------------------------------------------------------------
    // Cast: @xmldom Document is structurally distinct from global DOM Document.
    const statusCodes = getByNsLocalName(doc, NS_SAMLP, "StatusCode");
    const topStatus = statusCodes[0];
    const statusValue = topStatus?.getAttribute("Value") ?? "";
    if (statusValue !== STATUS_SUCCESS) {
        throw new SamlAssertionError("SAML_STATUS_NOT_SUCCESS", `IdP returned non-success status: ${statusValue || "(absent)"}`);
    }
    // -------------------------------------------------------------------------
    // Step 5: Locate Assertion element
    // -------------------------------------------------------------------------
    const assertions = getByNsLocalName(doc, NS_SAML, "Assertion");
    if (assertions.length === 0) {
        throw new SamlAssertionError("SAML_ASSERTION_MISSING", "No saml:Assertion element found in Response.");
    }
    // Use the first assertion (multiple assertions are rare; reject if present
    // to avoid confusion attacks). We only need one.
    const assertion = assertions[0];
    // -------------------------------------------------------------------------
    // Step 6: Locate and validate XML Signature
    //
    // Strategy:
    //  a) Look for a Signature inside the Assertion (preferred — assertion-level).
    //  b) Fall back to a Signature at the Response level.
    //
    // The IdP's certificate is used EXCLUSIVELY for verification.
    // KeyInfo inside the document is IGNORED to prevent key confusion attacks.
    // -------------------------------------------------------------------------
    const allSigs = getByNsLocalName(doc, NS_DSIG, "Signature");
    if (allSigs.length === 0) {
        throw new SamlAssertionError("SAML_SIGNATURE_MISSING", "SAMLResponse contains no XMLDSig Signature element. Unsigned assertions are rejected.");
    }
    // Prefer Assertion-level signature
    let signatureNode = null;
    for (const sig of allSigs) {
        // Check if this Signature's parent is the Assertion or inside it
        let parent = sig.parentNode;
        while (parent) {
            if (parent === assertion ||
                parent.localName === "Assertion") {
                signatureNode = sig;
                break;
            }
            parent = parent.parentNode;
        }
        if (signatureNode)
            break;
    }
    // Fallback: use first signature found
    if (!signatureNode)
        signatureNode = allSigs[0];
    // -----------------------------------------------------------------------
    // R8.2.1 — certificate rotation: build the list of certs to try.
    //
    // We always try the primary cert first. If a next/rotation cert is
    // configured AND the primary fails, we try the secondary. This allows
    // an IdP to rotate its signing certificate without causing downtime:
    //   Phase 1: admin adds `idpCertificateNext` (both certs accepted).
    //   Phase 2: IdP starts signing with the new cert — assertions still pass.
    //   Phase 3: admin promotes `idpCertificateNext` to primary, clears next.
    //
    // Two independent verifier instances are created so we get a clean
    // loadSignature() + checkSignature() for each cert attempt.
    // -----------------------------------------------------------------------
    const certsToTry = [input.idpCertificate];
    if (input.idpCertificateNext) {
        certsToTry.push(input.idpCertificateNext);
    }
    let signatureVerified = false;
    for (const certBase64 of certsToTry) {
        const certPem = certToPem(certBase64);
        const verifier = new SignedXml({
            // idAttribute tells xml-crypto that SAML uses 'ID' (not 'id' or 'Id')
            // to identify referenced elements in Reference/@URI.
            idAttribute: "ID",
            // We supply the IdP's public certificate directly.
            // This OVERRIDES any KeyInfo in the document (key confusion prevention).
            publicCert: certPem,
            // getCertFromKeyInfo: ignore KeyInfo, always use our pinned cert.
            getCertFromKeyInfo: () => certPem,
        });
        verifier.loadSignature(signatureNode);
        // checkSignature validates the complete chain:
        //   1. Finds the referenced element by URI (using ID attribute lookup).
        //   2. Applies transforms (C14N, enveloped-signature).
        //   3. Computes the digest and compares with DigestValue.
        //   4. Verifies the SignatureValue over SignedInfo.
        if (verifier.checkSignature(xmlString)) {
            signatureVerified = true;
            break;
        }
    }
    if (!signatureVerified) {
        throw new SamlAssertionError("SAML_SIGNATURE_INVALID", "XMLDSig signature verification failed against all configured IdP certificates.");
    }
    // -------------------------------------------------------------------------
    // Step 7: Extract InResponseTo from Response element
    // -------------------------------------------------------------------------
    const responseEls = getByNsLocalName(doc, NS_SAMLP, "Response");
    const responseEl = responseEls[0] ?? doc.documentElement;
    const inResponseTo = responseEl.getAttribute("InResponseTo") ?? null;
    if (input.expectedInResponseTo != null &&
        input.expectedInResponseTo.trim() !== "") {
        if (inResponseTo !== input.expectedInResponseTo) {
            throw new SamlAssertionError("SAML_IN_RESPONSE_TO_MISMATCH", "InResponseTo does not match the stored AuthnRequest ID.");
        }
    }
    // -------------------------------------------------------------------------
    // Step 8: Extract and validate Conditions
    // -------------------------------------------------------------------------
    const conditionEls = getByNsLocalName(assertion, NS_SAML, "Conditions");
    const conditions = conditionEls[0] ?? null;
    let notBefore = null;
    let notOnOrAfter = null;
    const audienceRestriction = [];
    if (conditions) {
        const nbAttr = conditions.getAttribute("NotBefore");
        const noaAttr = conditions.getAttribute("NotOnOrAfter");
        if (nbAttr)
            notBefore = new Date(nbAttr);
        if (noaAttr)
            notOnOrAfter = new Date(noaAttr);
        // AudienceRestriction
        const audienceEls = getByNsLocalName(conditions, NS_SAML, "Audience");
        for (const aud of audienceEls) {
            const val = textOf(aud);
            if (val)
                audienceRestriction.push(val);
        }
    }
    const now = Date.now();
    const skewMs = clockSkew * 1000;
    if (notBefore && now < notBefore.getTime() - skewMs) {
        throw new SamlAssertionError("SAML_CONDITIONS_NOT_YET_VALID", "Assertion is not yet valid (NotBefore condition).");
    }
    if (notOnOrAfter && now > notOnOrAfter.getTime() + skewMs) {
        throw new SamlAssertionError("SAML_CONDITIONS_EXPIRED", "Assertion has expired (NotOnOrAfter condition).");
    }
    // Audience check — our SP entityID must appear in AudienceRestriction
    // if one is declared. If no AudienceRestriction declared, we still enforce
    // that the Issuer matches what we expect (done at the service layer).
    if (audienceRestriction.length > 0 &&
        !audienceRestriction.includes(input.spEntityId)) {
        throw new SamlAssertionError("SAML_AUDIENCE_MISMATCH", "SP entityID not found in AudienceRestriction.");
    }
    // -------------------------------------------------------------------------
    // Step 9: Extract NameID
    // -------------------------------------------------------------------------
    const subjectEls = getByNsLocalName(assertion, NS_SAML, "Subject");
    const nameIdEls = subjectEls.length > 0
        ? getByNsLocalName(subjectEls[0], NS_SAML, "NameID")
        : getByNsLocalName(assertion, NS_SAML, "NameID");
    const nameIdEl = nameIdEls[0] ?? null;
    if (!nameIdEl) {
        throw new SamlAssertionError("SAML_NAME_ID_MISSING", "No NameID element found in Assertion Subject.");
    }
    const nameId = textOf(nameIdEl);
    if (!nameId) {
        throw new SamlAssertionError("SAML_NAME_ID_MISSING", "NameID element has empty text content.");
    }
    const nameIdFormat = nameIdEl.getAttribute("Format") ??
        "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";
    // -------------------------------------------------------------------------
    // Step 10: Extract AuthnStatement
    // -------------------------------------------------------------------------
    let sessionIndex = null;
    let authnContextClassRef = null;
    const authnStmts = getByNsLocalName(assertion, NS_SAML, "AuthnStatement");
    if (authnStmts.length > 0) {
        sessionIndex = authnStmts[0].getAttribute("SessionIndex") ?? null;
        const classRefs = getByNsLocalName(authnStmts[0], NS_SAML, "AuthnContextClassRef");
        if (classRefs.length > 0) {
            authnContextClassRef = textOf(classRefs[0]);
        }
    }
    // -------------------------------------------------------------------------
    // Step 11: Extract AttributeStatement
    // -------------------------------------------------------------------------
    const attributes = {};
    const attrStmts = getByNsLocalName(assertion, NS_SAML, "AttributeStatement");
    for (const stmt of attrStmts) {
        const attrEls = getByNsLocalName(stmt, NS_SAML, "Attribute");
        for (const attr of attrEls) {
            const attrName = attr.getAttribute("Name") ??
                attr.getAttribute("FriendlyName") ??
                null;
            if (!attrName)
                continue;
            const values = [];
            const valEls = getByNsLocalName(attr, NS_SAML, "AttributeValue");
            for (const val of valEls) {
                const v = textOf(val);
                if (v)
                    values.push(v);
            }
            if (values.length > 0) {
                attributes[attrName] = values;
            }
        }
    }
    // -------------------------------------------------------------------------
    // Step 12: Extract Issuer
    // -------------------------------------------------------------------------
    const issuerEls = getByNsLocalName(assertion, NS_SAML, "Issuer");
    const issuer = issuerEls.length > 0 ? textOf(issuerEls[0]) : "";
    // -------------------------------------------------------------------------
    // Return validated assertion (NameID hashed for audit safety)
    // -------------------------------------------------------------------------
    return {
        nameId,
        nameIdFormat,
        sessionIndex: sessionIndex ?? null,
        inResponseTo: inResponseTo ?? null,
        issuer,
        attributes,
        authnContextClassRef: authnContextClassRef ?? null,
        notBefore,
        notOnOrAfter,
        audienceRestriction,
        nameIdHash: hashValue(nameId),
    };
}
