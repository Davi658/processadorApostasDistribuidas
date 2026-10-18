import { AsyncLocalStorage } from 'node:async_hooks';
import type { Knex } from 'knex';
import { LockMode, type Options } from '@mikro-orm/core';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Injectable, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { Wallet } from '../../../domain/entities/wallet.entity';
import { WagerTransaction } from '../../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.entity';
import { Money } from '../../../domain/value-objects/money.vo';
import { IntegrationEvent, IntegrationEventEnvelope } from '../../../domain/events/events';
import {
  TransactionRequiredError,
  TransactionRollbackOnlyError,
} from '../../../domain/errors/domain.error';
import {
  ClaimedOutboxMessage,
  OutboxRepositoryPort,
  UnitOfWorkPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
  WagerTransactionRepositoryPort,
} from '../../../application/ports/ports';
import {
  OutboxMessageOrmEntity,
  WagerTransactionOrmEntity,
  WalletLedgerOrmEntity,
  WalletOrmEntity,
} from './entities/orm-entities';
import defaultMikroOrmConfig from './mikro-orm.config';

export type FailureHookPoint =
  | 'after_inbox_save'
  | 'after_wallet_save'
  | 'after_tx_save'
  | 'after_ledger_save'
  | 'after_outbox_save'
  | 'after_begin'
  | 'before_commit'
  | 'after_commit';

