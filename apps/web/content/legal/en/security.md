# Security and Responsible Disclosure Policy

Last Updated: 2026-06-23

PROOVRA is designed for trust-sensitive workflows involving digital evidence preservation, integrity verification, custody recording, and controlled review. This page describes PROOVRA's security posture at a practical level and explains how researchers can responsibly report vulnerabilities affecting the platform.

This policy is read together with the Technical and Organizational Measures (TOMs), the Incident Response Policy, the Subprocessors page, the Privacy Policy, the Data Processing Addendum (DPA), the Verification Methodology, the Verification Disclaimer, and the AI Use Policy.

## 1. SECURITY OBJECTIVES

PROOVRA's security program is designed to support:

- confidentiality of account, workspace, and service data
- integrity of evidence material and verification artifacts
- protection of signing-key references and verification context recorded by the platform
- controlled reviewer access to Verification Reports, Verification Packages, and Public Verification URLs
- availability and reliability of the Services
- resilience against unauthorized access, tampering, abuse, and misuse of verification links and reports

## 2. SECURITY GOVERNANCE

Security responsibilities are assigned internally. Security policies are reviewed periodically as the platform evolves. Production access is limited to personnel with a need to know. Security practices evolve with product maturity, regulatory developments, and operational experience. This page describes the intended posture; unless separately verified by a named audit report or certification document, PROOVRA does not claim formal certification of these practices.

## 3. ACCESS CONTROL

Access-control measures may include, as appropriate:

- Role-Based Access Control (RBAC) inside the platform
- workspace-scoped permissions and least-privilege defaults
- separation of administrative and operational roles where supported by the surface
- periodic review of standing access
- removal of access when no longer needed
- environment-specific access control (production, staging, development)

Customers remain responsible for configuring their own team membership, roles, permissions, sharing settings, and external invitations within their workspace.

## 4. IDENTITY AND AUTHENTICATION

Identity and authentication measures may include, as appropriate:

- strong password hashing for password-based authentication
- Multi-Factor Authentication (MFA) where enabled by the customer
- Single Sign-On via SAML where configured
- automated provisioning and de-provisioning via SCIM where configured
- federated sign-in via supported OAuth providers (Google, Apple) where the user chooses such sign-in
- session controls, including session lifetime and high-risk-operation re-authentication where supported

## 5. DATA PROTECTION

Data-protection measures may include, as appropriate:

- TLS / encryption in transit on supported channels
- server-side encryption at rest where supported by the storage provider and the deployment configuration
- object-storage controls (including immutability or Object Lock) where configured by the customer or deployment
- protection of secrets and tokens via secret-management controls
- environment-appropriate handling of sensitive material

No system can guarantee absolute security; these measures are designed to reduce risk in a layered way.

## 6. KEY MANAGEMENT AND SIGNING MATERIAL

Signing material used by the platform may be platform-controlled or KMS-backed where configured. Key identifiers and signing context may be recorded on signature records for later verification. Signing-key rotation or revocation may occur after an incident or where operationally appropriate. PROOVRA does not claim that platform signatures or timestamps constitute a qualified electronic signature, qualified electronic seal, qualified electronic timestamp, or PAdES qualified signature unless separately verified for a named release.

## 7. EVIDENCE-INTEGRITY CONTROLS

Evidence-integrity controls may include, as appropriate:

- SHA-256 fingerprinting at intake and at verification time
- structured fingerprint records
- digital signature operations using a signing key (AWS KMS-backed where configured)
- RFC 3161 trusted timestamping where configured
- OpenTimestamps anchoring where available
- hash-chained custody events
- Verification Report and Verification Package generation from recorded materials
- Public Verification URLs for reviewer-facing inspection, subject to access controls and customer settings

These controls support technical review of recorded integrity material. They do not, by themselves, prove factual truth, authorship, identity, intent, lawful provenance, legal admissibility, or court acceptance.

## 8. LOGGING AND MONITORING

Logging and monitoring measures may include, as appropriate:

- immutable audit log capture for security-relevant events
- administrative-action logging
- authentication-event logging
- hash-chained custody events for evidence operations
- error and reliability monitoring where enabled
- security telemetry collection for intrusion detection and abuse prevention

Logs are used for security, debugging, abuse prevention, incident response, and auditability, and are retained according to the Data Retention Policy.

## 9. INFRASTRUCTURE SECURITY

Infrastructure-security measures may include, as appropriate:

