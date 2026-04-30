ALTER TABLE "evidence"
ADD COLUMN "tsa_input_digest_hex" VARCHAR(128),
ADD COLUMN "tsa_input_kind" VARCHAR(64);
