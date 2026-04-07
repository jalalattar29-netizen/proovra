CREATE TABLE IF NOT EXISTS "public"."user_legal_acceptances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "policy_key" VARCHAR(64) NOT NULL,
  "policy_version" VARCHAR(32) NOT NULL,
  "source" VARCHAR(64),
  "ip_address" VARCHAR(45),
  "user_agent" VARCHAR(512),
  "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_legal_acceptances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_legal_acceptances_user_id_policy_key_key" UNIQUE ("user_id", "policy_key"),
  CONSTRAINT "user_legal_acceptances_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "user_legal_acceptances_user_id_idx"
  ON "public"."user_legal_acceptances"("user_id");

CREATE INDEX IF NOT EXISTS "user_legal_acceptances_policy_key_policy_version_idx"
  ON "public"."user_legal_acceptances"("policy_key", "policy_version");


CREATE TABLE IF NOT EXISTS "public"."cookie_consent_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID,
  "consent_version" VARCHAR(32) NOT NULL,
  "necessary" BOOLEAN NOT NULL DEFAULT true,
  "preferences" BOOLEAN NOT NULL DEFAULT false,
  "analytics" BOOLEAN NOT NULL DEFAULT false,
  "marketing" BOOLEAN NOT NULL DEFAULT false,
  "source" VARCHAR(64),
  "ip_address" VARCHAR(45),
  "user_agent" VARCHAR(512),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cookie_consent_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cookie_consent_records_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "cookie_consent_records_user_id_created_at_idx"
  ON "public"."cookie_consent_records"("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "cookie_consent_records_consent_version_idx"
  ON "public"."cookie_consent_records"("consent_version");