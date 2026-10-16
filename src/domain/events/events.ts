export interface DomainEvent {
  readonly eventName: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly occurredAt: string;
  readonly payload: Record<string, any>;
}

export class WagerTransactionProcessedEvent implements DomainEvent {
  public readonly eventName = 'WagerTransactionProcessed';
  public readonly aggregateType = 'WagerTransaction';
  public readonly aggregateId: string;
  public readonly occurredAt: string;
  public readonly payload: {
    transactionId: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    roundId: string;
    gameId: string;
    kind: string;
    amount: string;
    currency: string;
    observedBalance: string;
  };

  constructor(params: {
    transactionId: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    roundId: string;
    gameId: string;
    kind: string;
    amount: string;
    currency: string;
    observedBalance: string;
    occurredAt?: string;
  }) {
    this.aggregateId = params.transactionId;
    this.occurredAt = params.occurredAt ?? new Date().toISOString();
    this.payload = {
      transactionId: params.transactionId,
      walletId: params.walletId,
      playerId: params.playerId,
      providerId: params.providerId,
      externalTransactionId: params.externalTransactionId,
      roundId: params.roundId,
      gameId: params.gameId,
      kind: params.kind,
      amount: params.amount,
      currency: params.currency,
      observedBalance: params.observedBalance,
    };
  }
}

export class WagerTransactionRejectedEvent implements DomainEvent {
  public readonly eventName = 'WagerTransactionRejected';
  public readonly aggregateType = 'WagerTransaction';
  public readonly aggregateId: string;
  public readonly occurredAt: string;
  public readonly payload: {
    transactionId: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    roundId: string;
    gameId: string;
    kind: string;
    amount: string;
    currency: string;
    reason: string;
    observedBalance: string;
  };

  constructor(params: {
    transactionId: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    roundId: string;
    gameId: string;
    kind: string;
    amount: string;
    currency: string;
    reason: string;
    observedBalance: string;
    occurredAt?: string;
  }) {
    this.aggregateId = params.transactionId;
    this.occurredAt = params.occurredAt ?? new Date().toISOString();
    this.payload = {
      transactionId: params.transactionId,
      walletId: params.walletId,
      playerId: params.playerId,
      providerId: params.providerId,
      externalTransactionId: params.externalTransactionId,
      roundId: params.roundId,
      gameId: params.gameId,
      kind: params.kind,
      amount: params.amount,
      currency: params.currency,
      reason: params.reason,
      observedBalance: params.observedBalance,
    };
  }
}

export class WalletBalanceChangedEvent implements DomainEvent {
  public readonly eventName = 'WalletBalanceChanged';
  public readonly aggregateType = 'Wallet';
  public readonly aggregateId: string;
  public readonly occurredAt: string;
  public readonly payload: {
    walletId: string;
    playerId: string;
    currency: string;
    previousBalance: string;
    currentBalance: string;
    version: number;
    triggerTransactionId: string;
  };

  constructor(params: {
    walletId: string;
    playerId: string;
    currency: string;
    previousBalance: string;
    currentBalance: string;
    version: number;
    triggerTransactionId: string;
    occurredAt?: string;
  }) {
    this.aggregateId = params.walletId;
    this.occurredAt = params.occurredAt ?? new Date().toISOString();
    this.payload = {
      walletId: params.walletId,
      playerId: params.playerId,
      currency: params.currency,
      previousBalance: params.previousBalance,
      currentBalance: params.currentBalance,
      version: params.version,
      triggerTransactionId: params.triggerTransactionId,
    };
  }
}
