# Privacy Policy

Last Updated: 2026-06-23

This Privacy Policy explains how PROOVRA ("PROOVRA", "we", "us", or "our") collects, uses, stores, shares, and protects personal data in connection with our websites, applications, APIs, verification pages, and related services (the "Services").

PROOVRA operates a digital evidence operations platform. It is not cloud storage, file sharing, backup software, e-signature software, or a general-purpose AI service. It is designed to support capture, preservation, hashing, signing, timestamping, custody, verification, reporting, and reviewer workflows for digital evidence.

This policy is intended to help users, customers, reviewers, business contacts, regulators, and data protection authorities understand how personal data is handled when using PROOVRA. It is read together with the Cookie Policy, Data Processing Addendum (DPA), Data Retention Policy, Subprocessors, Technical and Organizational Measures (TOMs), Evidence Handling Policy, Verification Methodology, Verification Disclaimer, AI Use Policy, Privacy Requests, Incident Response Policy, Law Enforcement Request Policy, and the Trust Center.

## 1. WHO WE ARE

Controller for the website and Services, unless otherwise stated:

Jalal Attar
Ruhlandplatz 3
45355 Essen
Germany

Contact:
- support@proovra.com — general support
- legal@proovra.com — privacy, legal, and policy questions
- security@proovra.com — security and responsible disclosure
- privacy@proovra.com — privacy requests and data-subject communications

Where the contact for a specific processing activity differs (for example, where a business customer acts as controller for content uploaded to its workspace), that controller's contact information is determined by the customer's own privacy notice. PROOVRA's role in that scenario is described in Section 13.

## 2. SCOPE OF THIS POLICY

This Privacy Policy applies to personal data processed when you:

- visit our website
- create or access an account
- use our web or mobile applications
- upload, capture, review, verify, or manage evidence
- use Cases, Teams, Workspaces, sharing, custody, or verification features
- exercise Single Sign-On (SSO), SAML, SCIM, or related identity flows
- contact support or communicate with us
- receive operational, billing, legal, or security communications
- interact with Verification Packages, Verification Reports, or Public Verification URLs

Where a business customer uses PROOVRA as the controller of uploaded content, PROOVRA may also act as a processor on that customer's behalf for certain processing activities. The processor relationship is governed by the Data Processing Addendum (DPA).

## 3. CATEGORIES OF PERSONAL DATA

Depending on how you use the Services, we may process the following categories.

### Account and Identity Data
- name
- email address
- account identifiers
- authentication-related data (password hashes, MFA secrets where enabled, SSO/SAML/SCIM identifiers)
- team, workspace, and organizational role data
- legal acceptance records (Terms of Service, DPA, Acceptable Use Policy, Cookie Policy)
- cookie preference records where linked to an authenticated account

### Evidence and User Content
- uploaded files (photos, videos, audio, documents, and related materials)
- optional metadata associated with evidence
- timestamps, file type, and file size
- device and capture-related metadata where available
- optional geolocation metadata where enabled by the user

### Integrity and Verification Data
- file hashes (typically SHA-256 fingerprints)
- fingerprint hashes
- digital signatures
- signing-key references (including AWS KMS key identifiers where configured)
- custody event records (hash-chained log of platform actions)
- timestamp metadata (RFC 3161 trusted timestamps where configured; OpenTimestamps anchoring state where available)
- Verification Reports
- Verification Package manifests and embedded metadata
- related technical verification materials

### Technical and Usage Data
- IP address
- device and browser information
- logs
- request metadata
- service diagnostics
- crash or error information
- security and access events
- behavioural-style telemetry strictly used for reliability, security, and abuse prevention (no advertising profiling)

### Billing and Transaction Data
- billing identifiers
- plan and subscription information
- transaction metadata
- payment provider references (payment card data is processed by our payment providers and is not stored by PROOVRA in its native form)

### Communications Data
- support requests
- legal requests
- abuse reports
- privacy requests and data-subject communications
- security reports
- other communications sent to us

### AI-Assisted Workflow Data (where enabled)
- structured metadata, record identifiers, case context, custody-event types, and verification result codes that may be passed to AI features where AI assistance is enabled for a workspace
- AI features in PROOVRA are advisory only. They are designed to operate primarily on metadata and structured operational context. They do not by themselves determine factual truth, authorship, identity, intent, liability, or legal admissibility. See Section 11 and the AI Use Policy.

## 4. PURPOSES OF PROCESSING

We may process personal data for the following purposes:

