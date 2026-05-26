-- =============================================================================
-- Phase E3.2 — Secure Webhook Delivery Boundary
--
-- Closes DEF-022. Adds:
--
--   * automation_webhook_destinations  — team-scoped, HTTPS-only,
--     allowlisted webhook endpoints.
--   * automation_webhook_deliveries    — per-attempt delivery audit
--     with idempotency, retry-ready model.
--
-- Also extends the action-type CHECK constraint on automation_rules to
-- include WEBHOOK_DELIVERY_INTERNAL_ONLY. The TS allowlist in
-- automation.service.ts is updated in lockstep.
--
-- Hard rules (also enforced by the service layer + tests):
--   - HTTPS-only destinations (validated at create + before send).
--   - SSRF protection: localhost / private IP / metadata service IPs
--     blocked at create + before send (DNS rebinding defence).
--   - HMAC-SHA256 signed payloads; signing secret stored encrypted-at-rest
--     and one-time-revealed at creation.
--   - Bounded payload (32 KiB cap), no raw evidence content.
--   - Bounded retries (model supports `attemptCount`+`nextAttemptAt`;
--     async retry worker is DEF-023, deferred to a future bounded phase).
--   - Idempotency: unique index on (teamId, runId, destinationId)
--     prevents duplicate delivery rows for the same run+destination.
-- =============================================================================

-- Extend the action-type allowlist to include the webhook action. The
-- TS allowlist in automation.service.ts is extended in lockstep.
ALTER TABLE "automation_rules"
  DROP CONSTRAINT "automation_rules_action_type_allowlist";

ALTER TABLE "automation_rules"
  ADD CONSTRAINT "automation_rules_action_type_allowlist"
  CHECK ("action_type" IN (
    'NOTIFY_USER',
    'NOTIFY_ROLE',
    'CREATE_REVIEW_TASK',
    'CREATE_ESCALATION',
    'ASSIGN_REVIEWER',
    'APPLY_LABEL',
    'ADD_OPERATIONAL_COMMENT',
    'WEBHOOK_DELIVERY_INTERNAL_ONLY'
  ));

-- =============================================================================
-- automation_webhook_destinations
-- =============================================================================

CREATE TABLE "automation_webhook_destinations" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "url" VARCHAR(600) NOT NULL,
    "url_origin" VARCHAR(200) NOT NULL,
    -- Encrypted webhook secret. The plaintext is generated server-side,
    -- shown once at creation, then encrypted with the same key
    -- material as other server-side secrets. Stored as base64.
    "encrypted_secret" TEXT NOT NULL,
    -- Bcrypt-style hash used for fast secret-rotation comparison +
    -- detection of misconfigured rotation. Stored separately from
    -- the encrypted secret on purpose.
    "secret_fingerprint" VARCHAR(80) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "disabled_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_failure_at" TIMESTAMPTZ(6),
    "failure_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "automation_webhook_destinations_pkey" PRIMARY KEY ("id")
);

-- A team may have at most one destination per (url_origin) — prevents
-- duplicate destinations pointing at the same origin (avoids
-- outbound-spam vector via "create 100 destinations to same URL").
CREATE UNIQUE INDEX "automation_webhook_destinations_team_origin_uniq"
  ON "automation_webhook_destinations"("team_id", "url_origin");

CREATE INDEX "automation_webhook_destinations_team_enabled_idx"
  ON "automation_webhook_destinations"("team_id", "enabled");

ALTER TABLE "automation_webhook_destinations"
  ADD CONSTRAINT "automation_webhook_destinations_team_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_webhook_destinations"
  ADD CONSTRAINT "automation_webhook_destinations_created_by_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "automation_webhook_destinations"
  ADD CONSTRAINT "automation_webhook_destinations_updated_by_fkey"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- automation_webhook_deliveries
-- =============================================================================

CREATE TABLE "automation_webhook_deliveries" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "destination_id" UUID NOT NULL,
    -- Deterministic key derived from (runId + destinationId). Prevents
    -- duplicate delivery rows for the same run+destination.
    "idempotency_key" VARCHAR(120) NOT NULL,
    -- Bounded enum: PENDING | DELIVERING | SUCCEEDED | FAILED | SKIPPED
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_attempt_at" TIMESTAMPTZ(6),
    -- HTTP response status code (small int, 0 when unknown).
    "response_status" INTEGER NOT NULL DEFAULT 0,
    -- Operator-safe failure reason, capped to 400 chars. Never the
    -- response body, never the URL with query string, never any
    -- payload bytes — only operator-meaningful classifications like
    -- "timeout" / "non_2xx" / "ssrf_blocked".
    "failure_reason" VARCHAR(400),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

    CONSTRAINT "automation_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- Bounded status enum at DB layer.
ALTER TABLE "automation_webhook_deliveries"
  ADD CONSTRAINT "automation_webhook_deliveries_status_allowlist"
  CHECK ("status" IN ('PENDING', 'DELIVERING', 'SUCCEEDED', 'FAILED', 'SKIPPED'));

-- Idempotency: at most one delivery row per (team, run, destination).
CREATE UNIQUE INDEX "automation_webhook_deliveries_team_run_dest_uniq"
  ON "automation_webhook_deliveries"("team_id", "run_id", "destination_id");

CREATE INDEX "automation_webhook_deliveries_team_created_idx"
  ON "automation_webhook_deliveries"("team_id", "created_at" DESC);
CREATE INDEX "automation_webhook_deliveries_team_status_idx"
  ON "automation_webhook_deliveries"("team_id", "status");
CREATE INDEX "automation_webhook_deliveries_destination_idx"
  ON "automation_webhook_deliveries"("destination_id");

ALTER TABLE "automation_webhook_deliveries"
  ADD CONSTRAINT "automation_webhook_deliveries_team_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_webhook_deliveries"
  ADD CONSTRAINT "automation_webhook_deliveries_run_fkey"
  FOREIGN KEY ("run_id") REFERENCES "automation_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_webhook_deliveries"
  ADD CONSTRAINT "automation_webhook_deliveries_destination_fkey"
  FOREIGN KEY ("destination_id") REFERENCES "automation_webhook_destinations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
