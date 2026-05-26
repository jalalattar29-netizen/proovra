# R8.2.1 — SAML IdP Compatibility Matrix

**Phase:** R8.2.1 — Real IdP Interoperability & SAML Hardening  
**Status:** PRODUCTION-READY (pilot)  
**Last updated:** 2026-05-25

This document describes how Proovra's SAML SP is configured for each major
enterprise IdP, what quirks to expect, and what the SP requires from each IdP.

---

## Table of Contents

1. [SP Capabilities](#sp-capabilities)
2. [Okta](#okta)
3. [Microsoft Entra ID (Azure AD)](#microsoft-entra-id-azure-ad)
4. [Google Workspace](#google-workspace)
5. [Generic SAML 2.0](#generic-saml-20)
6. [Attribute Mapping Reference](#attribute-mapping-reference)
7. [Certificate Rotation Procedure](#certificate-rotation-procedure)
8. [Known Limitations](#known-limitations)

---

## SP Capabilities

| Capability | Status |
|---|---|
| HTTP-Redirect binding (AuthnRequest) | ✅ Supported |
| HTTP-POST binding (ACS) | ✅ Supported |
| Assertion-level signature verification | ✅ Required |
| Response-level signature (fallback) | ✅ Accepted |
| Unsigned assertions | ❌ Rejected (always) |
| Encrypted assertions | ❌ Not yet supported |
| SAML SLO (Single Logout) | ❌ Not yet supported |
| SP-initiated sign-on | ✅ Supported |
| IdP-initiated sign-on | ❌ Rejected (no InResponseTo) |
| Dual-cert rotation (zero-downtime) | ✅ R8.2.1 |
| JIT provisioning | ✅ Per-connection policy |
| SCIM-managed JIT suppression | ✅ R8.2.1 |

---

## Okta

### Configuration (Okta Admin Console)

1. **Application type:** SAML 2.0
2. **Single Sign-On URL (ACS URL):**
   ```
   https://api.proovra.com/v1/auth/saml/acs
   ```
3. **SP Entity ID:**
   ```
   https://api.proovra.com/saml/sp/{connectionId}
   ```
   Retrieve `{connectionId}` from `GET /v1/auth/saml/metadata/{connectionId}`.

4. **Name ID format:** `EmailAddress` (Okta sends the email as NameID)
5. **Attribute statements:** Not required if Name ID format is EmailAddress.
   Optional additions:
   | Name | Value |
   |---|---|
   | `displayName` | `${user.displayName}` |
   | `email` | `${user.email}` |

6. **Signature algorithm:** RSA-SHA256 (default Okta)
7. **Digest algorithm:** SHA256

### Quirks
- Okta includes `InResponseTo` on SP-initiated flows — verify is enforced.
- Okta uses `emailAddress` NameID format by default; the SP accepts this.
- Okta may send `email` as both a NameID and an attribute; the SP prefers
  the NameID when it has email format.
- Okta's metadata XML is available at `https://{okta-domain}/app/{app-id}/sso/saml/metadata`.
  Paste it into the **Ingest Metadata** field in the Security Center SSO panel.

### Expected assertions
```
NameID Format: urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
NameID Value: user@company.com
Attribute: displayName → "Jane Smith"
```

---

## Microsoft Entra ID (Azure AD)

### Configuration (Azure Portal → Enterprise Applications → SAML)

1. **Basic SAML Configuration:**
   - **Identifier (Entity ID):**
     ```
     https://api.proovra.com/saml/sp/{connectionId}
     ```
   - **Reply URL (ACS URL):**
     ```
     https://api.proovra.com/v1/auth/saml/acs
     ```
   - **Sign on URL:** leave blank (SP-initiated)

2. **Attributes & Claims:**
   Entra ID sends email via the WS-Fed claim URI, not as a plain attribute name.
   The SP automatically handles:
   - `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`
   - `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn`
   - `http://schemas.microsoft.com/identity/claims/userprincipalname`
   - `userPrincipalName`
   
   No custom attribute mapping required for standard Entra ID tenants.

3. **SAML Signing Certificate:** Download in Base64 format. Ingest via the
   Security Center metadata URL field or paste the full metadata XML.

### Quirks
- **NameID format:** Entra ID sends `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`
  with an opaque ObjectID as the NameID value by default. Configure the NameID
  claim to emit the user's email:
  - In Azure → SAML → Attributes & Claims → Edit → "Unique User Identifier"
  - Change "Source attribute" from `user.userprincipalname` to `user.mail` 
  - Change "Name identifier format" to `Email address`
  
  OR: add `email` as a custom claim with value `user.mail` and configure the
  Proovra connection with `samlAttributeMapping = { "email": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" }`.

- **Certificate rotation:** Entra ID rotates signing certificates every 3 years.
  Use the R8.2.1 cert rotation flow (PUT `/certificate-next`) before Entra
  rotates so both certs are accepted during the transition window.

- **Audience restriction:** Entra ID enforces the Entity ID exactly. The SP
  sends the connectionId-scoped entityID; ensure this matches the "Identifier"
  field in the Entra app configuration.

- **Clock skew:** Entra ID assertions are typically valid for 1 hour. The SP
  applies 60-second default skew tolerance.

### Expected assertions
```
NameID Format: urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
NameID Value: user@tenant.onmicrosoft.com
Attribute: http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress → user@company.com
Attribute: http://schemas.microsoft.com/identity/claims/displayname → "Jane Smith"
```

---

## Google Workspace

### Configuration (Google Admin Console → Apps → SAML Apps)

1. **ACS URL:**
   ```
   https://api.proovra.com/v1/auth/saml/acs
   ```
2. **Entity ID:**
   ```
   https://api.proovra.com/saml/sp/{connectionId}
   ```
3. **Name ID format:** `EMAIL` (default Google Workspace)
4. **Name ID:** Basic Information → Primary email

5. **Attribute mapping (optional):**
   | Google Directory attribute | App attribute |
   |---|---|
   | Primary email | `email` |
   | First name + Last name | `displayName` |

### Quirks
- Google Workspace sends the user's primary email as both the NameID (with
  email format) and optionally as the `email` attribute.
- Google's signing certificate is in PEM format in the metadata XML. The
  SP strips PEM headers on ingest automatically.
- **No InResponseTo:** Google Workspace SAML does support SP-initiated flows
  and includes `InResponseTo`. Ensure SP-initiated is used (not IdP-initiated).
- **Metadata URL:** `https://accounts.google.com/o/saml2/idp?idpid={YOUR_IDP_ID}`
  or download from the SAML app setup flow.

### Expected assertions
```
NameID Format: urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
NameID Value: user@company.com
Attribute: email → user@company.com
```

---

## Generic SAML 2.0

For IdPs not listed above (Ping Identity, OneLogin, ADFS, Shibboleth, Keycloak):

### Minimum requirements
1. **Binding:** HTTP-POST for the ACS; HTTP-Redirect for AuthnRequest.
2. **Signature:** Assertion-level RSA-SHA256 or RSA-SHA1 (SHA256 preferred).
3. **Email resolution:** The SP will try (in order):
   - Custom `samlAttributeMapping.email` attribute name
   - NameID if format indicates email or value contains `@`
   - All aliases in `EMAIL_ATTR_NAMES` (see Attribute Mapping Reference)
4. **AudienceRestriction:** Must include the SP entityID exactly.
5. **InResponseTo:** Must match the `ID` attribute of the AuthnRequest.

### Recommended attribute configuration
```
Attribute Name: email
Attribute Value: user's primary email
```

---

## Attribute Mapping Reference

The SP tries these attribute names **in order** to resolve the user's email.
First non-empty match wins. Custom `samlAttributeMapping.email` takes priority
over this list.

| Priority | Attribute Name | Covers |
|---|---|---|
| 1 (custom) | `samlAttributeMapping.email` | Operator-specified override |
| 2 | NameID (if email format or contains @) | Okta, Google Workspace |
| 3 | `email` | Okta, Google, generic |
| 4 | `mail` | LDAP-based IdPs |
| 5 | `emailAddress` | Legacy SAML apps |
| 6 | `EmailAddress` | Some ADFS versions |
| 7 | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` | Entra ID |
| 8 | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn` | Entra ID UPN |
| 9 | `http://schemas.microsoft.com/identity/claims/userprincipalname` | Entra ID |
| 10 | `userPrincipalName` | Entra ID short-form |
| 11 | `urn:oasis:names:tc:SAML:attribute:email` | Google Workspace OID |
| 12 | `urn:oid:0.9.2342.19200300.100.1.3` | RFC 2798 mail OID |
| 13 | `urn:oid:1.3.6.1.4.1.5923.1.1.1.6` | eduPerson eppn |

If none of these resolve to a valid email, the assertion is rejected with
`saml_attribute_mapping_failed` (severity: WARNING) and the operator can see
which attribute keys the IdP sent (but NOT their values) in the Security Center
event details.

---

## Certificate Rotation Procedure

Zero-downtime certificate rotation using the R8.2.1 dual-cert feature:

### Phase 1 — Add the new cert as "next"
```http
PUT /v1/auth/saml/{connectionId}/certificate-next
Authorization: Bearer {admin-token}
Content-Type: application/json

{
  "certificate": "<base64-only cert, no PEM headers>"
}
```
Response: `{ "ok": true, "certNextFingerprint": "sha256hex..." }`

From this point, both the primary cert and the next cert are accepted.

### Phase 2 — Rotate at the IdP
Configure the IdP to start signing with the new certificate. Both certs are
accepted by the SP during this transition window.

### Phase 3 — Promote next to primary
After confirming the new cert works (use test-connection), promote:
```http
DELETE /v1/auth/saml/{connectionId}/certificate-next
Authorization: Bearer {admin-token}
```
Response: `{ "ok": true, "certFingerprint": "sha256hex..." }`

The new cert is now the only accepted cert. The old cert is dropped.

---

## Known Limitations

1. **No encrypted assertions:** Assertion encryption is not yet supported.
   IdPs that require encrypted assertions cannot be configured with Proovra
   in R8.2.1. This is on the roadmap for R8.3.

2. **No IdP-initiated flows:** The SP requires `InResponseTo` to match a
   stored AuthnRequest ID. IdP-initiated flows (where the IdP pushes an
   assertion without the SP initiating) are rejected.

3. **No SAML SLO:** Single Logout is not implemented. Sessions must be
   revoked via the Security Center session management surface.

4. **HTTP-POST only for ACS:** The ACS binding is HTTP-POST. The SP does not
   support HTTP-Redirect binding for the ACS (this is correct per SAML spec
   for assertion delivery).

5. **Single assertion:** If an IdP sends a Response with multiple Assertion
   elements, only the first is processed.
