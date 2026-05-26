# Runbook 15 — SAML / SSO failure

**Scope:** customer's organization reports SSO login failures, certificate-expiry warnings, or first-pilot rehearsal blockers.

**Prerequisites:**

- Operator access to the customer's IdP admin console (or coordination with the customer's IdP administrator).
- Read access to `SamlConfig`, `SamlCertificate`, and the security event stream.
- Knowledge of which SAML pilot phase the customer is in (Phase R8.2.2 contract).

**Forbidden:**

- Enabling `SAML_TEST_MODE=true` in production. The startup validator rejects this.
- Disabling SAML assertion signature verification.
- Bypassing per-organization SAML configuration to "test" a login.
- Pasting raw `samlResponse` XML into the support ticket — the assertion may carry user attributes considered PII.

---

## Login failure (post-IdP redirect)

1. **Capture the error code.** The platform's SAML ACS surface returns one of:
   - `saml_signature_invalid` — IdP signing certificate doesn't match the recorded `SamlCertificate.publicKeyPem`.
   - `saml_assertion_replay` — `InResponseTo` / assertion id has been seen before.
   - `saml_clock_skew` — server clock vs assertion `NotBefore` / `NotOnOrAfter` mismatch.
   - `saml_audience_mismatch` — assertion audience does not match the configured `entityId`.
   - `saml_attribute_missing` — required NameID / email attribute absent from the assertion.
   - `saml_user_mapping_failed` — SCIM-provisioned user not found and `SAML_AUTO_PROVISION_ENABLED=false`.

2. **Map error to root cause:**
   - `saml_signature_invalid` → IdP rotated its signing cert. Coordinate with the customer's IdP admin to upload the new cert; update `SamlCertificate` via the admin panel.
   - `saml_assertion_replay` → the same assertion was submitted twice. If the customer reproduces by clicking back / refresh, that's expected (the assertion is single-use). If the customer is on first attempt, investigate for clock-skew or a misconfigured proxy that retries.
   - `saml_clock_skew` → operator action: confirm server NTP sync. The platform tolerates a small skew (operator-configurable); persistent skew is an Ops issue.
   - `saml_audience_mismatch` → re-confirm the customer's IdP application is configured with the correct PROOVRA `entityId` + ACS URL.
   - `saml_attribute_missing` → the IdP needs to add the missing attribute mapping. Provide the customer with the canonical attribute schema reference.
   - `saml_user_mapping_failed` → ensure SCIM is provisioning users to PROOVRA before the customer attempts login.

3. **Confirm the audit event.** Every SAML failure emits a security event (visible in the admin audit log). The event metadata captures the redacted assertion id + the error code.

## Certificate expiry warning

1. **Identify the certificate.** Admin panel shows all per-organization SAML certificates with their `validNotAfter` timestamp.
2. **Coordinate rotation with the customer's IdP admin.** They upload a new cert; PROOVRA admin replaces the old one.
3. **Both old + new certificate active during transition.** PROOVRA supports a temporary dual-cert period (when both are valid) so transitions don't disrupt login.

## First-pilot rehearsal (DEF-002 closure path)

The Phase R8.2.2 pilot checklist (`docs/security/R8_2_2_SAML_REAL_IDP_PILOT_CHECKLIST.md`) is the canonical end-to-end procedure. The pilot rehearsal is the gating event for closing DEF-002 (BLOCKS_ENTERPRISE_PILOT). Until DEF-002 closes, an enterprise pilot may NOT begin.

## DEF-aware caveats

- **DEF-001 (POST_LAUNCH):** SP request signing is schema-supported but the signing code does not yet apply the SP private key to `AuthnRequest`. Most production IdPs accept unsigned AuthnRequests for the pilot phase; a future R8.3 phase closes this.
- **DEF-002 (BLOCKS_ENTERPRISE_PILOT):** live IdP roundtrip has not been completed. Pilot is gated on Ops + customer joint rehearsal.
- **DEF-013 (POST_LAUNCH):** IdP-initiated login is intentionally not implemented. All SAML flows must be SP-initiated. If a customer requests IdP-initiated specifically, escalate as a feature request (out of scope for this runbook).
- **DEF-037 (BLOCKS_LAUNCH):** SAML ACS endpoint has no per-IP rate limit. A future fix adds throttling; until then, document the gap in any pilot conversation.

---

## Honest gaps

- The platform does not auto-rotate SP certificates. All certificate lifecycle is operator-driven on both IdP + SP sides.
- SAML configuration UI exposes test-mode toggles in non-production environments only; production refuses `SAML_TEST_MODE=true` at startup.
