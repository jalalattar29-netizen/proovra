# Data Retention Policy

Last Updated: 2026-06-23

This Data Retention Policy explains how PROOVRA approaches retention of account data, uploaded materials, technical logs, billing data, audit material, and evidence-related verification artifacts.

It is intended to help customers, reviewers, regulators, and data protection authorities understand how retention supports service operation, security, legal compliance, fraud prevention, and the continuity of evidence-integrity functions on the platform. Read together with the Privacy Policy, DPA, Privacy Requests, and the Evidence Handling Policy.

## 1. RETENTION PRINCIPLES

PROOVRA seeks to retain personal data no longer than is reasonably necessary for the purposes for which it is processed, except where longer retention is justified by:

- applicable law (including accounting, tax, regulatory, and reporting obligations)
- security needs (intrusion detection, abuse prevention, account-recovery security)
- fraud prevention
- legal hold, ongoing investigations, or pending legal claims
- the operational need to preserve the integrity and reviewability of completed evidence records (see Section 4)

Specific retention periods may depend on customer configuration, plan capabilities, applicable law, and the category of data.

## 2. RETENTION MATRIX

The matrix below describes retention basis, normal retention, and extension conditions per data category. Specific durations may evolve and may differ for enterprise customers under contract.

| Category | Retention basis | Normal retention | Extension conditions |
|---|---|---|---|
| Account records (name, email, account identifiers, workspace membership) | Contract performance and legitimate interests for service continuity | Duration of the account plus a reasonable period after closure for service-continuity, security, dispute handling, and audit purposes | Legal hold; pending dispute; security investigation; statutory record-keeping obligation |
| Authentication records (password hashes, MFA secrets where enabled, SSO/SAML/SCIM identifiers) | Contract performance; security | Duration of the account; secrets rotated and previous values invalidated on the user's request or upon credential reset | Pending account-recovery, fraud investigation, or law-enforcement preservation request |
| Legal acceptance records (Terms, DPA, AUP, Cookie Policy acceptance events and policy versions accepted) | Legitimate interests; compliance with contractual evidence requirements | Duration sufficient to demonstrate that the customer agreed to the applicable terms, normally for the lifetime of the account plus a reasonable period after closure | Pending dispute; statutory limitation period |
| Audit logs (security-relevant platform events; admin operations) | Legitimate interests; security; legal obligations | Limited retention period sufficient to support incident response, audit, and reasonable forensic review | Active or recent incident; pending audit; legal preservation request |
| Security logs (intrusion detection telemetry, authentication telemetry, abuse signals) | Legitimate interests; security | Limited retention period sufficient to support security operations | Active investigation; abuse-prevention requirement |
| Support requests and communications | Contract performance; legitimate interests | Retention period sufficient to support resolution and reasonable follow-up | Pending dispute; legal hold |
| Privacy requests and data-subject communications | Legal obligation (demonstration of GDPR compliance) | Retention sufficient to demonstrate handling of the request, normally a defined number of years | Pending complaint or regulatory inquiry |
| Billing and transaction records | Legal obligation (accounting, tax) | Period required by applicable accounting and tax law (commonly several years) | Pending audit; pending tax authority review |
| Evidence content (files uploaded or captured into a customer workspace) | Customer instruction (processor role); contract performance | Per customer-configured retention; until workspace deletion; until customer-controlled lifecycle action | Customer-applied legal hold; preservation request; integrity-record dependency (see Section 4) |
| Custody records (Chain of Custody events, hash-chained logs) | Service operation; evidence integrity | Retained for the lifetime of the underlying evidence record, and may be retained separately to preserve auditability of records already shared externally | Legal hold; record already shared externally via Public Verification URL or Verification Package |
| Digital signatures and signing-key references | Service operation; evidence integrity | Retained for the lifetime of the integrity record; signing-key material retained under key-management controls | Cryptographic-rotation events; security incident; legal hold |
| Verification Reports | Service operation; evidence integrity | Retained for the lifetime of the underlying record and any external reviewer dependency | Record already shared externally; legal hold |
| Verification Packages | Service operation; evidence integrity | Retained for as long as the package can be presented to a recipient and as long as the underlying record exists | External recipient dependency; legal hold |
| Timestamp tokens (RFC 3161; OpenTimestamps proofs) | Service operation; evidence integrity | Retained alongside the integrity record | Legal hold; verification continuity |
| Cookie preference records | Compliance with cookie law | Period sufficient to demonstrate the user's consent state and re-prompt at version change | Consent-version review by competent authority |
| Reliability and error-reporting telemetry (where enabled) | Legitimate interests; service reliability | Short to medium-term retention; aggregated metrics may be retained longer in de-identified form | Active reliability investigation |
| Marketing communications data (where applicable) | Consent or legitimate interests (depending on jurisdiction) | Retention sufficient for the marketing purpose; honour unsubscribe immediately | Suppression list required to honour opt-out |
| Legal hold records | Legal obligation; processor instruction | Until the legal hold is released by the customer controller or by a competent authority | The hold itself defines retention |

