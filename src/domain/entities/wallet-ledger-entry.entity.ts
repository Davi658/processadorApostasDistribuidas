import { Money } from '../value-objects/money.vo';
import { CurrencyMismatchError, InvalidWagerOperationError } from '../errors/domain.error';

export type LedgerEntryType = 'CREDIT' | 'DEBIT';

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  entryType: LedgerEntryType;
  amount: Money;
  currency: string;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: string;
}

export class WalletLedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly entryType: LedgerEntryType;
  public readonly amount: Money;
  public readonly currency: string;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;
  public readonly createdAt: string;

  private constructor(props: WalletLedgerEntryProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.entryType = props.entryType;
    this.amount = props.amount;
    this.currency = props.currency;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.createdAt = props.createdAt;

    Object.freeze(this);
  }

  public static create(props: Omit<WalletLedgerEntryProps, 'createdAt'> & { createdAt?: string }): WalletLedgerEntry {
    if (!props.amount.isPositive()) {
      throw new InvalidWagerOperationError('Ledger entry amount must be strictly greater than zero');
    }

    if (props.amount.getCurrency() !== props.currency) {
      throw new CurrencyMismatchError(
        `Entry currency "${props.currency}" does not match amount currency "${props.amount.getCurrency()}"`
      );
    }

    if (props.balanceBefore.getCurrency() !== props.currency || props.balanceAfter.getCurrency() !== props.currency) {
      throw new CurrencyMismatchError('Balance currency does not match ledger entry currency');
    }

    // Verify arithmetic invariant
    if (props.entryType === 'CREDIT') {
      const expectedAfter = props.balanceBefore.add(props.amount);
      if (!props.balanceAfter.equals(expectedAfter)) {
        throw new InvalidWagerOperationError(
          `Arithmetic mismatch for CREDIT: balanceBefore (${props.balanceBefore.getAmount()}) + amount (${props.amount.getAmount()}) != balanceAfter (${props.balanceAfter.getAmount()})`
        );
      }
    } else if (props.entryType === 'DEBIT') {
      const expectedAfter = props.balanceBefore.subtract(props.amount);
      if (!props.balanceAfter.equals(expectedAfter)) {
        throw new InvalidWagerOperationError(
          `Arithmetic mismatch for DEBIT: balanceBefore (${props.balanceBefore.getAmount()}) - amount (${props.amount.getAmount()}) != balanceAfter (${props.balanceAfter.getAmount()})`
        );
      }
    } else {
      throw new InvalidWagerOperationError(`Unknown ledger entry type: "${props.entryType}"`);
    }

    return new WalletLedgerEntry({
      ...props,
      createdAt: props.createdAt ?? new Date().toISOString(),
    });
  }

  public static rehydrate(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(props);
  }
}
