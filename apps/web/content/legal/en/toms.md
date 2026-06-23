# Technical and Organizational Measures (TOMs)

Last Updated: 2026-06-23

This page summarizes the technical and organizational measures PROOVRA may implement to protect personal data, support service availability, and preserve evidence-integrity functions. The measures below describe the platform's intended design; specific configuration may depend on customer choice, plan capabilities, and deployment configuration. Wording such as "where configured", "where enabled", "where supported by the provider", and "where deployed" reflects that not every measure is active in every environment.

This page is read together with the Privacy Policy, the Data Processing Addendum (DPA — Appendix B in particular), the Subprocessors page, the Security and Responsible Disclosure policy, the Incident Response Policy, and the Trust Center.

## 1. ACCESS CONTROL

Measures may include, as appropriate:

- Role-Based Access Control (RBAC) inside the platform
- workspace-scoped permissions and least-privilege defaults
- separation of administrative and operational roles
- environment-specific access control (production, staging, development)
- credential lifecycle management and periodic review of standing access

## 2. AUTHENTICATION

Measures may include, as appropriate:

- strong password hashing for password-based authentication
- Multi-Factor Authentication (MFA) where enabled by the customer
- Single Sign-On via SAML where configured
- automated provisioning and de-provisioning via SCIM where configured
- federated sign-in via supported OAuth providers (Google, Apple) where the user chooses such sign-in
- session controls, including session lifetime, MFA continuity, and high-risk-operation re-authentication where applicable

## 3. AUTHORIZATION

Measures may include, as appropriate:

- capability-based gating for high-risk operations
- enterprise feature gates for SCIM, SAML, retention, legal hold, audit, identity governance, and similar functionality where the plan supports those features
- workspace-scoped authorization for evidence content and related operations

## 4. AUDIT LOGGING

Measures may include, as appropriate:

- immutable audit log capture for security-relevant events
- hash-chained Chain of Custody events for evidence operations
- administrative-action logging
- retention of audit logs per the Data Retention Policy

## 5. DATA PROTECTION

Measures may include, as appropriate:

- encryption in transit (TLS) on supported channels
- server-side encryption at rest where supported by the storage provider
- Object Lock / immutable storage controls where configured by the customer
- protection of secrets and tokens via secret-management controls

## 6. EVIDENCE-INTEGRITY CONTROLS

Measures may include, as appropriate:

- SHA-256 fingerprinting at intake and at verification time
- digital signature operations using a signing key (AWS KMS-backed where configured)
- RFC 3161 trusted timestamping where configured
- OpenTimestamps anchoring where available
- hash-chained custody events
- Verification Report and Verification Package generation from recorded materials
- Public Verification URLs for reviewer-facing inspection

## 7. INFRASTRUCTURE SECURITY

Measures may include, as appropriate:

- hardened cloud infrastructure (see the Subprocessors page for the current set of providers)
- network controls and segmentation where applicable
- edge security and bot protection where deployed
- secret management for credentials and keys
- environment hardening for production systems

## 8. BACKUP AND RECOVERY

Measures may include, as appropriate:

- operational backups of platform metadata
- recovery procedures for service-impacting incidents
- testing of recovery procedures from time to time
- separation of backup environments from primary environments

## 9. INCIDENT RESPONSE

Measures may include, as appropriate:

- monitoring-driven incident detection
- triage, containment, remediation, and post-incident review
- breach-notification process consistent with applicable law (see the Incident Response Policy for the full process)
- coordination with subprocessors during incidents

## 10. SECURE DEVELOPMENT

Measures may include, as appropriate:

- code review and peer review for production changes
- dependency review for production dependencies
- use of vulnerability monitoring tools where applicable
- environment separation between development, staging, and production

## 11. VENDOR MANAGEMENT

Measures may include, as appropriate:

- subprocessor selection that includes data-protection review
- contractual data-protection obligations on subprocessors consistent with the DPA
- periodic review of the subprocessor set
- transfer assessments for subprocessors operating outside adequate jurisdictions

## 12. MONITORING

Measures may include, as appropriate:

- platform availability and reliability monitoring
- security telemetry collection for intrusion detection and abuse prevention
- error and reliability monitoring where enabled
- proactive alerting on defined operational and security signals

## 13. ORGANIZATIONAL MEASURES

Measures may include, as appropriate:

- confidentiality obligations for personnel and contractors
- need-to-know access allocation
- security and privacy training appropriate to role
- policy maintenance and periodic review
- vendor and subprocessor review

## 14. NO CERTIFICATION CLAIM

This page summarises intended design. PROOVRA does not claim certification, accreditation, or audit approval for the measures listed in this document unless that claim has been independently verified for a named release and described elsewhere. PROOVRA continues to evolve its security posture and may update this summary over time.

## 15. RELATED DOCUMENTS

- Data Processing Addendum (DPA) — see Appendix B
- Subprocessors
- Privacy Policy
- Data Retention Policy
- Security and Responsible Disclosure
- Incident Response Policy
- Verification Methodology
- Verification Disclaimer
- AI Use Policy
- Trust Center

## 16. CONTACT

For questions about these measures, contact **security@proovra.com** or **legal@proovra.com**.
