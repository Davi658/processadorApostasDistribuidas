export abstract class IntegrationEvent<T> {
  public readonly eventId: string;
  public readonly occurredAt: string;
  public abstract readonly eventType: string;
  public abstract readonly version: number;
  public readonly aggregateId: string;
  public readonly correlationId: string;
  public readonly causationId?: string;
  public readonly data: T;

  constructor(params: {
    eventId?: string;
    occurredAt?: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    data: T;
  }) {
    this.eventId = params.eventId ?? crypto.randomUUID();
    this.occurredAt = params.occurredAt ?? new Date().toISOString();
    this.aggregateId = params.aggregateId;
    this.correlationId = params.correlationId;
    this.causationId = params.causationId;
    this.data = params.data;
  }
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'OPENING';
  amount: { amount: string; currency: string };
  balance: { amount: string; currency: string };
}

export class WagerTransactionProcessedEvent extends IntegrationEvent<WagerTransactionProcessedData> {
  public readonly eventType = 'WagerTransactionProcessed';
  public readonly version = 1;
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: 'BET';
  amount: { amount: string; currency: string };
  balance: { amount: string; currency: string };
  failureCode: string;
}

export class WagerTransactionRejectedEvent extends IntegrationEvent<WagerTransactionRejectedData> {
  public readonly eventType = 'WagerTransactionRejected';
  public readonly version = 1;
}

export interface WalletBalanceChangedData {
  walletId: string;
  playerId: string;
  currency: string;
  previousBalance: { amount: string; currency: string };
  currentBalance: { amount: string; currency: string };
  version: number;
  triggerTransactionId: string;
}

export class WalletBalanceChangedEvent extends IntegrationEvent<WalletBalanceChangedData> {
  public readonly eventType = 'WalletBalanceChanged';
  public readonly version = 1;
}
