# R8.2.2 — SAML Real IdP Pilot Validation Checklist

## Status

**Implementation-ready checklist. Live IdP validation still required before claiming production readiness with a specific IdP.**

This document is the operational checklist for the R8.2.2 pilot phase, during which the SAML 2.0 integration is connected to a real Identity Provider (IdP) with real credentials for the first time. Nothing in this checklist may be marked complete based on mock-IdP test output, unit tests, or integration tests that simulate SAML responses. Each item requires a human operator to confirm against a live IdP tenant.

Last updated: 2026-05-25
Phase: R8.2.2 — SAML Real IdP Pilot

---

## Section 1: Prerequisite — What "Code-Supported" Means

Before executing any item in this checklist, it is important to understand the boundary between two different states of readiness:

**Code-Supported (current state prior to this checklist)**

The Digital Witness SAML implementation has been written, reviewed, and covered by automated tests. This means:

- The SP metadata endpoint (`/auth/saml/metadata`) generates a valid XML document conforming to the SAML 2.0 metadata schema.
- The ACS endpoint (`/auth/saml/acs`) accepts HTTP-POST binding requests, validates signatures using the configured IdP certificate, checks audience restriction, validates timestamps and InResponseTo correlation, extracts the email attribute via the `EMAIL_ATTR_NAMES` alias list, and performs JIT provisioning subject to the active JIT policy.
- Cert rotation logic is implemented: dual-cert windows are supported, `samlCertNotAfter` is parsed on metadata ingest, and expiry events are scheduled at 90, 60, and 30 days prior to expiration.
- SAML failure events are categorised using `SAML_FAILURE_CATEGORY_LABELS` and written to the Security Center event log.
- All of the above has been verified against synthesised SAML responses in test fixtures. A real IdP was **not** used for this verification.

**Externally Tested (what this checklist validates)**

A claim of production readiness with a specific IdP requires that:

1. A real tenant or directory was configured in that IdP.
2. A real user account in that IdP performed a login flow end-to-end.
3. The assertion reached the ACS endpoint and was accepted without modification.
4. The resulting session is valid, the Security Center event fired, and the user record is correct.
5. Any IdP-specific attribute format quirks, cert chain behaviour, or clock-skew behaviour were observed under real conditions.

This checklist covers the steps required to achieve that externally tested state for each supported IdP.

**Do not update this checklist's items to "complete" using automated test output.** Each checkbox requires a human sign-off from the operator who performed the live test.

---

## Section 2: Okta Checklist

Operator must have access to an Okta tenant with admin rights. A free Okta Developer tenant is sufficient for validation. A real user account must be assigned to the application.

- [ ] **2.1 Create a SAML 2.0 App Integration in the Okta Admin Console.** Navigate to Applications > Applications > Create App Integration. Select SAML 2.0 as the sign-in method. Do not select OIDC.
- [ ] **2.2 Set the ACS URL (Single sign-on URL) in the Okta app configuration.** The value must be the HTTP-POST binding ACS endpoint for this environment, e.g. `https://<tenant>.digitalwitness.io/auth/saml/acs`. Confirm that "Use this for Recipient URL and Destination URL" is checked.
- [ ] **2.3 Set the SP Entity ID (Audience URI) in the Okta app configuration.** The value must match the `entityID` attribute in the SP metadata document exactly. Retrieve it from `/auth/saml/metadata` and paste verbatim — do not paraphrase or abbreviate.
- [ ] **2.4 Download the Okta metadata XML for this app.** In the Sign On tab, click "Identity Provider metadata" link and save the XML file. Verify it contains an `X509Certificate` element and an `IDPSSODescriptor` with HTTP-POST binding.
- [ ] **2.5 Ingest the Okta metadata XML via the Digital Witness admin UI ingest-metadata flow.** Navigate to Settings > Security > SAML. Use the "Import IdP Metadata" control to upload the XML file obtained in step 2.4. Confirm the UI displays the parsed IdP Entity ID and cert expiry date without error.
- [ ] **2.6 Verify the ingested cert expiry date is correct.** The `samlCertNotAfter` value shown in the admin UI must match the `NotAfter` attribute on the X.509 certificate inside the Okta metadata XML. Cross-check manually.
- [ ] **2.7 Set the NameID format to `emailAddress` in the Okta app's SAML Settings.** Under SAML Settings > General, set "Name ID format" to `EmailAddress`. This ensures the NameID in assertions uses the `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress` format.
- [ ] **2.8 Map Okta profile attributes to assertion attributes.** In the SAML Settings > Attribute Statements section, add the following mappings: `email` → `user.email`, `firstName` → `user.firstName`, `lastName` → `user.lastName`. The attribute names must match entries in the `EMAIL_ATTR_NAMES` alias list or be configured explicitly.
- [ ] **2.9 Assign a real Okta user to the application and perform a SP-initiated login.** From the Digital Witness login page, initiate the SAML login. Confirm the browser is redirected to the Okta login page, that authentication succeeds with the real user's credentials, and that the browser is redirected back to the ACS endpoint and then to the authenticated home page.
- [ ] **2.10 Verify the `saml_login_succeeded` event fires in Security Center.** After the successful login in step 2.9, navigate to Security Center > Events and confirm an event of type `saml_login_succeeded` appears, with the correct user email and IdP Entity ID recorded.
- [ ] **2.11 Test cert rotation using the dual-cert window.** Upload a second Okta certificate (or simulate key rollover in a developer tenant) and verify that the ACS endpoint accepts assertions signed by either certificate during the overlap window. Promote the new cert and confirm the old cert is removed without a login failure.
- [ ] **2.12 Confirm SCIM-managed user behaviour if Okta SCIM is active.** If the Okta tenant has SCIM provisioning configured for this app, confirm that a user provisioned via SCIM can log in via SAML and that JIT does not create a duplicate record.
- [ ] **2.13 Document the Okta-specific IdP Entity ID format observed.** Okta IdP Entity IDs follow the pattern `http://www.okta.com/<app-id>`. Record the actual value used in this tenant in the pilot notes. Confirm it was accepted by the ACS validation logic without alteration.

