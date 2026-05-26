# Runbook 19 — First-pilot SAML IdP rehearsal (DEF-002 closure path)

**Scope:** the operational procedure Ops + the first enterprise pilot customer follow to close `DEF-002` (live IdP roundtrip rehearsal) before pilot onboarding. The platform's SAML SP code is production-shape (Phase R8.2 / R8.2.1 / R8.2.2); this runbook covers the END-TO-END LIVE VERIFICATION that the integration works with a specific real IdP.

**Prerequisites:**

- Operator access to the customer's SAML IdP admin console (or co-driver with the customer's IdP admin).
- A non-production PROOVRA tenant available for the rehearsal — do NOT rehearse against the customer's production tenant.
- A test user account on the IdP that maps to a test user in the PROOVRA tenant (via SCIM provisioning if enabled, or manual creation if not).
- The R8.2.2 SAML pilot checklist as the canonical reference: `docs/security/R8_2_2_SAML_REAL_IDP_PILOT_CHECKLIST.md`.

**Forbidden:**

- Rehearsing against production data of any kind (customer or PROOVRA).
- Pasting raw `samlResponse` XML into the rehearsal log — the assertion may carry PII.
- Enabling `SAML_TEST_MODE=true` in production. The startup validator rejects this.
- Bypassing SAML assertion signature verification "to make the test pass". The signature failure IS the test.
- Marking DEF-002 RESOLVED before all sections below complete.

---

## What this runbook is NOT

It is NOT a SAML configuration tutorial — that lives in the R8.2.2 checklist + customer-facing docs.

It is NOT a substitute for the customer's IdP onboarding work. It is the joint rehearsal Ops + customer run together once the customer-side config is in place.

It is NOT a substitute for the unit + contract tests in `phase-r8-2-saml-*.test.ts`. Those pin source-level invariants; this runbook proves the integration end-to-end with a real IdP.

---

## Steps

### Section A — Pre-rehearsal setup

1. **Identify the IdP.** Common: Okta, Entra ID (Azure AD), Google Workspace, generic SAML 2.0. Record the IdP vendor + version + the customer admin contact.

2. **Provision a non-production PROOVRA tenant** for the rehearsal. Note its `entityId` and `acsUrl`. Confirm `SAML_TEST_MODE=false` is the rehearsal environment's setting (production-shape config).

