-- Settings remediation (2026-07-17) — explicit notification-timezone
-- inheritance.
--
-- `notification_schedule_settings.timezone` becomes NULLABLE:
--   NULL      = no explicit workspace override; the digest scheduler
--               inherits the account timezone (users.timezone) → UTC.
--   non-null  = an EXPLICIT per-workspace override.
--
-- Constraint relaxation only (no object removals): DROP NOT NULL +
-- DROP DEFAULT, then a restrictive idempotent backfill that converts the
-- old implicit column default ('UTC', written for every row created
-- before this change regardless of user intent) into NULL so those rows
-- inherit the account timezone instead of silently overriding it with
-- UTC. Rows carrying a real user-chosen timezone are untouched. Re-runs
-- are no-ops (no 'UTC' rows remain after the first application).

ALTER TABLE "notification_schedule_settings"
    ALTER COLUMN "timezone" DROP NOT NULL;

ALTER TABLE "notification_schedule_settings"
    ALTER COLUMN "timezone" DROP DEFAULT;

UPDATE "notification_schedule_settings"
    SET "timezone" = NULL
    WHERE "timezone" = 'UTC';
