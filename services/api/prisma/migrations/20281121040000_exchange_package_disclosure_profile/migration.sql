-- WS-OUT / RG-18 (PRO-W1C-05, DEC-25) — an exchange package honours a
-- selected disclosure profile. Expand-only: every existing and every
-- unspecified package keeps today's behaviour (FULL_FORENSIC). The worker
-- applies the external projection only when a package asks for it.
ALTER TABLE "evidence_exchange_packages"
  ADD COLUMN IF NOT EXISTS "disclosure_profile" VARCHAR(32) NOT NULL DEFAULT 'FULL_FORENSIC';