- providing and operating the Services
- creating and managing user accounts, teams, workspaces, and organizational structures
- authenticating users (including SSO, SAML, SCIM, MFA where enabled)
- storing and processing evidence records
- generating hashes, signatures, custody logs, reports, timestamps, and verification outputs
- enabling Verification Reports, Verification Packages, and Public Verification URLs
- enabling evidence review, case workflows, reviewer assignments, and collaboration features
- maintaining Chain of Custody and audit trail records
- processing billing and subscriptions
- providing support
- maintaining legal acceptance records and policy version records
- storing cookie preference records where applicable
- monitoring reliability, detecting errors, debugging, and improving the Services
- maintaining security, preventing abuse, fraud, and unauthorized access
- complying with legal obligations
- establishing, exercising, or defending legal claims
- responding to government, regulatory, law-enforcement, abuse, and privacy requests where required or permitted by law

## 5. LEGAL BASES

Where GDPR applies, we may rely on one or more of the following legal bases:

- **Article 6(1)(b) GDPR** — processing necessary for performance of a contract, or to take steps at your request before entering a contract
- **Article 6(1)(c) GDPR** — processing necessary for compliance with legal obligations to which PROOVRA is subject
- **Article 6(1)(f) GDPR** — processing necessary for legitimate interests pursued by PROOVRA or by a third party, including platform security, fraud prevention, service reliability, product improvement, legal acceptance traceability, evidence-integrity preservation, and legal risk management. Where this basis is used, PROOVRA seeks to balance these interests against the rights and freedoms of the data subject
- **Article 6(1)(a) GDPR** — consent, where required, including for optional cookies or similar technologies and for any optional processing clearly disclosed at the point of collection

Where special categories of personal data are uploaded by users (for example, health, biometric, or other sensitive content embedded in evidence material), the lawful basis for such upload generally remains the responsibility of the user or customer controlling that content. PROOVRA's role with respect to such content is described in Section 13.

## 6. COOKIES AND SIMILAR TECHNOLOGIES

We may use cookies and similar technologies for:

- authentication
- session continuity
- security
- preference storage
- service performance
- analytics and diagnostics, where enabled and consented to where required

Where required by applicable law, non-essential cookies or similar technologies are used only after obtaining valid consent. Users may manage optional cookie choices through the cookie preference center where implemented. Please review our Cookie Policy for the cookie inventory, categorization, and consent withdrawal process.

## 7. DISCLOSURES AND RECIPIENTS

We may disclose personal data to:

- infrastructure, hosting, storage, and database providers
- authentication providers (including OAuth providers such as Google and Apple where used)
- payment providers (including Stripe and similar providers where used)
- monitoring, logging, error-reporting, and email-delivery providers
- legal, security, or professional advisors where necessary
- competent authorities where legally required (see Law Enforcement Request Policy)
- business counterparties in connection with lawful business transfers, restructurings, mergers, or acquisitions, subject to appropriate safeguards and continuity of this Privacy Policy

**We do not sell personal data** in the ordinary meaning of that term. We do not provide personal data to third parties for cross-context behavioural advertising.

## 8. SUBPROCESSORS

We may engage subprocessors and service providers to operate the Services. The Subprocessors page lists the current set of subprocessors, the purpose of each engagement, the categories of personal data they may process, the locations or regions where processing takes place, and the relevant transfer mechanism.

PROOVRA seeks to impose appropriate contractual data protection obligations on subprocessors, including confidentiality obligations and technical and organizational measures consistent with the DPA.

## 9. INTERNATIONAL DATA TRANSFERS

Some PROOVRA processing — including processing performed by certain subprocessors — may involve transfer of personal data outside the European Economic Area (EEA), United Kingdom, or Switzerland.

Where transfers of personal data take place to a country that has not been recognised by the European Commission (or the UK or Swiss equivalent) as providing an adequate level of protection, PROOVRA seeks to rely on appropriate safeguards required by applicable law, which may include:

- **Standard Contractual Clauses (SCCs)** approved by the European Commission, including the EU 2021/914 modules where applicable
- the **UK International Data Transfer Addendum** where the UK GDPR applies
- the **EU-US Data Privacy Framework (DPF)** for transfers to certified recipients, where applicable
- supplementary technical and organizational measures where assessed as required following a transfer impact assessment
- other lawful transfer mechanisms recognised under applicable law

PROOVRA may make additional transfer documentation available to enterprise customers on reasonable request, subject to confidentiality.

## 10. RETENTION

We retain personal data only for as long as reasonably necessary for the purposes described in this policy, except where longer retention is justified by legal obligations, security requirements, fraud prevention, dispute handling, or evidence-integrity preservation needs.

Please see the Data Retention Policy for category-level retention guidance and the interaction between deletion requests and evidence-integrity records.

## 11. AI-ASSISTED PROCESSING

Where AI features are enabled in a PROOVRA workspace, the following principles apply.

