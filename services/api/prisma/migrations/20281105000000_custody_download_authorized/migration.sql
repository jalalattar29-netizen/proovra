-- CUSTODY: DOWNLOAD AUTHORIZED (EVID-006, EVID-008, 2026-11-05).
-- Additive only: one enum value.
--
-- Report, package and original downloads are served by a presigned URL, so the
-- API sees the URL issued and never the bytes move. EVIDENCE_DOWNLOADED,
-- REPORT_DOWNLOADED and VERIFICATION_PACKAGE_DOWNLOADED were written at that
-- moment, so a custody chain claimed downloads nobody performed. New URL
-- issuance appends DOWNLOAD_AUTHORIZED instead, the same correction
-- UPLOAD_AUTHORIZED made for uploads. The three older types stay: historical
-- rows are never rewritten, and REPORT_DOWNLOADED still records a report the API
-- streamed in full.
--
-- Its own migration, deliberately: a value added by ALTER TYPE cannot be used
-- in the transaction that adds it.

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'DOWNLOAD_AUTHORIZED';
