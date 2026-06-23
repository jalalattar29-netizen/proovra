# Data Processing Addendum (DPA)

Last Updated: 2026-06-23

This Data Processing Addendum ("DPA") forms part of the agreement between PROOVRA and the customer ("Customer") using the Services where PROOVRA processes personal data on behalf of that Customer. Where there is a conflict between this DPA and the main agreement on data protection matters, this DPA prevails to the extent of the conflict.

## 1. PARTIES

This DPA applies between:

**Customer** — the user or organization acting as controller for customer-submitted personal data processed in connection with the Services.

**PROOVRA** — the processor for such customer-submitted personal data, where applicable.

For website, account, billing, support, security, legal acceptance logging, and certain platform-level processing, PROOVRA may also act as an independent controller. The Privacy Policy describes those scenarios. The DPA addresses the processor relationship.

## 2. SUBJECT MATTER

PROOVRA provides a digital evidence operations platform that may process personal data in connection with:

- intake, capture, and storage of uploaded or captured files
- generation of SHA-256 hashes, fingerprints, digital signatures (including AWS KMS-backed signing where configured), and Verification Reports
- Chain of Custody event records (hash-chained log of platform actions)
- RFC 3161 trusted timestamping (where configured) and OpenTimestamps anchoring (where available)
- Verification Packages, Public Verification URLs, and reviewer workflows
- Cases, Teams, Workspaces, and reviewer collaboration features
- Legal Hold, retention, and governance controls
- support and technical operations
- AI-assisted workflows where enabled (advisory only; see the AI Use Policy)

## 3. NATURE AND PURPOSE OF PROCESSING

Processing is carried out solely to provide, secure, support, maintain, and improve the Services, and to comply with legal obligations and documented Customer instructions as reflected in the Service configuration, the main agreement, and Customer use.

## 4. DURATION OF PROCESSING

Processing under this DPA continues for the duration of the main agreement and, after termination or expiry, for the period required for return, deletion, or lawful retention of personal data as described in Appendix E.

## 5. CATEGORIES OF DATA

Depending on Customer use, personal data may include:

- account identifiers
- names and email addresses
- workspace, team, and case identifiers
- uploaded files and personal data embedded in those files
- technical metadata associated with uploaded content
- logs, audit events, and custody events
- team, role, and access information
- Verification artifacts (hashes, signatures, custody events, timestamp metadata, Verification Reports, Verification Package manifests)

## 6. DATA SUBJECTS

Data subjects may include:

- Customer personnel and authorized end-users
- end-users of the Customer's workspace
- subjects whose data appears in uploaded evidence material
- reviewers, recipients, or collaborators invited into a case
- support contacts and other persons whose data appears in submitted material

## 7. PROCESSOR OBLIGATIONS

PROOVRA shall:

- process personal data only on documented instructions from the Customer, unless otherwise required by applicable law; where law requires processing, PROOVRA shall inform the Customer unless prohibited
- ensure that persons authorized to process personal data are bound by confidentiality
- implement appropriate technical and organizational measures consistent with Appendix B
- assist the Customer where reasonably possible with data-subject requests, security matters, breach notification, and other compliance obligations under applicable data protection law
- notify the Customer without undue delay after becoming aware of a personal data breach affecting Customer-controlled personal data, with information reasonably necessary to enable the Customer to comply with its own notification obligations
- delete or return personal data upon termination of the main agreement, in accordance with Appendix E, except where retention is justified by applicable law, security, fraud prevention, or evidence-integrity preservation requirements
- make available information reasonably necessary to demonstrate compliance with this DPA, subject to Appendix F

## 8. SECURITY MEASURES

PROOVRA implements technical and organizational measures consistent with Appendix B (TOMs). PROOVRA may update those measures from time to time, provided that the security posture is not materially diminished.

## 9. SUBPROCESSORS

PROOVRA may engage subprocessors to support delivery of the Services. The current set of subprocessors is published in Appendix C (and mirrored on the public Subprocessors page).

PROOVRA shall:

- impose data protection obligations on subprocessors that are substantially the same as those in this DPA
- remain responsible to the Customer for the performance of the subprocessor's obligations
- provide reasonable advance notice of intended changes to the subprocessor list, where commercially practicable; the Customer may object to a new subprocessor on reasonable data-protection grounds, in which case the parties will work in good faith to reach an acceptable resolution

