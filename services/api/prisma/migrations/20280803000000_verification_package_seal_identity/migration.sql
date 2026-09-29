-- VERIFICATION PACKAGE SEAL IDENTITY (2026-09-29, ET-PKG-02). Additive only:
-- two nullable columns.
--
-- A format-5 package is sealed by a key that travels INSIDE the package, so the
-- seal alone vouches for nothing: anyone who edits a file can re-seal with their
-- own key. PROOVRA now records, per package, the SHA-256 of the exact
-- package-seal.json it signed and the SHA-256 fingerprint of the signing key's
-- DER SubjectPublicKeyInfo, and Public Verify serves them beside the package's
-- own SHA-256 so a recipient can check the package they hold against PROOVRA.
--
-- Historical rows keep NULL ("not recorded"). Nothing is inferred or backfilled.

ALTER TABLE "verification_packages"
  ADD COLUMN IF NOT EXISTS "seal_sha256" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "seal_signing_key_sha256" VARCHAR(64);
