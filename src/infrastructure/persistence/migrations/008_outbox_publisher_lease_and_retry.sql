-- UP Migration: 008_outbox_publisher_lease_and_retry.sql
-- Adds lease reservation, retry backoff, and operational blocking for outbox publisher

ALTER TABLE outbox_messages
    ADD COLUMN IF NOT EXISTS lease_token VARCHAR(64) NULL,
    ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS last_error TEXT NULL,
    ADD COLUMN IF NOT EXISTS is_operationally_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS operational_block_reason VARCHAR(255) NULL;

-- Partial index for high-throughput skip-locked unpublished claim
CREATE INDEX IF NOT EXISTS idx_outbox_messages_claim
    ON outbox_messages (next_attempt_at ASC NULLS FIRST, created_at ASC)
    WHERE published_at IS NULL AND is_operationally_blocked = FALSE;

-- Partial index for identifying expired leases
CREATE INDEX IF NOT EXISTS idx_outbox_messages_lease_expires
    ON outbox_messages (lease_expires_at)
    WHERE published_at IS NULL AND lease_expires_at IS NOT NULL;

-- Permissions for application user
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_messages TO app_user;
    END IF;
END $$;
