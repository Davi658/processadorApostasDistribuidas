-- DOWN Migration: 008_outbox_publisher_lease_and_retry.down.sql

DROP INDEX IF EXISTS idx_outbox_messages_claim;
DROP INDEX IF EXISTS idx_outbox_messages_lease_expires;

ALTER TABLE outbox_messages
    DROP COLUMN IF EXISTS lease_token,
    DROP COLUMN IF EXISTS lease_owner,
    DROP COLUMN IF EXISTS lease_expires_at,
    DROP COLUMN IF EXISTS attempts,
    DROP COLUMN IF EXISTS next_attempt_at,
    DROP COLUMN IF EXISTS last_error,
    DROP COLUMN IF EXISTS is_operationally_blocked,
    DROP COLUMN IF EXISTS operational_block_reason;
