-- Restore the exact pre-M11 function and UPDATE-only trigger.
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
