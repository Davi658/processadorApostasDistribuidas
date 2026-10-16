import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { AppModule } from '../../src/interfaces/http/app.module';
import { DomainExceptionFilter } from '../../src/interfaces/http/filters/domain-exception.filter';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';

describe('HTTP Endpoints Real Integration Tests', () => {
  let app: INestApplication;
  let serverUrl: string;
  let testPool: pg.Pool;

  beforeAll(async () => {
    const migrator = new DatabaseMigrator();
    await migrator.up();
    await migrator.close();

    testPool = new pg.Pool({
      host: '127.0.0.1',
      port: 5432,
      database: 'betting_db',
      user: 'postgres',
      password: '',
    });

    await testPool.query('TRUNCATE TABLE outbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE');

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'string' ? address : address.port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
    await testPool.end();
  });

  it('POST /wallets should create a wallet with initial balance and return 201', async () => {
    const playerId = `http-player-1-${crypto.randomUUID()}`;
    const res = await fetch(`${serverUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        currency: 'BRL',
        initialBalance: '150.00',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.walletId).toBeDefined();
    expect(body.playerId).toBe(playerId);
    expect(body.balance).toBe('150.00');
    expect(body.version).toBe(1);
  });

  it('POST /wallets should return 409 Conflict if wallet already exists for player and currency', async () => {
    const playerId = `http-dup-player-${crypto.randomUUID()}`;
    await fetch(`${serverUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        currency: 'BRL',
      }),
    });

    const resDup = await fetch(`${serverUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        currency: 'BRL',
      }),
    });

    expect(resDup.status).toBe(409);
    const body = (await resDup.json()) as any;
    expect(body.code).toBe('DUPLICATE_WALLET');
  });

  it('GET /wallets/:walletId should return 200 with wallet details or 404 if not found', async () => {
    const createRes = await fetch(`${serverUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: `http-player-get-${crypto.randomUUID()}`,
        currency: 'BRL',
        initialBalance: '50.00',
      }),
    });
    const created = (await createRes.json()) as any;

    const getRes = await fetch(`${serverUrl}/wallets/${created.walletId}`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as any;
    expect(getBody.walletId).toBe(created.walletId);
    expect(getBody.balance).toBe('50.00');

    const notFoundRes = await fetch(`${serverUrl}/wallets/${crypto.randomUUID()}`);
    expect(notFoundRes.status).toBe(404);
  });

  it('POST /wagering/transactions should return 400 when Idempotency-Key header is missing', async () => {
    const res = await fetch(`${serverUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'prov-1',
        externalTransactionId: `ext-no-header-${crypto.randomUUID()}`,
        playerId: 'player-x',
        walletId: crypto.randomUUID(),
        roundId: 'r-1',
        gameId: 'g-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    });

    expect(res.status).toBe(400);
  });

  it('POST /wagering/transactions should reject operations other than BET with 400', async () => {
    const res = await fetch(`${serverUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `key-unsupported-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        providerId: 'prov-1',
        externalTransactionId: `ext-win-${crypto.randomUUID()}`,
        playerId: 'player-x',
        walletId: crypto.randomUUID(),
        roundId: 'r-1',
        gameId: 'g-1',
        kind: 'WIN',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe('INVALID_WAGER_OPERATION');
  });

  it('POST /wagering/transactions should return 200 for processed BET and 422 for insufficient balance', async () => {
    const createRes = await fetch(`${serverUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: `http-bettor-${crypto.randomUUID()}`,
        currency: 'BRL',
        initialBalance: '100.00',
      }),
    });
    const wallet = (await createRes.json()) as any;

    const idempKey1 = `http-idemp-1-${crypto.randomUUID()}`;
    const extTx1 = `ext-http-1-${crypto.randomUUID()}`;

    const betRes = await fetch(`${serverUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempKey1,
      },
      body: JSON.stringify({
        providerId: 'prov-http',
        externalTransactionId: extTx1,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '60.00', currency: 'BRL' },
      }),
    });

    expect(betRes.status).toBe(200);
    const betBody = (await betRes.json()) as any;
    expect(betBody.status).toBe('PROCESSED');
    expect(betBody.observedBalance).toBe('40.00');

    const rejectRes = await fetch(`${serverUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `http-idemp-2-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        providerId: 'prov-http',
        externalTransactionId: `ext-http-2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-2',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '60.00', currency: 'BRL' },
      }),
    });

    expect(rejectRes.status).toBe(422);
    const rejectBody = (await rejectRes.json()) as any;
    expect(rejectBody.status).toBe('REJECTED');
    expect(rejectBody.reason).toBe('INSUFFICIENT_FUNDS');
    expect(rejectBody.observedBalance).toBe('40.00');

    const replayRes = await fetch(`${serverUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempKey1,
      },
      body: JSON.stringify({
        providerId: 'prov-http',
        externalTransactionId: extTx1,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '60.00', currency: 'BRL' },
      }),
    });

    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as any;
    expect(replayBody.status).toBe('PROCESSED');
    expect(replayBody.observedBalance).toBe('40.00');

    const reconRes = await fetch(`${serverUrl}/wallets/${wallet.walletId}/reconciliation`, {
      method: 'POST',
    });
    expect(reconRes.status).toBe(200);
    const reconBody = (await reconRes.json()) as any;
    expect(reconBody.consistent).toBe(true);
    expect(reconBody.storedBalance).toBe('40.00');
    expect(reconBody.calculatedBalance).toBe('40.00');
    expect(reconBody.difference).toBe('0.00');
  });
});
