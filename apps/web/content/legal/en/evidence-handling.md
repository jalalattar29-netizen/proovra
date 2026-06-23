# Evidence Handling Policy

Last Updated: 2026-06-23

This document explains how PROOVRA captures, processes, preserves, organizes, and verifies digital materials submitted to the platform.

It is intended to help users, legal professionals, investigators, journalists, insurers, auditors, and enterprise reviewers understand how the platform handles evidence-related materials and supporting review outputs.

This page is read together with the Verification Methodology, the Verification Disclaimer, the Privacy Policy, the Data Retention Policy, the Technical and Organizational Measures (TOMs), the Security and Responsible Disclosure policy, the AI Use Policy, and the Trust Center.

## 1. PURPOSE

PROOVRA is designed to help users preserve digital materials in a way that supports later technical integrity verification.

The platform may provide tools to:

- capture or upload supported files
- generate cryptographic fingerprints
- record custody events
- generate digital signature material
- generate Verification Reports and Verification Packages
- provide Public Verification URLs for reviewer-facing access
- support later technical review of recorded material

PROOVRA does not determine the factual truth of user content. PROOVRA does not act as a court, regulator, forensic-investigation authority, or legal-advice provider.

## 2. EVIDENCE LIFECYCLE OVERVIEW

The table below summarizes how material may move through the platform. Not every stage applies to every workflow; some stages depend on plan, configuration, region, and customer choice.

| Stage | What may happen | Main records created | Important limitation |
|---|---|---|---|
| Capture / Upload | User captures or uploads supported material | Upload metadata, file metadata, intake context | PROOVRA does not verify pre-capture truth or lawful provenance |
| Intake / Organization | Material is associated with a workspace, case, matter, claim, or review context | Case / workspace identifiers, user and team context | The customer or user remains responsible for lawful collection and classification |
| Processing | The platform processes the submitted material for storage and technical review | Processing status, file type, file size, technical metadata | Processing does not mean factual validation |
| Fingerprinting | Cryptographic hashes and fingerprint records may be generated | SHA-256 hash, structured fingerprint record, fingerprint hash | Hashing detects later change; it does not prove original truth |
| Signing | The platform may apply digital signature material where configured | Signature record, signing-key reference | Signature confirms platform-recorded integrity material, not real-world authenticity |
| Timestamp / Anchoring | RFC 3161 or OpenTimestamps context may be attached where configured or available | Timestamp token, anchoring status, related metadata | Availability depends on configured services and successful workflow completion |
| Custody Logging | Platform actions are recorded as custody events | Hash-chained custody events, actor / time / action metadata | Custody log records platform activity, not every real-world handoff outside PROOVRA |
| Review / Verification | Reviewers may inspect Verification Reports, Verification Packages, or Public Verification URLs | Report, package, reviewer-access events | Review surfaces do not determine admissibility or truth |
| Retention / Legal Hold | Records may be retained, deleted, or placed under legal hold depending on customer settings and legal requirements | Retention status, legal-hold status, audit events | Deletion may be limited by legal, security, fraud, or integrity-preservation needs |
| Deletion / Export | User-facing content may be deleted or exported where supported | Deletion and export records, remaining integrity or audit artifacts where justified | Some logs or artifacts may remain where legally or operationally necessary |

## 3. EVIDENCE FILE VS EVIDENCE RECORD

PROOVRA distinguishes between the original material and the structured record around it.

- **Evidence File** — the original uploaded or captured material (photo, video, document, audio, export, or other supported file).
- **Evidence Record** — a structured platform record around the Evidence File, including hashes, metadata, custody events, signature context, timestamp or anchoring context, governance context, and reviewer-facing outputs.

Verification materials describe what PROOVRA recorded around the Evidence File. They do not certify factual truth, authorship, identity, intent, lawful provenance, or admissibility. See the Verification Methodology for the full artifact model.

## 4. EVIDENCE SUBMISSION

Users may submit materials such as:

- photographs
- videos
- documents
- audio files
- other digital files supported by the platform

Depending on the workflow, the system may also record associated metadata such as:

- upload or capture time
- file type
- file size
- device-related metadata where available
- optional location metadata where enabled by the user
- technical processing metadata

## 5. CUSTOMER AND USER RESPONSIBILITY

Users and customers are responsible for:

- having a lawful basis for capture and upload
- obtaining consent where required (including under recording, surveillance, and workplace privacy laws)
- compliance with privacy and personality rights
- compliance with intellectual-property rights
- deciding whether location or device metadata should be collected
- configuring access, sharing, retention, and legal-hold settings appropriate to their workflow
- evaluating whether evidence should be used in a legal, employment, insurance, regulatory, journalistic, or investigative process
- ensuring that uploaded material does not contain prohibited content under the Acceptable Use Policy

The user or customer, not PROOVRA, remains the controller of the underlying material in most workflows.