## 10. INTERNATIONAL TRANSFERS

Where personal data is transferred outside the EEA, UK, or Switzerland to a country that has not been recognised as providing an adequate level of protection, PROOVRA shall seek to rely on appropriate transfer safeguards. The applicable transfer framework is described in Appendix D.

## 11. AUDITS AND INFORMATION

PROOVRA shall make available information reasonably necessary to demonstrate compliance with this DPA, in accordance with Appendix F. Audit rights are subject to reasonable confidentiality, security, and proportionality limitations.

## 12. RETENTION AND DELETION

Retention and deletion obligations are described in Appendix E. They remain subject to applicable law, legal hold, security, fraud-prevention, dispute-handling, audit, and evidence-integrity preservation requirements.

## 13. ASSISTANCE WITH DATA SUBJECT REQUESTS

To the extent the Customer is unable to address a data-subject request through workspace controls, PROOVRA shall provide reasonable assistance to the Customer in responding to access, rectification, deletion, restriction, portability, and objection requests under applicable law. Where a data-subject request relates to content under the Customer's control, PROOVRA may direct the data subject to the Customer.

## 14. LIABILITY AND GOVERNING LAW

The limitations and exclusions of liability set out in the main agreement apply to this DPA, except where applicable law requires otherwise. This DPA is governed by the same law governing the main agreement, unless otherwise required by mandatory law.

## 15. ORDER OF PRECEDENCE

In the event of conflict between this DPA and the main agreement on data protection matters, this DPA prevails. In the event of conflict between this DPA and an applicable SCC, the SCC prevails to the extent required.

## 16. CONTACT

For questions about this DPA, contact **legal@proovra.com**.

---

## Appendix A — Detailed Processing Activities

The following table describes the processing activities PROOVRA performs as a processor on behalf of the Customer.

| Processing activity | Purpose | Categories of personal data | Categories of data subjects | Duration |
|---|---|---|---|---|
| Storage of uploaded or captured files | Provide evidence storage and reviewer access | Uploaded files; embedded personal data; capture metadata | Customer personnel; subjects in uploaded material | Duration of service + retention policy |
| Hashing and fingerprinting | Compute SHA-256 fingerprints supporting integrity verification | File content (transient hashing) | Subjects in uploaded material | Duration of service |
| Digital signature operation | Sign integrity material using a signing key (AWS KMS-backed where configured) | File fingerprints; key identifiers | n/a | Duration of service |
| RFC 3161 trusted timestamping (where configured) | Bind a record fingerprint to an externally signed time | File fingerprints; timestamp tokens | n/a | Duration of service |
| OpenTimestamps anchoring (where available) | Anchor digests to public timestamping calendars | File fingerprints; OTS proofs | n/a | Duration of service |
| Chain of Custody event recording | Maintain a hash-chained log of platform actions on a record | Actor identifiers; record identifiers; event types | Customer personnel; reviewers | Duration of service + retention policy |
| Verification Report generation | Produce a reviewer-ready report from recorded materials | Record identifiers; integrity material; custody chain | Subjects in uploaded material | Duration of service + retention policy |
| Verification Package generation | Bundle manifests, hashes, signatures, custody references | Same as report generation | Same | Duration of service + retention policy |
| Public Verification URL generation | Expose a read-only reviewer surface for a record | Record identifiers; integrity material; redacted metadata | Subjects in uploaded material | Until the URL is revoked or the underlying record is removed |
| Reviewer collaboration | Support assigned reviewers, comments, and case workflow | Reviewer identifiers; case identifiers | Customer personnel; reviewers | Duration of service |
| Legal hold and retention controls | Apply Customer-configured legal hold and retention | Record identifiers; hold flags; retention configuration | n/a | Until Customer or competent authority releases the hold |
| Security monitoring (processor scope) | Detect intrusion attempts, abuse, and account compromise affecting the Customer workspace | Access logs; authentication events; request metadata | Customer personnel | Up to the security log retention period in the Data Retention Policy |
| AI-assisted workflows (where enabled) | Advisory metadata-first AI features to support reviewer preparation; see the AI Use Policy | Operational metadata; structured workspace context; verification result codes | Customer personnel; subjects in uploaded material | Duration of the AI feature usage |

