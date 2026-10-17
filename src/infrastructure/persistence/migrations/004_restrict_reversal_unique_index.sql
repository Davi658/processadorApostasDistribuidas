-- UP Migration: 004_restrict_reversal_unique_index.sql
-- Restricts unique index uq_processed_reversal_per_reference exclusively to reversal operations (REFUND, ROLLBACK)
-- allowing multiple WIN operations on the same BET reference.

DROP INDEX IF EXISTS uq_processed_reversal_per_reference;

CREATE UNIQUE INDEX uq_processed_reversal_per_reference
    ON wager_transactions (provider_id, reference_external_transaction_id, kind)
    WHERE status = 'PROCESSED' 
      AND reference_external_transaction_id IS NOT NULL 
      AND kind IN ('REFUND', 'ROLLBACK');
