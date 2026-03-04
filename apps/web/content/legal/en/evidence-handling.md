# Evidence Handling Policy – Proovra

Last Updated: 08.02.2026

This document explains how Proovra captures, processes, preserves, and verifies digital materials submitted to the platform.

This policy is intended to help users, investigators, journalists, legal professionals, and courts understand how evidence integrity is maintained within the Proovra system.

## 1. PURPOSE

Proovra is designed to help users capture and preserve digital materials in a way that allows later verification of their integrity.

The platform provides tools to:

- capture or upload files
- generate cryptographic fingerprints
- record custody events
- produce verification reports
- enable independent verification

Proovra does not determine the factual truth of any content.

## 2. EVIDENCE SUBMISSION

Users may submit materials including:

- photographs
- video recordings
- documents
- other digital files

At the time of submission, the system may record metadata such as:

- timestamp
- file size
- file type
- device metadata (if available)
- optional location data (if enabled by the user)

## 3. CRYPTOGRAPHIC FINGERPRINTING

When evidence is processed, Proovra generates cryptographic artifacts including:

- SHA-256 file hash
- canonical fingerprint record
- fingerprint hash
- system signature

These artifacts allow later verification that the stored file has not been modified.

## 4. CHAIN OF CUSTODY

The platform records custody events including actions such as:

- upload
- verification
- signature generation
- report creation

Each event includes a timestamp and event type.

The custody log is designed to provide an auditable sequence of system actions.

## 5. SIGNATURES AND VERIFICATION

When evidence is completed, Proovra may generate:

- digital signatures
- integrity reports
- verification links
- cryptographic artifacts

These outputs allow independent verification of evidence integrity.

However, signatures confirm **data integrity only**, not authorship or factual accuracy.

## 6. EVIDENCE IMMUTABILITY

Once an evidence record is finalized:

- hashes cannot be modified
- signatures cannot be altered
- custody logs are preserved

If a user deletes their account, integrity artifacts may remain retained to preserve verification capability.

## 7. LIMITATIONS

Proovra does not:

- verify who created the content
- verify where content was recorded unless metadata exists
- determine whether content is truthful
- provide legal certification of evidence

Admissibility of evidence is determined by courts or competent authorities.

## 8. INDEPENDENT VERIFICATION

Anyone with access to the report or verification link may independently verify integrity by:

1. downloading the original file
2. computing the SHA-256 hash
3. comparing it with the hash listed in the report
4. validating the digital signature

## 9. SECURITY AND STORAGE

Proovra implements safeguards including:

- encrypted transport
- controlled access
- audit logging
- key management practices

No system can guarantee absolute security.

## 10. CONTACT

For questions regarding evidence handling:

legal@proovra.com