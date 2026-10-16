-- UP Migration: 002_reinforce_schema_and_outbox.sql

-- 1. Composite currency matching: wallet currency must match transaction and ledger entry currency
ALTER TABLE wallets ADD CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency);

ALTER TABLE wager_transactions 
    ADD CONSTRAINT fk_wager_wallet_currency 
    FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency) ON DELETE RESTRICT;

ALTER TABLE wallet_ledger_entries 
    ADD CONSTRAINT fk_ledger_wallet_currency 
    FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency) ON DELETE RESTRICT;

-- 2. Value checks for kind and status
ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_kind 
    CHECK (kind IN ('BET', 'OPENING'));

ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_status 
    CHECK (status IN ('PROCESSED', 'REJECTED'));

-- 3. Contract requirements for external BET operations
ALTER TABLE wager_transactions 
    ADD CONSTRAINT chk_wager_transactions_external_contract 
    CHECK (
        (kind = 'BET' AND idempotency_key IS NOT NULL AND payload_hash IS NOT NULL AND response_snapshot IS NOT NULL) OR
        (kind = 'OPENING')
    );

-- 4. Preserve terminal states: PROCESSED or REJECTED transactions cannot be modified
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

-- 5. Outbox envelope alignment
ALTER TABLE outbox_messages
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(128) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS causation_id VARCHAR(128) NULL,
    ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 6. Strict least-privilege security: explicitly revoke TRUNCATE and DDL permissions from application user
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_user;
        REVOKE CREATE ON SCHEMA public FROM app_user;
    END IF;
END $$;