## 6. PROCESSING AND INTEGRITY ARTIFACTS

During or after processing, PROOVRA may generate technical artifacts such as:

- SHA-256 file hashes
- structured fingerprint records
- fingerprint hashes
- digital signatures
- hash-chained custody event records
- Verification Reports and Verification Packages
- timestamp-related metadata where enabled (RFC 3161)
- OpenTimestamps-related metadata where enabled

These artifacts are intended to support tamper detection and subsequent technical review. See the Verification Methodology for the technical model and the Verification Disclaimer for the scope of what these artifacts do and do not establish.

## 7. METADATA HANDLING

PROOVRA may record technical metadata associated with the Evidence Record, including:

- file size
- MIME type / content type
- SHA-256 hash values
- intake and capture timestamps
- device or capture context where available
- upload source
- user, workspace, case, and reviewer identifiers
- custody event types
- verification result codes and status

Optional geolocation metadata is recorded only where enabled or user-provided. Device-supplied metadata may be incomplete, unavailable, modified before upload, or controlled by the originating device or app. PROOVRA does not guarantee metadata completeness or real-world accuracy.

## 8. CHAIN OF CUSTODY

The platform maintains a hash-chained custody record reflecting important system actions affecting the Evidence Record.

This may include actions such as:

- creation
- upload
- completion
- signature application
- report or package generation
- verification activity
- selected status changes
- legal-hold or retention status changes

The custody record is designed to support auditability of system-recorded events. It does not represent every real-world handoff that may occur outside PROOVRA.

## 9. STORAGE AND PRESERVATION

Storage may use configured infrastructure and subprocessors (see the Subprocessors page for the current set). Object-storage controls (including retention and immutability features such as Object Lock) may be applied where configured for the deployment; not every deployment has the same storage controls. Preservation metadata may be surfaced on Verification Reports where available.

Legal hold may pause deletion where supported and configured. Storage controls support technical integrity preservation; they do not, by themselves, prove content truth or admissibility.

## 10. SHARING AND REVIEWER ACCESS

Reports, Public Verification URLs, and Verification Packages may be shared with reviewers, counsel, experts, insurers, auditors, or other authorized recipients.

Customers and users control who receives access, subject to platform configuration. Public Verification URLs may be tokenized, revoked, expired, or restricted where supported by the surface. Sharing material outside PROOVRA may create operational and legal responsibility for the sharing customer or user.

## 11. SIGNATURES, REPORTS, AND VERIFICATION LINKS

Once an evidence item reaches the relevant workflow stage, PROOVRA may provide:

- digital signature material
- Verification Reports
- Verification Packages
- Public Verification URLs
- structured verification materials for reviewer use

These outputs are intended to support later technical review by authorized recipients. They are not, by themselves, determinations of legal admissibility, court acceptance, or factual truth.

## 12. DELETION, RETENTION, AND INTEGRITY ARTIFACTS

User-facing deletion may remove visible content or revoke access. Certain logs, custody records, legal-acceptance records, verification artifacts, or security records may be retained beyond deletion of user-facing content where reasonably necessary for:

- legal compliance
- fraud prevention
- security and abuse handling
- dispute handling
- auditability
- evidence-integrity preservation

See the Data Retention Policy for the full retention framework.

## 13. SECURITY

PROOVRA uses technical and organizational measures designed to protect evidence-related data and platform operations. See the Security and Responsible Disclosure policy and the Technical and Organizational Measures (TOMs) for the operational measures, and the Incident Response Policy for incident handling. No system can guarantee absolute security; PROOVRA seeks to apply layered protections appropriate to the workflow.

## 14. AI-ASSISTED PROCESSING

Where AI features are enabled for the workspace, AI assistance is advisory only and metadata-first by design. Customer evidence content is not sent to AI providers by default and is not used to train general-purpose AI models. See the AI Use Policy for the full position on AI.

## 15. WHAT PROOVRA DOES NOT DO

PROOVRA does not:

- investigate facts
- determine whether a depicted event happened
- determine who created the content
- determine whether a person consented to recording
- determine legal admissibility, evidentiary weight, or court acceptance
- provide legal advice
- guarantee that metadata is complete, accurate, or unmodified before upload
- guarantee that a court, regulator, insurer, employer, platform, or counterparty will accept a record

Those determinations remain external to the platform and may require independent legal, expert, or procedural analysis.

## 16. RELATED DOCUMENTS

- Verification Methodology
- Verification Disclaimer
- Privacy Policy
- Data Retention Policy
- Technical and Organizational Measures (TOMs)
- Security and Responsible Disclosure
- Incident Response Policy
- Acceptable Use Policy
- AI Use Policy
- Subprocessors
- Trust Center

## 17. CONTACT

For questions regarding evidence handling: **legal@proovra.com**
