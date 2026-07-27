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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The validated, extracted content of a SAML Assertion. */
export type SamlAssertion = {
  /** NameID value (typically the user's email address or opaque subject). */
  nameId: string;
  /** NameID format URI. */
  nameIdFormat: string;
  /** SessionIndex from AuthnStatement, for future SLO support. */
  sessionIndex: string | null;
  /** InResponseTo from the Response element (our AuthnRequest ID). */
  inResponseTo: string | null;
  /** Issuer of the Assertion. */
  issuer: string;
  /**
   * SAML AttributeStatement values. Keys are Attribute/@Name values;
   * values are arrays of AttributeValue text contents.
   */
  attributes: Record<string, string[]>;
  /** AuthnContextClassRef URI, or null if not present. */
  authnContextClassRef: string | null;
  /** Conditions/@NotBefore as a Date, or null if not in the assertion. */
  notBefore: Date | null;
  /** Conditions/@NotOnOrAfter as a Date, or null if not in the assertion. */
  notOnOrAfter: Date | null;
  /** Audience URIs from AudienceRestriction. */
  audienceRestriction: string[];
  /**
   * SHA-256 hash of the NameID value (safe for logging/events).
   * Never log the raw NameID.
   */
  nameIdHash: string;
};

/** Input to the SAML response validator. */
export type ValidateSamlResponseInput = {
  /**
   * The base64-encoded SAMLResponse value from the HTTP-POST body.
   * This is the raw value of the `SAMLResponse` form field.
   */
  samlResponseBase64: string;
  /**
   * The IdP's X.509 certificate in base64-only format (no PEM headers,
   * whitespace stripped). Sourced from `SsoConnection.samlCertificate`.
   * Used exclusively for signature verification; KeyInfo in the
   * assertion is ignored.
   */
  idpCertificate: string;
  /**
   * R8.2.1 — Optional secondary IdP certificate (base64-only, no PEM
   * headers). When set, signature verification tries `idpCertificate`
   * first; if that fails, tries `idpCertificateNext`. This enables
   * zero-downtime certificate rotation: the IdP can rotate its signing
   * cert while Proovra accepts assertions signed by either cert.
   *
   * Once the IdP has fully rotated, admins should clear `idpCertificate`
   * and promote `idpCertificateNext` to the primary slot.
   */
  idpCertificateNext?: string | null;
  /**
   * Our SP entityID, used to verify AudienceRestriction.
   * Must match exactly one Audience URI in the Assertion.
   */
  spEntityId: string;
  /**
   * If provided, the InResponseTo attribute on the Response element MUST
   * match this value. This prevents assertion injection attacks.
   * Set to the requestId returned by buildSamlAuthnRequest.
   */
  expectedInResponseTo?: string | null;
  /**
   * Clock skew tolerance in seconds (default: 60, max: 300).
   * Applied symmetrically to NotBefore and NotOnOrAfter.
   */
  allowedClockSkewSeconds?: number;
  /**
   * P0 remediation (2026-07-21) — the IdP entityID pinned on the
   * SsoConnection (`samlIdpEntityId`). When provided, the assertion's
   * Issuer MUST equal it exactly; a mismatch is rejected. When the
   * connection has no pinned entityID (legacy, metadata never ingested)
   * the check is skipped — callers should surface that as a warning.
   */
  expectedIdpEntityId?: string | null;
  /**
   * PHASE 8 §11.2 — when true, an assertion with NO AudienceRestriction
   * is rejected (mandatory audience). Default (unset) preserves the
   * legacy "enforce only when declared" behavior.
   */
  requireAudience?: boolean;
  /**
   * PHASE 8 §11.2 — the SP's own ACS URL. When `requireRecipientDestination`
   * is set, the response Destination + assertion Recipient must both equal
   * this. Default (unset) preserves legacy behavior.
   */
  expectedAcsUrl?: string | null;
  requireRecipientDestination?: boolean;
};

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type SamlAssertionErrorCode =
  | "SAML_DECODE_FAILED"
  | "SAML_XML_UNSAFE"
  | "SAML_PARSE_FAILED"
  | "SAML_STATUS_NOT_SUCCESS"
  | "SAML_SIGNATURE_MISSING"
  | "SAML_SIGNATURE_INVALID"
  | "SAML_CONDITIONS_EXPIRED"
  | "SAML_CONDITIONS_NOT_YET_VALID"
  | "SAML_AUDIENCE_MISMATCH"
  | "SAML_IN_RESPONSE_TO_MISMATCH"
  | "SAML_NAME_ID_MISSING"
  | "SAML_ASSERTION_MISSING"
  // P0 remediation (2026-07-21) — signature-wrapping + issuer binding.
  | "SAML_MULTIPLE_ASSERTIONS"
  | "SAML_SIGNATURE_NOT_BOUND"
  | "SAML_ISSUER_MISMATCH"
  // PHASE 8 §11.2 (2026-07-22) — mandatory issuer: connection has no
  // pinned IdP entityID; login fails closed pending metadata ingestion.
  | "SAML_ISSUER_UNPINNED"
  // PHASE 8 §11.2 — Destination/Recipient not bound to this SP's ACS URL.
  | "SAML_RECIPIENT_DESTINATION_MISMATCH";

