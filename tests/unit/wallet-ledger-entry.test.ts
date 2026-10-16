import { describe, expect, it } from 'bun:test';
import { WalletLedgerEntry } from '../../src/domain/entities/wallet-ledger-entry.entity';
import { Money } from '../../src/domain/value-objects/money.vo';
import { CurrencyMismatchError, InvalidWagerOperationError } from '../../src/domain/errors/domain.error';

describe('WalletLedgerEntry Entity', () => {
  it('should create valid CREDIT ledger entry and verify arithmetic invariant', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: 'w-1',
      transactionId: 'tx-1',
      entryType: 'CREDIT',
      amount: Money.create('50.00', 'BRL'),
      currency: 'BRL',
      balanceBefore: Money.create('10.00', 'BRL'),
      balanceAfter: Money.create('60.00', 'BRL'),
    });

    expect(entry.entryType).toBe('CREDIT');
    expect(entry.amount.getAmount()).toBe('50.00');
    expect(entry.balanceBefore.getAmount()).toBe('10.00');
    expect(entry.balanceAfter.getAmount()).toBe('60.00');
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('should create valid DEBIT ledger entry and verify arithmetic invariant', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-2',
      walletId: 'w-1',
      transactionId: 'tx-2',
      entryType: 'DEBIT',
      amount: Money.create('40.00', 'BRL'),
      currency: 'BRL',
      balanceBefore: Money.create('100.00', 'BRL'),
      balanceAfter: Money.create('60.00', 'BRL'),
    });

    expect(entry.entryType).toBe('DEBIT');
    expect(entry.amount.getAmount()).toBe('40.00');
    expect(entry.balanceBefore.getAmount()).toBe('100.00');
    expect(entry.balanceAfter.getAmount()).toBe('60.00');
  });

  it('should throw InvalidWagerOperationError on arithmetic mismatch for CREDIT', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-3',
        walletId: 'w-1',
        transactionId: 'tx-3',
        entryType: 'CREDIT',
        amount: Money.create('50.00', 'BRL'),
        currency: 'BRL',
        balanceBefore: Money.create('10.00', 'BRL'),
        balanceAfter: Money.create('55.00', 'BRL'), // Mismatch! Should be 60.00
      })
    ).toThrow(InvalidWagerOperationError);
  });

  it('should throw InvalidWagerOperationError on arithmetic mismatch for DEBIT', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-4',
        walletId: 'w-1',
        transactionId: 'tx-4',
        entryType: 'DEBIT',
        amount: Money.create('30.00', 'BRL'),
        currency: 'BRL',
        balanceBefore: Money.create('100.00', 'BRL'),
        balanceAfter: Money.create('80.00', 'BRL'), // Mismatch! Should be 70.00
      })
    ).toThrow(InvalidWagerOperationError);
  });

  it('should throw CurrencyMismatchError if amount currency differs from entry currency', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-5',
        walletId: 'w-1',
        transactionId: 'tx-5',
        entryType: 'CREDIT',
        amount: Money.create('50.00', 'USD'),
        currency: 'BRL',
        balanceBefore: Money.create('10.00', 'BRL'),
        balanceAfter: Money.create('60.00', 'BRL'),
      })
    ).toThrow(CurrencyMismatchError);
  });
});