---

## Section 3: Microsoft Entra ID (Azure AD) Checklist

Operator must have access to a Microsoft Entra ID tenant with at least Application Administrator rights. A free Microsoft 365 Developer Program tenant is sufficient for validation.

- [ ] **3.1 Create an Enterprise Application in the Entra ID portal.** Navigate to Microsoft Entra ID > Enterprise Applications > New application > Create your own application. Select "Integrate any other application you don't find in the gallery". Do not use a gallery app template, as template defaults may conflict with SP configuration.
- [ ] **3.2 Configure SAML-based sign-on.** In the new application, navigate to Single sign-on > SAML. Confirm the "SAML-based Sign-on" mode is selected.
- [ ] **3.3 Set the ACS URL and Entity ID in Basic SAML Configuration.** In the "Basic SAML Configuration" panel, set "Reply URL (Assertion Consumer Service URL)" to the HTTP-POST ACS endpoint and set "Identifier (Entity ID)" to the SP Entity ID from the SP metadata. Save the configuration.
- [ ] **3.4 Download the Federation Metadata XML from Entra ID.** In the "SAML Certificates" section, click "Download" next to "Federation Metadata XML". Save the file.
- [ ] **3.5 Ingest the Entra ID Federation Metadata XML via the admin UI ingest-metadata flow.** Follow the same process as step 2.5. Confirm that the parsed IdP Entity ID and cert expiry are displayed. Entra ID Federation Metadata XML may contain multiple certificates; confirm the UI correctly identifies the active signing certificate.
- [ ] **3.6 Verify attribute claim mapping for the email address.** Entra ID emits the email attribute under the claim URI `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`. Confirm this URI is present in the `EMAIL_ATTR_NAMES` alias list or add an explicit alias. Without this, email extraction will fail silently.
- [ ] **3.7 Verify UPN claim alias awareness.** Entra ID may also send the email as the UPN claim (`http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name`) if `user.userprincipalname` is configured. Confirm which claim contains the routable email address in this tenant and verify the alias list covers it.
- [ ] **3.8 Assign a user or group to the application in Entra ID.** Under the Enterprise Application > Users and groups, add the test user or a test group. Confirm the assignment is saved before attempting login.
- [ ] **3.9 Perform a SP-initiated login with the assigned user.** Initiate SAML login from the Digital Witness login page. Confirm the flow redirects to the Microsoft login page, authentication succeeds, and the user is redirected to the authenticated home page.
- [ ] **3.10 Verify the `saml_login_succeeded` event fires in Security Center** after the Entra ID login, as in step 2.10.
- [ ] **3.11 Confirm cert rotation awareness for Entra ID's 3-year default cert lifetime.** Entra ID signing certificates have a default expiry of 3 years unless a custom certificate is configured. Confirm the expiry date is recorded correctly and that the 90-day warning event would fire at the appropriate time. If the tenant uses a custom cert with a shorter lifetime, confirm that shorter expiry is reflected.
- [ ] **3.12 Verify login works for a user assigned via a group (not directly).** Assign the test user to the application via group assignment only. Confirm the login flow still succeeds and the user record is created correctly.