/**
 * PHASE 8 §11.2 (2026-07-22) — pure audience decision (mandatory-audience
 * enforcement). Extracted so the fail-closed behavior is unit-testable
 * without constructing a signature-valid SAML fixture:
 *   - `requireAudience` + NO AudienceRestriction declared  → REJECT;
 *   - AudienceRestriction declared but SP entityID absent   → REJECT;
 *   - SP entityID present (or no restriction + !require)    → ACCEPT.
 */
/**
 * PHASE 8 §11.2 (2026-07-22) — pure Recipient/Destination decision.
 * The response's `Destination` (Response @Destination) and the assertion's
 * `Recipient` (SubjectConfirmationData @Recipient) MUST equal the SP's own
 * ACS URL when the check is required. This defeats a token minted for a
 * DIFFERENT SP / a DIFFERENT tenant's ACS from being replayed at ours.
 *   - required + either value missing → REJECT;
 *   - present but ≠ our ACS URL      → REJECT (alternate-tenant ACS);
 *   - both equal our ACS URL         → ACCEPT.
 */
export function evaluateSamlRecipientDestination(input: {
  destination: string | null;
  recipient: string | null;
  expectedAcsUrl: string | null;
  require: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.require || !input.expectedAcsUrl) return { ok: true };
  if (!input.destination || !input.recipient) {
    return {
      ok: false,
      reason: "Missing SAML Destination/Recipient (both required).",
    };
  }
  if (input.destination !== input.expectedAcsUrl) {
    return { ok: false, reason: "SAML Destination does not match this SP's ACS URL." };
  }
  if (input.recipient !== input.expectedAcsUrl) {
    return { ok: false, reason: "SAML Recipient does not match this SP's ACS URL." };
  }
  return { ok: true };
}

