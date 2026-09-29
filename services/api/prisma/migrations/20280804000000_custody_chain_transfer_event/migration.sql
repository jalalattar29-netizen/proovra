-- CUSTODY CHAIN TRANSFER EVENT (2026-09-29, ET-CUS-02). Additive only: one
-- enum value.
--
-- Chain-of-custody transfers between organisations wrote their custody event
-- with a type that did not exist in CustodyEventType; the insert failed and the
-- failure was swallowed, so no hand-off ever reached a custody chain. The value
-- is added here and the transfer now appends it inside its state transition.

ALTER TYPE "CustodyEventType" ADD VALUE IF NOT EXISTS 'CHAIN_TRANSFER_CUSTODY_EXTENDED';