- **Advisory only.** AI inside PROOVRA is advisory. It does not determine factual truth, authorship, identity, intent, liability, or legal admissibility, and it does not issue forensic conclusions.
- **Metadata-first.** AI processing in PROOVRA's first iteration operates primarily on operational metadata, structured workspace context, custody-event types, verification result codes, and reviewer assignment metadata. Processing of evidence content (uploaded files, captured material, embedded media) by AI features is not enabled by default and, where introduced, is clearly disclosed at the workspace level and requires workspace authorization.
- **No training on customer evidence content.** PROOVRA does not use customer evidence content to train general-purpose AI models. Where third-party AI providers are used, PROOVRA configures those providers to disable training on customer content where the provider supports such configuration.
- **Aggregated metrics.** Aggregated, de-identified operational metrics may be used to maintain, secure, and improve the Services.
- **Human review.** Decisions that affect a case, claim, workspace policy, retention outcome, legal hold, or external stakeholder are not made automatically by AI. AI may surface suggestions; the operator or reviewer remains the decision-maker.
- **Availability.** AI assistance is not guaranteed to be available at all times. When AI is unavailable, verification, custody, reporting, and reviewer workflows continue to operate without AI.

See the AI Use Policy for the full set of AI commitments and limitations.

## 12. SECURITY MONITORING, FRAUD PREVENTION, AND VERIFICATION ARTIFACTS

PROOVRA processes certain personal data for the legitimate interests of platform security and integrity, including:

- access logs and authentication telemetry, used for intrusion detection, abuse prevention, and account-recovery security
- request metadata, used to identify automated abuse, credential stuffing, and platform misuse
- verification artifacts (hashes, signatures, custody-event records, timestamp metadata, Verification Reports, Verification Package manifests), used to preserve the integrity of completed evidence records and to support reviewer inspection
- fraud prevention signals associated with billing, account creation, and high-risk operations

Because verification artifacts are the foundation of the platform's evidence-integrity model, they may be retained on a separate retention cadence from the underlying user-facing content. See the Data Retention Policy.

## 13. BUSINESS CUSTOMERS AND CONTROLLER / PROCESSOR ROLES

Depending on the circumstances, PROOVRA may act as:

- a **controller** for website, account, billing, support, legal acceptance logging, cookie preference records associated with account use, certain platform security processing, and direct marketing communications where applicable
- a **processor** for evidence content and related customer-controlled data processed on behalf of a customer organization

### 13.1 Customer Controller Responsibilities

Where the customer is the controller for uploaded content, the customer is responsible for:

- establishing the lawful basis for collecting and processing that content
- providing required notices to data subjects whose data appears in uploaded material
- obtaining required consents where applicable (for example, recording or surveillance consent under local law)
- handling data-subject requests relating to that customer-controlled content
- assigning workspace permissions, retention configuration, legal hold, and deletion outcomes
- ensuring uploaded content does not contain unlawful, abusive, or unauthorised material

### 13.2 Uploaded Third-Party Personal Data

Where a user uploads evidence containing third-party personal data (for example, recordings of identifiable individuals), the user or the customer remains responsible for the lawful basis of that processing. PROOVRA's role is to provide the platform; PROOVRA does not independently establish or verify the lawful basis for content uploaded by users.

### 13.3 Enterprise Customer Obligations

Enterprise customers using SSO, SAML, SCIM, or workspace governance features are responsible for the security and accuracy of identity data they provision into the platform, for the assignment of admin roles, and for the configuration of retention, legal hold, sharing, and disclosure controls within their workspace.

### 13.4 Processor / Controller Examples

| Scenario | PROOVRA acts as |
|---|---|
| Website visitor, account creation, billing, support, security telemetry | controller |
| Cookie preference records linked to a PROOVRA account | controller |
| Direct PROOVRA marketing emails (where applicable) | controller |
| Evidence files uploaded into a customer workspace | processor (on behalf of the customer controller) |
| Custody events generated by platform actions on customer content | processor |
| Verification Reports rendered from customer evidence records | processor |
| AI-assisted features operating on customer evidence context (where enabled) | processor |

The DPA governs the processor relationship and includes the appendices that describe processing activities, security measures, subprocessors, transfers, and audit rights.

## 14. DATA SUBJECT RIGHTS

Where applicable under GDPR, UK GDPR, the German Federal Data Protection Act (BDSG), or similar privacy laws, you may have the following rights:

- **Access** to your personal data
- **Rectification** of inaccurate or incomplete personal data
- **Erasure** of personal data (subject to retention exceptions in Section 10 and Section 15)
- **Restriction** of processing
- **Objection** to processing, including objection to processing based on legitimate interests
- **Data portability**, where applicable
- **Withdrawal of consent** where processing is based on consent (without affecting the lawfulness of processing already carried out)
- the right to lodge a complaint with a competent supervisory authority

### 14.1 Data Subject Request Workflow

To exercise these rights, please contact **privacy@proovra.com** with:

