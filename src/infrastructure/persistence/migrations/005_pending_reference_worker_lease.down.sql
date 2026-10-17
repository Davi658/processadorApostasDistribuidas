-- DOWN Migration: 005_pending_reference_worker_lease.down.sql

DROP INDEX IF EXISTS idx_wager_tx_lease_expires;
DROP INDEX IF EXISTS idx_wager_tx_pending_claim;

ALTER TABLE wager_transactions
    DROP COLUMN IF EXISTS operational_block_reason,
    DROP COLUMN IF EXISTS is_operationally_blocked,
    DROP COLUMN IF EXISTS lease_expires_at,
    DROP COLUMN IF EXISTS lease_owner,
    DROP COLUMN IF EXISTS lease_token;
