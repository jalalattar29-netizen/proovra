-- Additive billing lifecycle state. No row is rewritten.
--
-- ABANDONED records the customer's local disposition of an unapproved storage
-- checkout after a provider-first check. It does not assert provider
-- cancellation and does not prevent a later provider-proven ACTIVE transition.
ALTER TYPE "WorkspaceStorageAddonStatus" ADD VALUE IF NOT EXISTS 'ABANDONED';