- a clear description of the right you are exercising
- enough information to identify your personal data (such as the email address used with PROOVRA)
- where applicable, the workspace, account, or context the request relates to

### 14.2 Identity Verification

To protect the rights of data subjects, PROOVRA may need to verify the identity of the requester before fulfilling certain requests. Verification may include confirming control of an associated email address or providing additional information sufficient to establish a reasonable link to the data subject. PROOVRA will not request more information than is necessary for verification.

### 14.3 Response Time

PROOVRA aims to respond to a valid GDPR request within **one month** of receiving the request and any required verification information. Where a request is complex or PROOVRA receives a large number of requests, this period may be extended by up to two further months where the extension is legally permitted. The requester will be informed of any such extension and the reasons for it.

### 14.4 Extension Circumstances

A response may be extended (within applicable legal limits) where, for example:

- the request involves significant volumes of data spread across multiple workspaces or cases
- identity verification requires additional information
- the request must be routed through a customer controller (see Section 13)
- a legal hold, ongoing investigation, or regulatory obligation applies to the data
- there is a risk that immediate disclosure would compromise the integrity of an evidence record or an active investigation

### 14.5 Customer Workspace Requests

Where the request concerns personal data inside a customer workspace (for example, content uploaded as evidence by a customer), PROOVRA will normally direct the requester to the customer who controls that workspace and will assist the customer as required by the DPA.

### 14.6 Supervisory Authority

If you believe your data protection rights have been infringed, you may lodge a complaint with the competent supervisory authority in the EU/EEA Member State of your habitual residence, place of work, or place of the alleged infringement.

For data subjects in Germany, the competent supervisory authority depends on the federal state. Where the relevant authority is the State Commissioner for Data Protection and Freedom of Information of North Rhine-Westphalia, the authority is:

**Landesbeauftragte für Datenschutz und Informationsfreiheit Nordrhein-Westfalen (LDI NRW)**

Please consult the LDI NRW's published guidance for current contact details and submission instructions.

See the Privacy Requests page for the full request workflow.

## 15. ACCOUNT DELETION, LEGAL HOLD, AND EVIDENCE PRESERVATION

### 15.1 Account Deletion Consequences

Account deletion or cancellation does not automatically delete:

- legal acceptance records reasonably necessary to demonstrate that customers agreed to applicable terms
- billing and tax records that PROOVRA is required to retain by law
- security and audit logs that PROOVRA is required to retain for incident response and compliance
- evidence records, custody events, and verification artifacts subject to a legal hold or workspace retention policy
- records subject to fraud-prevention obligations

### 15.2 Legal Hold Implications

Where a customer applies a legal hold to records inside its workspace, those records may be exempt from individual deletion requests until the legal hold is released by the customer or by a competent authority. PROOVRA will not unilaterally remove records under legal hold without instruction from the customer controller or a legally binding order.

### 15.3 Evidence Preservation Implications

Verification artifacts (hashes, signatures, timestamp metadata, custody events) underpin the integrity model of completed evidence records. Deletion of the underlying user-facing content does not necessarily delete the associated integrity record, because retention of the integrity record may be required for the auditability and reviewability of evidence already shared with external recipients (for example, through Public Verification URLs or Verification Packages). The Data Retention Policy describes how these records are handled.

## 16. DIRECT MARKETING

Where PROOVRA sends direct marketing communications, recipients may unsubscribe at any time using the unsubscribe link in the communication or by contacting privacy@proovra.com. PROOVRA does not sell email addresses to third-party advertisers and does not use evidence content for marketing.

## 17. CHILDREN

The Services are not directed to children under the age required by applicable law for independent consent. Users must not upload unlawful exploitative content involving children, including CSAM. PROOVRA cooperates with competent authorities in accordance with the Law Enforcement Request Policy and applicable law.

## 18. POLICY VERSIONING AND CHANGES

We may update this Privacy Policy from time to time. Material changes will be posted on this page with an updated effective date. Where appropriate, we may maintain internal or user-facing records of accepted legal versions and may request renewed acceptance after material legal updates. The Legal Changelog records material changes to the public legal documents.

## 19. RELATED DOCUMENTS

You may also review:

- Terms of Service
- Cookie Policy
- Data Processing Addendum (DPA)
- Data Retention Policy
- Subprocessors
- Technical and Organizational Measures (TOMs)
- Privacy Requests
- AI Use Policy
- Verification Methodology
- Verification Disclaimer
- Evidence Handling Policy
- Security and Responsible Disclosure
- Incident Response Policy
- Transparency Policy
- Law Enforcement Request Policy
- Acceptable Use Policy
- Legal Changelog
- Trust Center

## 20. CONTACT

For privacy questions or data protection requests:

- **privacy@proovra.com** — primary contact for privacy requests
- **legal@proovra.com** — legal questions and policy review
