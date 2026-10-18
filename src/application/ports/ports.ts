import { Wallet } from '../../domain/entities/wallet.entity';
import { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.entity';
import { IntegrationEvent, IntegrationEventEnvelope } from '../../domain/events/events';

export interface WalletRepositoryPort {
  findById(id: string, lockForUpdate?: boolean): Promise<Wallet | null>;
  findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}

export interface ClaimedPendingReference {
  id: string;
  walletId: string;
  leaseToken: string;
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface WagerTransactionRepositoryPort {
  findById(id: string, lockForUpdate?: boolean): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  findByProviderAndReference(providerId: string, referenceExternalTransactionId: string, kind?: string): Promise<WagerTransaction | null>;
  listPendingReferences(limit?: number): Promise<WagerTransaction[]>;
  claimPendingReferences(limit: number, leaseDurationMs: number, owner: string): Promise<ClaimedPendingReference[]>;
  releaseLease(id: string, token: string): Promise<boolean>;
  renewLease(id: string, token: string, leaseDurationMs: number): Promise<boolean>;
  markOperationallyBlocked(id: string, token: string, reason: string): Promise<boolean>;
  isLeaseValid(id: string, token: string): Promise<boolean>;
  save(transaction: WagerTransaction): Promise<void>;
}

export interface WalletLedgerRepositoryPort {
  save(entry: WalletLedgerEntry): Promise<void>;
  listByWalletId(walletId: string): Promise<WalletLedgerEntry[]>;
}

export interface ClaimedOutboxMessage {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  version: number;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  payload: any;
  leaseToken: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  attempts: number;
}

export interface OutboxQueuePublisherPort {
  publish(
    event: IntegrationEventEnvelope,
    options?: { signal?: AbortSignal }
  ): Promise<{ messageId: string }>;
}

export interface OutboxRepositoryPort {
  save(event: IntegrationEvent<unknown>): Promise<void>;
  listUnpublished(limit?: number): Promise<IntegrationEventEnvelope[]>;
  findById(id: string): Promise<IntegrationEventEnvelope | null>;
  claimUnpublishedEvents(
    batchSize?: number,
    leaseDurationMs?: number,
    owner?: string
  ): Promise<ClaimedOutboxMessage[]>;
  markPublished(id: string, leaseToken: string): Promise<boolean>;
  recordFailure(
    id: string,
    leaseToken: string,
    retryDelayMs: number,
    errorMessage: string
  ): Promise<boolean>;
  markOperationallyBlocked(
    id: string,
    leaseToken: string,
    reason: string,
    errorMessage?: string
  ): Promise<boolean>;
  releaseLease(id: string, leaseToken: string): Promise<boolean>;
}

export interface UnitOfWorkPort {
  runInTransaction<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
