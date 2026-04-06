# Evidence Verification Methodology

Last Updated: 06.04.2026

This document explains the technical model Proovra uses to preserve and verify digital evidence integrity.

The platform is designed to generate cryptographic and audit-oriented artifacts that allow later technical verification that an evidence record has not been altered after completion, subject to the limitations described below.

## 1. OVERVIEW

At or around evidence completion, Proovra may generate and associate technical artifacts such as:

- cryptographic file hashes
- a canonical fingerprint record
- a fingerprint hash
- platform signature material
- custody event records
- verification reports
- timestamp-related metadata where enabled
- OpenTimestamps-related metadata where enabled

These artifacts are intended to support later tamper detection and technical review.

## 2. FILE HASHING

Proovra may compute a cryptographic hash of the evidence file.

A secure hash function is designed to be deterministic and highly sensitive to any change in the underlying file content. Even a small change to the file should produce a different output hash.

The file hash therefore functions as a technical fingerprint of the file content.

## 3. EVIDENCE FINGERPRINT

In addition to the file hash, Proovra may generate a structured fingerprint record associated with the evidence item.

Depending on the workflow, this may include:

- file hash
- file metadata
- capture or upload timestamps
- platform identifiers
- optional contextual metadata
- other verification-related fields

The fingerprint record may be serialized in a canonical form and hashed to produce a fingerprint hash.

## 4. DIGITAL SIGNATURE

After generation of the fingerprint hash, the platform may apply a digital signature using platform-controlled signing material.

This allows later verification that:

- the signature corresponds to the platform verification key material
- the signed fingerprint hash has not changed since signature generation

## 5. CUSTODY EVENT RECORDS

Proovra maintains a custody timeline designed to record important system actions affecting an evidence record.

Events may include:

- evidence creation
- upload-related actions
- completion
- signature application
- report generation
- verification-related actions
- timestamp or anchoring-related events where applicable

These records are intended to provide an auditable system activity history.

## 6. REPORTS AND VERIFICATION OUTPUTS

Where supported, Proovra may generate reports or verification outputs containing selected integrity materials, including:

- file hash
- fingerprint hash
- signature material
- custody event summaries
- timestamp-related metadata
- storage protection metadata where available

A reviewer may compare the report or verification output with the original file and recompute technical checks.

## 7. WHAT THE SYSTEM IS DESIGNED TO VERIFY

The Proovra verification model is intended to help assess:

- whether the file hash matches the recorded file hash
- whether the fingerprint hash matches the recorded fingerprint data
- whether the signature corresponds to the expected verification material
- whether custody records appear internally consistent
- whether selected timestamp or anchoring metadata is present where enabled

## 8. WHAT THE SYSTEM DOES NOT VERIFY

The platform does **not** independently determine:

- who originally created the content
- whether the content is truthful
- whether the surrounding context is accurate
- whether the content was manipulated before capture or upload
- whether a court or authority will admit the material as evidence

Those questions may require additional investigative, forensic, contractual, and legal analysis.

## 9. INDEPENDENT REVIEW

Technical review may include:

- recomputing the file hash
- reviewing the fingerprint data
- verifying signature material
- reviewing custody event history
- reviewing reports and verification outputs

Independent review may be possible using the technical materials made available by the platform, but successful review depends on the available artifacts and workflow.

## 10. TIMESTAMPS AND ANCHORING

Where enabled, Proovra may include timestamp-related or anchoring-related metadata, including Trusted Timestamp Authority data or OpenTimestamps-related data.

Availability, format, and evidentiary weight of such metadata depend on the enabled feature set, service environment, and the successful completion of the relevant workflow.

## 11. LIMITATIONS

Cryptographic verification demonstrates technical consistency and tamper detection value. It does not, by itself, establish factual authenticity, authorship, legal validity, or admissibility.

## 12. FUTURE DEVELOPMENT

As the platform evolves, verification methods may change or expand. Updated versions of this page may describe new mechanisms as they become operational.