- hardened cloud infrastructure, database, and object storage (see the Subprocessors page for the current set of providers)
- environment separation between development, staging, and production
- network controls and segmentation where applicable
- edge security, bot detection, DDoS protection, and TLS edge termination where deployed
- rate limiting and abuse prevention
- backup and recovery controls where configured
- secret management for credentials and keys

Subprocessor dependencies are disclosed on the Subprocessors page.

## 10. SECURE DEVELOPMENT

Secure-development measures may include, as appropriate:

- code review and peer review for production changes
- dependency review for production dependencies
- use of vulnerability monitoring tools where applicable
- environment separation between development, staging, and production
- configuration review for security-sensitive settings
- secrets are not intended to be committed to source control
- production changes follow review and deployment controls appropriate to the stage of the company

## 11. VULNERABILITY MANAGEMENT

Security reports are triaged by severity. Remediation priority depends on severity, exploitability, affected data, and operational risk. PROOVRA does not operate a public bug bounty unless explicitly stated. The safe-harbor language in Section 16 remains in force for good-faith research that follows this policy.

## 12. THIRD-PARTY AND SUBPROCESSOR SECURITY

PROOVRA reviews providers based on service role and risk. Contractual protections are sought where applicable. Transfer mechanisms are described in the DPA (Appendix D) and on the Subprocessors page. PROOVRA does not claim provider certifications as its own; each provider's own published certifications and assurances are the authoritative source for that provider's compliance posture.

## 13. INCIDENT RESPONSE

PROOVRA maintains an Incident Response process designed to support:

- monitoring-driven incident detection
- triage, containment, investigation, remediation, and post-incident review
- breach-notification process consistent with applicable law
- customer and regulatory notification where required
- preservation of logs and integrity artifacts during security incidents
- coordination with subprocessors during incidents

See the Incident Response Policy for the full process and notification expectations.

## 14. CUSTOMER SECURITY RESPONSIBILITIES

Customers and users remain responsible for:

- protecting credentials, recovery codes, and devices
- enabling MFA and other security features where available
- managing team membership, roles, and permissions inside their workspace
- controlling distribution of Verification Reports, Verification Packages, and Public Verification URLs
- ensuring lawful basis, consent, and rights for uploaded material
- promptly reporting suspected compromise or misuse to PROOVRA

## 15. RESPONSIBLE VULNERABILITY DISCLOSURE

PROOVRA welcomes good-faith reports of security vulnerabilities affecting the platform.

Please report security issues to **security@proovra.com**. Where possible, include:

- a clear description of the issue
- the affected URL, endpoint, feature, or workflow
- an impact assessment
- reproduction steps
- a safe proof of concept, only where lawful and non-destructive
- your contact details for follow-up

When testing or reporting, please:

- avoid accessing data belonging to other users
- avoid modifying, deleting, or exfiltrating data
- avoid disrupting service availability
- avoid social engineering, phishing, spam, or physical attacks
- avoid privacy violations of users or staff
- limit testing to what is reasonably necessary to demonstrate the issue
- give PROOVRA reasonable time to investigate and remediate before public disclosure

## 16. SAFE HARBOR

If you act in good faith, follow this policy, avoid harming users or the Services, and promptly report the issue to PROOVRA, PROOVRA does not intend to pursue legal action solely because of that compliant security research. This safe harbor does not apply to unlawful conduct, data exfiltration, extortion, disruption of services, social engineering, privacy violations, or conduct outside this policy.

## 17. NO CERTIFICATION CLAIM

Unless separately stated in a named audit report or certification document, this policy does not claim SOC 2, ISO 27001, HIPAA compliance, eIDAS qualified status, qualified trust service status, PAdES qualified signature status, or any other certification, accreditation, or audit outcome. PROOVRA continues to evolve its security posture and may update this summary over time.

## 18. RESPONSE EXPECTATIONS

Response times depend on severity and operational context. PROOVRA generally seeks to:

- acknowledge security reports within a reasonable timeframe
- assess severity and prioritize remediation
- communicate status to reporters where appropriate

These are operational targets, not contractual service-level commitments.

## 19. RELATED DOCUMENTS

- Technical and Organizational Measures (TOMs)
- Incident Response Policy
- Subprocessors
- Privacy Policy
- Data Processing Addendum (DPA)
- Data Retention Policy
- Verification Methodology
- Verification Disclaimer
- AI Use Policy
- Trust Center

## 20. CONTACT

Security reports: **security@proovra.com**
General security or compliance questions: **security@proovra.com** or **legal@proovra.com**
