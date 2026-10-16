-- UP Migration: 001_initial_schema.sql

-- 1. Create Wallets Table
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY,
    player_id VARCHAR(128) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    balance NUMERIC(18, 2) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
    CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0),
    CONSTRAINT chk_wallets_version_positive CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS idx_wallets_player_id ON wallets(player_id);

-- 2. Create Wager Transactions Table
CREATE TABLE IF NOT EXISTS wager_transactions (
    id UUID PRIMARY KEY,
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    player_id VARCHAR(128) NOT NULL,
    provider_id VARCHAR(128) NOT NULL,
    external_transaction_id VARCHAR(128) NOT NULL,
    round_id VARCHAR(128) NOT NULL,
    game_id VARCHAR(128) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(32) NOT NULL,
    rejection_reason VARCHAR(255) NULL,
    idempotency_key VARCHAR(255) NULL,
    payload_hash CHAR(64) NULL,
    response_snapshot JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_wager_transactions_provider_external UNIQUE (provider_id, external_transaction_id),
    CONSTRAINT uq_wager_transactions_idempotency_key UNIQUE (idempotency_key),
    CONSTRAINT chk_wager_transactions_amount_positive CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_wager_transactions_wallet_id ON wager_transactions(wallet_id);

-- 3. Create Wallet Ledger Entries Table
CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
    id UUID PRIMARY KEY,
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    transaction_id UUID NOT NULL REFERENCES wager_transactions(id) ON DELETE RESTRICT,
    entry_type VARCHAR(16) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    balance_before NUMERIC(18, 2) NOT NULL,
    balance_after NUMERIC(18, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_wallet_ledger_entries_tx_wallet UNIQUE (transaction_id, wallet_id),
    CONSTRAINT chk_ledger_positive_amount CHECK (amount > 0),
    CONSTRAINT chk_ledger_non_negative_balances CHECK (balance_before >= 0 AND balance_after >= 0),
    CONSTRAINT chk_ledger_arithmetic CHECK (
        (entry_type = 'CREDIT' AND balance_after = balance_before + amount) OR
        (entry_type = 'DEBIT' AND balance_after = balance_before - amount)
    )
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_entries_wallet_created ON wallet_ledger_entries(wallet_id, created_at ASC, id ASC);

-- 4. Create Outbox Messages Table
CREATE TABLE IF NOT EXISTS outbox_messages (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_messages_unpublished ON outbox_messages(published_at) WHERE published_at IS NULL;

-- 5. Ledger Immutability: Trigger function and trigger
CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Modifications and deletions are strictly prohibited on wallet_ledger_entries';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_wallet_ledger_entries ON wallet_ledger_entries;

CREATE TRIGGER trg_protect_wallet_ledger_entries
BEFORE UPDATE OR DELETE ON wallet_ledger_entries
FOR EACH ROW
EXECUTE FUNCTION prevent_ledger_modification();

-- 6. Grant least-privilege access to application user
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT USAGE ON SCHEMA public TO app_user;
        GRANT SELECT, INSERT, UPDATE ON wallets TO app_user;
        GRANT SELECT, INSERT, UPDATE ON wager_transactions TO app_user;
        REVOKE ALL ON wallet_ledger_entries FROM app_user;
        GRANT SELECT, INSERT ON wallet_ledger_entries TO app_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_messages TO app_user;
    END IF;
END $$;