---

## Section 4: Google Workspace Checklist

Operator must have access to a Google Workspace domain with Super Admin rights. A Google Workspace for Education or Business trial domain is sufficient.

- [ ] **4.1 Create a Custom SAML App in Google Admin Console.** Navigate to Google Admin > Apps > Web and mobile apps > Add App > Add custom SAML app. Provide a name and proceed.
- [ ] **4.2 Download the Google Workspace IdP metadata or record the SSO URL and certificate.** On the "Google Identity Provider details" screen, either download the metadata XML or copy the SSO URL, Entity ID, and certificate. The metadata XML is preferred for the ingest-metadata flow.
- [ ] **4.3 Enter SP configuration in Google Admin.** On the "Service Provider Details" screen, set the ACS URL to the HTTP-POST ACS endpoint and the Entity ID to the SP Entity ID from the SP metadata. Confirm the "Signed response" checkbox state matches what the SP expects (signed assertion is required; signed response is optional but acceptable).
- [ ] **4.4 Set NameID format.** In the SP Details screen, set NameID format to `EMAIL`. This maps to `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`. Confirm NameID value is set to the user's primary email.
- [ ] **4.5 Ingest the Google Workspace metadata XML via the admin UI ingest-metadata flow.** If the metadata XML was downloaded in step 4.2, upload it. If only SSO URL and certificate were obtained, use the manual entry path. Confirm the cert expiry is recorded correctly.
- [ ] **4.6 Verify the Google Workspace certificate fingerprint.** Google Workspace certificates are shared across the domain. Confirm the SHA-256 fingerprint of the ingested certificate matches the fingerprint shown in Google Admin Console to rule out a clipboard error during manual entry.
- [ ] **4.7 Configure attribute mapping for email in Google Admin.** In the "Attribute Mapping" step, add a mapping from the Google directory attribute "Primary email" to the SAML attribute name `email` (or `urn:oid:0.9.2342.19200300.100.1.3` if the IdP uses OID-based attribute names). Confirm the chosen attribute name is in the `EMAIL_ATTR_NAMES` alias list.
- [ ] **4.8 Assign the custom SAML app to the test user's organisational unit.** Navigate to the app's User access settings and confirm it is turned ON for the organisational unit containing the test user. Google Workspace will not issue assertions for users whose OU does not have the app enabled.
- [ ] **4.9 Perform a SP-initiated login with the assigned user and confirm success.** Initiate SAML login from the Digital Witness login page. Authenticate with the test user's Google account. Confirm the flow completes and the authenticated home page is reached.
- [ ] **4.10 Verify the `saml_login_succeeded` event fires in Security Center** after the Google Workspace login.
- [ ] **4.11 Confirm certificate rotation procedure for Google Workspace.** Google Workspace does not automatically rotate SAML signing certificates; the admin must generate a new certificate manually. Confirm the dual-cert window procedure can be executed by downloading the new certificate from Google Admin and uploading it as a pending cert before promoting it.

---

## Section 5: Generic SAML 2.0 IdP Checklist

For any SAML 2.0-compliant IdP not covered by the sections above (e.g., PingFederate, ADFS, Shibboleth, OneLogin, JumpCloud, Duo SSO). The operator must adapt these items to the specific IdP's admin interface.

