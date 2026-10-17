-- UP Migration: 005_pending_reference_worker_lease.sql
-- Adds lease reservation columns, operational block columns, indexes and permissions for background worker

ALTER TABLE wager_transactions
    ADD COLUMN IF NOT EXISTS lease_token VARCHAR(64) NULL,
    ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS is_operationally_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS operational_block_reason VARCHAR(255) NULL;

-- Partial index for high-throughput skip-locked pending claim
CREATE INDEX IF NOT EXISTS idx_wager_tx_pending_claim
    ON wager_transactions (next_attempt_at ASC NULLS FIRST, created_at ASC)
    WHERE status = 'PENDING_REFERENCE' AND is_operationally_blocked = FALSE;

-- Partial index for identifying expired leases
CREATE INDEX IF NOT EXISTS idx_wager_tx_lease_expires
    ON wager_transactions (lease_expires_at)
    WHERE status = 'PENDING_REFERENCE' AND lease_expires_at IS NOT NULL;

-- Permissions for application user
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON wager_transactions TO app_user;
    END IF;
END $$;
