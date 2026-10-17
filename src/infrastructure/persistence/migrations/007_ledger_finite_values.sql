-- NUMERIC(18,2) rejects infinities/overflow but accepts NaN, which compares above
-- finite values and satisfies the historical >= 0 and NaN = NaN checks.
-- Validate existing data; abort atomically rather than rewriting financial history.
ALTER TABLE wallet_ledger_entries
    ADD CONSTRAINT chk_ledger_finite_values
    CHECK (amount <> 'NaN'::numeric AND balance_before <> 'NaN'::numeric AND balance_after <> 'NaN'::numeric);

ALTER TABLE wallets
    ADD CONSTRAINT chk_wallets_balance_finite
    CHECK (balance <> 'NaN'::numeric);
