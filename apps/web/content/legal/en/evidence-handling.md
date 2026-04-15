# Evidence Handling Policy

Last Updated: 06.04.2026

This document explains how PROOVRA captures, processes, preserves, organizes, and verifies digital materials submitted to the platform.

It is intended to help users, legal professionals, investigators, journalists, insurers, auditors, and enterprise reviewers understand how the platform handles evidence-related materials and supporting review outputs.

## 1. PURPOSE

Proovra is designed to help users preserve digital materials in a way that supports later technical integrity verification.

The platform may provide tools to:

- capture or upload files
- generate cryptographic fingerprints
- record custody events
- generate signatures
- generate reports
- provide verification links
- support later technical review

Proovra does not determine the factual truth of user content.

## 2. EVIDENCE SUBMISSION

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

## 3. PROCESSING AND INTEGRITY ARTIFACTS

During or after processing, Proovra may generate technical artifacts such as:

- file hashes
- fingerprint records
- fingerprint hashes
- digital signatures
- custody event records
- verification outputs
- timestamp-related metadata where enabled
- OpenTimestamps-related metadata where enabled

These artifacts are intended to support tamper detection and subsequent technical review.

## 4. CHAIN OF CUSTODY

The platform is designed to maintain a custody record reflecting important system actions affecting the evidence record.

This may include actions such as:

- creation
- upload
- completion
- signature application
- report generation
- verification activity
- selected status changes

The custody record is designed to support auditability of system-recorded events.

## 5. SIGNATURES, REPORTS, AND VERIFICATION LINKS

Once an evidence item reaches the relevant workflow stage, Proovra may provide:

- digital signatures
- verification reports
- verification links
- structured verification materials

These outputs are intended to support later technical review by authorized recipients.

## 6. STORAGE AND IMMUTABILITY

Depending on the deployed storage configuration, Proovra may apply storage protection controls or preserve metadata relating to storage retention or immutability.

However, storage behavior depends on the actual environment, selected infrastructure, and technical implementation.

## 7. USER CONTROL AND ACCESS

Users remain responsible for:

- controlling access to uploaded content
- deciding who receives reports and verification links
- sharing evidence lawfully
- configuring teams, cases, and permissions appropriately

## 8. IMPORTANT LIMITATIONS

Proovra does **not** independently verify:

- who created the content
- whether the content is truthful
- whether the content was manipulated before submission
- whether metadata supplied by the device is complete or accurate
- whether an authority, court, insurer, or employer will accept a given record as evidence

Those determinations remain external to the platform.

## 9. DELETION, RETENTION, AND PRESERVATION

User-facing deletion and retention behavior may vary by workflow and system design.

In some circumstances, technical integrity artifacts, logs, or reports may remain retained beyond deletion of user-facing content where reasonably necessary for security, legal compliance, fraud prevention, or evidentiary-integrity preservation.

## 10. SECURITY

Proovra uses technical and organizational measures designed to protect evidence-related data and platform operations, but no system can guarantee absolute security.

## 11. CONTACT

For questions regarding evidence handling:

legal@proovra.com