/**
 * saml-metadata.service.ts
 *
 * Phase R8.2 — Real SAML Service Provider Activation
 *
 * Parses IdP SAML metadata XML (raw string or fetched from a URL) and extracts
 * the fields needed to configure our SP. Uses @xmldom/xmldom for parsing with
 * XXE disabled and node:crypto for certificate fingerprint computation.
 *
 * Security notes:
 *  - @xmldom/xmldom does NOT process external entities by default (no XXE risk).
 *  - DTD entity injection (`<!ENTITY`) is blocked before parsing.
 *  - Certificate data and XML content are never logged.
 */

import { DOMParser } from "@xmldom/xmldom";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Fields extracted from IdP SAML metadata that our SP needs. */
export type SamlIdpMetadata = {
  /** IdP entityID from EntityDescriptor/@entityID */
  entityId: string;
  /** IdP SSO URL — HTTP-Redirect binding preferred, POST fallback */
  ssoUrl: string;
  /**
   * Base64-only certificate string (no PEM headers, whitespace stripped).
   * This is the raw X.509 DER bytes in base64 form.
   */
  certificate: string;
  /** SHA-256 hex fingerprint of the DER-encoded certificate bytes (lowercase) */
  certFingerprint: string;
  /** NameIDFormat declared in metadata, or null if absent */
  nameIdFormat: string | null;
};

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type SamlMetadataErrorCode =
  | "METADATA_PARSE_FAILED"
  | "METADATA_MISSING_ENTITY_ID"
  | "METADATA_MISSING_SSO_URL"
  | "METADATA_MISSING_CERTIFICATE"
  | "METADATA_FETCH_FAILED"
  | "METADATA_XML_UNSAFE";

/** Structured error thrown by SAML metadata parsing operations. */
export class SamlMetadataError extends Error {
  constructor(
    public readonly code: SamlMetadataErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SamlMetadataError";
  }
}
const BINDING_HTTP_REDIRECT =
  "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const BINDING_HTTP_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the first element with the given local name inside a parent node,
 * searching the direct child list only (one level deep) then recursively.
 * Returns null if not found.
 */
