import { Money } from '../value-objects/money.vo';
import { CurrencyMismatchError, InsufficientBalanceError, InvalidWagerOperationError } from '../errors/domain.error';
import { WalletLedgerEntry } from './wallet-ledger-entry.entity';
import { WagerTransaction } from './wager-transaction.entity';

export interface WalletProps {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WalletCreationResult {
  wallet: Wallet;
  openingTransaction?: WagerTransaction;
  ledgerEntry?: WalletLedgerEntry;
}

export class Wallet {
  private _id: string;
  private _playerId: string;
  private _currency: string;
  private _balance: Money;
  private _version: number;
  private _createdAt: string;
  private _updatedAt: string;

  private constructor(props: WalletProps) {
    if (props.balance.isNegative()) {
      throw new InsufficientBalanceError('Wallet balance cannot be negative');
    }
    if (props.version < 1) {
      throw new InvalidWagerOperationError('Wallet version must be greater than or equal to 1');
    }

    this._id = props.id;
    this._playerId = props.playerId;
    this._currency = props.currency;
    this._balance = props.balance;
    this._version = props.version;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  public get id(): string {
    return this._id;
  }

  public get playerId(): string {
    return this._playerId;
  }

  public get currency(): string {
    return this._currency;
  }

  public get balance(): Money {
    return this._balance;
  }

  public get version(): number {
    return this._version;
  }

  public get createdAt(): string {
    return this._createdAt;
  }

  public get updatedAt(): string {
    return this._updatedAt;
  }

  /**
   * Factory for creating a brand new Wallet.
   * - If initialBalance > 0: generates internal OPENING transaction and CREDIT ledger entry.
   * - If initialBalance == 0: no financial ledger entry generated.
   * - Final version after opening is 1.
   */
  public static create(params: {
    id: string;
    playerId: string;
    currency: string;
    initialBalance?: Money;
    openingTransactionId?: string;
    openingLedgerEntryId?: string;
  }): WalletCreationResult {
    const currency = params.currency.trim().toUpperCase();
    const balance = params.initialBalance ?? Money.zero(currency);

    if (balance.getCurrency() !== currency) {
      throw new CurrencyMismatchError(
        `Initial balance currency "${balance.getCurrency()}" does not match wallet currency "${currency}"`
      );
    }

    if (balance.isNegative()) {
      throw new InsufficientBalanceError('Initial balance cannot be negative');
    }

    const now = new Date().toISOString();
    const wallet = new Wallet({
      id: params.id,
      playerId: params.playerId,
      currency,
      balance,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    if (balance.isPositive()) {
      const openingTransactionId = params.openingTransactionId ?? crypto.randomUUID();
      const openingLedgerEntryId = params.openingLedgerEntryId ?? crypto.randomUUID();

      const openingTransaction = WagerTransaction.createOpening({
        id: openingTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: balance,
      });

      const ledgerEntry = WalletLedgerEntry.create({
        id: openingLedgerEntryId,
        walletId: wallet.id,
        transactionId: openingTransaction.id,
        entryType: 'CREDIT',
        amount: balance,
        currency,
        balanceBefore: Money.zero(currency),
        balanceAfter: balance,
        createdAt: now,
      });

      return {
        wallet,
        openingTransaction,
        ledgerEntry,
      };
    }

    return { wallet };
  }

  /**
   * Factory for rehydrating a Wallet from persistence.
   */
  public static rehydrate(props: WalletProps): Wallet {
    return new Wallet(props);
  }

  /**
   * Debit money from the wallet:
   * - Validates currency match
   * - Validates balance sufficiency
   * - Decrements balance
   * - Increments version ONLY because balance changed
   * - Generates immutable DEBIT ledger entry
   */
  public debit(params: {
    transactionId: string;
    amount: Money;
    ledgerEntryId: string;
  }): WalletLedgerEntry {
    if (!params.amount.isPositive()) {
      throw new InvalidWagerOperationError('Debit amount must be strictly greater than zero');
    }

    if (params.amount.getCurrency() !== this._currency) {
      throw new CurrencyMismatchError(
        `Debit currency "${params.amount.getCurrency()}" does not match wallet currency "${this._currency}"`
      );
    }

    if (this._balance.lessThan(params.amount)) {
      throw new InsufficientBalanceError(
        `Insufficient balance: current balance is ${this._balance.getAmount()} ${this._currency}, requested debit is ${params.amount.getAmount()} ${this._currency}`
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(params.amount);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date().toISOString();

    return WalletLedgerEntry.create({
      id: params.ledgerEntryId,
      walletId: this._id,
      transactionId: params.transactionId,
      entryType: 'DEBIT',
      amount: params.amount,
      currency: this._currency,
      balanceBefore,
      balanceAfter,
      createdAt: this._updatedAt,
    });
  }

  /**
   * Credit money to the wallet:
   * - Validates currency match
   * - Increments balance
   * - Increments version ONLY because balance changed
   * - Generates immutable CREDIT ledger entry
   */
  public credit(params: {
    transactionId: string;
    amount: Money;
    ledgerEntryId: string;
  }): WalletLedgerEntry {
    if (!params.amount.isPositive()) {
      throw new InvalidWagerOperationError('Credit amount must be strictly greater than zero');
    }

    if (params.amount.getCurrency() !== this._currency) {
      throw new CurrencyMismatchError(
        `Credit currency "${params.amount.getCurrency()}" does not match wallet currency "${this._currency}"`
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(params.amount);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date().toISOString();

    return WalletLedgerEntry.create({
      id: params.ledgerEntryId,
      walletId: this._id,
      transactionId: params.transactionId,
      entryType: 'CREDIT',
      amount: params.amount,
      currency: this._currency,
      balanceBefore,
      balanceAfter,
      createdAt: this._updatedAt,
    });
  }
}
