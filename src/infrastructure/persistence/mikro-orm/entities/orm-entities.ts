import { Entity, PrimaryKey, Property, Unique, Check, Index } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'], name: 'uq_wallets_player_currency' })
@Unique({ properties: ['id', 'currency'], name: 'uq_wallets_id_currency' })
@Check({ expression: 'balance >= 0', name: 'chk_wallets_balance_non_negative' })
export class WalletOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Index({ name: 'idx_wallets_player_id' })
  @Property({ fieldName: 'player_id', length: 128 })
  playerId!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ columnType: 'numeric(18,2)', type: 'string' })
  balance!: string;

  @Property({ default: 1 })
  version!: number;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt: Date = new Date();

  @Property({ fieldName: 'updated_at', columnType: 'timestamptz' })
  updatedAt: Date = new Date();
}

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'externalTransactionId'], name: 'uq_wager_transactions_provider_external' })
@Unique({ properties: ['idempotencyKey'], name: 'uq_wager_transactions_idempotency_key' })
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Index({ name: 'idx_wager_transactions_wallet_id' })
  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', length: 128 })
  playerId!: string;

  @Property({ fieldName: 'provider_id', length: 128 })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', length: 128 })
  externalTransactionId!: string;

  @Property({ fieldName: 'round_id', length: 128 })
  roundId!: string;

  @Property({ fieldName: 'game_id', length: 128 })
  gameId!: string;

  @Property({ length: 32 })
  kind!: string;

  @Property({ columnType: 'numeric(18,2)', type: 'string' })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ length: 32 })
  status!: string;

  @Property({ fieldName: 'rejection_reason', length: 255, nullable: true })
  rejectionReason?: string | null;

  @Property({ fieldName: 'idempotency_key', length: 255, nullable: true })
  idempotencyKey?: string | null;

  @Property({ fieldName: 'payload_hash', length: 64, nullable: true })
  payloadHash?: string | null;

  @Property({ fieldName: 'response_snapshot', type: 'json', nullable: true })
  responseSnapshot?: any | null;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt: Date = new Date();

  @Property({ fieldName: 'updated_at', columnType: 'timestamptz' })
  updatedAt: Date = new Date();
}

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['transactionId', 'walletId'], name: 'uq_wallet_ledger_entries_tx_wallet' })
export class WalletLedgerOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Property({ fieldName: 'entry_type', length: 16 })
  entryType!: string;

  @Property({ columnType: 'numeric(18,2)', type: 'string' })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ fieldName: 'balance_before', columnType: 'numeric(18,2)', type: 'string' })
  balanceBefore!: string;

  @Property({ fieldName: 'balance_after', columnType: 'numeric(18,2)', type: 'string' })
  balanceAfter!: string;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt: Date = new Date();
}

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'aggregate_type', length: 64, default: 'Wallet' })
  aggregateType!: string;

  @Property({ fieldName: 'aggregate_id', length: 128 })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', length: 64 })
  eventType!: string;

  @Property({ default: 1 })
  version!: number;

  @Property({ fieldName: 'correlation_id', length: 128, default: '' })
  correlationId!: string;

  @Property({ fieldName: 'causation_id', length: 128, nullable: true })
  causationId?: string | null;

  @Property({ fieldName: 'occurred_at', columnType: 'timestamptz' })
  occurredAt: Date = new Date();

  @Property({ type: 'json' })
  payload!: any;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt: Date = new Date();

  @Property({ fieldName: 'published_at', columnType: 'timestamptz', nullable: true })
  publishedAt?: Date | null;
}
