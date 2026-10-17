import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import crypto from 'crypto';
import { AppModule } from '../../src/interfaces/http/app.module';
import { WageringQueryModule } from '../../src/interfaces/http/wagering-query.module';
import { DomainExceptionFilter } from '../../src/interfaces/http/filters/domain-exception.filter';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';
import { LedgerCursorCodec } from '../../src/application/pagination/ledger-cursor-codec';
import { PersistenceModule } from '../../src/infrastructure/persistence/persistence.module';
import { MikroOrmWalletRepository, MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { MikroOrmWalletLedgerQueryRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-wallet-ledger-query-repository';
import { GetWalletLedgerUseCase } from '../../src/application/use-cases/get-wallet-ledger.use-case';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { ModulesContainer } from '@nestjs/core';

describe('M17: Read Endpoints & Keyset Ledger Pagination', () => {
  let app: INestApplication;
  let serverUrl: string;
  let isolatedDb: IsolatedTestDatabase;
  let adminPool: pg.Pool;
  const previousWorkerEnabled = process.env.PENDING_WORKER_ENABLED;

  beforeAll(async () => {
    // 1. Create disposable database for isolated execution
    isolatedDb = await createIsolatedTestDatabase('m17_read_endpoints_');
    adminPool = new pg.Pool(isolatedDb.adminConfig);
    adminPool.on('error', () => {});

    process.env.PENDING_WORKER_ENABLED = 'false';
    // Exercise the actual application entry module, including its worker and persistence.
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'string' ? address : address.port;
    serverUrl = `http://127.0.0.1:${port}`;
  }, 30000);

  afterAll(async () => {
    try {
      if (app) {
        const uow = app.get(MikroOrmUnitOfWork);
        await app.close();
        expect(uow.isClosed()).toBe(true);
        const sessions = await adminPool.query('SELECT pid FROM pg_stat_activity WHERE datname = $1 AND usename = $2', [isolatedDb.dbName, isolatedDb.appConfig.user]);
        expect(sessions.rows).toEqual([]);
      }
    } finally {
      if (previousWorkerEnabled === undefined) delete process.env.PENDING_WORKER_ENABLED;
      else process.env.PENDING_WORKER_ENABLED = previousWorkerEnabled;
      if (adminPool) await adminPool.end();
      if (isolatedDb) await isolatedDb.closeAndDrop();
    }
  }, 30000);

  // Helper to create a wallet directly in PostgreSQL
  async function insertWallet(id: string, playerId: string, balance: string, currency = 'BRL'): Promise<void> {
    await adminPool.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, NOW(), NOW())`,
      [id, playerId, currency, balance]
    );
  }

  // Helper to insert a wager transaction directly in PostgreSQL
  async function insertTransaction(props: {
    id: string;
    walletId: string;
    playerId: string;
    providerId: string;
    externalTransactionId: string;
    roundId?: string;
    gameId?: string;
    kind?: string;
    amount?: string;
    currency?: string;
    status?: string;
    createdAt?: string;
  }): Promise<void> {
    const kind = props.kind ?? 'BET';
    const idempotencyKey = kind === 'BET' ? `idem-${props.id}` : null;
    const payloadHash = kind === 'BET' ? crypto.createHash('sha256').update(props.id).digest('hex') : null;
    const responseSnapshot = kind === 'BET' ? JSON.stringify({ status: props.status ?? 'PROCESSED' }) : null;

    await adminPool.query(
      `INSERT INTO wager_transactions (
        id, wallet_id, player_id, provider_id, external_transaction_id,
        round_id, game_id, kind, amount, currency, status,
        idempotency_key, payload_hash, response_snapshot,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
      [
        props.id,
        props.walletId,
        props.playerId,
        props.providerId,
        props.externalTransactionId,
        props.roundId ?? 'round-1',
        props.gameId ?? 'game-1',
        kind,
        props.amount ?? '10.00',
        props.currency ?? 'BRL',
        props.status ?? 'PROCESSED',
        idempotencyKey,
        payloadHash,
        responseSnapshot,
        props.createdAt ?? new Date().toISOString(),
      ]
    );
  }

  // Helper to insert a ledger entry directly in PostgreSQL
  async function insertLedgerEntry(props: {
    id: string;
    walletId: string;
    transactionId: string;
    entryType: 'CREDIT' | 'DEBIT';
    amount: string;
    currency?: string;
    balanceBefore: string;
    balanceAfter: string;
    createdAt?: string;
  }): Promise<void> {
    await adminPool.query(
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, entry_type, amount, currency, balance_before, balance_after, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        props.id,
        props.walletId,
        props.transactionId,
        props.entryType,
        props.amount,
        props.currency ?? 'BRL',
        props.balanceBefore,
        props.balanceAfter,
        props.createdAt ?? new Date().toISOString(),
      ]
    );
  }

  describe('1. GET /wagering/transactions/:transactionId', () => {
    it('should return 200 with transaction details and money as { amount, currency }', async () => {
      const walletId = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      const txId = crypto.randomUUID();
      const providerId = 'provider-alpha';
      const externalTxId = `ext-${crypto.randomUUID()}`;

      await insertWallet(walletId, playerId, '100.00');
      await insertTransaction({
        id: txId,
        walletId,
        playerId,
        providerId,
        externalTransactionId: externalTxId,
        amount: '25.50',
        currency: 'BRL',
        status: 'PROCESSED',
      });

      const res = await fetch(`${serverUrl}/wagering/transactions/${txId}`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.id).toBe(txId);
      expect(body.walletId).toBe(walletId);
      expect(body.playerId).toBe(playerId);
      expect(body.providerId).toBe(providerId);
      expect(body.externalTransactionId).toBe(externalTxId);
      expect(body.kind).toBe('BET');
      expect(body.status).toBe('PROCESSED');
      expect(body.money).toEqual({
        amount: '25.50',
        currency: 'BRL',
      });
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
    });

    it('should return 404 Not Found when transaction does not exist', async () => {
      const nonExistentId = crypto.randomUUID();
      const res = await fetch(`${serverUrl}/wagering/transactions/${nonExistentId}`);
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.statusCode).toBe(404);
      expect(body.error).toBe('Not Found');
      expect(body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('should return 400 Bad Request when transactionId is not a valid UUID', async () => {
      const invalidIds = ['invalid-id', '12345', '   ', 'not-a-uuid-format'];
      for (const id of invalidIds) {
        const res = await fetch(`${serverUrl}/wagering/transactions/${encodeURIComponent(id)}`);
        expect(res.status).toBe(400);

        const body = (await res.json()) as any;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
        expect(body.message).toContain('transactionId must be a valid UUID');
      }
    });
  });

  describe('2. GET /providers/:providerId/wagering/transactions/:externalTransactionId', () => {
    it('should return 200 with transaction details when querying by provider and external ID', async () => {
      const walletId = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      const txId = crypto.randomUUID();
      const providerId = 'pragmatic-play';
      const externalTxId = `bet-ext-${Date.now()}`;

      await insertWallet(walletId, playerId, '50.00');
      await insertTransaction({
        id: txId,
        walletId,
        playerId,
        providerId,
        externalTransactionId: externalTxId,
        amount: '50.00',
        currency: 'BRL',
        status: 'PROCESSED',
      });

      const res = await fetch(
        `${serverUrl}/providers/${providerId}/wagering/transactions/${externalTxId}`
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.id).toBe(txId);
      expect(body.providerId).toBe(providerId);
      expect(body.externalTransactionId).toBe(externalTxId);
      expect(body.money).toEqual({
        amount: '50.00',
        currency: 'BRL',
      });
    });

    it('should return 404 Not Found when provider or external ID is unknown', async () => {
      const res = await fetch(
        `${serverUrl}/providers/unknown-provider/wagering/transactions/non-existent-external-id`
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.statusCode).toBe(404);
      expect(body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('should return 400 Bad Request when externalTransactionId is empty or whitespace', async () => {
      const res = await fetch(
        `${serverUrl}/providers/valid-provider/wagering/transactions/${encodeURIComponent('   ')}`
      );
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.statusCode).toBe(400);
      expect(body.message).toContain('cannot be empty or contain only whitespace');
    });
  });

  describe('3. GET /wallets/:walletId/ledger (Keyset Pagination & Invariants)', () => {
    it('should return 200 with empty items, nextCursor null, and hasMore false for empty wallet', async () => {
      const walletId = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      await insertWallet(walletId, playerId, '0.00');

      const res = await fetch(`${serverUrl}/wallets/${walletId}/ledger`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.items).toEqual([]);
      expect(body.nextCursor).toBeNull();
      expect(body.hasMore).toBe(false);
      expect(body.limit).toBe(50);
    });

    it('should return 404 Not Found when wallet does not exist', async () => {
      const nonExistentWalletId = crypto.randomUUID();
      const res = await fetch(`${serverUrl}/wallets/${nonExistentWalletId}/ledger`);
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.statusCode).toBe(404);
      expect(body.code).toBe('WALLET_NOT_FOUND');
    });

    it('should return 400 Bad Request when walletId is invalid', async () => {
      const res = await fetch(`${serverUrl}/wallets/invalid-wallet-id/ledger`);
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.statusCode).toBe(400);
      expect(body.message).toContain('walletId must be a valid UUID');
    });

    it('should return 400 Bad Request for invalid limit values', async () => {
      const walletId = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      await insertWallet(walletId, playerId, '0.00');

      const invalidLimits = ['0', '-1', '101', 'abc', '1.5', ''];
      for (const limit of invalidLimits) {
        const res = await fetch(`${serverUrl}/wallets/${walletId}/ledger?limit=${limit}`);
        expect(res.status).toBe(400);

        const body = (await res.json()) as any;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
      }
    });

    it('paginação sem repetição: should paginate deterministically across multiple pages without duplicates or omissions', async () => {
      const walletId = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      const totalEntries = 12;
      const pageSize = 5;

      await insertWallet(walletId, playerId, '120.00');

      // Insert 12 entries with strictly increasing timestamps
      const baseTime = new Date('2026-10-17T10:00:00.000Z').getTime();
      const insertedIds: string[] = [];

      for (let i = 0; i < totalEntries; i++) {
        const txId = crypto.randomUUID();
        const entryId = crypto.randomUUID();
        insertedIds.push(entryId);

        const timestampIso = new Date(baseTime + i * 1000).toISOString();
        const balanceBefore = (i * 10).toFixed(2);
        const balanceAfter = ((i + 1) * 10).toFixed(2);

        await insertTransaction({
          id: txId,
          walletId,
          playerId,
          providerId: 'provider-test',
          externalTransactionId: `tx-seq-${i}-${Date.now()}`,
          amount: '10.00',
          createdAt: timestampIso,
        });

        await insertLedgerEntry({
          id: entryId,
          walletId,
          transactionId: txId,
          entryType: 'CREDIT',
          amount: '10.00',
          balanceBefore,
          balanceAfter,
          createdAt: timestampIso,
        });
      }

      // Page 1: items 0..4
      const resPage1 = await fetch(`${serverUrl}/wallets/${walletId}/ledger?limit=${pageSize}`);
      expect(resPage1.status).toBe(200);
      const page1 = (await resPage1.json()) as any;

      expect(page1.items.length).toBe(pageSize);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();
      expect(typeof page1.nextCursor).toBe('string');
      expect(page1.items[0].id).toBe(insertedIds[0]);
      expect(page1.items[4].id).toBe(insertedIds[4]);

      // Verify money format { amount, currency } on every entry
      for (const item of page1.items) {
        expect(item.amount).toEqual({ amount: '10.00', currency: 'BRL' });
        expect(item.balanceBefore).toHaveProperty('amount');
        expect(item.balanceBefore).toHaveProperty('currency');
        expect(item.balanceAfter).toHaveProperty('amount');
        expect(item.balanceAfter).toHaveProperty('currency');
      }

      // Page 2: items 5..9
      const resPage2 = await fetch(
        `${serverUrl}/wallets/${walletId}/ledger?limit=${pageSize}&cursor=${page1.nextCursor}`
      );
      expect(resPage2.status).toBe(200);
      const page2 = (await resPage2.json()) as any;

      expect(page2.items.length).toBe(pageSize);
      expect(page2.hasMore).toBe(true);
      expect(page2.nextCursor).toBeDefined();
      expect(page2.items[0].id).toBe(insertedIds[5]);
      expect(page2.items[4].id).toBe(insertedIds[9]);

      // Page 3: items 10..11 (last page)
      const resPage3 = await fetch(
        `${serverUrl}/wallets/${walletId}/ledger?limit=${pageSize}&cursor=${page2.nextCursor}`
      );
      expect(resPage3.status).toBe(200);
      const page3 = (await resPage3.json()) as any;

      expect(page3.items.length).toBe(2);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
      expect(page3.items[0].id).toBe(insertedIds[10]);
      expect(page3.items[1].id).toBe(insertedIds[11]);

      // Assert total distinct items retrieved equals totalEntries
      const allRetrievedIds = [
        ...page1.items.map((it: any) => it.id),
        ...page2.items.map((it: any) => it.id),
        ...page3.items.map((it: any) => it.id),
      ];

      expect(allRetrievedIds.length).toBe(totalEntries);
      expect(new Set(allRetrievedIds).size).toBe(totalEntries);
      expect(allRetrievedIds).toEqual(insertedIds);
    });

    it('timestamps iguais: should deterministically break ties with id ASC when multiple entries have identical created_at', async () => {
      const walletId = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      await insertWallet(walletId, playerId, '50.00');

      const identicalTimestamp = '2026-10-17T12:30:00.000Z';
      const numIdentical = 5;

      // Generate deterministically ordered UUIDs for tie breaking
      const entryIds = [
        '10000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000002',
        '30000000-0000-0000-0000-000000000003',
        '40000000-0000-0000-0000-000000000004',
        '50000000-0000-0000-0000-000000000005',
      ];

      for (let i = 0; i < numIdentical; i++) {
        const txId = crypto.randomUUID();
        await insertTransaction({
          id: txId,
          walletId,
          playerId,
          providerId: 'provider-test',
          externalTransactionId: `tx-identical-${i}-${Date.now()}`,
          amount: '10.00',
          createdAt: identicalTimestamp,
        });

        await insertLedgerEntry({
          id: entryIds[i],
          walletId,
          transactionId: txId,
          entryType: 'CREDIT',
          amount: '10.00',
          balanceBefore: (i * 10).toFixed(2),
          balanceAfter: ((i + 1) * 10).toFixed(2),
          createdAt: identicalTimestamp,
        });
      }

      // Fetch with limit = 2
      const res1 = await fetch(`${serverUrl}/wallets/${walletId}/ledger?limit=2`);
      const p1 = (await res1.json()) as any;
      expect(p1.items.length).toBe(2);
      expect(p1.items[0].id).toBe(entryIds[0]);
      expect(p1.items[1].id).toBe(entryIds[1]);
      expect(p1.hasMore).toBe(true);

      const res2 = await fetch(`${serverUrl}/wallets/${walletId}/ledger?limit=2&cursor=${p1.nextCursor}`);
      const p2 = (await res2.json()) as any;
      expect(p2.items.length).toBe(2);
      expect(p2.items[0].id).toBe(entryIds[2]);
      expect(p2.items[1].id).toBe(entryIds[3]);
      expect(p2.hasMore).toBe(true);

      const res3 = await fetch(`${serverUrl}/wallets/${walletId}/ledger?limit=2&cursor=${p2.nextCursor}`);
      const p3 = (await res3.json()) as any;
      expect(p3.items.length).toBe(1);
      expect(p3.items[0].id).toBe(entryIds[4]);
      expect(p3.hasMore).toBe(false);
      expect(p3.nextCursor).toBeNull();

      // Verify no duplicates and exact deterministic sequence
      const collected = [
        ...p1.items.map((i: any) => i.id),
        ...p2.items.map((i: any) => i.id),
        ...p3.items.map((i: any) => i.id),
      ];
      expect(collected).toEqual(entryIds);
    });

    it('cursor inválido: should reject malformed, non-base64, corrupted or invalid payload cursors with 400 Bad Request', async () => {
      const walletId = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      await insertWallet(walletId, playerId, '10.00');

      const invalidCursors = [
        'not-base64!',
        '???===',
        Buffer.from('not a json string').toString('base64url'),
        Buffer.from(JSON.stringify('a plain string')).toString('base64url'),
        Buffer.from(JSON.stringify({ walletId: 'not-uuid', id: 'not-uuid', createdAt: '2026-10-17' })).toString('base64url'),
        Buffer.from(JSON.stringify({ walletId, id: crypto.randomUUID(), createdAt: 'not-a-date' })).toString('base64url'),
        Buffer.from(JSON.stringify({ walletId, createdAt: new Date().toISOString() })).toString('base64url'), // missing id
      ];

      for (const badCursor of invalidCursors) {
        const res = await fetch(`${serverUrl}/wallets/${walletId}/ledger?cursor=${encodeURIComponent(badCursor)}`);
        expect(res.status).toBe(400);

        const body = (await res.json()) as any;
        expect(body.statusCode).toBe(400);
        expect(body.error).toBe('Bad Request');
        expect(body.message).toContain('cursor');
      }
    });

    it('cursor vinculado à carteira: should return 400 Bad Request when attempting to use a cursor generated for another wallet', async () => {
      const walletA = crypto.randomUUID();
      const walletB = crypto.randomUUID();
      await insertWallet(walletA, crypto.randomUUID(), '10.00');
      await insertWallet(walletB, crypto.randomUUID(), '10.00');

      // Generate a legitimate cursor encoded for Wallet A
      const cursorForWalletA = LedgerCursorCodec.encode({
        walletId: walletA,
        createdAt: '2026-10-17T12:30:00.000001Z',
        id: crypto.randomUUID(),
      });

      // Submit cursor for Wallet A to Wallet B's endpoint
      const res = await fetch(`${serverUrl}/wallets/${walletB}/ledger?cursor=${cursorForWalletA}`);
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe('Bad Request');
      expect(body.message).toBe('Cursor does not belong to the requested wallet');
    });

    it('última página: querying past the end should return empty items and nextCursor null', async () => {
      const walletId = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      const txId = crypto.randomUUID();
      const entryId = crypto.randomUUID();

      await insertWallet(walletId, playerId, '10.00');
      await insertTransaction({ id: txId, walletId, playerId, providerId: 'p', externalTransactionId: `ext-${Date.now()}` });
      await insertLedgerEntry({ id: entryId, walletId, transactionId: txId, entryType: 'CREDIT', amount: '10.00', balanceBefore: '0.00', balanceAfter: '10.00' });

      // Fetch first page with limit=1
      const res1 = await fetch(`${serverUrl}/wallets/${walletId}/ledger?limit=1`);
      const body1 = (await res1.json()) as any;
      expect(body1.items.length).toBe(1);
      expect(body1.hasMore).toBe(false); // only 1 item total
      expect(body1.nextCursor).toBeNull();

      // If client creates a cursor for that last item and requests next page
      const syntheticCursor = LedgerCursorCodec.encode({
        walletId,
        createdAt: body1.items[0].createdAt,
        id: body1.items[0].id,
      });

      const res2 = await fetch(`${serverUrl}/wallets/${walletId}/ledger?limit=1&cursor=${syntheticCursor}`);
      expect(res2.status).toBe(200);

      const body2 = (await res2.json()) as any;
      expect(body2.items).toEqual([]);
      expect(body2.nextCursor).toBeNull();
      expect(body2.hasMore).toBe(false);
    });
  });

  describe('4. Ausência de Mutações & Sem Efeitos Financeiros', () => {
    it('should strictly perform read-only queries with zero mutations on balances, ledger, transactions, or outbox', async () => {
      const walletId = crypto.randomUUID();
      const playerId = crypto.randomUUID();
      const txId = crypto.randomUUID();
      const entryId = crypto.randomUUID();
      const providerId = 'readonly-provider';
      const externalTxId = `ext-ro-${Date.now()}`;

      await insertWallet(walletId, playerId, '75.00');
      await insertTransaction({
        id: txId,
        walletId,
        playerId,
        providerId,
        externalTransactionId: externalTxId,
        amount: '25.00',
        status: 'PROCESSED',
      });
      await insertLedgerEntry({
        id: entryId,
        walletId,
        transactionId: txId,
        entryType: 'CREDIT',
        amount: '25.00',
        balanceBefore: '50.00',
        balanceAfter: '75.00',
      });

      // Snapshot database counts and balance before queries
      const getCounts = async () => {
        const snapshot: Record<string, string[]> = {};
        for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages']) {
          const rows = await adminPool.query(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY id`);
          snapshot[table] = rows.rows.map(row => row.row);
        }
        return snapshot;
      };

      const before = await getCounts();

      // Execute read endpoints multiple times, including successful reads, 404s, and 400s
      await fetch(`${serverUrl}/wagering/transactions/${txId}`);
      await fetch(`${serverUrl}/wagering/transactions/${crypto.randomUUID()}`);
      await fetch(`${serverUrl}/providers/${providerId}/wagering/transactions/${externalTxId}`);
      await fetch(`${serverUrl}/providers/other-prov/wagering/transactions/other-ext`);
      await fetch(`${serverUrl}/wallets/${walletId}/ledger?limit=10`);
      await fetch(`${serverUrl}/wallets/${crypto.randomUUID()}/ledger`);
      await fetch(`${serverUrl}/wallets/${walletId}/ledger?cursor=invalid-cursor`);

      // Snapshot database counts and balance after queries
      const after = await getCounts();

      expect(after).toEqual(before);
    });
  });
  it('shares one UoW and existing repositories between command and query providers', () => {
    const uow = app.get(MikroOrmUnitOfWork);
    expect(app.select(PersistenceModule).get(MikroOrmUnitOfWork, { strict: true })).toBe(uow);
    const modules = app.get(ModulesContainer);
    const instances = [...modules.values()].flatMap(module => [...module.providers.values()])
      .map(provider => provider.instance).filter(instance => instance instanceof MikroOrmUnitOfWork);
    expect(instances).toEqual([uow]);
    const query = app.select(WageringQueryModule).get(GetWalletLedgerUseCase, { strict: true });
    expect((query as any).walletRepo).toBe(app.get(MikroOrmWalletRepository));
    expect((query as any).ledgerQueryRepo).toBe(app.get(MikroOrmWalletLedgerQueryRepository));
    expect((app.get(MikroOrmWalletLedgerQueryRepository) as any).uow).toBe(uow);
    expect((app.get(MikroOrmWagerTransactionRepository) as any).uow).toBe(uow);
    expect((app.get(ProcessWagerUseCase) as any).uow).toBe(uow);
  });

  it('isolates identical external IDs by provider and returns the identical transaction contract by ID', async () => {
    const walletId = crypto.randomUUID(), playerId = crypto.randomUUID();
    const externalId = `shared-${crypto.randomUUID()}`;
    await insertWallet(walletId, playerId, '9999999999999999.99');
    for (const providerId of ['provider-one', 'provider-two']) {
      const id = crypto.randomUUID();
      await insertTransaction({ id, walletId, playerId, providerId, externalTransactionId: externalId, amount: '9999999999999999.99' });
      const byId = await fetch(`${serverUrl}/wagering/transactions/${id}`);
      const byExternal = await fetch(`${serverUrl}/providers/${providerId}/wagering/transactions/${externalId}`);
      expect(byId.status).toBe(200);
      expect(byExternal.status).toBe(200);
      const body = await byId.json() as any;
      expect(await byExternal.json()).toEqual(body);
      expect(body.id).toBe(id);
      expect(body.providerId).toBe(providerId);
      expect(body.money).toEqual({ amount: '9999999999999999.99', currency: 'BRL' });
    }
    expect((await fetch(`${serverUrl}/providers/provider-three/wagering/transactions/${externalId}`)).status).toBe(404);
    expect((await fetch(`${serverUrl}/providers/%20/wagering/transactions/${externalId}`)).status).toBe(400);
    expect((await fetch(`${serverUrl}/providers/${'p'.repeat(129)}/wagering/transactions/${externalId}`)).status).toBe(400);
  });

  it('preserves every microsecond across pages, identical timestamps, UUID ties and exact large ledger amounts', async () => {
    const walletId = crypto.randomUUID(), playerId = crypto.randomUUID();
    await insertWallet(walletId, playerId, '9999999999999999.99');
    // Deliberately reverse UUID order across distinct microseconds: losing precision
    // would repeat or omit rows when crossing a cursor boundary.
    const fractions = ['000001', '000001', '000002', '000999', '001000', '001001'];
    const ids = ['a', 'b', '9', '8', '7', '6'].map(prefix => `${prefix}0000000-0000-0000-0000-000000000017`);
    for (let i = 0; i < ids.length; i++) {
      const transactionId = crypto.randomUUID();
      await insertTransaction({ id: transactionId, walletId, playerId, providerId: 'micros', externalTransactionId: transactionId });
      await insertLedgerEntry({ id: ids[i], walletId, transactionId, entryType: 'CREDIT', amount: '9999999999999999.99', balanceBefore: '0.00', balanceAfter: '9999999999999999.99', createdAt: `2024-02-29T12:34:56.${fractions[i]}Z` });
    }
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < ids.length; i++) {
      const response = await fetch(`${serverUrl}/wallets/${walletId}/ledger?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(response.status).toBe(200);
      const page = await response.json() as any;
      expect(page.items).toHaveLength(1);
      const item = page.items[0];
      collected.push(item.id);
      expect(item.createdAt).toBe(`2024-02-29T12:34:56.${fractions[i]}Z`);
      expect(item.amount).toEqual({ amount: '9999999999999999.99', currency: 'BRL' });
      expect(item.balanceBefore.amount).toBe('0.00');
      expect(item.balanceAfter.amount).toBe('9999999999999999.99');
      expect(page.hasMore).toBe(i < ids.length - 1);
      cursor = page.nextCursor;
      if (cursor) expect(LedgerCursorCodec.decode(cursor, walletId)?.createdAt).toBe(item.createdAt);
      else expect(i).toBe(ids.length - 1);
    }
    expect(collected).toEqual(ids);
    expect(new Set(collected).size).toBe(ids.length);
  });

  it('rejects impossible dates and noncanonical cursor formats before any repository SQL', async () => {
    const walletId = crypto.randomUUID();
    const invalidDates = [
      '2025-02-29T00:00:00.000001Z', '2024-02-30T00:00:00.000001Z',
      '1900-02-29T00:00:00.000001Z', '2024-04-31T00:00:00.000001Z',
      '0000-01-01T00:00:00.000001Z', '2024-00-01T00:00:00.000001Z',
      '2024-13-01T00:00:00.000001Z', '2024-01-00T00:00:00.000001Z',
      '2024-01-01T24:00:00.000001Z', '2024-01-01T00:60:00.000001Z',
      '2024-01-01T00:00:60.000001Z', '2024-01-01', 'October 17, 2026',
      '2024-01-01T00:00:00.123Z', '2024-01-01T00:00:00Z',
      '2024-01-01T00:00:00.1234567Z', '2024-01-01T00:00:00.000001+00:00',
      '2024-01-01 00:00:00.000001Z', '2024-01-01T00:00:00.000001z',
      '2024-01-01T00:00:00.000001Z\' OR 1=1 --',
    ];
    const uow = app.get(MikroOrmUnitOfWork);
    const sqlAccess = spyOn(uow, 'getEntityManager');
    try {
      for (const createdAt of invalidDates) {
        const cursor = Buffer.from(JSON.stringify({ walletId, id: crypto.randomUUID(), createdAt })).toString('base64url');
        const response = await fetch(`${serverUrl}/wallets/${walletId}/ledger?cursor=${cursor}`);
        expect(response.status).toBe(400);
        expect((await response.json() as any).message).toContain('cursor');
      }
      expect(sqlAccess).not.toHaveBeenCalled();
    } finally { sqlAccess.mockRestore(); }
  });

  it('accepts default and maximum limits and rejects repeated query parameters', async () => {
    const walletId = crypto.randomUUID();
    await insertWallet(walletId, crypto.randomUUID(), '0.00');
    for (const [suffix, limit] of [['', 50], ['?limit=100', 100]] as const) {
      const response = await fetch(`${serverUrl}/wallets/${walletId}/ledger${suffix}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [], nextCursor: null, hasMore: false, limit });
    }
    expect((await fetch(`${serverUrl}/wallets/${walletId}/ledger?limit=1&limit=2`)).status).toBe(400);
    expect((await fetch(`${serverUrl}/wallets/${walletId}/ledger?cursor=a&cursor=b`)).status).toBe(400);
  });

});