- [ ] **5.1 Register the SP metadata URL with the IdP.** Provide the IdP with the SP metadata URL (`/auth/saml/metadata`) or upload the SP metadata XML. Confirm the IdP parsed the metadata without errors and recognised the ACS URL and Entity ID.
- [ ] **5.2 Confirm HTTP-POST binding is selected for the ACS endpoint.** The IdP must send the SAML response using the HTTP-POST binding. HTTP-Redirect binding is not supported for the ACS endpoint. Confirm this in the IdP's binding configuration.
- [ ] **5.3 Confirm WantAssertionsSigned is honoured by the IdP.** The SP metadata declares `WantAssertionsSigned="true"`. Verify that the IdP signs the SAML assertion (not only the outer response element). An unsigned assertion will be rejected at the ACS endpoint.
- [ ] **5.4 Confirm NameID format is set to emailAddress.** Verify the IdP is configured to issue a NameID of format `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress` containing the user's routable email address.
- [ ] **5.5 Confirm the assertion contains an attribute with the user's email address.** Identify which attribute name the IdP uses for the email address and confirm that name is present in the `EMAIL_ATTR_NAMES` alias list. If not, add an alias or configure the IdP to use a name already in the list.
- [ ] **5.6 Confirm InResponseTo correlation is enabled on the IdP.** The SP includes an `ID` attribute in the AuthnRequest. The IdP must include a matching `InResponseTo` attribute in the SAML response. Confirm the IdP does not strip this value, as the ACS endpoint validates it to prevent replay attacks.
- [ ] **5.7 Confirm Audience Restriction in the assertion includes the SP Entity ID.** The SAML assertion must contain an `AudienceRestriction` element whose `Audience` value exactly matches the SP Entity ID. A mismatch will produce an `invalid_audience` failure.
- [ ] **5.8 Track the IdP certificate expiry after metadata ingest.** After ingesting the IdP metadata, confirm the `samlCertNotAfter` value is recorded correctly. Establish a process to update the certificate before it expires, and confirm the 90/60/30-day warning events will reach the correct notification channel.

---

## Section 6: Common Failure Diagnostics

The following table maps SAML failure category codes (from `SAML_FAILURE_CATEGORY_LABELS`) to their most likely IdP configuration causes. When a login fails, check the Security Center event for the `failureCategory` field and use this table to direct investigation.

| Failure Category Code | Security Center Label | Likely IdP Configuration Cause |
|---|---|---|
| `invalid_signature` | Invalid Signature | The certificate configured in the SP (ingested from IdP metadata) does not match the private key the IdP used to sign this assertion. Common causes: (1) the IdP rotated its signing cert and the SP metadata was not re-ingested; (2) the wrong cert was copied during manual setup; (3) the IdP has multiple certs and the wrong one is active. Resolution: re-download and re-ingest the IdP metadata, or verify the active signing cert in the IdP admin console. |
| `expired_assertion` | Expired Assertion | The SAML assertion's `NotOnOrAfter` timestamp has passed by the time it reaches the ACS endpoint. Most commonly caused by clock skew greater than 60 seconds between the IdP server and the SP server. Resolution: sync NTP on both sides. Some IdPs allow extending the assertion validity window; a 5-minute window is typical. |
| `invalid_audience` | Invalid Audience | The `Audience` value in the assertion's `AudienceRestriction` element does not exactly match the SP Entity ID. Common causes: (1) the SP Entity ID was entered incorrectly in the IdP (trailing slash, protocol mismatch, or typo); (2) the SP Entity ID was changed after initial setup without updating the IdP. Resolution: copy the Entity ID verbatim from `/auth/saml/metadata` and re-enter it in the IdP. |
| `missing_email_attribute` | Missing Email Attribute | The ACS endpoint could not find an email address in the assertion. The assertion did not contain any attribute whose name matches an entry in the `EMAIL_ATTR_NAMES` alias list, and the NameID was either absent or in a non-email format. Common causes: (1) the IdP attribute mapping was not configured; (2) the attribute name used by the IdP is not in the alias list. Resolution: check the raw assertion (visible in browser developer tools under the SAML response POST), identify the attribute name containing the email, and add it to the alias list or update the IdP mapping. |
| `jit_policy_denied` | JIT Provisioning Denied | The user was not pre-provisioned in Digital Witness and the active JIT policy disallows automatic provisioning. This can occur when SCIM provisioning is active and JIT is intentionally disabled to ensure only SCIM-managed users may authenticate. Resolution: provision the user via SCIM first, or change the JIT policy setting if automatic provisioning is acceptable for this deployment. |
| `invalid_in_response_to` | Invalid InResponseTo | The `InResponseTo` attribute in the SAML response does not match any pending AuthnRequest ID. This can occur if the user's session expired before they completed the IdP login, if the IdP strips the `InResponseTo` value, or if a SAML response is replayed. Resolution: confirm the IdP preserves the `InResponseTo` value. If the IdP strips it, check whether the IdP has a setting to include it. |
| `assertion_not_yet_valid` | Assertion Not Yet Valid | The assertion's `NotBefore` timestamp is in the future relative to the SP's clock. This is a clock skew issue similar to `expired_assertion` but in the opposite direction. Resolution: sync NTP on the SP server. |

