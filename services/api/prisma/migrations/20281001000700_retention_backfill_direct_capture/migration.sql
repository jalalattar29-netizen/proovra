-- UC-ARCH-002 — legacy direct-capture and mobile records receive their workspace's default
-- retention, as every other channel always did.
--
-- Before the UC-ARCH-002 fix only the web POST /v1/evidence route and intake orchestration
-- applied the workspace default retention, so records made by the mobile app, the browser
-- extension and Android/iOS screen capture were created with retention_until_utc NULL and were
-- invisible to retention reconciliation. createEvidence now applies it for every channel; this
-- backfill gives the records made before that the same date: created_at + the workspace's
-- default_retention_days.
--
-- WHAT IT CHANGES: only rows with retention_until_utc IS NULL, not deleted, in a workspace whose
-- policy sets default_retention_days > 0, of the five channels that were skipped. Never shortens
-- or overrides an existing date. The retention sweeper only FLAGS expired rows for triage (it
-- never deletes; held records are skipped), so a backfilled date that is already in the past
-- surfaces the record to operators — that is the policy the workspace configured.
--
-- BACKFILL / OWNER_ACTION_AFTER_BACKUP. Idempotent (conditioned on NULL). Irreversible only in
-- the sense that the previous NULL is not recorded; ROLLBACK: set retention_until_utc back to
-- NULL for these channels where it equals created_at + the policy days.
UPDATE "evidence" AS e
   SET "retention_until_utc" = e."created_at" + make_interval(days => p."default_retention_days")
  FROM "workspace_governance_policies" AS p
 WHERE p."team_id" = e."team_id"
   AND p."default_retention_days" > 0
   AND e."retention_until_utc" IS NULL
   AND e."deleted_at" IS NULL
   AND e."acquisition_mode" IN (
     'PROOVRA_MOBILE_APP',
     'DIRECT_WEB_CAPTURE_EXTENSION',
     'DIRECT_SCREEN_CAPTURE_ANDROID',
     'DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS',
     'DIRECT_SCREEN_CAPTURE_IOS'
   );
