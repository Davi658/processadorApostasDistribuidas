-- DOWN Migration: 001_initial_schema.down.sql

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        REVOKE ALL ON outbox_messages FROM app_user;
        REVOKE ALL ON wallet_ledger_entries FROM app_user;
        REVOKE ALL ON wager_transactions FROM app_user;
        REVOKE ALL ON wallets FROM app_user;
    END IF;
END $$;

DROP TRIGGER IF EXISTS trg_protect_wallet_ledger_entries ON wallet_ledger_entries;
DROP FUNCTION IF EXISTS prevent_ledger_modification();
DROP TABLE IF EXISTS outbox_messages CASCADE;
DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;
DROP TABLE IF EXISTS wager_transactions CASCADE;
DROP TABLE IF EXISTS wallets CASCADE;
