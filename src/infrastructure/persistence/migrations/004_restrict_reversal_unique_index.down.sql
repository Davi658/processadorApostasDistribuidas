-- DOWN Migration: 004_restrict_reversal_unique_index.down.sql
-- Reverts unique index uq_processed_reversal_per_reference to 003 definition (affecting any PROCESSED operation with reference).
-- If conflicting records exist (e.g. multiple PROCESSED WINs for the same reference), safely refuses the migration without deleting any records.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM wager_transactions
        WHERE status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL
        GROUP BY provider_id, reference_external_transaction_id, kind
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Cannot revert migration 004: multiple PROCESSED records exist for the same reference that violate 003 unique constraint'
            USING ERRCODE = '23505';
    END IF;
END $$;

DROP INDEX IF EXISTS uq_processed_reversal_per_reference;

CREATE UNIQUE INDEX uq_processed_reversal_per_reference
    ON wager_transactions (provider_id, reference_external_transaction_id, kind)
    WHERE status = 'PROCESSED' 
      AND reference_external_transaction_id IS NOT NULL;
