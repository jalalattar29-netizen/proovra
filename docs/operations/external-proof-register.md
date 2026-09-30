# External-proof register — evidence lifecycle

What has been proven against a **real external system**, what has only been
proven against a **local stand-in**, and what is blocking the difference.

A local stand-in is never recorded here as external proof. MinIO is not AWS S3.
A locally minted timestamp authority is not GlobalTrust. A recorded webhook
fixture is not the Stripe or PayPal sandbox.

Last reviewed: 2026-09-30, at the close of the evidence-lifecycle remediation
(branch `fix/evidence-lifecycle-remediation`).

## Status on 2026-09-30

**No external proof was run in this remediation.** No non-production
credentials exist for any of the six integrations below: the repository has no
Staging or Sandbox environment, and the shell the gates ran in exposes no
staging, sandbox, AWS, TSA, Stripe or PayPal variable. The only credentials
present on the workstation are Production ones (`services/api/.env`), which
were not read, not loaded (`PROOVRA_ENV_BOOTSTRAPPED=1`) and not used.
Production was not contacted.

Every row is therefore **LOCAL PROOF ONLY — EXTERNAL PROOF OUTSTANDING**.

| # | Integration | Claim that needs the real system | Local proof (stand-in) | External proof | Blocker |
|---|---|---|---|---|---|
| 1 | AWS S3 Object Lock | A finalized original is retained under COMPLIANCE-mode Object Lock **on the exact VersionId the record stores**; that version cannot be deleted or overwritten before its retain-until date; an integrity recheck reads that VersionId, not "latest" | MinIO (loopback): `services/api/test/s3-object-lock-commands.test.ts`, `services/api/test/integrity-recheck.integration.test.ts` (recheck records the VersionId it read), `services/worker/test/integrity-recheck-digest-rule.test.ts` | **None** | No non-production AWS account, bucket with Object Lock enabled, or credentials |
| 2 | GlobalTrust TSA (RFC 3161) | A token from the real authority chains to the configured trust anchor, carries an accepted policy OID, and matches the record's imprint and nonce | Locally minted authority over loopback HTTP: `services/api/test/tsa-token-validation.test.ts` (trusted / forged / expired / wrong imprint / replayed nonce / altered signature / no anchor / test anchor refused in Production), `services/api/test/tsa-finalize-persistence.integration.test.ts` | **None** | No non-production TSA endpoint or account; the real chain (`TSA_TRUST_BUNDLE_PATH`) has never been validated against a real token outside Production |
| 3 | OpenTimestamps | A digest submitted to public calendars receives a pending proof, and a later upgrade yields a Bitcoin-attested proof the record then reports as anchored | Calendar responses stubbed: `services/api/test/ots-upgrade-ladder.integration.test.ts`, `ots-integrity-lifecycle.integration.test.ts`, `services/worker/test/ots-upgrade-processor.behaviour.test.ts`, `ots-transition-rule.test.ts`, `ots-pending-recovery.integration.test.ts` | **None** | The integration suites run behind an outbound-network guard; no run has been authorised to reach public calendars, and an upgrade needs hours of wall-clock time after submission |
| 4 | Stripe (sandbox) | `charge.refunded` and `charge.dispute.*` reverse evidence credits correctly **in whatever order Stripe actually delivers them** (refund before or after the checkout completion; dispute opened, then won or lost; partial refund) | Signed fixture events replayed in both orders: `services/api/test/stripe-credit-refund-reversal.integration.test.ts` | **None** | No Stripe test-mode keys or webhook signing secret configured for a non-production deployment |
| 5 | PayPal (sandbox) | Order capture, refund and dispute webhooks settle and reverse credits; duplicate and out-of-order deliveries are idempotent | Fixture payloads: `services/api/test/billing-paypal-integrity.integration.test.ts`, `paypal-end-to-end-settlement.test.ts`, `phase-10-paypal-idempotency.test.ts` | **None** | No PayPal sandbox client id / secret / webhook id configured for a non-production deployment |
| 6 | Browser-extension OAuth allow-list | With `EXTENSION_OAUTH_REDIRECT_ALLOW` set to the published extension's id, the real extension completes sign-in and every other `chromiumapp.org` id is refused | `services/api/test/uc1-extension-oauth.integration.test.ts` (unset refuses every redirect; listed id accepted; unlisted id refused) | **None** | The extension is unpublished, so its production id does not exist yet; no non-production deployment to exercise it against |

## What closes each row

Each row closes when the named run is performed against a **non-production**
account and its output is attached here (date, environment, command, result).

1. **S3 Object Lock.** Non-production bucket created with Object Lock enabled
   and versioning on. Finalize a record; read back `GetObjectRetention` and
   `HeadObject` for the stored VersionId; attempt `DeleteObject` with that
   VersionId and record the `AccessDenied`; run the integrity recheck and
   confirm the check row's `storage_version_id` equals the stored one.
2. **TSA chain.** Non-production TSA credentials and the authority's real CA
   bundle at `TSA_TRUST_BUNDLE_PATH`, with `TSA_ACCEPTED_POLICY_OIDS` set to the
   authority's published policy. Finalize a record; confirm the token validates
   (chain, policy, imprint, nonce); then point the bundle at an unrelated CA and
   confirm the same token is FAILED.
3. **OpenTimestamps.** One record submitted to public calendars from a
   non-production worker; the pending proof recorded; the upgrade sweep left to
   run until the proof is Bitcoin-attested; the proof verified independently
   with the reference `ots verify` client.
4. **Stripe.** Test-mode keys; a real Checkout purchase of credits; then, in
   separate runs: full refund, partial refund, dispute lost, dispute won — each
   with the webhook delivered by Stripe, not replayed from a fixture. Record the
   delivery order Stripe actually used.
5. **PayPal.** Sandbox app; capture, refund and dispute, each delivered by
   PayPal; plus one deliberate redelivery from the PayPal dashboard.
6. **Extension OAuth.** The extension published (or loaded with its pinned key
   so its id is stable); `EXTENSION_OAUTH_REDIRECT_ALLOW` set to that id on a
   non-production API; sign-in completed from the extension; a second extension
   with a different id refused.

## Production configuration this depends on

These are requirements, not proof. None was changed or verified by this
remediation.

- `EXTENSION_OAUTH_REDIRECT_ALLOW` **must** be set in Production. Unset, the API
  refuses every extension sign-in (fail closed).
- `TSA_TRUST_BUNDLE_PATH` and `TSA_ACCEPTED_POLICY_OIDS` must name the real
  authority. With no trust anchor a timestamp is recorded as FAILED, never as
  stamped; a test anchor is refused in Production.
- `S3_OBJECT_LOCK_LEGAL_HOLD` stays off (it is deliberately inert and refused at
  boot when on).
