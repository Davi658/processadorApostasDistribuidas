-- DOWN Migration: 002_reinforce_schema_and_outbox.down.sql

DROP TRIGGER IF EXISTS trg_protect_wager_terminal_state ON wager_transactions;
DROP FUNCTION IF EXISTS prevent_terminal_transaction_modification();

ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS chk_wager_transactions_external_contract;
ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS chk_wager_transactions_status;
ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS chk_wager_transactions_kind;

ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS fk_ledger_wallet_currency;
ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS fk_wager_wallet_currency;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS uq_wallets_id_currency;

ALTER TABLE outbox_messages
    DROP COLUMN IF EXISTS occurred_at,
    DROP COLUMN IF EXISTS causation_id,
    DROP COLUMN IF EXISTS correlation_id,
    DROP COLUMN IF EXISTS version;
