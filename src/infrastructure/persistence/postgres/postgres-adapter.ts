import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { Wallet } from '../../../domain/entities/wallet.entity';
import { WagerTransaction } from '../../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.entity';
import { DomainEvent } from '../../../domain/events/events';
import { Money } from '../../../domain/value-objects/money.vo';
import {
  OutboxRepositoryPort,
  UnitOfWorkPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
  WagerTransactionRepositoryPort,
} from '../../../application/ports/ports';

export class PostgresUnitOfWork implements UnitOfWorkPort {
  private readonly pool: pg.Pool;
  private readonly asyncLocalStorage = new AsyncLocalStorage<pg.PoolClient>();
  private readonly ownsPool: boolean;

  constructor(poolOrConfig?: pg.Pool | pg.PoolConfig) {
    if (poolOrConfig instanceof pg.Pool) {
      this.pool = poolOrConfig;
      this.ownsPool = false;
    } else {
      this.pool = new pg.Pool(
        poolOrConfig ?? {
          host: process.env.APP_DB_HOST || '127.0.0.1',
          port: Number(process.env.APP_DB_PORT) || 5432,
          database: process.env.APP_DB_NAME || 'betting_db',
          user: process.env.APP_DB_USER || 'app_user',
          password: process.env.APP_DB_PASSWORD || 'app_user_secret',
          max: 50,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        }
      );
      this.ownsPool = true;
    }
  }

  public getClient(): pg.Pool | pg.PoolClient {
    return this.asyncLocalStorage.getStore() ?? this.pool;
  }

  public async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    const existingClient = this.asyncLocalStorage.getStore();
    if (existingClient) {
      return await work();
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.asyncLocalStorage.run(client, async () => {
        return await work();
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Rollback log if needed
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

export class PostgresWalletRepository implements WalletRepositoryPort {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  public async findById(id: string, lockForUpdate = false): Promise<Wallet | null> {
    const client = this.uow.getClient();
    const query = lockForUpdate
      ? 'SELECT id, player_id, currency, balance, version, created_at, updated_at FROM wallets WHERE id = $1 FOR UPDATE'
      : 'SELECT id, player_id, currency, balance, version, created_at, updated_at FROM wallets WHERE id = $1';

    const res = await client.query(query, [id]);
    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: Money.rehydrate(row.balance, row.currency),
      version: row.version,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }

  public async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const client = this.uow.getClient();
    const res = await client.query(
      'SELECT id, player_id, currency, balance, version, created_at, updated_at FROM wallets WHERE player_id = $1 AND currency = $2',
      [playerId, currency]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: Money.rehydrate(row.balance, row.currency),
      version: row.version,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }

  public async save(wallet: Wallet): Promise<void> {
    const client = this.uow.getClient();
    await client.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         balance = EXCLUDED.balance,
         version = EXCLUDED.version,
         updated_at = EXCLUDED.updated_at`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.getAmount(),
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ]
    );
  }
}

export class PostgresWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  public async findById(id: string): Promise<WagerTransaction | null> {
    const client = this.uow.getClient();
    const res = await client.query('SELECT * FROM wager_transactions WHERE id = $1', [id]);
    if (res.rows.length === 0) {
      return null;
    }
    return this.mapToWagerTransaction(res.rows[0]);
  }

  public async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const client = this.uow.getClient();
    const res = await client.query('SELECT * FROM wager_transactions WHERE idempotency_key = $1', [key]);
    if (res.rows.length === 0) {
      return null;
    }
    return this.mapToWagerTransaction(res.rows[0]);
  }

  public async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const client = this.uow.getClient();
    const res = await client.query(
      'SELECT * FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2',
      [providerId, externalTransactionId]
    );
    if (res.rows.length === 0) {
      return null;
    }
    return this.mapToWagerTransaction(res.rows[0]);
  }

  public async save(transaction: WagerTransaction): Promise<void> {
    const client = this.uow.getClient();
    await client.query(
      `INSERT INTO wager_transactions (
        id, wallet_id, player_id, provider_id, external_transaction_id,
        round_id, game_id, kind, amount, currency, status,
        rejection_reason, idempotency_key, payload_hash, response_snapshot,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        rejection_reason = EXCLUDED.rejection_reason,
        response_snapshot = EXCLUDED.response_snapshot,
        updated_at = EXCLUDED.updated_at`,
      [
        transaction.id,
        transaction.walletId,
        transaction.playerId,
        transaction.providerId,
        transaction.externalTransactionId,
        transaction.roundId,
        transaction.gameId,
        transaction.kind,
        transaction.money.getAmount(),
        transaction.money.getCurrency(),
        transaction.status,
        transaction.rejectionReason,
        transaction.idempotencyKey,
        transaction.payloadHash,
        transaction.responseSnapshot ? JSON.stringify(transaction.responseSnapshot) : null,
        transaction.createdAt,
        transaction.updatedAt,
      ]
    );
  }

  private mapToWagerTransaction(row: any): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      walletId: row.wallet_id,
      playerId: row.player_id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: Money.rehydrate(row.amount, row.currency),
      status: row.status,
      rejectionReason: row.rejection_reason,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      responseSnapshot: typeof row.response_snapshot === 'string' ? JSON.parse(row.response_snapshot) : row.response_snapshot,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }
}

export class PostgresWalletLedgerRepository implements WalletLedgerRepositoryPort {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  public async save(entry: WalletLedgerEntry): Promise<void> {
    const client = this.uow.getClient();
    await client.query(
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, entry_type, amount, currency, balance_before, balance_after, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.entryType,
        entry.amount.getAmount(),
        entry.currency,
        entry.balanceBefore.getAmount(),
        entry.balanceAfter.getAmount(),
        entry.createdAt,
      ]
    );
  }

  public async listByWalletId(walletId: string): Promise<WalletLedgerEntry[]> {
    const client = this.uow.getClient();
    const res = await client.query(
      `SELECT id, wallet_id, transaction_id, entry_type, amount, currency, balance_before, balance_after, created_at
       FROM wallet_ledger_entries
       WHERE wallet_id = $1
       ORDER BY created_at ASC, id ASC`,
      [walletId]
    );

    return res.rows.map((row) =>
      WalletLedgerEntry.rehydrate({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        entryType: row.entry_type,
        amount: Money.rehydrate(row.amount, row.currency),
        currency: row.currency,
        balanceBefore: Money.rehydrate(row.balance_before, row.currency),
        balanceAfter: Money.rehydrate(row.balance_after, row.currency),
        createdAt: new Date(row.created_at).toISOString(),
      })
    );
  }
}

export class PostgresOutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly uow: PostgresUnitOfWork) {}

  public async save(event: DomainEvent): Promise<void> {
    const client = this.uow.getClient();
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO outbox_messages (id, aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        event.aggregateType,
        event.aggregateId,
        event.eventName,
        JSON.stringify(event.payload),
        event.occurredAt,
      ]
    );
  }
}
