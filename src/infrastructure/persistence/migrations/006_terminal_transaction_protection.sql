-- Terminal rows preserve all fields except the explicit M10 operational allowlist.
CREATE OR REPLACE FUNCTION prevent_terminal_transaction_modification()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'terminal_transaction_delete_forbidden: %', OLD.status
                USING ERRCODE = '55000';
        END IF;
        IF (to_jsonb(NEW) - ARRAY['updated_at', 'attempts', 'next_attempt_at', 'lease_token', 'lease_owner', 'lease_expires_at', 'is_operationally_blocked', 'operational_block_reason'])
            IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at', 'attempts', 'next_attempt_at', 'lease_token', 'lease_owner', 'lease_expires_at', 'is_operationally_blocked', 'operational_block_reason']) THEN
            RAISE EXCEPTION 'terminal_transaction_protected_fields: %', OLD.status
                USING ERRCODE = '55000';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_wager_terminal_state ON wager_transactions;
CREATE TRIGGER trg_protect_wager_terminal_state
BEFORE UPDATE OR DELETE ON wager_transactions
FOR EACH ROW EXECUTE FUNCTION prevent_terminal_transaction_modification();
