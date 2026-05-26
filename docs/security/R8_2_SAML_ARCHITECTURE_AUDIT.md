# R8.2 — SAML Architecture Audit

**Phase:** R8.2 — SAML SP Activation  
**Document class:** Security Architecture Audit  
**Author:** Engineering Security Team  
**Date:** 2026-05-25  
**Status:** Active — reviewed at phase close  

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Security Controls](#security-controls)
3. [Threat Model](#threat-model)
4. [Implementation Decisions](#implementation-decisions)
5. [Known Limitations](#known-limitations)
6. [Future Work](#future-work)

---

## Architecture Overview

Digital Witness implements a SAML 2.0 Service Provider (SAML SP) using the
`samlify` library for assertion parsing and the `xml-crypto` library for
XML signature validation. The SP is multi-tenant: each workspace (team)
may have one or more `SsoProvider` records in the database, each scoped to
a `connectionId`. A single API server hosts all SP endpoints. The SP does
not act as an Identity Provider under any circumstance.

### Binding Support

The SP supports the following SAML 2.0 bindings:

- **HTTP-Redirect binding** — used exclusively for sending AuthnRequests from
  the SP to the IdP. The SP constructs a compressed, Base64-encoded, URL-encoded
  `AuthnRequest` XML document, signs it with the SP private key using
  `RSA-SHA256`, and appends the signature to the redirect URL as `SigAlg` +
  `Signature` query parameters. This is the standard HTTP-Redirect binding
  for SP-initiated SSO.

- **HTTP-POST binding** — used exclusively for receiving SAML Responses
  (assertions) from the IdP at the Assertion Consumer Service (ACS) endpoint.
  The browser POSTs a Base64-encoded, optionally-deflate-compressed `SAMLResponse`
  form field to the ACS. The ACS decodes, parses, and validates the response
  before issuing a session.

The SP intentionally does not support HTTP-Artifact binding. Artifact binding
requires a back-channel from the SP to the IdP's Artifact Resolution Service
and introduces additional complexity with minimal security benefit for our
threat model.

### Endpoint Map

| Role | Route | Method | Notes |
|------|-------|--------|-------|
| SP Metadata | `/v1/auth/saml/metadata/:connectionId` | GET | Returns EntityDescriptor XML |
| SP-Initiated Login | `/v1/auth/saml/:connectionId/login` | GET | Constructs AuthnRequest, redirects to IdP |
| Assertion Consumer Service (ACS) | `/v1/auth/saml/:connectionId/acs` | POST | Validates SAMLResponse, issues session |
| IdP Metadata Ingest | `/v1/auth/saml/:connectionId/ingest-metadata` | POST | Admin-only, extracts SSO URL + cert |

### SP EntityID

The SP EntityID is computed as:

```
https://{API_BASE}/v1/auth/saml/metadata/{connectionId}
```

This is a stable URL that doubles as both the SP's SAML EntityID and the
metadata endpoint. The EntityID must match exactly what is registered with
each IdP. Mismatches are a common source of IdP-side `Audience` validation
failures.

### AuthnRequest Construction

The SP constructs a minimal `AuthnRequest` on each SP-initiated login:

```xml
<samlp:AuthnRequest
  xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="_<random-uuid>"
  Version="2.0"
  IssueInstant="<UTC ISO-8601>"
  Destination="<IdP SSO URL>"
  AssertionConsumerServiceURL="<ACS URL>"
  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer><SP EntityID></saml:Issuer>
</samlp:AuthnRequest>
```

The `ID` attribute is a `_`-prefixed UUIDv4. It is stored in a short-lived
database record (`SamlPendingRequest`) keyed on `(connectionId, requestId)` with
a 10-minute TTL. The ACS verifies the `InResponseTo` attribute of the incoming
`SAMLResponse` against these pending records.

---

## Security Controls

### 1. Signature Validation

All SAML Responses and enclosed Assertions received at the ACS are validated
using `xml-crypto`. The validation path is:

1. Parse the raw POST body (`SAMLResponse` form field).
2. Base64-decode the value.
3. Parse the resulting XML string using a safe XML parser configured with
   `xml-crypto`'s `SignedXml` class.
4. Locate the `ds:Signature` element within the `samlp:Response` or
   `saml:Assertion` element.
5. Validate the signature against the stored certificate fingerprint (`samlCertFingerprint`)
   extracted during metadata ingest.
6. Reject any response where signature validation fails with a structured
   `SAML_SIGNATURE_INVALID` error event.

Unsigned responses are rejected unconditionally. There is no configuration
knob to accept unsigned assertions in production.

### 2. InResponseTo Validation and Replay Protection

The ACS enforces `InResponseTo` validation to prevent SAML assertion replay:

- On SP-initiated login, the `AuthnRequest` ID is stored as a `SamlPendingRequest`
  with a 10-minute expiry.
- On ACS receipt, the `InResponseTo` attribute of the `SAMLResponse` is required
  and must match a non-expired `SamlPendingRequest` for the given `connectionId`.
- Matched `SamlPendingRequest` records are deleted immediately on first successful
  use — they are single-use tokens. A second attempt to use the same `InResponseTo`
  value is rejected with `SAML_REPLAY_DETECTED`.
- Responses without an `InResponseTo` attribute (IdP-initiated SSO) are currently
  rejected. See Known Limitations for rationale.

This mechanism constitutes the primary Replay protection layer. It is
complemented by `Conditions`/`NotOnOrAfter` timestamp enforcement (see below).

### 3. Audience Restriction Enforcement

The ACS validates the `<saml:AudienceRestriction>` element within the assertion
conditions:

- The `<saml:Audience>` value must exactly match the SP EntityID for the
  given `connectionId`.
- Mismatched audience values produce a `SAML_AUDIENCE_MISMATCH` error and
  a structured security event.
- This prevents cross-tenant assertion reuse: an assertion issued for
  workspace A's SP cannot be accepted by workspace B's ACS even if both
  share the same IdP.

### 4. Timestamp Enforcement

The ACS enforces SAML `Conditions` timestamps with a 30-second clock skew
allowance:

- `NotBefore`: assertion is rejected if the current UTC time is more than
  30 seconds before `NotBefore`.
- `NotOnOrAfter`: assertion is rejected if the current UTC time is at or
  after `NotOnOrAfter`.
- `AuthnStatement/SessionNotOnOrAfter`: used as an advisory upper bound for
  the issued session TTL. The actual session TTL is `min(SessionNotOnOrAfter,
  globalMaxSessionTtl)`.

### 5. XXE Prevention

XML eXternal Entity (XXE) injection is a well-documented SAML attack vector.
An attacker-controlled SAML Response containing a DOCTYPE declaration with an
external entity reference could cause the server to make outbound HTTP requests
(SSRF) or expose local files.

Mitigations in place:

- The XML parser used by `xml-crypto` and `samlify` is configured to discard
  DOCTYPE declarations before parsing. Any SAML Response containing a `<!DOCTYPE`
  declaration is rejected with `SAML_MALFORMED_XML`.
- The raw bytes of the incoming `SAMLResponse` are scanned for `<!DOCTYPE`,
  `<!ENTITY`, and `SYSTEM` before decoding to catch encoded variants.
- Node.js's built-in XML parser does not load external resources by default,
  but the explicit DOCTYPE block provides defense-in-depth.

### 6. Certificate Fingerprint Pinning

Rather than accepting any certificate that chains to a known CA, the SP pins
the exact SHA-256 fingerprint of the IdP signing certificate extracted during
metadata ingest. This provides:

- Resistance to CA compromise attacks targeting SAML.
- Immediate detection of IdP certificate rotation (rotation requires re-ingest).
- Prevents Key confusion attacks where a certificate from a different IdP
  or a self-signed certificate could be substituted to forge assertions.

Certificate fingerprints are stored as lowercase hex SHA-256 strings. The
comparison is constant-time to prevent timing side-channels.

### 7. NameID and Attribute Mapping

The `NameID` from the SAML assertion is treated as an opaque identifier from
the IdP. The SP:

- Stores the `NameID` format alongside the value in the session provisioning
  record.
- Does not use the `NameID` as a primary account key without a confirmed
  email attribute cross-check.
- Rejects `NameID` values longer than 1024 bytes.
- Rejects assertions with no `NameID` element.

### 8. Failure Counting and Outage Detection

The `SsoProvider` record tracks:

- `consecutiveFailureCount`: incremented on each ACS validation failure,
  reset to zero on any successful assertion acceptance.
- `outageDetectedAtUtc`: set when `consecutiveFailureCount` crosses the
  configured threshold (default: 5). Cleared on next successful assertion.

The Security Center admin surface surfaces these signals so operators can
detect IdP certificate rotation, metadata drift, or clock skew issues before
they result in a full workspace lockout.

---

## Threat Model

### Assets

1. User sessions — the primary outcome of a successful SAML flow.
2. User identity claims — `NameID`, email, role attributes.
3. SP private key — used to sign `AuthnRequest` under HTTP-Redirect binding.
4. IdP certificate — pinned per-connection; compromise enables assertion forgery.

### Threat Actors

- **External attacker (unauthenticated):** Can interact with the ACS endpoint
  directly. Goal: forge a SAML assertion to gain unauthorized access.
- **Compromised IdP:** An IdP that has been taken over and is issuing fraudulent
  assertions.
- **Network-level attacker (MitM on HTTP-POST):** Can intercept and replay
  SAML Responses over insecure channels. Mitigated by TLS requirement.
- **Malicious workspace admin:** An admin of workspace A attempting to use
  workspace A's IdP credentials to access workspace B.

### Attack Surface Analysis

| Attack | Mitigation |
|--------|-----------|
| Assertion replay | `InResponseTo` single-use token + `NotOnOrAfter` timestamp |
| Cross-tenant assertion reuse | `AudienceRestriction` per-connection EntityID |
| Forged assertion (unsigned) | Unsigned responses rejected unconditionally |
| Forged assertion (wrong key) | Certificate fingerprint pinning |
| XXE via DOCTYPE injection | DOCTYPE stripping + pre-decode byte scan |
| SSRF via XML entity | DOCTYPE stripping; no external resource resolution |
| Key confusion (cert substitution) | Exact SHA-256 fingerprint match, not CA chain |
| Clock skew / replay window | 30-second skew allowance; no unbounded window |
| IdP-initiated SSO abuse | IdP-initiated flows currently rejected (see Known Limitations) |
| SP metadata spoofing | Metadata endpoint requires `connectionId` scoped to tenant |
| ACS parameter tampering | `connectionId` bound to ACS URL; cross-connection reuse rejected |
| Brute force login via SP flow | Rate limiting on `/login` endpoint (per-IP, per-team) |

---

## Implementation Decisions

### D1: samlify + xml-crypto as the SAML parsing stack

**Decision:** Use `samlify` for high-level SAML flow orchestration and
`xml-crypto` for low-level XML signature operations.

**Rationale:** `samlify` is the most widely deployed Node.js SAML SP library
and has received dedicated security research and CVE scrutiny. `xml-crypto`
is the de-facto standard for XML-DSIG in Node.js. Both libraries are actively
maintained. The split means signature validation can be audited independently
of the higher-level flow logic.

**Tradeoff:** `samlify` has had historical XXE vulnerabilities (CVE-2017-11429
class). All known vectors are mitigated by the DOCTYPE stripping described in
Security Controls §5. The library is pinned to a specific version and updates
are gated on a security review.

### D2: Reject IdP-initiated SSO

**Decision:** SAML Responses without a valid `InResponseTo` are rejected.

**Rationale:** IdP-initiated SSO (unsolicited responses) bypasses the
`InResponseTo` replay protection mechanism entirely. The attack surface of
IdP-initiated flows is substantially larger: any party who can coerce a user's
browser to POST a forged `SAMLResponse` to the ACS can potentially issue a
session. SP-initiated flows provide a clear chain of custody: the SP created
the request, the IdP responded to it, the ACS verified the relationship.

**Tradeoff:** Some enterprise IdPs (notably certain Okta configurations) prefer
IdP-initiated flows as a default. Organizations requiring IdP-initiated SSO
are advised to configure SP-initiated flows at the IdP level. If IdP-initiated
support is required in future, it must be gated behind an explicit per-connection
flag and must implement compensating controls (binding nonce, per-flow state).

### D3: Metadata ingest model (pull-on-demand, not push)

**Decision:** Admins paste raw IdP metadata XML into the admin UI. The server
parses and extracts `ssoUrl`, `certFingerprint`, `nameIdFormat`, and `entityId`.
The raw XML is not stored server-side.

**Rationale:** Storing raw IdP metadata XML creates a secondary XML parsing
surface that must be kept XXE-safe at rest. Extracting only the necessary
scalar fields at ingest time reduces the persistent attack surface. The admin
UI displays the extracted values for verification before they take effect.

**Tradeoff:** If the IdP rotates its signing certificate, the admin must
re-ingest metadata manually. The failure-counting mechanism (Security Controls
§8) is designed to surface certificate rotation outages before they cause
widespread lockout.

### D4: HTTP-Redirect binding for AuthnRequest, HTTP-POST for ACS

**Decision:** AuthnRequests use HTTP-Redirect binding. ACS uses HTTP-POST binding.

**Rationale:** This is the SAML 2.0 standard recommendation. HTTP-Redirect
binding for AuthnRequests keeps the request in the URL (visible in browser
history) but is appropriate because AuthnRequests contain no sensitive data.
HTTP-POST binding for the ACS prevents the SAML Response (which contains
sensitive assertion data) from appearing in server access logs or browser
history via the URL. Some IdPs enforce this split as a compatibility requirement.

### D5: SP private key per-deployment, not per-connection

**Decision:** The SP signing key (used for signing AuthnRequests under HTTP-Redirect
binding) is a single RSA-2048 key stored as an environment secret, shared across
all `connectionId` values.

**Rationale:** Per-connection key management adds significant operational
complexity (key rotation per tenant, secure storage of N keys). Since the SP
key is used only to sign AuthnRequests (not to decrypt assertions), its compromise
does not enable session forgery — the IdP validates AuthnRequest signatures
but SAML 2.0 does not require signed AuthnRequests for the ACS to accept
responses. The primary cryptographic trust anchor is the IdP certificate pinned
per-connection, not the SP key.

**Tradeoff:** Key rotation requires a coordinated deployment. This is acceptable
given the limited impact of SP key compromise.

---

## Known Limitations

### L1: No support for encrypted assertions

SAML 2.0 supports `<saml:EncryptedAssertion>` where the IdP encrypts the
assertion body with the SP's public encryption key. This implementation does
not support encrypted assertions. The ACS will reject responses containing
only an `EncryptedAssertion` without a plaintext `Assertion` sibling.

**Impact:** IdPs configured to require assertion encryption cannot be used.
Most enterprise IdPs (Okta, Azure AD, Google Workspace) default to signed-but-
unencrypted assertions when TLS is in use. Encryption is optional in the SAML
2.0 spec.

**Workaround:** Operators should configure their IdP to send signed-but-unencrypted
assertions. TLS at the transport layer provides equivalent confidentiality
protection for assertion data in transit.

### L2: IdP-initiated SSO not supported

See Implementation Decisions §D2. Organizations that require IdP-initiated
flows cannot use this SP implementation without code changes.

### L3: Single-logout (SLO) not implemented

SAML 2.0 Single Logout (SLO) allows an IdP or SP to propagate logout signals
across all active sessions in a federation. This SP does not implement SLO.
Logout is handled locally: the user's SP session is terminated, but no
`LogoutRequest` is sent to the IdP and the SP does not process incoming
`LogoutRequest` messages from the IdP.

**Impact:** After SP-side logout, the user's IdP session remains active. If
the IdP session has not expired, the user can immediately re-authenticate via
SP-initiated SSO without entering credentials. This may not meet the security
expectations of organizations with strict session-termination policies.

### L4: No attribute-based authorization

The SP extracts `NameID` and a configurable set of SAML attributes (email,
displayName) from assertions, but does not implement attribute-based role
mapping. Role assignment is handled by the application's workspace permission
model after the user's account is located or provisioned. IdP groups or roles
expressed as SAML attributes are not consumed.

### L5: Certificate expiry not proactively monitored

The SP stores certificate fingerprints but not the full certificate DER/PEM.
As a result, it cannot inspect the `NotAfter` field of the IdP certificate
and cannot warn admins of impending certificate expiry. Expired certificates
will cause all ACS validations to fail (since the certificate is no longer
valid for signature verification purposes under the pinning model). The
failure-counting mechanism (Security Controls §8) will surface the outage,
but not proactively before it occurs.

---

## Future Work

### FW1: Encrypted assertion support

Add support for `<saml:EncryptedAssertion>` using the SP's RSA key pair.
This will require storing an SP encryption certificate in the SP metadata
endpoint and implementing `xml-enc` decryption before signature validation.
Priority: medium. Required for IdPs that enforce assertion encryption.

### FW2: IdP-initiated SSO with compensating controls

If customer demand warrants it, implement IdP-initiated SSO gated behind a
per-connection opt-in flag. Compensating controls must include:

- A binding nonce stored in the SP session (anti-CSRF for the ACS POST)
- Strict `NotOnOrAfter` window (maximum 2 minutes from `IssueInstant`)
- Per-connection rate limiting on ACS POST submissions
- Security event emission for all accepted unsolicited responses

### FW3: Single Logout (SLO) implementation

Implement SP-initiated SLO and IdP-initiated SLO processing. This requires:

- Storing `SessionIndex` from the assertion for use in `LogoutRequest`
- Implementing `/v1/auth/saml/:connectionId/slo` as both an SP-initiated
  sender and an IdP-initiated receiver
- Handling both HTTP-Redirect and HTTP-POST bindings for SLO messages
- Propagating SLO to all active SP sessions for the affected `NameID`

### FW4: Certificate expiry monitoring

Store the full IdP certificate PEM alongside the fingerprint during metadata
ingest. Add a scheduled worker job (`saml-cert-expiry-check`) that:

- Scans all `SsoProvider` records with a stored certificate
- Emits a `SAML_CERT_EXPIRING_SOON` security event and admin notification
  when `NotAfter` is within 30 days
- Emits `SAML_CERT_EXPIRED` when `NotAfter` has passed

### FW5: SCIM provisioning integration

Phase R8.3 (planned) will add SCIM 2.0 User and Group provisioning for IdPs
that support it (Okta, Azure AD, OneLogin). SCIM provisioning will handle
just-in-time user creation at the IdP level, reducing reliance on SAML
just-in-time provisioning at the ACS. The SAML SP and SCIM provisioner will
share the `SsoProvider` connection record but operate independently.

### FW6: AuthnRequest signing policy per-connection

Implement a per-connection `requireSignedAuthnRequest` flag. When disabled
(the current default), AuthnRequests are unsigned. When enabled, the SP signs
the request and includes `SigAlg`/`Signature` parameters in the HTTP-Redirect
binding URL. Some IdPs (notably ADFS in strict mode) require signed
AuthnRequests as a policy prerequisite.

### FW7: Dedicated SP key pair per connection

Evaluate per-connection SP key pairs for high-isolation tenant requirements.
This would allow independent key rotation per tenant and eliminate the shared
SP key as a cross-tenant attack vector (limited as it is today — see D5).
Requires a key management service integration (e.g., HSM-backed KMS) and
is gated on enterprise tier availability.

---

## Appendix A: Security Event Vocabulary

The following security events are emitted by the SAML SP as part of R8.2:

| Event Code | Trigger |
|------------|---------|
| `SAML_AUTH_SUCCESS` | ACS accepted assertion, session issued |
| `SAML_AUTH_FAILURE` | ACS rejected assertion (any reason) |
| `SAML_SIGNATURE_INVALID` | `xml-crypto` signature check failed |
| `SAML_REPLAY_DETECTED` | `InResponseTo` already consumed or not found |
| `SAML_AUDIENCE_MISMATCH` | Assertion `Audience` does not match SP EntityID |
| `SAML_TIMESTAMP_VIOLATION` | `NotBefore`/`NotOnOrAfter` check failed |
| `SAML_MALFORMED_XML` | DOCTYPE detected or XML parse failed |
| `SAML_OUTAGE_DETECTED` | Consecutive failure count exceeded threshold |
| `SAML_OUTAGE_RESOLVED` | Successful assertion after outage state |
| `SAML_METADATA_INGESTED` | Admin completed IdP metadata ingest |

---

## Appendix B: Dependency Versions

| Package | Version | Role |
|---------|---------|------|
| `samlify` | pinned | High-level SAML SP flow |
| `xml-crypto` | pinned | XML-DSIG signature validation |
| `fast-xml-parser` | pinned | Safe XML parsing (DOCTYPE-aware) |

All SAML-related dependencies are pinned to exact versions in `package.json`.
Updates require a security review and a re-run of the SAML contract test suite
before merge.

---

_End of R8.2 SAML Architecture Audit_
