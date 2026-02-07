# Backup & Recovery (Proovra)

This document describes the recommended backup and restore procedures for the
Proovra production database. It is documentation only; no automation is added
in this phase.

## Daily Backup (Logical)

- Frequency: daily.
- Type: logical dump (PostgreSQL).
- Retention: 7–30 days.
- Storage: encrypted object storage or secure backup vault.

Example (logical dump):

```
pg_dump "$DATABASE_URL" --format=custom --file=backup-$(date -u +%F).dump
```

## Restore Procedure

1. Provision a new PostgreSQL instance (or use the target restore instance).
2. Verify the target instance is empty or restore into a dedicated database.
3. Restore the most recent verified backup.

Example (restore):

```
pg_restore --dbname="$DATABASE_URL" --clean --if-exists backup-YYYY-MM-DD.dump
```

## Notes

- Backups should be encrypted at rest.
- Test restores on a schedule to validate backup integrity.
- Store restore logs for audit purposes.