PROOVRA may publish or otherwise make available updated retention information from time to time. Enterprise customers may have additional retention controls available through workspace configuration.

## 3. DELETION, ANONYMIZATION, AND THE INTEGRITY BOUNDARY

### 3.1 Deletion

Where deletion is requested and legally permissible, PROOVRA seeks to delete or anonymize personal data within a reasonable period, subject to technical feasibility and to the retention exceptions described in this policy.

### 3.2 Anonymization

Where PROOVRA chooses to anonymize rather than delete, the data is processed in a manner that no longer permits identification of the data subject. Anonymized aggregate metrics may be retained to maintain, secure, and improve the Services.

### 3.3 Legal Holds and Pending Investigations

Records subject to a legal hold remain in retention until the hold is released by the customer controller or by a competent authority. PROOVRA will not unilaterally remove records under legal hold.

## 4. EVIDENCE-INTEGRITY PRESERVATION

The platform's evidence-integrity model depends on the retention of integrity records (hashes, signatures, custody events, timestamp tokens, Verification Reports, Verification Package manifests). These records may be retained on a separate retention cadence from the underlying user-facing content because:

- a recipient of a Public Verification URL or Verification Package may rely on those integrity records to inspect a recorded evidence state
- deletion of the integrity record could materially impair the reviewability of an evidence record already shared externally
- preservation of integrity material supports later review under disputes, audits, claims, or investigations

Where the underlying user-facing content is deleted but the integrity record is retained, PROOVRA seeks to retain only the material necessary to preserve auditability — for example, the cryptographic fingerprint, the custody-event log, the timestamp token, and metadata required to render a Verification Report.

## 5. LEGAL OBLIGATIONS AFFECTING RETENTION

Retention may be extended where required by:

- accounting and tax law (typically requiring multi-year retention of billing records)
- statutory limitation periods relevant to potential legal claims
- regulatory obligations applicable to the relevant industry or jurisdiction
- court orders, regulatory orders, or legally binding preservation requests
- the customer's own retention obligations applied through workspace configuration

PROOVRA may rely on these obligations as a lawful basis for retention beyond the normal retention periods set out in Section 2.

## 6. CUSTOMER-CONFIGURED RETENTION

Customers may configure retention controls within their workspace where the relevant feature is available on the plan. Customer-configured retention controls do not override PROOVRA's own retention obligations under applicable law or under this policy.

## 7. SUBPROCESSOR RETENTION

Subprocessors may retain personal data only to the extent reasonably necessary to provide their service to PROOVRA, subject to contractual obligations consistent with the DPA. Provider-specific retention information is available in the Subprocessors page where applicable.

## 8. RELATED DOCUMENTS

- Privacy Policy
- Cookie Policy
- Data Processing Addendum (DPA)
- Subprocessors
- Technical and Organizational Measures (TOMs)
- Privacy Requests
- Evidence Handling Policy
- Verification Methodology
- Verification Disclaimer
- AI Use Policy
- Incident Response Policy
- Trust Center

## 9. CONTACT

For questions about retention, contact **legal@proovra.com** or **privacy@proovra.com**.