export interface TransactionContext {
  id?: string;
  em: EntityManager;
  depth: number;
  rollbackOnly: boolean;
  rollbackReason?: unknown;
  phase?: 'working' | 'committing' | 'committed' | 'rolled_back';
}

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWorkPort, OnModuleInit, OnApplicationShutdown {
  private orm?: MikroORM;
  private readonly asyncLocalStorage = new AsyncLocalStorage<TransactionContext>();
  private readonly testHooks = new Map<FailureHookPoint, (entity?: any) => void | Promise<void>>();
  private readonly activeTransactions = new Set<TransactionContext>();
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;

  constructor(@Optional() private readonly customConfig?: Options) {
    this.lockTimeoutMs = Number(process.env.DB_LOCK_TIMEOUT_MS) || 5000;
    this.statementTimeoutMs = Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 10000;
  }

  public async onModuleInit(): Promise<void> {
    if (!this.orm) {
      this.orm = (await MikroORM.init(this.customConfig ?? defaultMikroOrmConfig)) as MikroORM;
    }
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  public async init(config?: Options): Promise<void> {
    if (!this.orm) {
      this.orm = (await MikroORM.init(config ?? this.customConfig ?? defaultMikroOrmConfig)) as MikroORM;
    }
  }

  public async close(): Promise<void> {
    if (this.orm) {
      const ormInstance = this.orm;
      this.orm = undefined;
      this.markAllRollbackOnly(new Error('ORM_CLOSED'));
      await ormInstance.close(true);
    }
  }

  public isClosed(): boolean {
    return !this.orm;
  }

  public markAllRollbackOnly(reason?: unknown): void {
    for (const ctx of this.activeTransactions) {
      if (ctx.phase && ctx.phase !== 'working') continue;
      ctx.rollbackOnly = true;
      if (!ctx.rollbackReason) {
        ctx.rollbackReason = reason;
      }
    }
  }

  public getActiveTransactionsCount(): number {
    return this.activeTransactions.size;
  }

  public getOrm(): MikroORM {
    if (!this.orm) {
      throw new Error('MikroORM has not been initialized. Call init() or onModuleInit() first.');
    }
    return this.orm;
  }

  public isTransactionActive(): boolean {
    return this.asyncLocalStorage.getStore() !== undefined;
  }

  public getTransactionContext(): TransactionContext | undefined {
    return this.asyncLocalStorage.getStore();
  }

  public getEntityManager(): EntityManager {
    const store = this.asyncLocalStorage.getStore();
    if (store) {
      return store.em;
    }
    // Fork a request-isolated EntityManager if called outside an explicit transaction
    return this.getOrm().em.fork();
  }

  public setTestFailurePoint(point: FailureHookPoint, callback?: (entity?: any) => void | Promise<void>): void {
    this.testHooks.set(
      point,
      callback ??
        (() => {
          throw new Error(`Injected failure at test point: ${point}`);
        })
    );
  }

  public setTestHook(point: FailureHookPoint, callback?: (entity?: any) => void | Promise<void>): void {
    this.setTestFailurePoint(point, callback);
  }

  public clearTestFailurePoints(): void {
    this.testHooks.clear();
  }

  public clearTestHooks(): void {
    this.clearTestFailurePoints();
  }

  public async triggerTestHook(point: FailureHookPoint, entity?: any): Promise<void> {
    const hook = this.testHooks.get(point);
    if (hook) {
      await hook(entity);
    }
  }

  public async runInTransaction<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.orm) {
      await this.init();
    }
    const orm = this.getOrm();
    const existingStore = this.asyncLocalStorage.getStore();

    if (existingStore) {
      // Nested transaction: reuse outer transaction without committing independently
      existingStore.depth++;
      try {
        if (existingStore.rollbackOnly) {
          throw new TransactionRollbackOnlyError(
            'Cannot execute work in nested transaction marked as rollback-only',
            existingStore.rollbackReason
          );
        }
        return await work();
      } catch (innerErr) {
        // Internal failure marks outer transaction as rollback-only to prevent partial commits
        existingStore.rollbackOnly = true;
        if (!existingStore.rollbackReason) {
          existingStore.rollbackReason = innerErr;
        }
        throw innerErr;
      } finally {
        existingStore.depth--;
      }
    }

    // Own the complete lifecycle: cancellation stays attached through flush and
    // commit preparation. The captured context never depends on the abort caller's ALS.
    const em = orm.em.fork();
    const context: TransactionContext = {
      id: crypto.randomUUID(), em, depth: 0, rollbackOnly: false, phase: 'working',
    };
    const onAbort = () => {
      // Once COMMIT has been dispatched, await its actual outcome. Never report
      // rollback merely because shutdown arrived while its acknowledgement was pending.
      if (context.phase !== 'working') return;
      context.rollbackOnly = true;
      context.rollbackReason = signal?.reason ?? new Error('ABORTED_BY_SHUTDOWN');
    };
    const assertCommittable = () => {
      if (context.rollbackOnly) {
        throw new TransactionRollbackOnlyError(
          'Transaction is rollback-only', context.rollbackReason
        );
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    this.activeTransactions.add(context);
    let begun = false;
    try {
      assertCommittable();
      await em.begin();
      begun = true;
      // PostgreSQL, rather than AbortController, bounds SQL and lock waits.
      // Fail closed if these limits cannot be installed.
      await em.execute(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'; SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms';`);
      const result = await this.asyncLocalStorage.run(context, async () => {
        assertCommittable();
        await this.triggerTestHook('after_begin');
        assertCommittable();
        const value = await work();
        assertCommittable();
        await this.triggerTestHook('before_commit');
        assertCommittable();
        await em.flush();
        assertCommittable();
        return value;
      });
      // No async boundary between final cancellation check and COMMIT dispatch.
      assertCommittable();
      const transaction = em.getTransactionContext<Knex.Transaction>()!;
      // Knex's public transaction API dispatches COMMIT directly. The ORM
      // connection wrapper awaits transaction event hooks before dispatch, which
      // would introduce a cancellation gap after our final check.
      context.phase = 'committing';
      transaction.commit();
      await transaction.executionPromise;
      context.phase = 'committed';
      em.resetTransactionContext();
      await this.triggerTestHook('after_commit', result);
      return result;
    } catch (error) {
      if (begun && context.phase !== 'committed') {
        await em.rollback();
        context.phase = 'rolled_back';
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.activeTransactions.delete(context);
      em.clear();
    }
  }
}

@Injectable()
export class MikroOrmWalletRepository implements WalletRepositoryPort {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  private get em(): EntityManager {
    return this.uow.getEntityManager();
  }

  public async findById(id: string, lockForUpdate = false): Promise<Wallet | null> {
    if (lockForUpdate && !this.uow.isTransactionActive()) {
      throw new TransactionRequiredError(
        'Pessimistic lock requires an active UnitOfWork transaction'
      );
    }
    const em = this.em;
    const ormEntity = await em.findOne(
      WalletOrmEntity,
      { id },
      lockForUpdate ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined
    );


    if (!ormEntity) {
      return null;
    }

    return Wallet.rehydrate({
      id: ormEntity.id,
      playerId: ormEntity.playerId,
      currency: ormEntity.currency,
      balance: Money.rehydrate(ormEntity.balance, ormEntity.currency),
      version: ormEntity.version,
      createdAt: ormEntity.createdAt.toISOString(),
      updatedAt: ormEntity.updatedAt.toISOString(),
    });
  }

  public async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const em = this.em;
    const ormEntity = await em.findOne(WalletOrmEntity, { playerId, currency });

    if (!ormEntity) {
      return null;
    }

    return Wallet.rehydrate({
      id: ormEntity.id,
      playerId: ormEntity.playerId,
      currency: ormEntity.currency,
      balance: Money.rehydrate(ormEntity.balance, ormEntity.currency),
      version: ormEntity.version,
      createdAt: ormEntity.createdAt.toISOString(),
      updatedAt: ormEntity.updatedAt.toISOString(),
    });
  }

  public async save(wallet: Wallet): Promise<void> {
    if (!this.uow.isTransactionActive()) {
      throw new TransactionRequiredError(
        'Write operation on WalletRepository requires an active UnitOfWork transaction'
      );
    }
    const em = this.em;
    let ormEntity = await em.findOne(WalletOrmEntity, { id: wallet.id });

    if (!ormEntity) {
      ormEntity = new WalletOrmEntity();
      ormEntity.id = wallet.id;
      ormEntity.playerId = wallet.playerId;
      ormEntity.currency = wallet.currency;
      ormEntity.createdAt = new Date(wallet.createdAt);
    }

    ormEntity.balance = wallet.balance.getAmount();
    ormEntity.version = wallet.version;
    ormEntity.updatedAt = new Date(wallet.updatedAt);

    await em.persistAndFlush(ormEntity);
    await this.uow.triggerTestHook('after_wallet_save', ormEntity);
  }
}

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  private get em(): EntityManager {
    return this.uow.getEntityManager();
  }

  public async findById(id: string, lockForUpdate = false): Promise<WagerTransaction | null> {
    const em = this.em;
    const ormEntity = await em.findOne(
      WagerTransactionOrmEntity,
      { id },
      lockForUpdate ? { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true } : undefined
    );
    if (!ormEntity) {
      return null;
    }
    return this.toDomain(ormEntity);
  }

  public async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const em = this.em;
    const ormEntity = await em.findOne(WagerTransactionOrmEntity, { idempotencyKey: key });
    if (!ormEntity) {
      return null;
    }
    return this.toDomain(ormEntity);
  }

  public async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string
  ): Promise<WagerTransaction | null> {
    const em = this.em;
    const ormEntity = await em.findOne(WagerTransactionOrmEntity, {
      providerId,
      externalTransactionId,
    });
    if (!ormEntity) {
      return null;
    }
    return this.toDomain(ormEntity);
  }

  public async findByProviderAndReference(
    providerId: string,
    referenceExternalTransactionId: string,
    kind?: string
  ): Promise<WagerTransaction | null> {
    const em = this.em;
    const where: any = {
      providerId,
      referenceExternalTransactionId,
      status: 'PROCESSED',
    };
    if (kind) {
      where.kind = kind;
    }
    const ormEntity = await em.findOne(WagerTransactionOrmEntity, where);
    if (!ormEntity) {
      return null;
    }
    return this.toDomain(ormEntity);
  }

  public async listPendingReferences(limit = 100): Promise<WagerTransaction[]> {
    const em = this.em;
    const query = `
      SELECT *
      FROM wager_transactions
      WHERE status = 'PENDING_REFERENCE'
        AND is_operationally_blocked = FALSE
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
      LIMIT ?;
    `;
    const rows = await em.execute<any[]>(query, [limit]);
    const ormEntities = rows.map((r) => em.map(WagerTransactionOrmEntity, r));
    return ormEntities.map((e) => this.toDomain(e));
  }

  public async claimPendingReferences(
    limit = 20,
    leaseDurationMs = 30000,
    owner = 'worker'
  ): Promise<Array<{ id: string; walletId: string; leaseToken: string; leaseOwner: string; leaseExpiresAt: string }>> {
    const em = this.em;
    const query = `
      WITH eligible AS (
        SELECT id
        FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'
          AND is_operationally_blocked = FALSE
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED
      )
      UPDATE wager_transactions wt
      SET lease_token = gen_random_uuid()::text,
          lease_owner = ?,
          lease_expires_at = NOW() + (? * INTERVAL '1 millisecond'),
          updated_at = NOW()
      FROM eligible
      WHERE wt.id = eligible.id
      RETURNING wt.id, wt.wallet_id, wt.lease_token, wt.lease_owner, wt.lease_expires_at;
    `;

    const results = await em.execute<
      Array<{
        id: string;
        wallet_id: string;
        lease_token: string;
        lease_owner: string;
        lease_expires_at: Date | string;
      }>
    >(query, [limit, owner, leaseDurationMs]);

    return (results || []).map((row) => ({
      id: row.id,
      walletId: row.wallet_id,
      leaseToken: row.lease_token,
      leaseOwner: row.lease_owner,
      leaseExpiresAt:
        row.lease_expires_at instanceof Date
          ? row.lease_expires_at.toISOString()
          : new Date(row.lease_expires_at).toISOString(),
    }));
  }

  public async releaseLease(id: string, token: string): Promise<boolean> {
    const em = this.em;
    const query = `
      UPDATE wager_transactions
      SET lease_token = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ? AND lease_token = ?
      RETURNING id;
    `;
    const res = await em.execute<Array<{ id: string }>>(query, [id, token]);
    return Array.isArray(res) && res.length > 0;
  }

  public async renewLease(id: string, token: string, leaseDurationMs: number): Promise<boolean> {
    const em = this.em;
    const query = `
      UPDATE wager_transactions
      SET lease_expires_at = NOW() + (? * INTERVAL '1 millisecond'),
          updated_at = NOW()
      WHERE id = ?
        AND lease_token = ?
        AND lease_expires_at > NOW()
        AND status = 'PENDING_REFERENCE'
        AND is_operationally_blocked = FALSE
      RETURNING id;
    `;
    const res = await em.execute<Array<{ id: string }>>(query, [leaseDurationMs, id, token]);
    return Array.isArray(res) && res.length > 0;
  }

  public async markOperationallyBlocked(id: string, token: string, reason: string): Promise<boolean> {
    const em = this.em;
    const query = `
      UPDATE wager_transactions
      SET is_operationally_blocked = TRUE,
          operational_block_reason = ?,
          lease_token = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE id = ?
        AND lease_token = ?
        AND lease_expires_at > NOW()
        AND is_operationally_blocked = FALSE
      RETURNING id;
    `;
    const res = await em.execute<Array<{ id: string }>>(query, [reason, id, token]);
    return Array.isArray(res) && res.length > 0;
  }

  public async isLeaseValid(id: string, token: string): Promise<boolean> {
    const em = this.em;
    const query = `
      SELECT id
      FROM wager_transactions
      WHERE id = ?
        AND lease_token = ?
        AND lease_expires_at > NOW()
        AND status = 'PENDING_REFERENCE'
        AND is_operationally_blocked = FALSE;
    `;
    const res = await em.execute<Array<{ id: string }>>(query, [id, token]);
    return Array.isArray(res) && res.length > 0;
  }

  public async save(transaction: WagerTransaction): Promise<void> {
    if (!this.uow.isTransactionActive()) {
      throw new TransactionRequiredError(
        'Write operation on WagerTransactionRepository requires an active UnitOfWork transaction'
      );
    }
    const em = this.em;
    let ormEntity = await em.findOne(WagerTransactionOrmEntity, { id: transaction.id });

    if (!ormEntity) {
      ormEntity = new WagerTransactionOrmEntity();
      ormEntity.id = transaction.id;
      ormEntity.createdAt = new Date(transaction.createdAt);
    }

    ormEntity.walletId = transaction.walletId;
    ormEntity.playerId = transaction.playerId;
    ormEntity.providerId = transaction.providerId;
    ormEntity.externalTransactionId = transaction.externalTransactionId;
    ormEntity.roundId = transaction.roundId;
    ormEntity.gameId = transaction.gameId;
    ormEntity.kind = transaction.kind;
    ormEntity.amount = transaction.money.getAmount();
    ormEntity.currency = transaction.money.getCurrency();
    ormEntity.status = transaction.status;
    ormEntity.rejectionReason = transaction.rejectionReason;
    ormEntity.idempotencyKey = transaction.idempotencyKey;
    ormEntity.payloadHash = transaction.payloadHash;
    ormEntity.responseSnapshot = transaction.responseSnapshot;
    ormEntity.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    ormEntity.attempts = transaction.attempts;
    ormEntity.nextAttemptAt = transaction.nextAttemptAt ? new Date(transaction.nextAttemptAt) : null;
    ormEntity.leaseToken = transaction.leaseToken;
    ormEntity.leaseOwner = transaction.leaseOwner;
    ormEntity.leaseExpiresAt = transaction.leaseExpiresAt ? new Date(transaction.leaseExpiresAt) : null;
    ormEntity.isOperationallyBlocked = transaction.isOperationallyBlocked;
    ormEntity.operationalBlockReason = transaction.operationalBlockReason;
    ormEntity.updatedAt = new Date(transaction.updatedAt);

    await em.persistAndFlush(ormEntity);
    await this.uow.triggerTestHook('after_tx_save', ormEntity);
  }

  private toDomain(orm: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: orm.id,
      walletId: orm.walletId,
      playerId: orm.playerId,
      providerId: orm.providerId,
      externalTransactionId: orm.externalTransactionId,
      roundId: orm.roundId,
      gameId: orm.gameId,
      kind: orm.kind as any,
      money: Money.rehydrate(orm.amount, orm.currency),
      status: orm.status as any,
      rejectionReason: orm.rejectionReason ?? null,
      idempotencyKey: orm.idempotencyKey ?? null,
      payloadHash: orm.payloadHash ?? null,
      responseSnapshot: orm.responseSnapshot ?? null,
      referenceExternalTransactionId: orm.referenceExternalTransactionId ?? null,
      attempts: orm.attempts ?? 0,
      nextAttemptAt: orm.nextAttemptAt ? orm.nextAttemptAt.toISOString() : null,
      leaseToken: orm.leaseToken ?? null,
      leaseOwner: orm.leaseOwner ?? null,
      leaseExpiresAt: orm.leaseExpiresAt ? orm.leaseExpiresAt.toISOString() : null,
      isOperationallyBlocked: orm.isOperationallyBlocked ?? false,
      operationalBlockReason: orm.operationalBlockReason ?? null,
      createdAt: orm.createdAt.toISOString(),
      updatedAt: orm.updatedAt.toISOString(),
    });
  }
}

@Injectable()
export class MikroOrmWalletLedgerRepository implements WalletLedgerRepositoryPort {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  private get em(): EntityManager {
    return this.uow.getEntityManager();
  }

  public async save(entry: WalletLedgerEntry): Promise<void> {
    if (!this.uow.isTransactionActive()) {
      throw new TransactionRequiredError(
        'Write operation on WalletLedgerRepository requires an active UnitOfWork transaction'
      );
    }
    const em = this.em;
    const ormEntity = new WalletLedgerOrmEntity();
    ormEntity.id = entry.id;
    ormEntity.walletId = entry.walletId;
    ormEntity.transactionId = entry.transactionId;
    ormEntity.entryType = entry.entryType;
    ormEntity.amount = entry.amount.getAmount();
    ormEntity.currency = entry.amount.getCurrency();
    ormEntity.balanceBefore = entry.balanceBefore.getAmount();
    ormEntity.balanceAfter = entry.balanceAfter.getAmount();
    ormEntity.createdAt = new Date(entry.createdAt);

    await em.persistAndFlush(ormEntity);
    await this.uow.triggerTestHook('after_ledger_save', ormEntity);
  }

  public async listByWalletId(walletId: string): Promise<WalletLedgerEntry[]> {
    const em = this.em;
    const entities = await em.find(
      WalletLedgerOrmEntity,
      { walletId },
      { orderBy: { createdAt: 'ASC', id: 'ASC' } }
    );

    return entities.map((e) =>
      WalletLedgerEntry.rehydrate({
        id: e.id,
        walletId: e.walletId,
        transactionId: e.transactionId,
        entryType: e.entryType as 'CREDIT' | 'DEBIT',
        amount: Money.rehydrate(e.amount, e.currency),
        currency: e.currency,
        balanceBefore: Money.rehydrate(e.balanceBefore, e.currency),
        balanceAfter: Money.rehydrate(e.balanceAfter, e.currency),
        createdAt: e.createdAt.toISOString(),
      })
    );
  }
}

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  private get em(): EntityManager {
    return this.uow.getEntityManager();
  }

  public async save(event: IntegrationEvent<unknown>): Promise<void> {
    if (!this.uow.isTransactionActive()) {
      throw new TransactionRequiredError(
        'Write operation on OutboxRepository requires an active UnitOfWork transaction'
      );
    }
    const em = this.em;
    const ormEntity = new OutboxMessageOrmEntity();
    ormEntity.id = event.eventId;
    ormEntity.aggregateType = 'Wallet';
    ormEntity.aggregateId = event.aggregateId;
    ormEntity.eventType = event.eventType;
    ormEntity.version = event.version;
    ormEntity.correlationId = event.correlationId;
    ormEntity.causationId = event.causationId ?? null;
    ormEntity.occurredAt = new Date(event.occurredAt);
    ormEntity.payload = event.data;
    ormEntity.createdAt = new Date();


    await em.persistAndFlush(ormEntity);
    await this.uow.triggerTestHook('after_outbox_save', ormEntity);
  }

  public async listUnpublished(limit = 100): Promise<IntegrationEventEnvelope[]> {
    const em = this.em;
    const entities = await em.find(
      OutboxMessageOrmEntity,
      { publishedAt: null },
      { limit, orderBy: { createdAt: 'ASC' } }
    );

    return entities.map((e) => ({
      eventId: e.id,
      eventType: e.eventType,
      version: e.version,
      aggregateId: e.aggregateId,
      correlationId: e.correlationId,
      causationId: e.causationId ?? null,
      occurredAt: e.occurredAt.toISOString(),
      data: e.payload,
    }));
  }

  public async findById(id: string): Promise<IntegrationEventEnvelope | null> {
    const em = this.em;
    const e = await em.findOne(OutboxMessageOrmEntity, { id });
    if (!e) {
      return null;
    }
    return {
      eventId: e.id,
      eventType: e.eventType,
      version: e.version,
      aggregateId: e.aggregateId,
      correlationId: e.correlationId,
      causationId: e.causationId ?? null,
      occurredAt: e.occurredAt.toISOString(),
      data: e.payload,
    };
  }

  public async claimUnpublishedEvents(
    batchSize: number = 20,
    leaseDurationMs: number = 30000,
    owner: string = 'outbox-publisher'
  ): Promise<ClaimedOutboxMessage[]> {
    const em = this.em;
    const query = `
      WITH eligible AS (
        SELECT id
        FROM outbox_messages
        WHERE published_at IS NULL
          AND is_operationally_blocked = FALSE
          AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
          AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
        ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_messages om
      SET lease_token = gen_random_uuid()::text,
          lease_owner = ?,
          lease_expires_at = clock_timestamp() + (? * INTERVAL '1 millisecond')
      FROM eligible
      WHERE om.id = eligible.id
      RETURNING om.id, om.aggregate_type, om.aggregate_id, om.event_type, om.version,
                om.correlation_id, om.causation_id, om.occurred_at, om.payload,
                om.lease_token, om.lease_owner, om.lease_expires_at, om.attempts;
    `;

    const results = await em.execute<any[]>(query, [batchSize, owner, leaseDurationMs]);
    return (results || []).map((row) => ({
      id: row.id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      version: Number(row.version),
      correlationId: row.correlation_id,
      causationId: row.causation_id ?? null,
      occurredAt:
        row.occurred_at instanceof Date
          ? row.occurred_at.toISOString()
          : new Date(row.occurred_at).toISOString(),
      payload: row.payload,
      leaseToken: row.lease_token,
      leaseOwner: row.lease_owner,
      leaseExpiresAt:
        row.lease_expires_at instanceof Date
          ? row.lease_expires_at.toISOString()
          : new Date(row.lease_expires_at).toISOString(),
      attempts: Number(row.attempts || 0),
    }));
  }

  public async markPublished(id: string, leaseToken: string): Promise<boolean> {
    const em = this.em;
    const query = `
      UPDATE outbox_messages
      SET published_at = clock_timestamp(),
          lease_token = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = ? AND lease_token = ?
        AND published_at IS NULL AND is_operationally_blocked = FALSE
        AND lease_expires_at > clock_timestamp()
      RETURNING id;
    `;
    const res = await em.execute<any[]>(query, [id, leaseToken]);
    return Array.isArray(res) && res.length > 0;
  }

  public async recordFailure(
    id: string,
    leaseToken: string,
    retryDelayMs: number,
    errorMessage: string
  ): Promise<boolean> {
    const em = this.em;
    const query = `
      UPDATE outbox_messages
      SET attempts = attempts + 1,
          next_attempt_at = clock_timestamp() + (? * INTERVAL '1 millisecond'),
          last_error = ?,
          lease_token = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = ? AND lease_token = ?
        AND published_at IS NULL AND is_operationally_blocked = FALSE
        AND lease_expires_at > clock_timestamp()
      RETURNING id;
    `;
    const res = await em.execute<any[]>(query, [retryDelayMs, errorMessage, id, leaseToken]);
    return Array.isArray(res) && res.length > 0;
  }

  public async markOperationallyBlocked(
    id: string,
    leaseToken: string,
    reason: string,
    errorMessage?: string
  ): Promise<boolean> {
    const em = this.em;
    const query = `
      UPDATE outbox_messages
      SET is_operationally_blocked = TRUE,
          operational_block_reason = ?,
          last_error = COALESCE(?, last_error),
          lease_token = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = ? AND lease_token = ?
        AND published_at IS NULL AND is_operationally_blocked = FALSE
        AND lease_expires_at > clock_timestamp()
      RETURNING id;
    `;
    const res = await em.execute<any[]>(query, [reason, errorMessage ?? null, id, leaseToken]);
    return Array.isArray(res) && res.length > 0;
  }

  // Safe relinquishment accepts expired matching tokens; never mutates delivery/retry state.
  public async releaseLease(id: string, leaseToken: string): Promise<boolean> {
    const em = this.em;
    const query = `
      UPDATE outbox_messages
      SET lease_token = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = ? AND lease_token = ? AND published_at IS NULL
      RETURNING id;
    `;
    const res = await em.execute<any[]>(query, [id, leaseToken]);
    return Array.isArray(res) && res.length > 0;
  }
}
