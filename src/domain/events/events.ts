export interface IntegrationEventEnvelope<T = unknown> {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId?: string | null;
  occurredAt: string;
  data: T;
}

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

  public toEnvelope(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId ?? null,
      occurredAt: this.occurredAt,
      data: this.data,
    };
  }

  public static reconstruct(envelope: IntegrationEventEnvelope<any>): IntegrationEvent<any> {
    return new ReconstructedIntegrationEvent(envelope);
  }
}

export class ReconstructedIntegrationEvent extends IntegrationEvent<unknown> {
  public readonly eventType: string;
  public readonly version: number;

  constructor(envelope: IntegrationEventEnvelope<unknown>) {
    super({
      eventId: envelope.eventId,
      occurredAt: envelope.occurredAt,
      aggregateId: envelope.aggregateId,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId ?? undefined,
      data: envelope.data,
    });
    this.eventType = envelope.eventType;
    this.version = envelope.version;
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
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'OPENING';
  amount: { amount: string; currency: string };
  balance: { amount: string; currency: string };
  referenceExternalTransactionId?: string | null;
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
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount: { amount: string; currency: string };
  balance: { amount: string; currency: string };
  failureCode: string;
  referenceExternalTransactionId?: string | null;
}

export class WagerTransactionRejectedEvent extends IntegrationEvent<WagerTransactionRejectedData> {
  public readonly eventType = 'WagerTransactionRejected';
  public readonly version = 1;
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: 'REFUND' | 'ROLLBACK' | 'WIN';
  amount: { amount: string; currency: string };
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReferenceEvent extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  public readonly eventType = 'WagerTransactionPendingReference';
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
