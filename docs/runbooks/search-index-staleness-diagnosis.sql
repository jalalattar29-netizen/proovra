-- =============================================================================
-- SEARCH INDEX — PRODUCTION DIAGNOSIS (READ ONLY)
-- =============================================================================
--
-- Every statement here is a SELECT. Nothing is created, updated or deleted.
-- Safe to run on production during business hours; the heaviest query is a
-- LEFT JOIN over `evidence` and `evidence_search_documents`.
--
-- WHAT IT ANSWERS
--
--   1. how many records search cannot see at all      (missing documents)
--   2. how many records search sees but answers WRONGLY about (stale
--      documents — a document written before External Intake identity was
--      added to the projection, which reports success and finds nothing)
--   3. for ONE named record, which layer actually failed
--
-- HOW TO RUN
--
--   docker compose exec -T postgres psql -U <user> -d dw -f - < \
--     docs/runbooks/search-index-staleness-diagnosis.sql
--
-- or paste the sections individually.
--
-- NOTE ON STALENESS DETECTION. After migration 20280401000000 the answer is
-- simply `projection_version < 2`. This file deliberately does NOT depend on
-- that column, because the point is to measure production BEFORE the migration
-- is deployed. It detects staleness the only way available today: a document
-- whose source has an identity value that the document's own body does not
-- contain.
--
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. COVERAGE — is the index complete at all?
-- -----------------------------------------------------------------------------
\echo '=== 1. COVERAGE (per workspace) ==='

SELECT
  e.team_id,
  count(*)                                   AS eligible_evidence,
  count(esd.id)                              AS documents,
  count(*) - count(esd.id)                   AS missing_documents,
  round(100.0 * count(esd.id) / nullif(count(*), 0), 1) AS coverage_pct
FROM evidence e
LEFT JOIN evidence_search_documents esd
       ON esd.team_id       = e.team_id
      AND esd.document_type = 'EVIDENCE'
      AND esd.source_id     = e.id
WHERE e.lifecycle_state NOT IN ('DESTROYED', 'PENDING_DESTRUCTION')
GROUP BY e.team_id
ORDER BY missing_documents DESC, eligible_evidence DESC;


-- -----------------------------------------------------------------------------
-- 2. STALENESS — does the document contain the identity its source has?
--
-- This is the production failure. A record whose intake link carries a
-- Customer ID or a phone number, whose search document EXISTS, and whose
-- document body does not contain that value, was indexed before the identity
-- fields were added to the projection. No reindex in the product could repair
-- it: the sweep only ever looked for evidence with NO document.
-- -----------------------------------------------------------------------------
\echo '=== 2. STALE DOCUMENTS (identity present at source, absent from document) ==='

WITH ident AS (
  SELECT
    e.id,
    e.team_id,
    e.intake_customer_id                    AS snapshot_customer_id,
    l.customer_id,
    l.recipient_phone_e164                  AS phone,
    l.recipient_email                       AS email
  FROM evidence e
  JOIN workflow_intake_sessions s ON s.evidence_id   = e.id
  JOIN workflow_intake_links    l ON l.id            = s.intake_link_id
  WHERE e.lifecycle_state NOT IN ('DESTROYED', 'PENDING_DESTRUCTION')
)
SELECT
  i.team_id,
  count(*)                                                                      AS intake_records,
  count(*) FILTER (WHERE i.customer_id IS NOT NULL)                             AS src_has_customer_id,
  count(*) FILTER (WHERE i.phone       IS NOT NULL)                             AS src_has_phone,
  -- never indexed at all
  count(*) FILTER (WHERE d.id IS NULL)                                          AS document_missing,
  -- indexed, but the body predates the identity fields
  count(*) FILTER (
    WHERE d.id IS NOT NULL AND i.customer_id IS NOT NULL
      AND position(i.customer_id IN coalesce(d.searchable_text, '')) = 0
  )                                                                             AS stale_no_customer_id,
  count(*) FILTER (
    WHERE d.id IS NOT NULL AND i.phone IS NOT NULL
      AND position(i.phone IN coalesce(d.searchable_text, '')) = 0
  )                                                                             AS stale_no_phone,
  -- the Evidence-list surface reads this snapshot column, not the link
  count(*) FILTER (
    WHERE i.customer_id IS NOT NULL AND i.snapshot_customer_id IS NULL
  )                                                                             AS snapshot_never_written
