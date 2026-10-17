import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { FinancialQueriesModule } from '../../src/interfaces/http/financial-queries.module';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../test-db-helper';

describe('M17 read queries with disposable PostgreSQL and real HTTP', () => {
  let db: IsolatedTestDatabase;
  let admin: pg.Pool;
  let app: INestApplication;
  let url: string;
  let baseline: pg.QueryResultRow[];
  const walletId = crypto.randomUUID();
  const emptyWalletId = crypto.randomUUID();
  const largeWalletId = crypto.randomUUID();
  const statusIds = new Map<string, string>();
  const ids: string[] = [];
  const txIds: string[] = [];
  const times = ['2026-01-01T00:00:00.123456Z', '2026-01-01T00:00:00.123456Z',
    '2026-01-01T00:00:00.123457Z', '2026-01-01T00:00:00.123999Z', '2026-01-02T00:00:00.000000Z'];

  async function snapshot() {
    const result = await admin.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM wallets w) AS wallets,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM wager_transactions t) AS transactions,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM wallet_ledger_entries l) AS ledger,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM outbox_messages o) AS outbox`);
    return result.rows;
  }
  const get = (path: string) => fetch(url + path);
  const ledger = (query = '', wallet = walletId) => get(`/wallets/${wallet}/ledger${query}`);

  beforeAll(async () => {
    db = await createIsolatedTestDatabase('m17_');
    admin = new pg.Pool(db.adminConfig);
    for (const id of [walletId, emptyWalletId]) {
      await admin.query(`INSERT INTO wallets VALUES ($1,$2,'BRL',0,1,NOW(),NOW())`, [id, crypto.randomUUID()]);
    }
    // Reverse UUID insertion order ensures tie-breaking is independent of insertion order.
    for (let i = 0; i < times.length; i++) {
      const id = `00000000-0000-4000-8000-${String(5 - i).padStart(12, '0')}`;
      const tx = crypto.randomUUID();
      ids.push(id); txIds.push(tx);
      await admin.query(`INSERT INTO wager_transactions
        (id,wallet_id,player_id,provider_id,external_transaction_id,round_id,game_id,kind,amount,currency,status,created_at,updated_at)
        SELECT $1,id,player_id,'provider-m17',$2,'round','game','OPENING',$3,'BRL','PROCESSED',$4,$4 FROM wallets WHERE id=$5`,
      [tx, `ext-${i}`, i === 4 ? '9999999999999999.99' : '0.01', times[i], walletId]);
      await admin.query(`INSERT INTO wallet_ledger_entries
        (id,wallet_id,transaction_id,entry_type,amount,currency,balance_before,balance_after,created_at)
        VALUES ($1,$2,$3,$4,$5,'BRL',$6,$7,$8)`,
      [id, walletId, tx, i === 2 || i === 3 ? 'DEBIT' : 'CREDIT', i === 4 ? '9999999999999999.99' : '0.01',
        ['0.00', '0.01', '0.02', '0.01', '0.00'][i],
        ['0.01', '0.02', '0.01', '0.00', '9999999999999999.99'][i], times[i]]);
    }
    await admin.query(`UPDATE wallets SET balance='9999999999999999.99', version=6 WHERE id=$1`, [walletId]);
    for (const status of ['PROCESSED', 'REJECTED', 'FAILED', 'PENDING', 'PENDING_REFERENCE']) {
      const id = crypto.randomUUID();
      statusIds.set(status, id);
      await admin.query(`INSERT INTO wager_transactions
        (id,wallet_id,player_id,provider_id,external_transaction_id,round_id,game_id,kind,amount,currency,status,
         idempotency_key,payload_hash,rejection_reason,created_at,updated_at)
        SELECT $1::uuid,id,player_id,'status-provider',$2,'round','game','LOSS',0,'BRL',$2,($1::uuid)::text,repeat('a',64),$3,NOW(),NOW()
        FROM wallets WHERE id=$4`, [id, status, status === 'REJECTED' ? 'REFERENCE_NOT_PROCESSED' : null, emptyWalletId]);
    }
    await admin.query(`INSERT INTO wallets VALUES ($1,$2,'BRL',1.05,106,NOW(),NOW())`, [largeWalletId, crypto.randomUUID()]);
    await admin.query(`WITH seeded AS (
      INSERT INTO wager_transactions
        (id,wallet_id,player_id,provider_id,external_transaction_id,round_id,game_id,kind,amount,currency,status,created_at,updated_at)
      SELECT gen_random_uuid(),w.id,w.player_id,'large-provider',s::text,'round','game','OPENING',0.01,'BRL','PROCESSED',
        '2026-01-01'::timestamptz,'2026-01-01'::timestamptz FROM wallets w CROSS JOIN generate_series(1,105) s WHERE w.id=$1
      RETURNING id,external_transaction_id)
      INSERT INTO wallet_ledger_entries (id,wallet_id,transaction_id,entry_type,amount,currency,balance_before,balance_after,created_at)
      SELECT gen_random_uuid(),$1,id,'CREDIT',0.01,'BRL',(external_transaction_id::numeric-1)/100,
        external_transaction_id::numeric/100,'2026-01-01'::timestamptz FROM seeded`, [largeWalletId]);
    baseline = await snapshot();
    app = await NestFactory.create(FinancialQueriesModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  }, 30000);

  afterAll(async () => {
    try {
      if (admin && baseline) expect(await snapshot()).toEqual(baseline);
    } finally {
      if (app) await app.close();
      if (admin) await admin.end();
      if (db) await db.closeAndDrop();
    }
  }, 30000);

  it('queries the same explicit transaction DTO by ID and composite external identity', async () => {
    const response = await get(`/wagering/transactions/${txIds[4]}`);
    expect(response.status).toBe(200);
    const byId = await response.json() as any;
    const external = await get('/wagering/transactions?providerId=provider-m17&externalTransactionId=ext-4');
    expect(external.status).toBe(200);
    expect(await external.json()).toEqual(byId);
    expect(byId.money).toEqual({ amount: '9999999999999999.99', currency: 'BRL' });
    expect(byId.transactionId).toBe(txIds[4]);
    expect(byId).not.toHaveProperty('payloadHash');
    expect(byId).not.toHaveProperty('idempotencyKey');
    expect(byId).not.toHaveProperty('leaseToken');
  });

  it('returns 404 for missing IDs, provider mismatch and external ID mismatch', async () => {
    for (const path of [`/wagering/transactions/${crypto.randomUUID()}`,
      '/wagering/transactions?providerId=other&externalTransactionId=ext-0',
      '/wagering/transactions?providerId=provider-m17&externalTransactionId=other']) {
      expect((await get(path)).status).toBe(404);
    }
    expect((await ledger('', crypto.randomUUID())).status).toBe(404);
  });

  it('exposes stored status and zero money without processing pending transactions or replaying them', async () => {
    for (const [status, id] of statusIds) {
      const response = await get(`/wagering/transactions/${id}`);
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.status).toBe(status);
      expect(body.money).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(body.failureCode).toBe(status === 'REJECTED' ? 'REFERENCE_NOT_PROCESSED' : null);
    }
  });

  it('enforces default 50 and maximum 100 and isolates wallets across a full traversal', async () => {
    expect((await (await ledger('', largeWalletId)).json() as any).items).toHaveLength(50);
    const first = await (await ledger('?limit=100', largeWalletId)).json() as any;
    expect(first.items).toHaveLength(100);
    const second = await (await ledger(`?limit=100&cursor=${first.nextCursor}`, largeWalletId)).json() as any;
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const entries = [...first.items, ...second.items];
    expect(new Set(entries.map(item => item.id)).size).toBe(105);
    expect(entries.every(item => item.walletId === largeWalletId)).toBe(true);
    expect(entries.map(item => item.id)).toEqual(entries.map(item => item.id).sort());
  });

  it('rejects malformed UUIDs and missing, repeated, empty or oversized external identifiers with 400', async () => {
    for (const path of ['/wagering/transactions/bad', '/wallets/bad/ledger', '/wagering/transactions',
      '/wagering/transactions?providerId=x', '/wagering/transactions?providerId=&externalTransactionId=x',
      '/wagering/transactions?providerId=x&providerId=y&externalTransactionId=x',
      `/wagering/transactions?providerId=${'a'.repeat(129)}&externalTransactionId=x`,
      `/wagering/transactions?providerId=x&externalTransactionId=${'a'.repeat(129)}`]) {
      expect((await get(path)).status).toBe(400);
    }
  });

  it('walks all pages exactly once with ties, microseconds, and an opaque wallet-scoped cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await ledger(`?limit=1${cursor ? '&cursor=' + cursor : ''}`);
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.items).toHaveLength(1);
      expect(body.items[0].money.amount).toBeTypeOf('string');
      seen.push(body.items[0].id);
      cursor = body.nextCursor;
      if (cursor) expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    } while (cursor);
    expect(seen).toEqual([ids[1], ids[0], ids[2], ids[3], ids[4]]);
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('returns deterministic repeat pages, monetary strings, and null cursor at exhaustion', async () => {
    const first = await (await ledger('?limit=2')).json() as any;
    expect(await (await ledger('?limit=2')).json()).toEqual(first);
    const next = await (await ledger(`?limit=100&cursor=${first.nextCursor}`)).json() as any;
    expect(next.nextCursor).toBeNull();
    expect(next.items[0].createdAt).toBe(times[2]);
    expect(next.items[1].entryType).toBe('DEBIT');
    expect(next.items[1].balanceBefore).toEqual({ amount: '0.01', currency: 'BRL' });
    expect(next.items[1].balanceAfter).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(next.items[2].money.amount).toBe('9999999999999999.99');
    expect((await (await ledger()).json() as any).items).toHaveLength(5);
    expect(await (await ledger('', emptyWalletId)).json()).toEqual({ items: [], nextCursor: null });
  });

  it('rejects invalid limits, duplicate query arguments and malformed/cross-wallet cursors', async () => {
    for (const limit of ['0', '101', '-1', '1.5', '1e2', '01', '', 'Infinity', '1&limit=2']) {
      expect((await ledger(`?limit=${limit}`)).status).toBe(400);
    }
    for (const cursor of ['', '!!!', 'e30', 'a'.repeat(513), 'null', 'x&cursor=y']) {
      expect((await ledger(`?cursor=${cursor}`)).status).toBe(400);
    }
    const first = await (await ledger('?limit=1')).json() as any;
    expect((await ledger(`?cursor=${first.nextCursor}`, emptyWalletId)).status).toBe(400);
    const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
    for (const change of [{ v: 2 }, { id: 'bad' }, { createdAt: '2026-02-30T00:00:00.000000Z' },
      { createdAt: '0000-01-01T00:00:00.000000Z' }, { extra: true }]) {
      const cursor = Buffer.from(JSON.stringify({ ...decoded, ...change })).toString('base64url');
      expect((await ledger(`?cursor=${cursor}`)).status).toBe(400);
    }
  });

  it('does not mutate any wallet, transaction, ledger or outbox row', async () => {
    expect(await snapshot()).toEqual(baseline);
  });
});
