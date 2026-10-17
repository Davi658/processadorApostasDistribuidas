import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import crypto from 'crypto';
import { AppModule } from '../../src/interfaces/http/app.module';
import { WageringQueryModule } from '../../src/interfaces/http/wagering-query.module';
import { DomainExceptionFilter } from '../../src/interfaces/http/filters/domain-exception.filter';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';
import { QueryValidator } from '../../src/interfaces/http/validation/query-validator';

describe('M17: Read Endpoints & Keyset Ledger Pagination', () => {
  let app: INestApplication;
  let serverUrl: string;
  let isolatedDb: IsolatedTestDatabase;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    // 1. Create disposable database for isolated execution
    isolatedDb = await createIsolatedTestDatabase('m17_read_endpoints_');
    adminPool = new pg.Pool(isolatedDb.adminConfig);
    adminPool.on('error', () => {});

    // 2. Start NestJS application against isolated database with query module
    app = await NestFactory.create(WageringQueryModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'string' ? address : address.port;
    serverUrl = `http://127.0.0.1:${port}`;
  }, 30000);

  afterAll(async () => {
    if (app) {
      try {
        const uow = app.get(MikroOrmUnitOfWork);
        await uow.close();
      } catch {}
      await app.close();
    }
    if (adminPool) {
      await adminPool.end();
    }
    if (isolatedDb) {
      await isolatedDb.closeAndDrop();
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
      const cursorForWalletA = QueryValidator.encodeCursor({
        walletId: walletA,
        createdAt: new Date().toISOString(),
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
      const syntheticCursor = QueryValidator.encodeCursor({
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
        const walletsRes = await adminPool.query('SELECT COUNT(*) AS cnt, balance, version FROM wallets WHERE id = $1 GROUP BY balance, version', [walletId]);
        const txsRes = await adminPool.query('SELECT COUNT(*) AS cnt FROM wager_transactions');
        const ledgerRes = await adminPool.query('SELECT COUNT(*) AS cnt FROM wallet_ledger_entries');
        const outboxRes = await adminPool.query('SELECT COUNT(*) AS cnt FROM outbox_messages');

        return {
          walletRow: walletsRes.rows[0],
          txCount: txsRes.rows[0].cnt,
          ledgerCount: ledgerRes.rows[0].cnt,
          outboxCount: outboxRes.rows[0].cnt,
        };
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

      expect(after.walletRow.balance).toBe(before.walletRow.balance);
      expect(after.walletRow.version).toBe(before.walletRow.version);
      expect(after.txCount).toBe(before.txCount);
      expect(after.ledgerCount).toBe(before.ledgerCount);
      expect(after.outboxCount).toBe(before.outboxCount);
    });
  });
});