---

## Section 7: Cert Expiry Monitoring

When IdP metadata is ingested (whether from an XML file upload or from a metadata URL refresh), the SP parses the `X509Certificate` element from the `IDPSSODescriptor` and extracts the certificate's `NotAfter` date. This value is stored as `samlCertNotAfter` on the SAML configuration record.

The following monitoring events are scheduled automatically at ingest time:

| Days Before Expiry | Event Type | Destination |
|---|---|---|
| 90 days | `saml_cert_expiry_warning_90d` | Security Center + notification channel |
| 60 days | `saml_cert_expiry_warning_60d` | Security Center + notification channel |
| 30 days | `saml_cert_expiry_warning_30d` | Security Center + notification channel (urgent) |

Prometheus metric counters are available under the `saml_cert_days_until_expiry` gauge, labelled by IdP Entity ID. This gauge is updated on each metadata ingest and can be scraped by an alerting system for out-of-band monitoring.

**Operator responsibilities during the pilot:**

- After ingesting metadata in any section above, manually confirm the `samlCertNotAfter` value shown in the admin UI is correct.
- Confirm the notification channel for expiry warnings is configured and reachable.
- If the IdP supports metadata URL-based auto-refresh (Okta and Entra ID both publish stable metadata URLs), consider enabling auto-refresh to keep the cert record current without manual intervention.

**Important:** cert expiry monitoring only fires if the scheduling job is running. Confirm the worker service is healthy after initial setup and that scheduled jobs are being processed.

---

## Section 8: Not Yet Validated

The following items are explicitly **not** validated by any automated test in the current codebase. Each requires a real IdP environment with real credentials before it can be marked complete. This list is provided to prevent false confidence in claims of production readiness.

1. **SP-initiated login full roundtrip with any IdP.** No automated test exercises the complete browser flow from the Digital Witness login page through an IdP authentication page and back to the ACS endpoint. All current tests inject a synthesised SAML response directly into the ACS endpoint. The redirect handshake, AuthnRequest generation, and browser-level POST must be verified manually.

2. **Cert rotation under live traffic.** The dual-cert window logic has been tested with synthesised assertions signed by a second certificate. It has not been tested while users are actively logging in, which is when rotation errors are most damaging. This must be validated in a staging environment with a real IdP before being done in production.

3. **SCIM + SAML interplay under concurrent provisioning.** The scenario where a SCIM provisioning event and a SAML login attempt occur simultaneously for the same user has not been tested against a real SCIM+SAML-enabled IdP (e.g., Okta with both SAML and SCIM enabled on the same app integration). Race condition behaviour in JIT suppression must be observed under real conditions.

4. **Entra ID group-based claim emission.** When Entra ID is configured to emit group membership claims in the SAML assertion, the assertion size may increase significantly. The ACS endpoint's handling of large assertions has not been tested against real Entra ID group claim output.

5. **Google Workspace OU-scoped access restriction.** The behaviour when a user outside the enabled OU attempts login (i.e., Google Workspace silently denies the AuthnRequest) has not been observed against a real Google Workspace tenant. The error surfaced to the user at the IdP side is not under SP control but should be documented for support purposes.

6. **Clock skew tolerance boundary with a real IdP.** The SP enforces a clock skew tolerance when validating `NotBefore` and `NotOnOrAfter`. The exact tolerance value has been tested in unit tests but has not been verified against an IdP whose clock is measurably skewed relative to the SP. This should be confirmed in a controlled environment before deployment to a distributed region where NTP reliability is lower.

7. **SP metadata URL-based auto-refresh cycle.** If the IdP is configured to have its metadata fetched and refreshed on a schedule (rather than uploaded manually), the auto-refresh job has not been exercised end-to-end against a real IdP metadata URL. This includes verifying that a cert rotation published by the IdP is correctly picked up on the next refresh cycle.

8. **IdP-initiated login (if supported).** The current implementation is designed around SP-initiated login. IdP-initiated login (where the user clicks a tile in the IdP portal rather than starting from the SP) involves a SAML response without an `InResponseTo` value. The handling of this flow has not been validated with a real IdP.

---

*This checklist is a living document. Update it as each item is validated during the R8.2.2 pilot. Do not mark items complete without operator sign-off and a note of the date, IdP tenant, and operator name.*
