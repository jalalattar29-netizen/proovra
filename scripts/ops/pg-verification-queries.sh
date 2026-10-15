#!/usr/bin/env bash
# =============================================================================
# The verification facts a backup records and a restore drill must reproduce
# (AUD-023). Sourced by pg-backup.sh and pg-restore-drill.sh so both sides ask
# the SAME questions — a drill that computed its facts differently from the
# backup could agree with anything.
# =============================================================================

# One line per table: "<schema>.<table>|<exact row count>", sorted. Ordinary
# and partitioned tables in every non-system schema.
# shellcheck disable=SC2034
PROOVRA_ROW_COUNT_SQL="SELECT format('%s.%s|%s', n.nspname, c.relname,
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp%'
ORDER BY 1;"

# The schema fingerprint: every column (type, nullability, default), every
# index definition and every constraint definition, one sorted line each.
# shellcheck disable=SC2034
PROOVRA_SCHEMA_FINGERPRINT_SQL="SELECT line FROM (
  SELECT format('col|%s.%s.%s|%s|%s|%s', table_schema, table_name, column_name, data_type, is_nullable, coalesce(column_default, '')) AS line
    FROM information_schema.columns
   WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  UNION ALL
  -- A partial index's WHERE predicate is compared by presence only, for the
  -- same deparser reason as CHECK constraints below; the index name, table,
  -- uniqueness, method and key columns compare exactly.
  SELECT format('idx|%s.%s|%s', schemaname, indexname,
                CASE WHEN position(' WHERE ' in indexdef) > 0
                     THEN left(indexdef, position(' WHERE ' in indexdef) - 1) || ' WHERE <predicate>'
                     ELSE indexdef END)
    FROM pg_indexes
   WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL
  -- CHECK expressions are compared by name and kind only: PostgreSQL's
  -- deparser does not round-trip them byte-identically through
  -- dump/restore (ANY(ARRAY[...]::text[]) is re-cast per element), although
  -- they are semantically the same. Keys, uniques and foreign keys compare
  -- their full definitions.
  SELECT format('con|%s.%s|%s|%s', n.nspname, con.conname, con.contype,
                CASE WHEN con.contype = 'c' THEN 'check' ELSE pg_get_constraintdef(con.oid) END)
    FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
) facts ORDER BY line;"
