-- AUD-026 — a client capture attempt names exactly one direct-capture session.
-- A retried open (lost response, dropped network) returns the same live
-- session instead of opening a second. Additive and nullable: existing rows
-- keep NULL, and NULLs are distinct under the unique index.
ALTER TABLE "capture_sessions" ADD COLUMN "client_attempt_id" VARCHAR(64);

CREATE UNIQUE INDEX "capture_sessions_owner_client_attempt_key"
  ON "capture_sessions" ("owner_user_id", "client_attempt_id");
