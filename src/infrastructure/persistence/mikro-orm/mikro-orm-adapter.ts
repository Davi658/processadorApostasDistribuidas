import { AsyncLocalStorage } from 'node:async_hooks';
import { LockMode, type Options } from '@mikro-orm/core';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Wallet } from '../../../domain/entities/wallet.entity';
import { WagerTransaction } from '../../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.entity';
import { Money } from '../../../domain/value-objects/money.vo';
import { IntegrationEvent, IntegrationEventEnvelope } from '../../../domain/events/events';
import {
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
  | 'after_wallet_save'
  | 'after_tx_save'
  | 'after_ledger_save'
  | 'after_outbox_save';

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWorkPort, OnModuleInit, OnModuleDestroy {
  private orm!: MikroORM;
  private readonly asyncLocalStorage = new AsyncLocalStorage<EntityManager>();
  private readonly testHooks = new Map<FailureHookPoint, (entity?: any) => void>();

  constructor(@Optional() private readonly customConfig?: Options) {}

  public async onModuleInit(): Promise<void> {
    if (!this.orm) {
      this.orm = (await MikroORM.init(this.customConfig ?? defaultMikroOrmConfig)) as MikroORM;
    }
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.orm) {
      await this.orm.close(true);
    }
  }

  public async init(config?: Options): Promise<void> {
    if (!this.orm) {
      this.orm = (await MikroORM.init(config ?? this.customConfig ?? defaultMikroOrmConfig)) as MikroORM;
    }
  }

  public async close(): Promise<void> {
    if (this.orm) {
      await this.orm.close(true);
    }
  }

  public getOrm(): MikroORM {
    return this.orm;
  }

  public getEntityManager(): EntityManager {
    const store = this.asyncLocalStorage.getStore();
    if (store) {
      return store;
    }
    // Fork a request-isolated EntityManager if called outside an explicit transaction
    return this.orm.em.fork();
  }

  public setTestFailurePoint(point: FailureHookPoint, callback?: (entity?: any) => void): void {
    this.testHooks.set(
      point,
      callback ??
        (() => {
          throw new Error(`Injected failure at test point: ${point}`);
        })
    );
  }

  public setTestHook(point: FailureHookPoint, callback?: (entity?: any) => void): void {
    this.setTestFailurePoint(point, callback);
  }

  public clearTestFailurePoints(): void {
    this.testHooks.clear();
  }

  public clearTestHooks(): void {
    this.clearTestFailurePoints();
  }

  public triggerTestHook(point: FailureHookPoint, entity?: any): void {
    const hook = this.testHooks.get(point);
    if (hook) {
      hook(entity);
    }
  }

  public async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    // If already in a transactional context, continue inside it
    const existingStore = this.asyncLocalStorage.getStore();
    if (existingStore) {
      return await work();
    }

    return await this.orm.em.transactional(async (forkedEm) => {
      return await this.asyncLocalStorage.run(forkedEm, async () => {
        const result = await work();
        await forkedEm.flush();
        return result;
      });
    });
  }
}

@Injectable()
export class MikroOrmWalletRepository implements WalletRepositoryPort {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  private get em(): EntityManager {
    return this.uow.getEntityManager();
  }

  public async findById(id: string, lockForUpdate = false): Promise<Wallet | null> {
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
    this.uow.triggerTestHook('after_wallet_save', ormEntity);
  }
}

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  private get em(): EntityManager {
    return this.uow.getEntityManager();
  }

  public async findById(id: string): Promise<WagerTransaction | null> {
    const em = this.em;
    const ormEntity = await em.findOne(WagerTransactionOrmEntity, { id });
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
    const entities = await em.find(
      WagerTransactionOrmEntity,
      {
        status: 'PENDING_REFERENCE',
        nextAttemptAt: { $lte: new Date() },
      },
      { limit, orderBy: { nextAttemptAt: 'ASC' } }
    );
    return entities.map((e) => this.toDomain(e));
  }

  public async save(transaction: WagerTransaction): Promise<void> {
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
    ormEntity.updatedAt = new Date(transaction.updatedAt);

    await em.persistAndFlush(ormEntity);
    this.uow.triggerTestHook('after_tx_save', ormEntity);
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
    this.uow.triggerTestHook('after_ledger_save', ormEntity);
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
    this.uow.triggerTestHook('after_outbox_save', ormEntity);
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
}