---

## Appendix B — Technical and Organizational Measures (TOMs)

PROOVRA implements technical and organizational measures designed to support the confidentiality, integrity, availability, and resilience of personal data, and to preserve evidence-integrity functions. The measures below describe the platform's intended design; specific configuration may depend on Customer choices.

### B.1 Access Control

- Role-Based Access Control (RBAC) inside the platform
- Workspace-scoped permissions
- Multi-Factor Authentication (MFA) where enabled by the Customer
- Single Sign-On via SAML and provisioning via SCIM where configured
- Least-privilege defaults for newly invited members

### B.2 Authentication

- Strong password hashing for password-based authentication
- Federated authentication via supported OAuth providers (Google, Apple)
- Session controls including session lifetime, MFA continuity, and high-risk operation re-authentication where applicable

### B.3 Authorization

- Capability-based gating for high-risk operations
- Enterprise feature gates for SCIM, SAML, retention, legal hold, and audit functionality where the plan supports those features

### B.4 Audit Logging

- Immutable audit log capture for security-relevant events
- Hash-chained Chain of Custody events for evidence operations
- Logs retained per the Data Retention Policy

### B.5 Data Protection

- Encryption in transit (TLS) on supported channels
- Server-side encryption at rest where supported by the storage provider
- Object Lock / immutable storage controls where configured by the Customer

### B.6 Evidence Integrity Controls

- SHA-256 fingerprinting at intake and at verification time
- Digital signature operations using a signing key (AWS KMS-backed where configured)
- RFC 3161 trusted timestamping where configured
- OpenTimestamps anchoring where available
- Hash-chained custody events
- Verification Report and Verification Package generation from recorded materials

### B.7 Infrastructure Security

- Hardened cloud infrastructure
- Network controls and segmentation where applicable
- Edge security and bot protection where deployed
- Secret management for credentials and keys

### B.8 Backup and Recovery

- Operational backups of platform metadata
- Recovery procedures for service-impacting incidents

### B.9 Incident Response

- Incident detection, triage, containment, remediation, post-incident review
- Breach-notification process consistent with applicable law (see the Incident Response Policy)

### B.10 Secure Development

- Code review and peer review for production changes
- Dependency review for production dependencies
- Use of vulnerability monitoring tools where applicable

### B.11 Vendor Management

- Subprocessor selection includes data-protection review
- Contractual data-protection obligations on subprocessors

### B.12 Monitoring

- Platform availability and reliability monitoring
- Security telemetry collection for intrusion detection and abuse prevention

---

## Appendix C — Subprocessors

The list below describes the categories of subprocessors PROOVRA may engage. The current set is mirrored on the public Subprocessors page. PROOVRA includes only providers actually used. Specific providers may evolve with platform configuration.

| Service | Purpose | Categories of personal data | Region |
|---|---|---|---|
| Cloud infrastructure and storage (e.g., AWS) | Hosting; storage of evidence content and metadata; KMS for signing keys | Uploaded content; account data; logs; signing-key identifiers | EU and other AWS regions used by the deployment |
| Payment processing (e.g., Stripe) | Process billing transactions for paid plans | Billing identifiers; transaction metadata | Stripe-supported regions |
| Federated authentication (Google) | OAuth sign-in where the user chooses Google sign-in | OAuth identifiers; minimal profile data | Google regions |
| Federated authentication (Apple) | OAuth sign-in where the user chooses Apple sign-in | OAuth identifiers; minimal profile data | Apple regions |
| Email delivery (where applicable) | Send transactional and policy emails | Email addresses; message metadata | Provider-specific regions |
| Edge security (where deployed) | Edge security, bot detection, infrastructure protection | Request metadata; IP address | Provider-specific regions |
| Reliability / error reporting (where enabled) | Detect crashes, performance regressions, service errors | Diagnostic telemetry; account identifiers | Provider-specific regions |
| AI provider (where AI features are enabled) | Advisory metadata-first AI assistance | Operational metadata; structured workspace context | Provider-specific regions |

A provider is included only where it is actually engaged for the platform. Providers not in the platform's current deployment are not listed. PROOVRA seeks to give reasonable advance notice of changes to the subprocessor list where commercially practicable.

---