FROM ident i
LEFT JOIN evidence_search_documents d
       ON d.team_id       = i.team_id
      AND d.document_type = 'EVIDENCE'
      AND d.source_id     = i.id
GROUP BY i.team_id
ORDER BY stale_no_customer_id DESC, stale_no_phone DESC;


-- -----------------------------------------------------------------------------
-- 3. AGE OF THE INDEX — when were the stale documents written?
--
-- If the stale documents all pre-date the deploy that added intake identity to
-- the projection, the diagnosis is confirmed: this is a data-repair problem,
-- not a query problem.
-- -----------------------------------------------------------------------------
\echo '=== 3. WHEN WERE DOCUMENTS LAST WRITTEN ==='

SELECT
  date_trunc('day', indexed_at_utc) AS indexed_day,
  count(*)                          AS documents
FROM evidence_search_documents
WHERE document_type = 'EVIDENCE'
GROUP BY 1
ORDER BY 1 DESC
LIMIT 30;


-- -----------------------------------------------------------------------------
-- 4. ONE RECORD, EVERY LAYER
--
-- Replace the reference below with the eight characters Operations printed —
-- e.g. from "RFC3161 timestamp missing for record 76b5d6ac".
--
-- Reads as: source data present? document present? field in document?
-- -----------------------------------------------------------------------------
\echo '=== 4. SINGLE RECORD TRACE (edit the reference below) ==='

\set record_ref '76b5d6ac'

SELECT
  e.id                                                        AS evidence_id,
  e.team_id,
  e.lifecycle_state,
  e.capture_method,
  -- SOURCE DATA PRESENT?
  (e.intake_customer_id IS NOT NULL)                          AS snapshot_customer_id_present,
  (l.customer_id        IS NOT NULL)                          AS link_customer_id_present,
  (l.recipient_phone_e164 IS NOT NULL)                        AS link_phone_present,
  (l.recipient_email    IS NOT NULL)                          AS link_email_present,
  -- SEARCH DOCUMENT PRESENT?
  (d.id IS NOT NULL)                                          AS document_present,
  d.indexed_at_utc,
  d.source_updated_at_utc,
  length(coalesce(d.searchable_text, ''))                     AS document_body_chars,
  -- FIELD PRESENT IN DOCUMENT?
  (l.customer_id IS NOT NULL
     AND position(l.customer_id IN coalesce(d.searchable_text, '')) > 0)
                                                              AS document_has_customer_id,
  (l.recipient_phone_e164 IS NOT NULL
     AND position(l.recipient_phone_e164 IN coalesce(d.searchable_text, '')) > 0)
                                                              AS document_has_phone,
  (l.recipient_email IS NOT NULL
     AND position(l.recipient_email IN coalesce(d.searchable_text, '')) > 0)
                                                              AS document_has_email
FROM evidence e
LEFT JOIN workflow_intake_sessions s ON s.evidence_id = e.id
LEFT JOIN workflow_intake_links    l ON l.id          = s.intake_link_id
LEFT JOIN evidence_search_documents d
       ON d.team_id       = e.team_id
      AND d.document_type = 'EVIDENCE'
      AND d.source_id     = e.id
WHERE e.id >= (:'record_ref' || '-0000-0000-0000-000000000000')::uuid
  AND e.id <= (:'record_ref' || '-ffff-ffff-ffff-ffffffffffff')::uuid;


-- -----------------------------------------------------------------------------
-- 5. AFTER THE FIX IS DEPLOYED — the same question, cheaply.
--
-- Once migration 20280401000000 has been applied, staleness is a column and
-- this is the query to watch while the reindex runs. It will error with
-- "column projection_version does not exist" until then, which is the correct
-- answer to "has the fix been deployed yet?".
-- -----------------------------------------------------------------------------
\echo '=== 5. PROJECTION VERSION (post-deploy only; errors before it) ==='

SELECT team_id, projection_version, count(*) AS documents
FROM evidence_search_documents
WHERE document_type = 'EVIDENCE'
GROUP BY team_id, projection_version
ORDER BY team_id, projection_version;
