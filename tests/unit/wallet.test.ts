import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../src/domain/entities/wallet.entity';
import { Money } from '../../src/domain/value-objects/money.vo';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidWagerOperationError,
} from '../../src/domain/errors/domain.error';

describe('Wallet Aggregate', () => {
  it('should create wallet with zero balance and no ledger entry or opening transaction', () => {
    const { wallet, openingTransaction, ledgerEntry } = Wallet.create({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
    });

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.getAmount()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(openingTransaction).toBeUndefined();
    expect(ledgerEntry).toBeUndefined();
  });

  it('should create wallet with positive balance and generate OPENING tx and CREDIT ledger', () => {
    const initialBalance = Money.create('100.00', 'BRL');
    const { wallet, openingTransaction, ledgerEntry } = Wallet.create({
      id: 'wallet-2',
      playerId: 'player-2',
      currency: 'BRL',
      initialBalance,
    });

    expect(wallet.balance.getAmount()).toBe('100.00');
    expect(wallet.version).toBe(1); // Opening final version is 1!

    expect(openingTransaction).toBeDefined();
    expect(openingTransaction?.kind).toBe('OPENING');
    expect(openingTransaction?.money.getAmount()).toBe('100.00');
    expect(openingTransaction?.status).toBe('PROCESSED');

    expect(ledgerEntry).toBeDefined();
    expect(ledgerEntry?.entryType).toBe('CREDIT');
    expect(ledgerEntry?.amount.getAmount()).toBe('100.00');
    expect(ledgerEntry?.balanceBefore.getAmount()).toBe('0.00');
    expect(ledgerEntry?.balanceAfter.getAmount()).toBe('100.00');
    expect(ledgerEntry?.transactionId).toBe(openingTransaction!.id);
  });

  it('should debit funds, increment version, and return DEBIT ledger entry', () => {
    const { wallet } = Wallet.create({
      id: 'wallet-3',
      playerId: 'player-3',
      currency: 'BRL',
      initialBalance: Money.create('100.00', 'BRL'),
    });

    expect(wallet.version).toBe(1);

    const ledgerEntry = wallet.debit({
      transactionId: 'tx-bet-1',
      amount: Money.create('80.00', 'BRL'),
      ledgerEntryId: 'ledger-1',
    });

    expect(wallet.balance.getAmount()).toBe('20.00');
    expect(wallet.version).toBe(2);

    expect(ledgerEntry.entryType).toBe('DEBIT');
    expect(ledgerEntry.amount.getAmount()).toBe('80.00');
    expect(ledgerEntry.balanceBefore.getAmount()).toBe('100.00');
    expect(ledgerEntry.balanceAfter.getAmount()).toBe('20.00');
    expect(ledgerEntry.transactionId).toBe('tx-bet-1');
  });

  it('should throw InsufficientBalanceError when debit exceeds balance without mutating wallet', () => {
    const { wallet } = Wallet.create({
      id: 'wallet-4',
      playerId: 'player-4',
      currency: 'BRL',
      initialBalance: Money.create('50.00', 'BRL'),
    });

    expect(() =>
      wallet.debit({
        transactionId: 'tx-bet-fail',
        amount: Money.create('80.00', 'BRL'),
        ledgerEntryId: 'ledger-fail',
      })
    ).toThrow(InsufficientBalanceError);

    expect(wallet.balance.getAmount()).toBe('50.00');
    expect(wallet.version).toBe(1); // Version MUST NOT change if balance did not change!
  });

  it('should reject debit with currency mismatch', () => {
    const { wallet } = Wallet.create({
      id: 'wallet-5',
      playerId: 'player-5',
      currency: 'BRL',
      initialBalance: Money.create('100.00', 'BRL'),
    });

    expect(() =>
      wallet.debit({
        transactionId: 'tx-usd',
        amount: Money.create('10.00', 'USD'),
        ledgerEntryId: 'ledger-usd',
      })
    ).toThrow(CurrencyMismatchError);

    expect(wallet.version).toBe(1);
  });

  it('should reject debit with zero amount', () => {
    const { wallet } = Wallet.create({
      id: 'wallet-6',
      playerId: 'player-6',
      currency: 'BRL',
      initialBalance: Money.create('100.00', 'BRL'),
    });

    expect(() =>
      wallet.debit({
        transactionId: 'tx-zero',
        amount: Money.zero('BRL'),
        ledgerEntryId: 'ledger-zero',
      })
    ).toThrow(InvalidWagerOperationError);
  });

  it('should credit funds, increment version, and return CREDIT ledger entry', () => {
    const { wallet } = Wallet.create({
      id: 'wallet-7',
      playerId: 'player-7',
      currency: 'BRL',
      initialBalance: Money.create('20.00', 'BRL'),
    });

    const ledger = wallet.credit({
      transactionId: 'tx-credit-1',
      amount: Money.create('30.00', 'BRL'),
      ledgerEntryId: 'ledger-cred',
    });

    expect(wallet.balance.getAmount()).toBe('50.00');
    expect(wallet.version).toBe(2);
    expect(ledger.balanceBefore.getAmount()).toBe('20.00');
    expect(ledger.balanceAfter.getAmount()).toBe('50.00');
  });
});
