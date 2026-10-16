-- DOWN Migration: 003_protect_terminals_and_composite_fk.down.sql

-- 1. Restore trigger to 002 definition
CREATE OR REPLACE FUNCTION prevent_terminal_transaction_modification()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('PROCESSED', 'REJECTED') AND (NEW.status <> OLD.status OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency) THEN
        RAISE EXCEPTION 'wager_transactions in terminal state cannot be modified'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_wager_terminal_state ON wager_transactions;

CREATE TRIGGER trg_protect_wager_terminal_state
BEFORE UPDATE ON wager_transactions
FOR EACH ROW
EXECUTE FUNCTION prevent_terminal_transaction_modification();

-- 2. Drop composite foreign key and unique constraint
ALTER TABLE wallet_ledger_entries 
    DROP CONSTRAINT IF EXISTS fk_ledger_wager_tx_wallet_currency;

ALTER TABLE wager_transactions 
    DROP CONSTRAINT IF EXISTS uq_wager_tx_id_wallet_currency;

-- 3. Drop reversal unique index and helper indexes
DROP INDEX IF EXISTS uq_processed_reversal_per_reference;
DROP INDEX IF EXISTS idx_wager_tx_pending_ref;
DROP INDEX IF EXISTS idx_wager_tx_ref_ext;

-- 4. Drop columns
ALTER TABLE wager_transactions
    DROP COLUMN IF EXISTS reference_external_transaction_id,
    DROP COLUMN IF EXISTS attempts,
    DROP COLUMN IF EXISTS next_attempt_at;

-- 5. Restore kind and status checks to 002 definition
ALTER TABLE wager_transactions 
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_status;

ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_status 
    CHECK (status IN ('PROCESSED', 'REJECTED'));

ALTER TABLE wager_transactions 
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_kind;

ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_kind 
    CHECK (kind IN ('BET', 'OPENING'));

ALTER TABLE wager_transactions 
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_external_contract;

ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_external_contract 
    CHECK (
        (kind = 'BET' AND idempotency_key IS NOT NULL AND payload_hash IS NOT NULL AND response_snapshot IS NOT NULL) OR
        (kind = 'OPENING')
    );

ALTER TABLE wager_transactions 
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_amount_positive;

ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_amount_positive 
    CHECK (amount > 0);

-- 6. Revert correlation_id and causation_id columns length in outbox_messages
ALTER TABLE outbox_messages 
    ALTER COLUMN correlation_id TYPE VARCHAR(128),
    ALTER COLUMN causation_id TYPE VARCHAR(128);
