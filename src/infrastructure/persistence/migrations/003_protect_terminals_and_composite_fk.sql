-- UP Migration: 003_protect_terminals_and_composite_fk.sql

-- 1. Expand correlation_id and causation_id columns to VARCHAR(255) in outbox_messages
ALTER TABLE outbox_messages 
    ALTER COLUMN correlation_id TYPE VARCHAR(255),
    ALTER COLUMN causation_id TYPE VARCHAR(255);

-- 2. Update allowed kind check to include all wager operations
ALTER TABLE wager_transactions 
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_kind;

ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_kind 
    CHECK (kind IN ('BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK', 'OPENING'));

-- 3. Update allowed status check to include lifecycle transitions
ALTER TABLE wager_transactions 
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_status;

ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_status 
    CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));

-- 3b. Update external contract check for all external operations and lifecycle
ALTER TABLE wager_transactions 
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_external_contract;

ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_external_contract 
    CHECK (
        (kind IN ('BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK') AND idempotency_key IS NOT NULL AND payload_hash IS NOT NULL) OR
        (kind = 'OPENING')
    );

-- 3c. Allow amount = 0 specifically for LOSS operations
ALTER TABLE wager_transactions 
    DROP CONSTRAINT IF EXISTS chk_wager_transactions_amount_positive;

ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_amount_positive 
    CHECK ((kind = 'LOSS' AND amount >= 0) OR (kind <> 'LOSS' AND amount > 0));

-- 4. Add columns for references, retry attempts and backoff scheduling
ALTER TABLE wager_transactions
    ADD COLUMN IF NOT EXISTS reference_external_transaction_id VARCHAR(128) NULL,
    ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_wager_tx_pending_ref 
    ON wager_transactions (next_attempt_at) 
    WHERE status = 'PENDING_REFERENCE';

CREATE INDEX IF NOT EXISTS idx_wager_tx_ref_ext 
    ON wager_transactions (provider_id, reference_external_transaction_id) 
    WHERE reference_external_transaction_id IS NOT NULL;

-- 5. Guarantee at most one processed reversal (REFUND or ROLLBACK) per reference and operation type
CREATE UNIQUE INDEX IF NOT EXISTS uq_processed_reversal_per_reference
    ON wager_transactions (provider_id, reference_external_transaction_id, kind)
    WHERE status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL;

-- 6. Composite uniqueness on wager_transactions (id, wallet_id, currency)
ALTER TABLE wager_transactions 
    ADD CONSTRAINT uq_wager_tx_id_wallet_currency UNIQUE (id, wallet_id, currency);

-- 7. Composite foreign key from wallet_ledger_entries to wager_transactions
-- Ensures that a ledger entry belongs to the EXACT transaction, wallet and currency
ALTER TABLE wallet_ledger_entries 
    ADD CONSTRAINT fk_ledger_wager_tx_wallet_currency 
    FOREIGN KEY (transaction_id, wallet_id, currency) 
    REFERENCES wager_transactions (id, wallet_id, currency) 
    ON DELETE RESTRICT;

-- 8. Strengthened Trigger Guard: Protect ALL identity, payload, and result fields on terminal transactions
-- Uses IS DISTINCT FROM for safe NULL comparisons and preserves non-terminal transitions
CREATE OR REPLACE FUNCTION prevent_terminal_transaction_modification()
RETURNS TRIGGER AS $$
BEGIN
    -- Only protect transactions that are already in a terminal state
    IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
        IF (
            NEW.status IS DISTINCT FROM OLD.status OR
            NEW.amount IS DISTINCT FROM OLD.amount OR
            NEW.currency IS DISTINCT FROM OLD.currency OR
            NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR
            NEW.player_id IS DISTINCT FROM OLD.player_id OR
            NEW.provider_id IS DISTINCT FROM OLD.provider_id OR
            NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id OR
            NEW.round_id IS DISTINCT FROM OLD.round_id OR
            NEW.game_id IS DISTINCT FROM OLD.game_id OR
            NEW.kind IS DISTINCT FROM OLD.kind OR
            NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
            NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR
            NEW.observed_balance IS DISTINCT FROM OLD.observed_balance OR
            NEW.response_snapshot IS DISTINCT FROM OLD.response_snapshot OR
            NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason OR
            NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
        ) THEN
            RAISE EXCEPTION 'wager_transactions in terminal state (%) cannot be modified on protected fields', OLD.status
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_wager_terminal_state ON wager_transactions;

CREATE TRIGGER trg_protect_wager_terminal_state
BEFORE UPDATE ON wager_transactions
FOR EACH ROW
EXECUTE FUNCTION prevent_terminal_transaction_modification();
