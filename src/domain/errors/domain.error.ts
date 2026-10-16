export abstract class DomainError extends Error {
  public abstract readonly code: string;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidMoneyError extends DomainError {
  public readonly code = 'INVALID_MONEY';

  constructor(message: string) {
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