## Appendix D — International Transfers

### D.1 Transfer Framework

Where personal data is transferred outside the EEA, UK, or Switzerland to a country that has not been recognised by the European Commission (or the UK or Swiss equivalent) as providing an adequate level of protection, PROOVRA seeks to rely on appropriate safeguards required by applicable law, including:

- **Standard Contractual Clauses (SCCs)** approved by the European Commission, including the EU 2021/914 modules where applicable
- the **UK International Data Transfer Addendum** where the UK GDPR applies
- the **EU-US Data Privacy Framework (DPF)** for transfers to certified recipients, where applicable
- supplementary technical and organizational measures where assessed as required following a transfer impact assessment

### D.2 Transfer Impact Assessments

PROOVRA may perform or rely on transfer impact assessments where required by applicable law, taking into account the legal regime of the destination country, the nature of the data, the duration of processing, and applicable safeguards.

### D.3 Additional Transfer Documentation

PROOVRA may make additional transfer documentation available to enterprise customers on reasonable request, subject to confidentiality.

---

## Appendix E — Deletion and Return of Data

### E.1 Account Termination

Upon termination of the main agreement, the Customer may instruct PROOVRA to either return or delete personal data within a reasonable period, subject to E.2.

### E.2 Retention Exceptions

PROOVRA may retain personal data after termination only where retention is justified by:

- applicable law (including accounting, tax, and regulatory obligations)
- security and audit logging requirements
- fraud prevention and abuse prevention
- legal hold or pending legal claims
- evidence-integrity preservation for completed evidence records

Retained data is processed only for the purposes justifying the retention.

### E.3 Deletion Workflow

Deletion or anonymization is carried out within a reasonable period after the deletion instruction is confirmed, subject to technical feasibility and the retention exceptions above. Verification artifacts (hashes, signatures, custody-event metadata, timestamp tokens) may be retained on a separate retention cadence where required to preserve the integrity and auditability of completed evidence records that may have been shared externally.

### E.4 Legal Holds

Records subject to a legal hold remain in retention until the legal hold is released by the Customer controller or by a competent authority. PROOVRA will not unilaterally remove records under legal hold without instruction from the Customer or a legally binding order.

### E.5 Audit and Custody Records

Audit logs and custody events relevant to the integrity, security, or auditability of the Services may be retained for the periods set out in the Data Retention Policy, even after the underlying user-facing content has been deleted.

---

## Appendix F — Audit and Information Rights

### F.1 Documentation Review

PROOVRA shall make available, on reasonable request, documentation reasonably necessary to demonstrate compliance with this DPA. Such documentation may include:

- the most recent description of TOMs (Appendix B)
- the current Subprocessors list (Appendix C)
- relevant security policies and procedures
- penetration test or vulnerability assessment summaries, where available and subject to confidentiality

### F.2 Security Questionnaire Handling

PROOVRA shall use reasonable efforts to respond to enterprise security and privacy questionnaires within a reasonable time, subject to confidentiality and operational capacity.

### F.3 Audit Process

Subject to confidentiality, security, and proportionality, the Customer (or a mutually agreed third-party auditor bound by appropriate confidentiality obligations) may audit PROOVRA's compliance with this DPA, including by reviewing documentation. The parties shall agree in advance on scope, timing, and conduct of any on-site audit, and the Customer shall bear the cost of an audit it requests unless the audit reveals a material breach by PROOVRA.

### F.4 Audit Limitations

Audits shall be conducted in a manner that does not interfere with PROOVRA's normal business operations, comply with PROOVRA's reasonable security and confidentiality requirements, respect the rights and confidentiality of other PROOVRA customers, and be limited in frequency to no more than once per twelve-month period, except where a specific incident or regulatory request justifies an additional audit.

### F.5 Cooperation with Supervisory Authorities

PROOVRA shall cooperate, on request, with the Customer's competent supervisory authority where required by applicable law.

---

## Related Documents

- Privacy Policy
- Cookie Policy
- Subprocessors
- Technical and Organizational Measures (TOMs)
- Data Retention Policy
- Security and Responsible Disclosure
- Incident Response Policy
- AI Use Policy
- Verification Methodology
- Verification Disclaimer
- Evidence Handling Policy
- Privacy Requests
- Trust Center