function findElement(
  parent: Element | Document,
  localName: string,
): Element | null {
  // Work with the actual child nodes
  const children = parent.childNodes;
  for (let i = 0; i < children.length; i++) {
    const node = children.item(i);
    if (node && node.nodeType === 1 /* ELEMENT_NODE */) {
      const el = node as Element;
      if (el.localName === localName) {
        return el;
      }
    }
  }
  // Recurse
  for (let i = 0; i < children.length; i++) {
    const node = children.item(i);
    if (node && node.nodeType === 1) {
      const found = findElement(node as Element, localName);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Returns ALL elements with the given local name anywhere under the given root,
 * in document order.
 */
function findAllElements(
  root: Element | Document,
  localName: string,
): Element[] {
  const results: Element[] = [];
  function walk(node: Node): void {
    if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const el = node as Element;
      if (el.localName === localName) {
        results.push(el);
      }
    }
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children.item(i);
      if (child) walk(child);
    }
  }
  walk(root as unknown as Node);
  return results;
}

/**
 * Collects all text node content under an element (concatenated).
 */
function textContent(el: Element): string {
  let text = "";
  const children = el.childNodes;
  for (let i = 0; i < children.length; i++) {
    const node = children.item(i);
    if (node && node.nodeType === 3 /* TEXT_NODE */) {
      text += (node as Text).nodeValue ?? "";
    }
  }
  return text;
}

/**
 * Computes SHA-256 fingerprint of DER-encoded certificate bytes.
 * Input is a base64 string (no headers, no whitespace).
 * Returns lowercase hex string.
 */
function computeCertFingerprint(base64Cert: string): string {
  const derBytes = Buffer.from(base64Cert, "base64");
  return createHash("sha256").update(derBytes).digest("hex");
}

// ---------------------------------------------------------------------------
// parseSamlMetadata
// ---------------------------------------------------------------------------

/**
 * Parses a raw SAML IdP metadata XML string and returns the SP-relevant fields.
 *
 * @param xmlString - Raw XML string of IdP metadata (e.g. content of metadata.xml).
 * @throws {SamlMetadataError} with appropriate code on any parsing failure.
 */
export function parseSamlMetadata(xmlString: string): SamlIdpMetadata {
  // Guard: must be a non-empty string
  if (typeof xmlString !== "string" || xmlString.trim().length === 0) {
    throw new SamlMetadataError(
      "METADATA_PARSE_FAILED",
      "Metadata XML must be a non-empty string.",
    );
  }

  // Guard: DTD entity injection — reject any XML that declares entities.
  // This is a defense-in-depth measure; @xmldom/xmldom does not process
  // external entities by default, but we also block <!ENTITY declarations
  // to prevent billion-laughs and similar DTD attacks.
  if (xmlString.includes("<!ENTITY")) {
    throw new SamlMetadataError(
      "METADATA_XML_UNSAFE",
      "Metadata XML contains DTD entity declarations which are not permitted.",
    );
  }

  // Parse with @xmldom/xmldom.
  // @xmldom/xmldom does not fetch external DTDs or process external entities
  // by default — no additional configuration is required to disable XXE.
  let parseError: string | null = null;
  const parser = new DOMParser({
    // @xmldom/xmldom v0.9.x uses a single ErrorHandlerFunction
    // (level, msg, context) => void — not an object with separate methods.
    errorHandler: (level, msg) => {
      if (level === "fatalError") {
        parseError = msg;
      }
      // Non-fatal errors and warnings are suppressed.
    },
  });

  const doc = parser.parseFromString(xmlString, "text/xml");

  if (parseError) {
    throw new SamlMetadataError(
      "METADATA_PARSE_FAILED",
      `XML parse error: ${parseError}`,
    );
  }

  if (!doc || !doc.documentElement) {
    throw new SamlMetadataError(
      "METADATA_PARSE_FAILED",
      "XML parser produced no document element.",
    );
  }

  const root = doc.documentElement;

  // -------------------------------------------------------------------------
  // 1. entityId — EntityDescriptor/@entityID
  // -------------------------------------------------------------------------
  const entityId = root.getAttribute("entityID");
  if (!entityId || entityId.trim() === "") {
    throw new SamlMetadataError(
      "METADATA_MISSING_ENTITY_ID",
      "EntityDescriptor/@entityID is absent or empty.",
    );
  }

  // -------------------------------------------------------------------------
  // 2. ssoUrl — SingleSignOnService, prefer HTTP-Redirect, fall back to POST
  // -------------------------------------------------------------------------
  // Cast: @xmldom Document is structurally distinct from global DOM Document.
  const ssoElements = findAllElements(doc as unknown as Document, "SingleSignOnService");

  let ssoUrl: string | null = null;

  // Prefer HTTP-Redirect binding
  for (const el of ssoElements) {
    if (el.getAttribute("Binding") === BINDING_HTTP_REDIRECT) {
      const loc = el.getAttribute("Location");
      if (loc) {
        ssoUrl = loc;
        break;
      }
    }
  }

  // Fall back to HTTP-POST binding
  if (!ssoUrl) {
    for (const el of ssoElements) {
      if (el.getAttribute("Binding") === BINDING_HTTP_POST) {
        const loc = el.getAttribute("Location");
        if (loc) {
          ssoUrl = loc;
          break;
        }
      }
    }
  }

  if (!ssoUrl) {
    throw new SamlMetadataError(
      "METADATA_MISSING_SSO_URL",
      "No SingleSignOnService with HTTP-Redirect or HTTP-POST binding found.",
    );
  }

  // -------------------------------------------------------------------------
  // 3. certificate — prefer IDPSSODescriptor/KeyDescriptor[@use="signing"],
  //    fall back to any X509Certificate in the document.
  // -------------------------------------------------------------------------
  let rawCert: string | null = null;

  // Attempt to find IDPSSODescriptor first
  const idpSsoDescriptor = findElement(doc as unknown as Document, "IDPSSODescriptor");

  if (idpSsoDescriptor) {
    // Look for KeyDescriptor with use="signing"
    const keyDescriptors = findAllElements(idpSsoDescriptor, "KeyDescriptor");
    for (const kd of keyDescriptors) {
      const use = kd.getAttribute("use");
      if (use === "signing" || use === null || use === "") {
        // use=null / empty means "any use", treat as valid
        const certEl = findElement(kd, "X509Certificate");
        if (certEl) {
          const raw = textContent(certEl).replace(/\s+/g, "");
          if (raw) {
            rawCert = raw;
            break;
          }
        }
      }
    }
  }

  // Fallback: any X509Certificate anywhere in the document
  if (!rawCert) {
    const allCerts = findAllElements(doc as unknown as Document, "X509Certificate");
    for (const certEl of allCerts) {
      const raw = textContent(certEl).replace(/\s+/g, "");
      if (raw) {
        rawCert = raw;
        break;
      }
    }
  }

  if (!rawCert) {
    throw new SamlMetadataError(
      "METADATA_MISSING_CERTIFICATE",
      "No X509Certificate found in IdP metadata.",
    );
  }

  // -------------------------------------------------------------------------
  // 4. certFingerprint — SHA-256 of DER bytes
  // -------------------------------------------------------------------------
  const certFingerprint = computeCertFingerprint(rawCert);

  // -------------------------------------------------------------------------
  // 5. nameIdFormat — optional
  // -------------------------------------------------------------------------
  let nameIdFormat: string | null = null;
  const nameIdEl = findElement(doc as unknown as Document, "NameIDFormat");
  if (nameIdEl) {
    const fmt = textContent(nameIdEl).trim();
    if (fmt) {
      nameIdFormat = fmt;
    }
  }

  return {
    entityId: entityId.trim(),
    ssoUrl,
    certificate: rawCert,
    certFingerprint,
    nameIdFormat,
  };
}

// ---------------------------------------------------------------------------
// fetchAndParseSamlMetadata
// ---------------------------------------------------------------------------

/**
 * Fetches SAML IdP metadata from the given HTTPS URL and parses it.
 *
 * Only HTTPS URLs are accepted to prevent metadata substitution attacks
 * over unencrypted channels.
 *
 * @param metadataUrl - Must start with `https://`.
 * @throws {SamlMetadataError} with METADATA_FETCH_FAILED for non-HTTPS,
 *   network errors, or non-OK HTTP responses.
 * @throws {SamlMetadataError} with other codes from {@link parseSamlMetadata}.
 */
export async function fetchAndParseSamlMetadata(
  metadataUrl: string,
): Promise<SamlIdpMetadata> {
  // Only allow HTTPS to prevent MITM / metadata substitution
  if (
    typeof metadataUrl !== "string" ||
    !metadataUrl.startsWith("https://")
  ) {
    throw new SamlMetadataError(
      "METADATA_FETCH_FAILED",
      "Metadata URL must use HTTPS.",
    );
  }

  let response: Response;
  try {
    response = await fetch(metadataUrl, {
      method: "GET",
      headers: { Accept: "application/xml, text/xml, */*" },
      // Redirect following is fine for metadata endpoints (default: "follow")
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SamlMetadataError(
      "METADATA_FETCH_FAILED",
      `Network error fetching metadata: ${msg}`,
    );
  }

  if (!response.ok) {
    throw new SamlMetadataError(
      "METADATA_FETCH_FAILED",
      `Metadata endpoint returned HTTP ${response.status}.`,
    );
  }

  let xmlText: string;
  try {
    xmlText = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SamlMetadataError(
      "METADATA_FETCH_FAILED",
      `Failed to read metadata response body: ${msg}`,
    );
  }

  return parseSamlMetadata(xmlText);
}
