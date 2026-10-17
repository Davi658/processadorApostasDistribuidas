export abstract class DomainError extends Error {
  public abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidMoneyError extends DomainError {
  public readonly code: string = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

export class MoneyOverflowError extends InvalidMoneyError {
  public override readonly code: string = 'MONEY_OVERFLOW';

  constructor(message = 'Amount exceeds maximum allowed capacity for NUMERIC(18,2)') {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  public readonly code = 'CURRENCY_MISMATCH';

  constructor(message: string) {
    super(message);
  }
}

export class InsufficientBalanceError extends DomainError {
  public readonly code = 'INSUFFICIENT_BALANCE';

  constructor(message = 'Wallet has insufficient balance for this debit') {
    super(message);
  }
}

export class InvalidWagerOperationError extends DomainError {
  public readonly code = 'INVALID_WAGER_OPERATION';

  constructor(message: string) {
    super(message);
  }
}

export class WalletNotFoundError extends DomainError {
  public readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet with ID "${walletId}" was not found`);
  }
}

export class DuplicateWalletError extends DomainError {
  public readonly code = 'DUPLICATE_WALLET';

  constructor(playerId: string, currency: string) {
    super(`A wallet already exists for player "${playerId}" with currency "${currency}"`);
  }
}

export class IdempotencyConflictError extends DomainError {
  public readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(message: string) {
    super(message);
  }
}

export class TransactionRequiredError extends DomainError {
  public readonly code = 'TRANSACTION_REQUIRED';

  constructor(message = 'Write operations require an active UnitOfWork transaction') {
    super(message);
  }
}

export class TransactionRollbackOnlyError extends DomainError {
  public readonly code = 'TRANSACTION_ROLLBACK_ONLY';
  public override readonly cause?: unknown;

  constructor(
    message = 'Transaction cannot be committed because it has been marked as rollback-only',
    cause?: unknown
  ) {
    super(message);
    this.cause = cause;
  }
}

export class ReplaySnapshotUnavailableError extends DomainError {
  public readonly code = 'REPLAY_SNAPSHOT_UNAVAILABLE';

  constructor(
    message = 'Replay snapshot is unavailable. Repeating the operation will not recover historical state; operational analysis is required.'
  ) {
    super(message);
  }
}

export class StaleLeaseError extends DomainError {
  public readonly code = 'STALE_LEASE';

  constructor(message = 'Lease token mismatch or lease expired') {
    super(message);
  }
}