3. **Provision a test IdP application** on the customer's IdP. Configure:
   - Application name: `PROOVRA-PILOT-REHEARSAL` (or equivalent — make it clearly a rehearsal app, not the production app).
   - ACS URL: PROOVRA rehearsal tenant's ACS URL.
   - Entity ID: PROOVRA rehearsal tenant's entity ID.
   - SP signing requirement: as the customer's IdP requires; PROOVRA's SP request signing is currently schema-supported only (DEF-001 POST_LAUNCH — most production IdPs accept unsigned AuthnRequests in the pilot phase).
   - Attribute mapping: NameID = email (or per the customer's IdP convention) + any additional attribute mappings the rehearsal needs.

4. **Provision a rehearsal test user** on the customer's IdP. Assign the user to the PROOVRA-PILOT-REHEARSAL app. If SCIM is enabled, confirm the SCIM-provisioned PROOVRA user appears.

5. **Upload the IdP signing certificate to the PROOVRA admin panel** for the rehearsal tenant. Confirm the cert appears in `SamlCertificate` with the correct `validNotAfter`.

### Section B — Live roundtrip

6. **SP-initiated login.** Open the PROOVRA rehearsal tenant's login page. Click the SAML SSO option. Confirm the browser is redirected to the customer's IdP.

7. **IdP authentication.** Authenticate as the rehearsal test user. Confirm the IdP redirects back to PROOVRA's ACS URL.

8. **ACS handling.** Confirm PROOVRA accepts the assertion and creates / matches the test user. Expected outcome: 302 to the PROOVRA dashboard with a session cookie set.

9. **Session validation.** Open `GET /v1/users/me` (or the dashboard's session indicator). Confirm the test user identity is set correctly.

10. **Audit verification.** Open the admin audit log for the rehearsal tenant. Confirm a `saml.login.succeeded` (or equivalent) event landed with the correct user id + IdP id + the redacted assertion id.

### Section C — Failure scenarios

Each of the following MUST be rehearsed at least once to confirm the failure path is bounded:

11. **Signature failure.** Temporarily upload a wrong signing certificate to PROOVRA. Retry login. Expected: PROOVRA returns `saml_signature_invalid`; security event lands; no session created. Restore the correct cert before continuing.

12. **Audience mismatch.** Temporarily change the IdP application's entity-id value to a wrong value. Retry login. Expected: PROOVRA returns `saml_audience_mismatch`; security event lands; no session created. Restore the correct entity-id before continuing.

13. **Clock skew.** (Optional — only if the customer's IdP allows configurable assertion validity windows.) Temporarily set the assertion `NotOnOrAfter` to the past. Retry login. Expected: PROOVRA returns `saml_clock_skew`. Restore.

14. **Assertion replay.** Capture a successful assertion's redirect URL. Open it twice in quick succession. Expected: first redirect succeeds; second returns `saml_assertion_replay`. Confirm both events land in the audit log.

### Section D — Certificate rollover (rehearsal)

15. **Upload a second certificate** to the PROOVRA admin panel (as a dual-cert transition). Confirm the rehearsal tenant accepts assertions signed with either cert. Remove the first cert when the customer's IdP fully migrates.

### Section E — Test-user cleanup

16. **Disable the rehearsal application** on the customer's IdP. Confirm subsequent login attempts fail at the IdP step (not at PROOVRA).

17. **Delete or disable the rehearsal user** on both the customer's IdP and the PROOVRA rehearsal tenant. Confirm the PROOVRA audit log records the delete/disable.

18. **Decommission the rehearsal PROOVRA tenant** OR retain it for future rehearsals — Ops decision.

### Section F — Sign-off

19. **Document the rehearsal outcome.** Append a row to the rehearsal log below: IdP vendor, customer admin, PROOVRA operator, rehearsal date, all sections A–E status, any deviations from this runbook, any new follow-on tickets.

20. **Mark closure.** If all sections A–E complete with the expected outcomes AND the rehearsal log row is dated within the last 90 days, Ops + the customer joint-sign that the rehearsal is complete. **This runbook does NOT directly close DEF-002; the rehearsal log row is the EVIDENCE that the closing phase references.**

---

## Rehearsal log template

Append one row per rehearsal. Do NOT edit historical rows.

| Rehearsal date (ISO 8601) | IdP vendor | Customer admin | PROOVRA operator | Sections A–E status | Deviations / follow-ups |
|---|---|---|---|---|---|
| _no rehearsal recorded yet_ | | | | | |

---

## What "evidence-backed closure" means for DEF-002

DEF-002 is `BLOCKS_ENTERPRISE_PILOT` in the master registry. Closure requires:

- This runbook is fully walked at least once per intended-pilot IdP vendor (e.g. one rehearsal for Okta, separately for Entra ID).
- The rehearsal log has a row dated within the last 90 days per intended-pilot IdP vendor.
- All sections A–E status = PASS for that row.
- No deviation / follow-up row outstanding.
- The closing phase's doc references the specific rehearsal log row (date + IdP + customer).

Until those conditions hold, DEF-002 stays OPEN in the master registry §6 and the corresponding enterprise pilot is NOT ready to begin.

---

## DEF-aware caveats

- **DEF-001 (POST_LAUNCH):** SP request signing is schema-supported only — the SP private key is not yet applied to outgoing AuthnRequests. Most production IdPs accept unsigned AuthnRequests for pilot. If the customer's IdP requires signed SP requests, the pilot must wait for R8.3.
- **DEF-013 (POST_LAUNCH):** IdP-initiated login is intentionally NOT implemented. All SAML flows must be SP-initiated. If the customer's procurement requires IdP-initiated specifically, escalate as a future feature decision (out of scope for this rehearsal).
- **DEF-037 (RESOLVED by E10.1):** the SAML ACS endpoint inherits the same auth-route hardening sprint that closed login + password-reset rate limits. The ACS endpoint itself is still tracked under DEF-039 for per-IP throttling (POST_LAUNCH).

---

## Honest gaps

- This runbook covers FIRST-pilot rehearsal. Each subsequent pilot vendor requires its own walk; the rehearsal log row is the per-vendor evidence.
- The runbook does NOT cover end-to-end SCIM provisioning rehearsal — that is operator-driven and tracked separately under the SCIM 2.0 surface in the launch readiness inventory.
- Certificate rotation cadence post-pilot is operator-driven; the PROOVRA admin panel surfaces expiry warnings but does not auto-rotate.