export function evaluateSamlAudience(input: {
  audienceRestriction: string[];
  spEntityId: string;
  requireAudience: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (input.requireAudience && input.audienceRestriction.length === 0) {
    return {
      ok: false,
      reason: "Assertion has no AudienceRestriction; audience is mandatory.",
    };
  }
  if (
    input.audienceRestriction.length > 0 &&
    !input.audienceRestriction.includes(input.spEntityId)
  ) {
    return { ok: false, reason: "SP entityID not found in AudienceRestriction." };
  }
  return { ok: true };
}

/**
 * PHASE 8 §11.2 — pure issuer-remediation predicate: a SAML connection
 * with no pinned IdP entityID cannot verify the issuer and therefore
 * must fail closed (login denied) + enter remediation until metadata is
 * ingested.
 */
export function samlConnectionRequiresIssuerRemediation(conn: {
  samlIdpEntityId: string | null | undefined;
}): boolean {
  return !conn.samlIdpEntityId;
}

/** Thrown when SAML assertion validation fails. */
export class SamlAssertionError extends Error {
  constructor(
    public readonly code: SamlAssertionErrorCode,
    message?: string,
  ) {
    super(message ?? code);
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
export const SAML_FAILURE_CATEGORY_LABELS: Record<string, string> = {
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
function certToPem(base64Cert: string): string {
  const wrapped = base64Cert.match(/.{1,64}/g)?.join("\n") ?? base64Cert;
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----`;
}

/**
 * Returns elements by namespace URI + local name from a Document or Element.
 * Uses getElementsByTagNameNS (supported by @xmldom/xmldom).
 */
function getByNsLocalName(
  node: Document | Element,
  ns: string,
  localName: string,
): Element[] {
  // @xmldom/xmldom supports getElementsByTagNameNS
  const nodeAsDoc = node as Document;
  const coll = nodeAsDoc.getElementsByTagNameNS
    ? nodeAsDoc.getElementsByTagNameNS(ns, localName)
    : (node as Element).getElementsByTagNameNS?.(ns, localName);
  if (!coll) return [];
  const result: Element[] = [];
  for (let i = 0; i < coll.length; i++) {
    const item = coll.item(i);
    if (item) result.push(item as Element);
  }
  return result;
}

/**
 * Concatenates all text node content under an element.
 */
function textOf(el: Element): string {
  let text = "";
  const children = el.childNodes;
  for (let i = 0; i < children.length; i++) {
    const n = children.item(i);
    if (n?.nodeType === 3) text += (n as Text).nodeValue ?? "";
  }
  return text.trim();
}

/**
 * Computes SHA-256 hex hash of a string value (for safe logging of NameID).
 */
function hashValue(val: string): string {
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
export function validateSamlResponse(
  input: ValidateSamlResponseInput,
): SamlAssertion {
  const clockSkew = Math.min(
    Math.max(0, input.allowedClockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS),
    MAX_CLOCK_SKEW_SECONDS,
  );

  // -------------------------------------------------------------------------
  // Step 1: Decode base64 → XML string
  // -------------------------------------------------------------------------
  let xmlString: string;
  try {
    const decoded = Buffer.from(input.samlResponseBase64, "base64");
    xmlString = decoded.toString("utf-8");
    if (!xmlString || !xmlString.trim()) {
      throw new Error("empty after decode");
    }
  } catch {
    throw new SamlAssertionError(
      "SAML_DECODE_FAILED",
      "Failed to base64-decode the SAMLResponse.",
    );
  }

  // -------------------------------------------------------------------------
  // Step 2: DTD entity injection guard
  // -------------------------------------------------------------------------
  if (xmlString.includes("<!ENTITY")) {
    throw new SamlAssertionError(
      "SAML_XML_UNSAFE",
      "SAMLResponse contains DTD entity declarations which are not permitted.",
    );
  }

  // -------------------------------------------------------------------------
  // Step 3: Parse XML
  // @xmldom/xmldom does NOT process external entities by default (no XXE).
  // -------------------------------------------------------------------------
  let parseError: string | null = null;
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
    throw new SamlAssertionError(
      "SAML_PARSE_FAILED",
      parseError
        ? `XML parse error: ${parseError}`
        : "Parser produced no document element.",
    );
  }

  // -------------------------------------------------------------------------
  // Step 4: Verify StatusCode == Success
  // -------------------------------------------------------------------------
  // Cast: @xmldom Document is structurally distinct from global DOM Document.
  const statusCodes = getByNsLocalName(doc as unknown as Document, NS_SAMLP, "StatusCode");
  const topStatus = statusCodes[0];
  const statusValue = topStatus?.getAttribute("Value") ?? "";
  if (statusValue !== STATUS_SUCCESS) {
    throw new SamlAssertionError(
      "SAML_STATUS_NOT_SUCCESS",
      `IdP returned non-success status: ${statusValue || "(absent)"}`,
    );
  }

  // -------------------------------------------------------------------------
  // Step 5: Locate Assertion element
  // -------------------------------------------------------------------------
  const assertions = getByNsLocalName(doc as unknown as Document, NS_SAML, "Assertion");
  if (assertions.length === 0) {
    throw new SamlAssertionError(
      "SAML_ASSERTION_MISSING",
      "No saml:Assertion element found in Response.",
    );
  }
  // P0 remediation (2026-07-21) — a Response carrying MORE than one
  // assertion is the classic XML-Signature-Wrapping setup (signed decoy +
  // unsigned payload). We consume exactly one assertion, so more than one
  // is rejected outright instead of silently picking the first.
  if (assertions.length > 1) {
    throw new SamlAssertionError(
      "SAML_MULTIPLE_ASSERTIONS",
      `Response contains ${assertions.length} assertions; exactly one is required.`,
    );
  }
  const assertion = assertions[0]!;

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
  const allSigs = getByNsLocalName(doc as unknown as Document, NS_DSIG, "Signature");
  if (allSigs.length === 0) {
    throw new SamlAssertionError(
      "SAML_SIGNATURE_MISSING",
      "SAMLResponse contains no XMLDSig Signature element. Unsigned assertions are rejected.",
    );
  }

  // Prefer Assertion-level signature
  let signatureNode: Element | null = null;
  for (const sig of allSigs) {
    // Check if this Signature's parent is the Assertion or inside it
    let parent: Node | null = sig.parentNode;
    while (parent) {
      if (
        parent === assertion ||
        (parent as Element).localName === "Assertion"
      ) {
        signatureNode = sig;
        break;
      }
      parent = parent.parentNode;
    }
    if (signatureNode) break;
  }
  // Fallback: use first signature found
  if (!signatureNode) signatureNode = allSigs[0]!;

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
      // PHASE 8 §11.2 (2026-07-22) — CRITICAL: do NOT pass
      // `idAttribute: "ID"`. xml-crypto 6.x's constructor `unshift`s the
      // supplied idAttribute onto its defaults ["Id","ID","id"], yielding
      // ["ID","Id","ID","id"] — "ID" DUPLICATED. The signature-wrapping
      // guard then double-counts every assertion referenced by an `ID`
      // attribute (standard SAML 2.0) and throws "multiple elements with
      // the same ID", REJECTING legitimately-signed assertions. The 6.x
      // defaults already include "ID"/"Id"/"id", so the explicit option
      // is redundant and harmful. Proven by phase-8-saml-signed-fixture
      // (validates with defaults, throws with the redundant option).
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
    throw new SamlAssertionError(
      "SAML_SIGNATURE_INVALID",
      "XMLDSig signature verification failed against all configured IdP certificates.",
    );
  }

  // -------------------------------------------------------------------------
  // P0 remediation (2026-07-21) — bind the VERIFIED signature to the
  // CONSUMED assertion (XML-Signature-Wrapping defence). checkSignature
  // proves that *some* referenced element hashes correctly; here we prove
  // that the signed Reference actually targets either the assertion we are
  // about to extract NameID/attributes from, or the enclosing Response
  // element (a response-level signature covers the whole document). Any
  // other target means the verified bytes are not the bytes we consume.
  // -------------------------------------------------------------------------
  {
    const assertionId = assertion.getAttribute("ID") ?? "";
    const responseId = doc.documentElement.getAttribute("ID") ?? "";
    const referenceEls = getByNsLocalName(signatureNode, NS_DSIG, "Reference");
    if (referenceEls.length !== 1) {
      throw new SamlAssertionError(
        "SAML_SIGNATURE_NOT_BOUND",
        `Signature carries ${referenceEls.length} References; exactly one is required.`,
      );
    }
    const uri = referenceEls[0]!.getAttribute("URI") ?? "";
    const boundToAssertion =
      assertionId.length > 0 && uri === `#${assertionId}`;
    const boundToResponse = responseId.length > 0 && uri === `#${responseId}`;
    // An empty URI ("") signs the enclosing document root — acceptable only
    // when the signature itself is a direct child of the Response element.
    const boundToDocumentRoot =
      uri === "" &&
      (signatureNode.parentNode as Node | null) ===
        (doc.documentElement as unknown as Node);
    if (!boundToAssertion && !boundToResponse && !boundToDocumentRoot) {
      throw new SamlAssertionError(
        "SAML_SIGNATURE_NOT_BOUND",
        "Verified signature does not reference the consumed Assertion or its enclosing Response.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: Extract InResponseTo from Response element
  // -------------------------------------------------------------------------
  const responseEls = getByNsLocalName(doc as unknown as Document, NS_SAMLP, "Response");
  const responseEl = responseEls[0] ?? doc.documentElement;
  const inResponseTo = responseEl.getAttribute("InResponseTo") ?? null;
  // PHASE 8 §11.2 — Destination (Response @Destination) + Recipient
  // (SubjectConfirmationData @Recipient) binding to THIS SP's ACS URL.
  const destination = responseEl.getAttribute("Destination") ?? null;
  const scdEls = getByNsLocalName(assertion, NS_SAML, "SubjectConfirmationData");
  const recipient = scdEls[0]?.getAttribute("Recipient") ?? null;
  const rd = evaluateSamlRecipientDestination({
    destination,
    recipient,
    expectedAcsUrl: input.expectedAcsUrl ?? null,
    require: input.requireRecipientDestination === true,
  });
  if (!rd.ok) {
    throw new SamlAssertionError("SAML_RECIPIENT_DESTINATION_MISMATCH", rd.reason);
  }

  if (
    input.expectedInResponseTo != null &&
    input.expectedInResponseTo.trim() !== ""
  ) {
    if (inResponseTo !== input.expectedInResponseTo) {
      throw new SamlAssertionError(
        "SAML_IN_RESPONSE_TO_MISMATCH",
        "InResponseTo does not match the stored AuthnRequest ID.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 8: Extract and validate Conditions
  // -------------------------------------------------------------------------
  const conditionEls = getByNsLocalName(assertion, NS_SAML, "Conditions");
  const conditions = conditionEls[0] ?? null;

  let notBefore: Date | null = null;
  let notOnOrAfter: Date | null = null;
  const audienceRestriction: string[] = [];

  if (conditions) {
    const nbAttr = conditions.getAttribute("NotBefore");
    const noaAttr = conditions.getAttribute("NotOnOrAfter");
    if (nbAttr) notBefore = new Date(nbAttr);
    if (noaAttr) notOnOrAfter = new Date(noaAttr);

    // AudienceRestriction
    const audienceEls = getByNsLocalName(conditions, NS_SAML, "Audience");
    for (const aud of audienceEls) {
      const val = textOf(aud);
      if (val) audienceRestriction.push(val);
    }
  }

  const now = Date.now();
  const skewMs = clockSkew * 1000;

  if (notBefore && now < notBefore.getTime() - skewMs) {
    throw new SamlAssertionError(
      "SAML_CONDITIONS_NOT_YET_VALID",
      "Assertion is not yet valid (NotBefore condition).",
    );
  }
  if (notOnOrAfter && now > notOnOrAfter.getTime() + skewMs) {
    throw new SamlAssertionError(
      "SAML_CONDITIONS_EXPIRED",
      "Assertion has expired (NotOnOrAfter condition).",
    );
  }

  // Audience check — PHASE 8 §11.2 via the pure `evaluateSamlAudience`
  // decision (behaviorally tested without a signed-XML harness).
  const audienceDecision = evaluateSamlAudience({
    audienceRestriction,
    spEntityId: input.spEntityId,
    requireAudience: input.requireAudience === true,
  });
  if (!audienceDecision.ok) {
    throw new SamlAssertionError("SAML_AUDIENCE_MISMATCH", audienceDecision.reason);
  }

  // -------------------------------------------------------------------------
  // Step 9: Extract NameID
  // -------------------------------------------------------------------------
  const subjectEls = getByNsLocalName(assertion, NS_SAML, "Subject");
  const nameIdEls = subjectEls.length > 0
    ? getByNsLocalName(subjectEls[0]!, NS_SAML, "NameID")
    : getByNsLocalName(assertion, NS_SAML, "NameID");

  const nameIdEl = nameIdEls[0] ?? null;
  if (!nameIdEl) {
    throw new SamlAssertionError(
      "SAML_NAME_ID_MISSING",
      "No NameID element found in Assertion Subject.",
    );
  }

  const nameId = textOf(nameIdEl);
  if (!nameId) {
    throw new SamlAssertionError(
      "SAML_NAME_ID_MISSING",
      "NameID element has empty text content.",
    );
  }

  const nameIdFormat =
    nameIdEl.getAttribute("Format") ??
    "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";

  // -------------------------------------------------------------------------
  // Step 10: Extract AuthnStatement
  // -------------------------------------------------------------------------
  let sessionIndex: string | null = null;
  let authnContextClassRef: string | null = null;

  const authnStmts = getByNsLocalName(assertion, NS_SAML, "AuthnStatement");
  if (authnStmts.length > 0) {
    sessionIndex = authnStmts[0]!.getAttribute("SessionIndex") ?? null;
    const classRefs = getByNsLocalName(
      authnStmts[0]!,
      NS_SAML,
      "AuthnContextClassRef",
    );
    if (classRefs.length > 0) {
      authnContextClassRef = textOf(classRefs[0]!);
    }
  }

  // -------------------------------------------------------------------------
  // Step 11: Extract AttributeStatement
  // -------------------------------------------------------------------------
  const attributes: Record<string, string[]> = {};

  const attrStmts = getByNsLocalName(assertion, NS_SAML, "AttributeStatement");
  for (const stmt of attrStmts) {
    const attrEls = getByNsLocalName(stmt, NS_SAML, "Attribute");
    for (const attr of attrEls) {
      const attrName =
        attr.getAttribute("Name") ??
        attr.getAttribute("FriendlyName") ??
        null;
      if (!attrName) continue;
      const values: string[] = [];
      const valEls = getByNsLocalName(attr, NS_SAML, "AttributeValue");
      for (const val of valEls) {
        const v = textOf(val);
        if (v) values.push(v);
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
  const issuer = issuerEls.length > 0 ? textOf(issuerEls[0]!) : "";

  // P0 remediation (2026-07-21) — enforce the pinned IdP entityID. The
  // pinned certificate proves WHO signed; the issuer proves WHICH IdP the
  // assertion claims to come from. Both must agree with the connection's
  // configuration. Skipped only when the connection has no pinned entityID
  // (legacy — callers surface a warning; new connections should always
  // ingest metadata).
  if (
    input.expectedIdpEntityId != null &&
    input.expectedIdpEntityId.trim() !== "" &&
    issuer.trim() !== input.expectedIdpEntityId.trim()
  ) {
    throw new SamlAssertionError(
      "SAML_ISSUER_MISMATCH",
      "Assertion Issuer does not match the connection's configured IdP entityID.",
    );
  }

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
