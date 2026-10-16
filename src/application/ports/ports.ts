import { Wallet } from '../../domain/entities/wallet.entity';
import { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.entity';
import { DomainEvent } from '../../domain/events/events';

export interface WalletRepositoryPort {
  findById(id: string, lockForUpdate?: boolean): Promise<Wallet | null>;
  findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  save(transaction: WagerTransaction): Promise<void>;
}

export interface WalletLedgerRepositoryPort {
  save(entry: WalletLedgerEntry): Promise<void>;
  listByWalletId(walletId: string): Promise<WalletLedgerEntry[]>;
}

export interface OutboxRepositoryPort {
  save(event: DomainEvent): Promise<void>;
}

export interface UnitOfWorkPort {
  runInTransaction<T>(work: () => Promise<T>): Promise<T>;
}
